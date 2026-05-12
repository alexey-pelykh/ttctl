#!/usr/bin/env tsx
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
 * Authored as a `.ts` script run via `tsx` (issue #139 AC #6) so the
 * canonical bearer-pattern regex lives ONCE — in
 * `packages/core/src/lib/redact.ts`'s `BEARER_PATTERN_SOURCE` — and is
 * consumed by BOTH this lint-time check and the runtime debug-log
 * redaction path. Any future addition to either side (new secret shape,
 * new redaction field) extends `redact.ts`; this script picks it up
 * automatically.
 *
 * Scope:
 *   - Scans tracked files (`git ls-files`) — untracked or gitignored
 *     files are not the concern (they're already excluded from PR diffs).
 *   - Excludes everything under `.tmp/` (where the E2E harness deliberately
 *     writes captured bearers — that's the safe location).
 *   - Excludes binary files, lockfiles (`pnpm-lock.yaml`), this script
 *     itself (which imports the pattern), the source-of-truth module
 *     `packages/core/src/lib/redact.ts` (which defines the pattern
 *     literal), AND the two test suites that exercise the redact /
 *     diagnostic-log modules (which require fixture bearers that match
 *     the canonical shape to verify the redaction logic). All four
 *     would self-match without the exclusion.
 *   - Excludes `node_modules/` (defensive — git ls-files shouldn't return
 *     them anyway).
 *
 * Exit codes:
 *   0 — no bearer-pattern matches in tracked source (clean)
 *   1 — one or more matches found; each is reported with file + line
 *
 * Wired into the root `lint` script via `package.json` so PR CI runs it
 * on every push.
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Single source of truth for the bearer pattern. `redact.ts` is the
// authoritative module — see its doc-comment for the canonical
// definition and the rationale for the wire shape. The relative path
// reaches into the core package source (NOT the built `dist/`) so this
// script does not depend on `pnpm build` having run first; `tsx`
// resolves the TypeScript directly via esbuild.
import { BEARER_PATTERN_SOURCE } from "../packages/core/src/lib/redact.js";

/**
 * Files / directories excluded from the scan. Everything under `.tmp/`
 * is implicitly excluded because git ls-files honors .gitignore and
 * `.tmp/` is gitignored — but we keep the explicit prefix check as
 * defense-in-depth. The paths after `node_modules/` are the source-of-
 * truth module, this script, and the two co-located test suites that
 * exercise redaction — all four contain canonical-shape bearer fixtures
 * by design and would self-match without the exclusion.
 */
const EXCLUDED_PATH_PREFIXES = [
  ".tmp/",
  "node_modules/",
  "scripts/check-secret-leakage.ts",
  "packages/core/src/lib/redact.ts",
  "packages/core/src/lib/__tests__/redact.test.ts",
  "packages/core/src/lib/__tests__/diagnostic-log.test.ts",
];

/**
 * File extensions excluded from the scan. Binary / encoded / minified
 * files won't have human-readable bearer tokens; the false-positive
 * surface from random alpha-numeric noise is too high.
 */
const EXCLUDED_EXTENSIONS = new Set<string>([
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
const EXCLUDED_FILENAMES = new Set<string>(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);

function shouldSkipPath(relativePath: string): boolean {
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

function listTrackedFiles(repoRoot: string): string[] {
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

interface Finding {
  line: number;
  match: string;
}

function scanFile(filePath: string): Finding[] {
  let content: string;
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

  // Construct a fresh `g`-flagged regex per file so the cursor
  // (`lastIndex`) state from one file's scan never leaks into the
  // next. The pattern source comes from the single source of truth
  // in `packages/core/src/lib/redact.ts`.
  const pattern = new RegExp(BEARER_PATTERN_SOURCE, "g");
  const findings: Finding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      findings.push({ line: i + 1, match: match[0] });
    }
  }
  return findings;
}

function main(): void {
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
