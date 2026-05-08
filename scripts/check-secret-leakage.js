#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Bearer-pattern leakage guard.
 *
 * Toptal Talent session bearers follow the format `user_<24hex>_<20alphanum>`
 * (e.g. `user_abc123def456789012345678_abcdefghij1234567890`). The pattern
 * is unambiguous and unique enough that any match in tracked source is
 * almost certainly a leak — typically a token that landed in a fixture,
 * snapshot, or commit message during local development.
 *
 * The post-#107 single-file model places the captured bearer inline in
 * the YAML config, which raises the risk of a fixture-leak by a
 * meaningful margin (the prior model put it in a separate auth.token
 * file, which never survived round-tripping through tests). This script
 * is the CI gate that catches the regression.
 *
 * Scope:
 *   - Scans tracked files (`git ls-files`) — untracked or gitignored
 *     files are not the concern (they're already excluded from PR diffs).
 *   - Excludes everything under `.tmp/` (where the E2E harness deliberately
 *     writes captured bearers — that's the safe location).
 *   - Excludes binary files, lockfiles (`pnpm-lock.yaml`), and this
 *     script itself (which contains the regex for the pattern).
 *   - Excludes `**` /node_modules/** (defensive — git ls-files shouldn't
 *     return them anyway).
 *
 * Exit codes:
 *   0 — no bearer-pattern matches in tracked source (clean)
 *   1 — one or more matches found; each is reported with file + line
 *
 * Wired into the `lint` Turbo task via `turbo.json` so PR CI runs it on
 * every push.
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Exact bearer pattern. Anchored to character class boundaries so the
 * match is precise:
 *   - `user_` literal prefix (TTCtl-specific; no false positive on Linux
 *     `/etc/passwd` entries or unrelated `user_` prefixes in test data)
 *   - `[0-9a-f]{24}` — 24 lowercase hex chars (the bearer's first segment)
 *   - `_` literal separator
 *   - `[A-Za-z0-9]{20}` — 20 mixed-case alphanumeric chars (second segment)
 */
const BEARER_PATTERN = /user_[0-9a-f]{24}_[A-Za-z0-9]{20}/g;

/**
 * Files / directories excluded from the scan. Everything under `.tmp/`
 * is implicitly excluded because git ls-files honors .gitignore and
 * `.tmp/` is gitignored — but we keep the explicit prefix check as a
 * defense-in-depth.
 */
const EXCLUDED_PATH_PREFIXES = [".tmp/", "node_modules/", "scripts/check-secret-leakage.js"];

/**
 * File extensions excluded from the scan. Binary / encoded / minified
 * files won't have human-readable bearer tokens; the false-positive
 * surface from random alpha-numeric noise is too high.
 */
const EXCLUDED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".ico",
  ".lock",
]);

/** Excluded specific filenames (regardless of path). */
const EXCLUDED_FILENAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);

function shouldSkipPath(relativePath) {
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (relativePath === prefix || relativePath.startsWith(prefix)) return true;
  }
  const lastSlash = relativePath.lastIndexOf("/");
  const filename = lastSlash >= 0 ? relativePath.slice(lastSlash + 1) : relativePath;
  if (EXCLUDED_FILENAMES.has(filename)) return true;
  const lastDot = filename.lastIndexOf(".");
  if (lastDot > 0) {
    const ext = filename.slice(lastDot).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function listTrackedFiles(repoRoot) {
  const stdout = execSync("git ls-files", {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function scanFile(filePath) {
  let content;
  try {
    const stat = statSync(filePath);
    // Skip files larger than 1 MiB — scanning gigabytes of tracked binary
    // (rare but possible) would be expensive and yield nothing useful.
    if (stat.size > 1024 * 1024) return [];
    content = readFileSync(filePath, "utf8");
  } catch {
    // Unreadable files (broken symlinks, permission denied) get a pass —
    // not the right place to surface those.
    return [];
  }

  const findings = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    BEARER_PATTERN.lastIndex = 0;
    let match;
    while ((match = BEARER_PATTERN.exec(line)) !== null) {
      findings.push({ line: i + 1, match: match[0] });
    }
  }
  return findings;
}

function main() {
  const repoRoot = process.cwd();
  const tracked = listTrackedFiles(repoRoot);

  let totalFindings = 0;
  for (const relativePath of tracked) {
    if (shouldSkipPath(relativePath)) continue;
    const absPath = join(repoRoot, relativePath);
    const findings = scanFile(absPath);
    if (findings.length > 0) {
      for (const f of findings) {
        process.stderr.write(`${relativePath}:${String(f.line)}: bearer-pattern match: ${f.match}\n`);
        totalFindings += 1;
      }
    }
  }

  if (totalFindings > 0) {
    process.stderr.write(
      `\nFAIL: found ${String(totalFindings)} bearer-pattern match(es) in tracked source.\n` +
        `These look like Toptal Talent session bearers (\`user_<24hex>_<20alphanum>\`) and should NOT\n` +
        `appear in committed code. Move them under .tmp/ (gitignored), redact them, or rotate the\n` +
        `affected session if they are real bearers.\n`,
    );
    process.exit(1);
  }
  // Quiet on success — Turbo's task aggregator already reports the OK.
}

main();
