#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Surface coverage gate for `@ttctl/core` service exports (issue #349).
 *
 * Structural defense against the **Class A gap pattern** described in
 * `CLAUDE.md` § Surface coverage gate: a service function is exported from
 * `packages/core/src/services/**\/index.ts` but is registered as NEITHER a
 * CLI command (`packages/cli/src/commands/**`) NOR an MCP tool
 * (`packages/mcp/src/tools/**`). When both surfaces omit symmetrically,
 * the CLI/MCP parity test (#151) stays green — the gap is invisible until
 * an agent or developer notices the capability is missing.
 *
 * Sibling of `check-e2e-coverage.ts`; same structure, same CLI ergonomics,
 * same warn/strict gating discipline.
 *
 * Detection scope:
 *
 *   - Walks `packages/core/src/services/<domain>/**\/index.ts` for the
 *     five covered domains: `profile`, `engagements`, `payments`,
 *     `timesheet`, `scheduler` (the last currently absent — silently
 *     skipped).
 *   - Two export shapes are recognized:
 *     1. Top-level `export async function <name>(...)` declarations.
 *     2. Sub-namespace exports: `export const <ns> = { async <name>(...) }`
 *        blocks (the `payouts` / `methods` / `rate` / `breaks` pattern).
 *   - Exports whose names start with `_` are treated as internal and
 *     skipped (convention; e.g. `_setMultipartFetchForTesting`). The
 *     leading-underscore convention exists alongside the explicit
 *     `// surface-exempt:` marker for cases where a renaming would be
 *     disruptive.
 *
 * Surface match mechanism (invocation-based, not name-based):
 *
 *   - For each service export, the script constructs the canonical call
 *     pattern (e.g. `profile.basic.show(`, `payments.payouts.list(`,
 *     `timesheet.list(`) and searches each tracked file under
 *     `packages/cli/src/commands/**` and `packages/mcp/src/tools/**`
 *     (excluding tests) for that literal string. A match in either tree
 *     counts as coverage in that surface.
 *   - Comment text (`/* ... *\/` block comments, JSDoc bodies starting
 *     with `*`, line-comment tails after `//`) is masked before matching
 *     so docstring references like `{@link timesheet.resolveCurrentCycle}`
 *     do not register as coverage.
 *   - Invocation-based detection is robust to MCP/CLI renaming (e.g.
 *     `basic.set()` service → `ttctl_profile_basic_update` MCP tool):
 *     the underlying call site still reads `profile.basic.set(`, so the
 *     mapping is captured automatically without an alias table.
 *   - The trade-off: a service export that is called only as an internal
 *     helper from another handler (e.g. `basic.getBasicInfo` called from
 *     `basic/show.ts`) registers as covered on whichever surface the
 *     caller lives in. That is intentional — invocation IS the user-
 *     facing exposure path. Internal-only helpers should carry an
 *     explicit `// surface-exempt:` marker so the disposition is
 *     auditable.
 *
 * Exemption mechanism:
 *
 *   - Per-export `// surface-exempt: <reason>` comment on the line
 *     directly above the `export async function ...` declaration or the
 *     `export const <ns> = {` namespace header. The reason is mandatory
 *     and surfaces in the report.
 *   - A marker placed on a namespace header (`export const breaks = {`)
 *     applies to every method inside; per-method markers override the
 *     namespace marker for that specific method.
 *   - Example:
 *
 *       // surface-exempt: internal helper for `submit.ts` cycle resolution; see #348
 *       export async function resolveCurrentCycle(
 *         token: string,
 *         opts: ResolveCurrentCycleOptions = {},
 *       ): Promise<CurrentCycleResolution> { ... }
 *
 * Modes:
 *
 *   - **warn** (default): always exits 0. Class A gaps (`NEITHER`
 *     disposition) are reported to stderr for visibility. Class C gaps
 *     (`CLI-ONLY` / `MCP-ONLY` — the parity-test domain) are reported as
 *     informational rows in the stdout table but never as warnings — that
 *     framing belongs to `check-surface-coverage`'s sibling parity gate
 *     (#151).
 *   - **strict** (`--strict` flag or `SURFACE_COVERAGE_STRICT=1` env):
 *     exits non-zero iff any non-exempt service export has `NEITHER`
 *     disposition. Flip to strict once the existing Class A gap window
 *     (#341, #342, #343, etc.) has been paid down.
 *
 * Output:
 *
 *   - stdout: header summary + per-export `disposition  canonical-ref
 *     file:line` table, sorted with NEITHER first.
 *   - stderr: Class A gap details when present (and the warn-mode
 *     reminder when not strict).
 *
 * Exit codes:
 *
 *   0 — warn-mode (always) OR strict-mode with no Class A gaps.
 *   1 — strict-mode with one or more Class A gaps.
 *
 * Wired into the root `lint` script via `package.json` so CI runs it on
 * every push. Matches the sibling pattern of `check-e2e-coverage.ts` and
 * `check-secret-leakage.ts`.
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Domains under coverage. Service files under
 * `packages/core/src/services/<domain>/**` are walked; files under any
 * other domain (`auth`, `availability`, `jobs`, `applications`,
 * `contracts`, etc.) are NOT walked. The list mirrors the issue #349
 * scope; expand here as new service domains land.
 */
const COVERED_DOMAINS = ["profile", "engagements", "payments", "timesheet", "scheduler"] as const;
type CoveredDomain = (typeof COVERED_DOMAINS)[number];
const COVERED_DOMAIN_SET = new Set<string>(COVERED_DOMAINS);

const CORE_SERVICES_PREFIX = "packages/core/src/services/";
const CLI_SRC_PREFIX = "packages/cli/src/commands/";
const MCP_SRC_PREFIX = "packages/mcp/src/tools/";

/** How far above an export declaration to look for `// surface-exempt:`. */
const EXEMPT_SEARCH_WINDOW = 1;

const EXEMPT_RE = /^\s*\/\/\s*surface-exempt:\s*(.+?)\s*$/;
const TOP_FN_RE = /^export\s+async\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const TOP_CONST_RE = /^export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/;
const NS_METHOD_RE = /^\s{2,}async\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

interface ServiceExport {
  /** Top-level domain (`profile`, `engagements`, ...). */
  domain: CoveredDomain;
  /** Optional sub-folder one level beneath the domain (e.g. `basic`, `portfolio`). */
  sub: string | null;
  /** Optional sub-namespace via `export const <ns> = { ... }`. */
  ns: string | null;
  /** Exported symbol name (camelCase as it appears in source). */
  name: string;
  /** Tracked path of the declaring file (POSIX, relative to repo root). */
  file: string;
  /** 1-indexed line of the declaration. */
  line: number;
  /** Reason from `// surface-exempt:`, or null. */
  exempt: string | null;
}

interface CoverageStatus {
  cli: boolean;
  mcp: boolean;
  /** First CLI file where the call pattern was found, for navigation. */
  cliFile: string | null;
  /** First MCP file where the call pattern was found, for navigation. */
  mcpFile: string | null;
}

type Disposition = "BOTH" | "CLI-ONLY" | "MCP-ONLY" | "NEITHER" | "EXEMPT";

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

/**
 * Classify a tracked path as a service `index.ts` under a covered domain.
 * Returns the parsed `(domain, sub?)` shape, or `null` if not in scope.
 *
 * Accepts: `<prefix><domain>/index.ts` and `<prefix><domain>/<sub>/index.ts`.
 * Rejects deeper nesting (the current codebase has no three-level service
 * trees; if one lands later, this function should be extended).
 */
function classifyServiceIndex(path: string): { domain: CoveredDomain; sub: string | null } | null {
  if (!path.startsWith(CORE_SERVICES_PREFIX)) return null;
  if (!path.endsWith("/index.ts")) return null;
  if (path.includes("/__tests__/")) return null;
  if (path.endsWith(".test.ts")) return null;

  const rel = path.slice(CORE_SERVICES_PREFIX.length, -"/index.ts".length);
  const parts = rel.split("/");
  const domain = parts[0];
  if (domain === undefined) return null;
  if (!COVERED_DOMAIN_SET.has(domain)) return null;

  if (parts.length === 1) {
    return { domain: domain as CoveredDomain, sub: null };
  }
  if (parts.length === 2) {
    const sub = parts[1];
    if (sub === undefined) return null;
    return { domain: domain as CoveredDomain, sub };
  }
  return null;
}

function isCliSurface(path: string): boolean {
  if (!path.startsWith(CLI_SRC_PREFIX)) return false;
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.includes("/__tests__/")) return false;
  return true;
}

function isMcpSurface(path: string): boolean {
  if (!path.startsWith(MCP_SRC_PREFIX)) return false;
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.includes("/__tests__/")) return false;
  return true;
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
 * `/* ... *\/` span OR is a JSDoc body line (`^\s*\*`). Tracks the flag
 * across lines so multi-line comments are entirely masked.
 *
 * Conservative on mixed-content lines: a line that contains BOTH an
 * opening `/*` and a closing `*\/` is flagged as comment for simplicity.
 * `operationName: "X"` / call-site literals never co-occur with `/*` on
 * the same line in this codebase.
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
    const lineEndsInComment = depth > 0;
    inComment[i] = lineStartsInComment || lineEndsInComment;
    if (/^\s*\*/.test(line)) inComment[i] = true;
  }
  return inComment;
}

/**
 * Strip the trailing `//` line-comment from a line, respecting quoted
 * string regions so a `//` inside `"..."` / `'...'` / `\`...\`` is not
 * treated as a comment opener.
 *
 * Lifted from `check-e2e-coverage.ts`; same trade-offs apply.
 */
function stripLineComment(line: string): string {
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

/**
 * Find the nearest `// surface-exempt: <reason>` marker within the
 * tight {@link EXEMPT_SEARCH_WINDOW} above `lineIndex`. The marker
 * must be on the line IMMEDIATELY ABOVE the export declaration —
 * a wider window would let a stray marker attach to the wrong export.
 *
 * Returns the trimmed reason string, or `null` if none found.
 */
function findExemptMarker(lines: readonly string[], lineIndex: number): string | null {
  const low = Math.max(0, lineIndex - EXEMPT_SEARCH_WINDOW);
  for (let j = lineIndex - 1; j >= low; j--) {
    const m = EXEMPT_RE.exec(lines[j] ?? "");
    if (m !== null) return m[1] ?? null;
  }
  return null;
}

/**
 * Parse one service `index.ts` for exported operation declarations.
 *
 * Recognizes:
 *   - `export async function <name>(...)` — single function export.
 *   - `export const <ns> = { async <name>(...) ... }` — namespace export
 *     with one or more async methods. Brace-tracking determines the
 *     end of the namespace block.
 *
 * Skips exports whose names start with `_` (internal convention).
 *
 * Returns a flat list of {@link ServiceExport} rows. Block-comment and
 * JSDoc lines are masked before pattern matching.
 */
function parseServiceExports(
  lines: readonly string[],
  relPath: string,
  domain: CoveredDomain,
  sub: string | null,
): ServiceExport[] {
  const out: ServiceExport[] = [];
  const inComment = maskBlockComments(lines);

  for (let i = 0; i < lines.length; i++) {
    if (inComment[i]) continue;
    const line = stripLineComment(lines[i] ?? "");

    const fnMatch = TOP_FN_RE.exec(line);
    if (fnMatch !== null) {
      const name = fnMatch[1];
      if (name === undefined) continue;
      if (name.startsWith("_")) continue;
      out.push({
        domain,
        sub,
        ns: null,
        name,
        file: relPath,
        line: i + 1,
        exempt: findExemptMarker(lines, i),
      });
      continue;
    }

    const constMatch = TOP_CONST_RE.exec(line);
    if (constMatch !== null) {
      const ns = constMatch[1];
      if (ns === undefined) continue;
      if (ns.startsWith("_")) continue;
      const nsExempt = findExemptMarker(lines, i);
      const endLine = findMatchingBraceLine(lines, inComment, i);
      // Scan ONLY the body lines (i + 1 .. endLine) for `async <name>(`.
      // The opening line itself can contain `= {` plus the start of the
      // first method on the same line; uncommon in this codebase but
      // tolerated by starting the walk at `i + 1`.
      for (let j = i + 1; j < endLine && j < lines.length; j++) {
        if (inComment[j]) continue;
        const inner = stripLineComment(lines[j] ?? "");
        const mm = NS_METHOD_RE.exec(inner);
        if (mm !== null) {
          const methodName = mm[1];
          if (methodName === undefined) continue;
          if (methodName.startsWith("_")) continue;
          const methodExempt = findExemptMarker(lines, j) ?? nsExempt;
          out.push({
            domain,
            sub,
            ns,
            name: methodName,
            file: relPath,
            line: j + 1,
            exempt: methodExempt,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Given a line index whose code contains an opening `{` (i.e. the
 * `export const <ns> = {` header), walk forward tracking brace depth
 * and return the 0-indexed line containing the matching closing `}`.
 *
 * Block-comment-masked lines contribute zero depth changes (their
 * braces are inside comments).
 *
 * Returns `lines.length` if no matching `}` is found — the parser
 * gracefully degrades into "scan to EOF" rather than aborting.
 */
function findMatchingBraceLine(lines: readonly string[], inComment: readonly boolean[], startLine: number): number {
  let depth = 0;
  let started = false;
  for (let j = startLine; j < lines.length; j++) {
    if (inComment[j]) continue;
    const code = stripLineComment(lines[j] ?? "");
    // Walk char-by-char to handle `}{` on the same line.
    for (let k = 0; k < code.length; k++) {
      const ch = code[k];
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (started && depth === 0) return j;
  }
  return lines.length;
}

/**
 * The literal call pattern that a surface file must contain to be
 * considered a coverage hit for `exp`. Construction:
 *
 *   `<domain>.[<sub>.][<ns>.]<name>(`
 *
 * Example:
 *
 *   - top-level fn: `timesheet.list(`
 *   - sub-folder:   `profile.basic.show(`
 *   - namespace:    `payments.payouts.list(`
 *   - both:         (not present in current codebase but tolerated:
 *                    `profile.basic.payouts.list(`)
 *
 * The `(` suffix prevents false positives from prefix matches
 * (`payouts.listAll` would not match `payouts.list(`).
 */
function callPattern(exp: ServiceExport): string {
  const parts: string[] = [exp.domain];
  if (exp.sub !== null) parts.push(exp.sub);
  if (exp.ns !== null) parts.push(exp.ns);
  parts.push(exp.name);
  return `${parts.join(".")}(`;
}

/**
 * For diagnostic output: dotted reference for an export. Matches
 * {@link callPattern} without the trailing `(`.
 */
function canonicalRef(exp: ServiceExport): string {
  const parts: string[] = [exp.domain];
  if (exp.sub !== null) parts.push(exp.sub);
  if (exp.ns !== null) parts.push(exp.ns);
  parts.push(exp.name);
  return parts.join(".");
}

/**
 * Read each pre-filtered surface file once and, per file, check every
 * call-pattern key against the file's de-commented text. Returns a Map
 * of pattern → first matching file path. Patterns absent from the
 * returned map are uncovered by this surface.
 *
 * Comment masking: read raw text, run {@link maskBlockComments}
 * line-by-line, strip line-comments with {@link stripLineComment}, then
 * join surviving code with `\n` before substring matching. JSDoc
 * references like `{@link foo.bar.baz}` are stripped along with the
 * block comments that contain them.
 */
function scanSurface(
  files: readonly string[],
  repoRoot: string,
  patterns: ReadonlyMap<string, ServiceExport>,
): Map<string, string> {
  const hits = new Map<string, string>();
  for (const path of files) {
    const abs = join(repoRoot, path);
    const lines = readSourceLines(abs);
    if (lines === null) continue;
    const inComment = maskBlockComments(lines);
    const codeOnly: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (inComment[i]) {
        codeOnly.push("");
        continue;
      }
      codeOnly.push(stripLineComment(lines[i] ?? ""));
    }
    const haystack = codeOnly.join("\n");
    for (const [pattern] of patterns) {
      if (hits.has(pattern)) continue;
      if (haystack.includes(pattern)) {
        hits.set(pattern, path);
      }
    }
  }
  return hits;
}

function classifyDisposition(exp: ServiceExport, status: CoverageStatus): Disposition {
  if (exp.exempt !== null) return "EXEMPT";
  if (status.cli && status.mcp) return "BOTH";
  if (status.cli) return "CLI-ONLY";
  if (status.mcp) return "MCP-ONLY";
  return "NEITHER";
}

interface RenderInputs {
  exports: readonly ServiceExport[];
  coverage: ReadonlyMap<ServiceExport, CoverageStatus>;
  strict: boolean;
}

interface RenderOutputs {
  stdoutLines: string[];
  stderrLines: string[];
  classAGapCount: number;
}

const DISPOSITION_ORDER: Record<Disposition, number> = {
  NEITHER: 0,
  "CLI-ONLY": 1,
  "MCP-ONLY": 2,
  BOTH: 3,
  EXEMPT: 4,
};

function render({ exports, coverage, strict }: RenderInputs): RenderOutputs {
  const stdout: string[] = [];
  const stderr: string[] = [];

  let bothCount = 0;
  let cliOnlyCount = 0;
  let mcpOnlyCount = 0;
  let neitherCount = 0;
  let exemptCount = 0;

  const annotated: { exp: ServiceExport; status: CoverageStatus; disposition: Disposition }[] = [];
  for (const exp of exports) {
    const status = coverage.get(exp) ?? { cli: false, mcp: false, cliFile: null, mcpFile: null };
    const disposition = classifyDisposition(exp, status);
    annotated.push({ exp, status, disposition });
    switch (disposition) {
      case "BOTH":
        bothCount += 1;
        break;
      case "CLI-ONLY":
        cliOnlyCount += 1;
        break;
      case "MCP-ONLY":
        mcpOnlyCount += 1;
        break;
      case "NEITHER":
        neitherCount += 1;
        break;
      case "EXEMPT":
        exemptCount += 1;
        break;
    }
  }

  annotated.sort((a, b) => {
    const oa = DISPOSITION_ORDER[a.disposition];
    const ob = DISPOSITION_ORDER[b.disposition];
    if (oa !== ob) return oa - ob;
    return canonicalRef(a.exp).localeCompare(canonicalRef(b.exp));
  });

  stdout.push(`Surface coverage gate — domains ${COVERED_DOMAINS.join(", ")}`);
  stdout.push(
    `  ${String(exports.length)} service operation(s), ` +
      `${String(bothCount)} on both surfaces, ` +
      `${String(cliOnlyCount)} CLI only, ` +
      `${String(mcpOnlyCount)} MCP only, ` +
      `${String(neitherCount)} on neither (Class A), ` +
      `${String(exemptCount)} exempt.`,
  );
  stdout.push("");

  for (const { exp, disposition } of annotated) {
    const ref = canonicalRef(exp);
    const suffix = disposition === "EXEMPT" && exp.exempt !== null ? `  — ${exp.exempt}` : "";
    stdout.push(`  ${disposition.padEnd(9)} ${ref.padEnd(56)} ${exp.file}:${String(exp.line)}${suffix}`);
  }

  if (neitherCount > 0) {
    stderr.push(`\nSurface coverage gate — ${String(neitherCount)} Class A gap(s) detected.`);
    stderr.push(`Each row below is a service operation exported from packages/core/src/services/**`);
    stderr.push(`that is invoked from NEITHER the CLI surface nor the MCP surface. The capability`);
    stderr.push(`ships in the core library but no user-facing surface exposes it. Add a CLI`);
    stderr.push(`command (\`packages/cli/src/commands/**\`) or MCP tool`);
    stderr.push(`(\`packages/mcp/src/tools/**\`), or mark internal-only with`);
    stderr.push(`\`// surface-exempt: <reason>\` directly above the \`export\`.`);
    stderr.push("");
    for (const { exp, disposition } of annotated) {
      if (disposition !== "NEITHER") continue;
      stderr.push(`  NEITHER    ${canonicalRef(exp).padEnd(56)} ${exp.file}:${String(exp.line)}`);
    }
    if (!strict) {
      stderr.push("");
      stderr.push(`Note: gate is in WARN mode. Exit code 0. Set SURFACE_COVERAGE_STRICT=1 (or`);
      stderr.push(`pass --strict) to fail on Class A gaps once the existing gap is paid down.`);
    }
  }

  return { stdoutLines: stdout, stderrLines: stderr, classAGapCount: neitherCount };
}

function main(): void {
  const repoRoot = process.cwd();
  const args = new Set(process.argv.slice(2));
  const strict = args.has("--strict") || process.env["SURFACE_COVERAGE_STRICT"] === "1";

  const tracked = listTrackedFiles(repoRoot);

  const exports: ServiceExport[] = [];
  const cliFiles: string[] = [];
  const mcpFiles: string[] = [];

  for (const relPath of tracked) {
    const svc = classifyServiceIndex(relPath);
    if (svc !== null) {
      const lines = readSourceLines(join(repoRoot, relPath));
      if (lines !== null) {
        exports.push(...parseServiceExports(lines, relPath, svc.domain, svc.sub));
      }
      continue;
    }
    if (isCliSurface(relPath)) {
      cliFiles.push(relPath);
      continue;
    }
    if (isMcpSurface(relPath)) {
      mcpFiles.push(relPath);
    }
  }

  // Dedupe call patterns (collisions can happen if two exports share a
  // path — they should not, but the map is keyed by pattern for a reason).
  const patterns = new Map<string, ServiceExport>();
  for (const exp of exports) {
    const pat = callPattern(exp);
    if (!patterns.has(pat)) patterns.set(pat, exp);
  }

  const cliHits = scanSurface(cliFiles, repoRoot, patterns);
  const mcpHits = scanSurface(mcpFiles, repoRoot, patterns);

  const coverage = new Map<ServiceExport, CoverageStatus>();
  for (const exp of exports) {
    const pat = callPattern(exp);
    const cliFile = cliHits.get(pat) ?? null;
    const mcpFile = mcpHits.get(pat) ?? null;
    coverage.set(exp, {
      cli: cliFile !== null,
      mcp: mcpFile !== null,
      cliFile,
      mcpFile,
    });
  }

  const { stdoutLines, stderrLines, classAGapCount } = render({ exports, coverage, strict });

  for (const line of stdoutLines) process.stdout.write(`${line}\n`);
  for (const line of stderrLines) process.stderr.write(`${line}\n`);

  if (strict && classAGapCount > 0) {
    process.exit(1);
  }
}

main();
