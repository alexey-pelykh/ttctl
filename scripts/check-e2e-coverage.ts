#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage gate for `talent-profile` + `scheduler` GraphQL operations
 * (issue #63).
 *
 * Structural enforcement of the schema/contract validation rule from
 * `CLAUDE.md`: any hand-rolled GraphQL operation invoked from
 * `packages/core/src/` against a Cloudflare-protected surface must carry a
 * corresponding `*.e2e.test.ts` that exercises the live wire format. The
 * CLAUDE.md text rule is review-time; this script is the CI-time mirror
 * that catches misses the human eye would. See #62 for the policy origin
 * and #59 / #60 for the empirical bugs that motivated both.
 *
 * Detection scope:
 *
 *   - Walks `packages/core/src/**` for literal `operationName: "X"`
 *     appearances in source (NOT inside `__tests__/` or `*.test.ts`).
 *   - For each match, walks upward up to 30 lines to find the nearest
 *     `surface: "..."` literal in the enclosing object expression. That
 *     surface determines whether the operation is in-scope for this gate.
 *     Only `talent-profile` and `scheduler` are gated; `mobile-gateway`
 *     calls are reported once at the end and otherwise ignored (per
 *     the AC's Out-of-Scope list).
 *   - Helper-wrapped invocations that pass `operationName` as a
 *     parameter (e.g. `callTalentProfile(token, "GetSkillSetWithConnections", ...)`
 *     in `services/profile/skills/index.ts`) are NOT detected by this
 *     v1 script — the literal does not match `operationName: "X"`. Two
 *     remediations: (a) refactor the helper to take a kwarg object
 *     `{ operationName: "X", query, variables }` so the literal becomes
 *     visible, or (b) place an `// e2e-exempt: <reason>` marker near the
 *     helper invocation. A v2 enhancement can extend detection to
 *     positional-arg helper signatures.
 *
 * Coverage declaration:
 *
 *   - E2E tests claim coverage via `// e2e-covers: OpName1, OpName2`
 *     directives placed anywhere in `packages/e2e/src/**\/*.e2e.test.ts`.
 *     Multiple directives per file accumulate. Whitespace and trailing
 *     punctuation around operation names are tolerated.
 *
 * Exemption mechanism:
 *
 *   - Per-call `// e2e-exempt: <reason>` placed within 5 lines preceding
 *     the `operationName:` line in core src. The reason is mandatory and
 *     surfaces in the report so reviewers can audit why an op is exempt
 *     (e.g. "destructive op, no safe round-trip", "wave-2, tracked in
 *     #NNN"). Example:
 *
 *       // e2e-exempt: destructive op, see #NNN
 *       const res = await impersonatedTransport({
 *         surface: "talent-profile",
 *         body: { operationName: "DeleteEverything", query, variables },
 *       });
 *
 *   - YAML-based per-package exemption files (`.e2e-exempt.yaml`) are
 *     scaffolded out of this v1 but the gate can be extended in a follow-
 *     up if broad exemption windows become necessary. Inline markers are
 *     preferred for auditability — they sit next to the call site they
 *     exempt.
 *
 * Modes:
 *
 *   - **warn** (default): always exits 0. Uncovered operations are
 *     reported to stderr for visibility. Suitable for the initial wave
 *     before all in-scope operations have been covered.
 *   - **strict** (`--strict` flag or `E2E_COVERAGE_STRICT=1` env): exits
 *     non-zero if any in-scope, non-exempt operation lacks a matching
 *     `// e2e-covers:` declaration. Flip to strict once the existing gap
 *     has been paid down (per AC #3 of #63).
 *
 * Output:
 *
 *   - stderr: per-op `surface  OperationName  file:line — <state>` lines
 *     for uncovered operations.
 *   - stdout: end-of-run summary `N called (in-scope), M covered,
 *     K exempt, G uncovered`.
 *
 * Exit codes:
 *
 *   0 — warn-mode (always) OR strict-mode with G = 0.
 *   1 — strict-mode with G > 0.
 *
 * Wired into the root `lint` script via `package.json` so PR CI runs it
 * on every push. Matches the sibling pattern of `check-secret-leakage.ts`.
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Surfaces the gate enforces. `mobile-gateway` is intentionally absent. */
const IN_SCOPE_SURFACES = new Set<string>(["talent-profile", "scheduler"]);

/** Path prefixes that contribute calling-source scans. */
const CORE_SRC_PREFIX = "packages/core/src/";

/** Path prefixes that contribute coverage declarations. */
const E2E_SRC_PREFIX = "packages/e2e/src/";

/** How far upward (in lines) to walk from `operationName:` to find `surface:`. */
const SURFACE_SEARCH_WINDOW = 30;

/** How far upward (in lines) to look for `// e2e-exempt:` from `operationName:`. */
const EXEMPT_SEARCH_WINDOW = 5;

interface CalledOp {
  /** Operation name from the `operationName: "X"` literal. */
  name: string;
  /** Surface from the nearest `surface: "..."` above. `null` if none found. */
  surface: string | null;
  /** Tracked path (POSIX) relative to repo root. */
  file: string;
  /** 1-indexed line number of the `operationName:` literal. */
  line: number;
  /** Reason from a nearby `// e2e-exempt:` marker, or `null` if not exempt. */
  exempt: string | null;
}

interface FileScanResult {
  ops: CalledOp[];
}

interface CoverageDeclaration {
  /** Operation names declared covered by this file. */
  names: Set<string>;
  /** Per-op originating file (for diagnostics). */
  origin: Map<string, string>;
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

function isCoreSrcCandidate(path: string): boolean {
  if (!path.startsWith(CORE_SRC_PREFIX)) return false;
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.includes("/__tests__/")) return false;
  return true;
}

function isE2eSrcCandidate(path: string): boolean {
  if (!path.startsWith(E2E_SRC_PREFIX)) return false;
  return path.endsWith(".e2e.test.ts");
}

function readSourceLines(absPath: string): string[] | null {
  try {
    const stat = statSync(absPath);
    if (stat.size > 4 * 1024 * 1024) return null; // 4 MiB guard
    return readFileSync(absPath, "utf8").split("\n");
  } catch {
    return null;
  }
}

/**
 * Mark each line with `inBlockComment = true` if it sits inside a
 * `/* ... *\/` span. Tracks the flag across lines so multi-line block
 * comments are entirely masked. Conservative: a line that contains BOTH
 * an opening `/*` AND a closing `*\/` is treated as code-after-comment
 * (the post-`*\/` portion may carry a real operationName literal).
 */
function maskBlockComments(lines: readonly string[]): boolean[] {
  const inComment: boolean[] = new Array<boolean>(lines.length).fill(false);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let scanFrom = 0;
    const lineStartsInComment = depth > 0;
    while (scanFrom < line.length) {
      if (depth === 0) {
        const open = line.indexOf("/*", scanFrom);
        if (open === -1) break;
        depth = 1;
        scanFrom = open + 2;
      } else {
        const close = line.indexOf("*/", scanFrom);
        if (close === -1) {
          scanFrom = line.length;
        } else {
          depth = 0;
          scanFrom = close + 2;
        }
      }
    }
    // If the line both started inside a comment AND ended inside one (or
    // never reached a `*/`), the whole line is comment. If it started in
    // code and entered a comment with no closing on the same line, the
    // partial-code portion is technically real — but `operationName: "X"`
    // literals never appear before a `/*` on the same line in this
    // codebase, so flag the whole line as comment for simplicity.
    const lineEndsInComment = depth > 0;
    inComment[i] = lineStartsInComment || lineEndsInComment;
    // Lines starting with `*` (JSDoc body) are always treated as comment.
    if (/^\s*\*/.test(line)) inComment[i] = true;
  }
  return inComment;
}

const OPERATION_NAME_RE = /\boperationName\s*:\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/;
const SURFACE_RE = /\bsurface\s*:\s*["']([a-z-]+)["']/;
const EXEMPT_RE = /^\s*\/\/\s*e2e-exempt:\s*(.+?)\s*$/;
const COVERS_RE = /^\s*\/\/\s*e2e-covers:\s*(.+?)\s*$/;

function scanCoreSrc(absPath: string, relPath: string): FileScanResult {
  const lines = readSourceLines(absPath);
  if (lines === null) return { ops: [] };
  const inComment = maskBlockComments(lines);
  const ops: CalledOp[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (inComment[i]) continue;
    const line = lines[i] ?? "";
    // Strip trailing line-comments so an `operationName:` literal in a
    // `// like this` comment is not picked up.
    const codePortion = stripLineComment(line);
    const opMatch = OPERATION_NAME_RE.exec(codePortion);
    if (opMatch === null) continue;
    const opName = opMatch[1];
    if (opName === undefined) continue;

    // Walk back for the nearest `surface: "..."` literal in non-comment code.
    let surface: string | null = null;
    const surfaceLow = Math.max(0, i - SURFACE_SEARCH_WINDOW);
    for (let j = i; j >= surfaceLow; j--) {
      if (inComment[j]) continue;
      const above = stripLineComment(lines[j] ?? "");
      const sm = SURFACE_RE.exec(above);
      if (sm !== null) {
        surface = sm[1] ?? null;
        break;
      }
    }

    // Walk back for an `// e2e-exempt:` marker within the tighter window.
    let exempt: string | null = null;
    const exemptLow = Math.max(0, i - EXEMPT_SEARCH_WINDOW);
    for (let j = i - 1; j >= exemptLow; j--) {
      const em = EXEMPT_RE.exec(lines[j] ?? "");
      if (em !== null) {
        exempt = em[1] ?? null;
        break;
      }
    }

    ops.push({ name: opName, surface, file: relPath, line: i + 1, exempt });
  }

  return { ops };
}

function stripLineComment(line: string): string {
  // Be conservative: do not strip `//` that sits inside a quoted string.
  // The transport-call lines never have `//` inside their literals in
  // this codebase, so a quote-aware parser is unnecessary; bail on the
  // first `//` not preceded by `:` (URL scheme) or `\`.
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  while (i < line.length - 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (!inSingle && !inDouble && !inTemplate && ch === "/" && next === "/") {
      return line.slice(0, i);
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`") inTemplate = !inTemplate;
    i += 1;
  }
  return line;
}

function scanE2eCoverage(absPath: string, relPath: string): CoverageDeclaration {
  const lines = readSourceLines(absPath);
  const decl: CoverageDeclaration = { names: new Set<string>(), origin: new Map<string, string>() };
  if (lines === null) return decl;
  for (const line of lines) {
    const m = COVERS_RE.exec(line);
    if (m === null) continue;
    const raw = m[1];
    if (raw === undefined) continue;
    for (const piece of raw.split(",")) {
      const name = piece.trim().replace(/[,;.]+$/, "");
      if (name.length === 0) continue;
      // Operation names follow the GraphQL identifier shape: letter/underscore,
      // then letters/digits/underscores. Anything else is a typo.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        process.stderr.write(`${relPath}: warn: skipping malformed e2e-covers token ${JSON.stringify(name)}\n`);
        continue;
      }
      decl.names.add(name);
      if (!decl.origin.has(name)) decl.origin.set(name, relPath);
    }
  }
  return decl;
}

interface RunReport {
  /** All in-scope (talent-profile/scheduler) operation invocations, deduped on (name, surface). */
  inScope: CalledOp[];
  /** Out-of-scope (e.g. mobile-gateway) invocations, deduped. Reported as a tail summary. */
  outOfScope: CalledOp[];
  /** Operations covered by some `// e2e-covers:` marker. */
  coveredNames: Set<string>;
  /** `// e2e-covers:` declarations grouped by origin file. */
  coverageDecls: CoverageDeclaration;
  /** `// e2e-covers:` markers that did not match any in-scope or out-of-scope call. */
  unmatchedCoverage: { name: string; file: string }[];
}

function buildReport(calledOps: CalledOp[], coverageDecls: CoverageDeclaration): RunReport {
  // Group by (surface, op). Multiple call sites for the same op are common
  // (e.g. `UPDATE_BASIC_INFO` in `profile/basic/index.ts` is invoked twice).
  // The first call site wins for file:line attribution (so the report points
  // at the canonical site), but exempt status is AGGREGATED across all call
  // sites — if ANY site carries `// e2e-exempt:`, the op is exempt. This
  // matches the developer intent of "I don't want this op tested, period"
  // and avoids the footgun of "marker placed on site 2 silently ignored".
  const grouped = new Map<string, CalledOp>();
  for (const op of calledOps) {
    const key = `${op.surface ?? "unknown"}:${op.name}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, op);
    } else if (existing.exempt === null && op.exempt !== null) {
      // Upgrade the entry to carry the exempt reason from a later call site,
      // preserving the canonical (first-seen) file:line for navigation.
      grouped.set(key, { ...existing, exempt: op.exempt });
    }
  }

  const inScope: CalledOp[] = [];
  const outOfScope: CalledOp[] = [];
  for (const op of grouped.values()) {
    if (op.surface !== null && IN_SCOPE_SURFACES.has(op.surface)) {
      inScope.push(op);
    } else {
      outOfScope.push(op);
    }
  }

  inScope.sort((a, b) => (a.surface ?? "").localeCompare(b.surface ?? "") || a.name.localeCompare(b.name));
  outOfScope.sort((a, b) => (a.surface ?? "").localeCompare(b.surface ?? "") || a.name.localeCompare(b.name));

  const allCalledNames = new Set<string>();
  for (const op of inScope) allCalledNames.add(op.name);
  for (const op of outOfScope) allCalledNames.add(op.name);
  const unmatchedCoverage: { name: string; file: string }[] = [];
  for (const name of coverageDecls.names) {
    if (!allCalledNames.has(name)) {
      unmatchedCoverage.push({ name, file: coverageDecls.origin.get(name) ?? "?" });
    }
  }
  unmatchedCoverage.sort((a, b) => a.name.localeCompare(b.name));

  return {
    inScope,
    outOfScope,
    coveredNames: coverageDecls.names,
    coverageDecls,
    unmatchedCoverage,
  };
}

function formatReport(
  report: RunReport,
  strict: boolean,
): { uncoveredCount: number; outputLines: string[]; stderrLines: string[] } {
  const out: string[] = [];
  const err: string[] = [];

  let coveredCount = 0;
  let exemptCount = 0;
  let uncoveredCount = 0;

  for (const op of report.inScope) {
    const surface = op.surface ?? "<unknown>";
    if (op.exempt !== null) {
      exemptCount += 1;
      out.push(`  EXEMPT    ${surface.padEnd(15)} ${op.name.padEnd(40)} ${op.file}:${String(op.line)}  — ${op.exempt}`);
      continue;
    }
    if (report.coveredNames.has(op.name)) {
      coveredCount += 1;
      const cov = report.coverageDecls.origin.get(op.name);
      out.push(
        `  COVERED   ${surface.padEnd(15)} ${op.name.padEnd(40)} ${op.file}:${String(op.line)}  ← ${cov ?? "?"}`,
      );
      continue;
    }
    uncoveredCount += 1;
    err.push(`UNCOVERED  ${surface.padEnd(15)} ${op.name.padEnd(40)} ${op.file}:${String(op.line)}`);
  }

  const summary =
    `E2E coverage gate — surfaces ${[...IN_SCOPE_SURFACES].join(", ")}\n` +
    `  ${String(report.inScope.length)} in-scope operation(s) called, ` +
    `${String(coveredCount)} covered, ` +
    `${String(exemptCount)} exempt, ` +
    `${String(uncoveredCount)} uncovered.\n` +
    `  ${String(report.outOfScope.length)} out-of-scope operation(s) (e.g. mobile-gateway) — not gated.\n`;

  out.unshift(summary);

  if (uncoveredCount > 0) {
    err.unshift(
      `\nE2E coverage gate — ${String(uncoveredCount)} uncovered in-scope operation(s).\n` +
        `Each line below is an operationName invoked against talent-profile or scheduler\n` +
        `from packages/core/src/ with no matching \`// e2e-covers: <name>\` directive in\n` +
        `packages/e2e/src/**/*.e2e.test.ts and no \`// e2e-exempt: <reason>\` marker.\n` +
        `Add coverage, or exempt with a justified marker. See scripts/check-e2e-coverage.ts\n` +
        `header for the exemption protocol.\n`,
    );
    if (!strict) {
      err.push(
        `\nNote: gate is in WARN mode. Exit code 0. Set E2E_COVERAGE_STRICT=1 (or pass\n` +
          `--strict) to fail on uncovered operations once the existing gap is paid down.\n`,
      );
    }
  }

  if (report.unmatchedCoverage.length > 0) {
    err.push(
      `\nWarning: ${String(report.unmatchedCoverage.length)} \`// e2e-covers:\` entries do not match any called operation:`,
    );
    for (const { name, file } of report.unmatchedCoverage) {
      err.push(`  ${name}  (declared in ${file})`);
    }
    err.push(
      `  These are either typos, renamed operations, or coverage declarations for ops only invoked via helper functions (not yet detected by this v1 gate — see script header).\n`,
    );
  }

  return { uncoveredCount, outputLines: out, stderrLines: err };
}

function main(): void {
  const repoRoot = process.cwd();
  const args = new Set(process.argv.slice(2));
  const strict = args.has("--strict") || process.env["E2E_COVERAGE_STRICT"] === "1";

  const tracked = listTrackedFiles(repoRoot);

  const calledOps: CalledOp[] = [];
  const coverageDecls: CoverageDeclaration = { names: new Set<string>(), origin: new Map<string, string>() };

  for (const relPath of tracked) {
    if (isCoreSrcCandidate(relPath)) {
      const abs = join(repoRoot, relPath);
      const { ops } = scanCoreSrc(abs, relPath);
      calledOps.push(...ops);
    } else if (isE2eSrcCandidate(relPath)) {
      const abs = join(repoRoot, relPath);
      const fileDecl = scanE2eCoverage(abs, relPath);
      for (const name of fileDecl.names) {
        coverageDecls.names.add(name);
        if (!coverageDecls.origin.has(name)) {
          const origin = fileDecl.origin.get(name);
          if (origin !== undefined) coverageDecls.origin.set(name, origin);
        }
      }
    }
  }

  const report = buildReport(calledOps, coverageDecls);
  const { uncoveredCount, outputLines, stderrLines } = formatReport(report, strict);

  for (const line of outputLines) process.stdout.write(`${line}\n`);
  for (const line of stderrLines) process.stderr.write(`${line}\n`);

  if (strict && uncoveredCount > 0) {
    process.exit(1);
  }
  // Default warn-mode: always exit 0.
}

main();
