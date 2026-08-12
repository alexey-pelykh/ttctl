#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Wire-routing manifest gate (issue #887).
 *
 * Structural defense for the maintenance rule CLAUDE.md § Track 1 vs Track 2
 * disposition states outright: "The manifest must be updated in the same PR as
 * any new op invocation." The manifest is `docs/wire-validation-routing.md`,
 * the authoritative per-op `T1` / `T2` / `NEITHER` disposition. Until now the
 * rule was carried by author memory and PR review alone — and had already been
 * broken: `AddProfileIndustryConnections`, `GetPerformedActions`, `GetViewer`,
 * `JobsByIDs`, `UpdateTimesheet` and `GET_REPORTING_TO_AUTOCOMPLETE` were each
 * invoked with no row anywhere.
 *
 * The invariant, one direction only: every operation invoked from
 * `packages/core/src/**` has a manifest row. The gate asserts PRESENCE — see
 * the granularity note below for what that does and does not mean.
 *
 * Op extraction is IMPORTED, not re-implemented. `check-e2e-coverage.ts` owns
 * the scan — the `operationName: "X"` sweep plus the `HELPER_SIGNATURES`
 * allowlist that resolves helper-wrapped invocations passing the name
 * positionally (`callTalentProfile(token, "X", ...)`), which a naive literal
 * scan misses entirely. `check-merge-completeness.ts` used to mirror that
 * allowlist by hand under a documented sync protocol; a third hand-mirrored
 * copy would recreate exactly the enumeration-agreement problem this gate
 * family exists to prevent, so this gate imports instead — and the same change
 * switched that script to deriving its allowlist from the shared map, retiring
 * the manual protocol. Importing is side-effect-free: that module's `main()`
 * sits behind its own `invokedDirectly()` guard.
 *
 * Detection scope:
 *
 *   - Invoked ops: every tracked file under `packages/core/src/**` that
 *     `isCoreSrcCandidate` accepts (excludes `__tests__/`, `*.test.ts`,
 *     `*.d.ts`), scanned via `scanCoreSrcLines`. All three surfaces count —
 *     unlike the e2e-coverage gate, which gates only the Cloudflare-protected
 *     ones, the manifest covers `mobile-gateway` too.
 *   - Manifest rows: the per-surface sections of `docs/wire-validation-routing.md`
 *     (`## \`<surface>\` (N ops)`), whose tables carry one row per op. A row's
 *     track cell must carry a canonical token — `T1`, `T2`, or `NEITHER`, with
 *     an optional parenthetical wiring-state qualifier the manifest uses
 *     (`T2 (wired)` / `T2 (ready)`).
 *
 * Granularity: presence, not correctness. The gate asserts that an invoked op
 * HAS a row; it does not re-derive that row's track from codegen state. The
 * derivation (`T2` iff codegen produced a `<OpName>(Query|Mutation|Subscription)`
 * type, `T1` otherwise) stays a review-time judgement, so a row asserting the
 * wrong track passes. Nor is a row required to sit in the section matching its
 * call site's surface. Both are deliberate: this issue scoped the gate to the
 * rule CLAUDE.md actually states, and re-deriving tracks here would duplicate
 * the codegen-exclusion logic that already lives on the research side.
 *
 * Stale rows — a manifest row naming an op no longer invoked anywhere — are the
 * inverse drift. They are REPORTED but never fail the gate: the rule this gate
 * enforces is one-directional, and a row outliving its call site is a
 * documentation question (was the op removed, or renamed?) rather than the
 * silent-omission failure the gate exists to catch. Visible, never silently
 * dropped — same posture as `check-readme-verbs.ts` unchecked claims.
 *
 * Exemption mechanism:
 *
 *   - `// wire-routing-exempt: <reason>` within five lines preceding the
 *     invocation in core src — the call site it exempts, mirroring
 *     `// e2e-exempt:` and `// surface-exempt:`. The reason is mandatory and
 *     surfaces in the report.
 *
 *     A marker with an EMPTY reason exempts NOTHING and is reported as a marker
 *     issue. Silently honouring it would suppress a real missing row and report
 *     only the comment syntax.
 *
 * Modes:
 *
 *   - **warn** (default): always exits 0. Findings reported to stderr.
 *   - **strict** (`--strict` or `WIRE_ROUTING_STRICT=1`): exits non-zero on
 *     missing rows, structural errors, or marker issues. The package.json
 *     wiring passes `--strict` from day one: the drifted ops listed above are
 *     dispositioned in the same PR that adds this gate, so the baseline is
 *     clean and there is no warn-phase gap to pay down. Same posture as
 *     `check-readme-verbs.ts` and `check-mcp-tool-catalog.ts`.
 *
 * Exit codes:
 *
 *   0 — warn-mode (always) OR strict-mode with no findings.
 *   1 — strict-mode with at least one finding.
 */

import { execSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isCoreSrcCandidate, scanCoreSrcLines, type CalledOp } from "./check-e2e-coverage.js";

// ─── Configuration ──────────────────────────────────────────────────

const MANIFEST_FILE = "docs/wire-validation-routing.md";

/** `## \`mobile-gateway\` (57 ops)` — opens a per-surface row table. */
const SURFACE_HEADING = /^##\s+`([a-z-]+)`\s+\(\d+\s+ops?\)\s*$/;

/** `| AddSurveyFeedback | T1 | ... |` — first cell is the op, second the track. */
const MANIFEST_ROW = /^\|\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\|\s*([^|]*?)\s*\|/;

/**
 * The canonical disposition enum from CLAUDE.md. The manifest annotates `T2`
 * with a wiring-state parenthetical (`T2 (wired)` / `T2 (ready)`), so validate
 * the base token and let the qualifier through rather than freezing today's
 * two qualifiers into the gate.
 */
const CANONICAL_TRACKS: ReadonlySet<string> = new Set(["T1", "T2", "NEITHER"]);

const EXEMPT_RE = /^\s*\/\/\s*wire-routing-exempt:\s*(.*?)\s*$/;

/** Same five-line window as `// e2e-exempt:` — a marker must sit near its call site. */
const EXEMPT_SEARCH_WINDOW = 5;

// ─── Types ──────────────────────────────────────────────────────────

interface ManifestRow {
  readonly op: string;
  readonly surface: string;
  readonly track: string;
  readonly line: number;
}

interface ParsedManifest {
  readonly rows: readonly ManifestRow[];
  readonly structuralErrors: readonly string[];
}

interface Finding {
  readonly op: string;
  readonly surface: string;
  readonly file: string;
  readonly line: number;
}

interface Exempted {
  readonly op: string;
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

interface StaleRow {
  readonly op: string;
  readonly surface: string;
  readonly line: number;
}

export interface RunReport {
  /** Invoked ops with no manifest row and no exemption. */
  readonly findings: readonly Finding[];
  readonly exempted: readonly Exempted[];
  readonly markerIssues: readonly string[];
  readonly structuralErrors: readonly string[];
  /** Manifest rows naming an op nothing invokes — informational only. */
  readonly staleRows: readonly StaleRow[];
  readonly invokedCount: number;
  readonly rowCount: number;
}

/** One scanned source file. */
export interface CoreFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  readonly content: string;
}

/** Injectable inputs for the pure core — wired to the real FS in `main`, to fixtures in tests. */
export interface ManifestInputs {
  /** Raw `docs/wire-validation-routing.md` content. */
  readonly manifest: string;
  /** Candidate `packages/core/src/**` files. Filtering is the caller's job. */
  readonly coreFiles: readonly CoreFile[];
}

// ─── Parsing ────────────────────────────────────────────────────────

export function parseManifest(manifest: string): ParsedManifest {
  const lines = manifest.split("\n");
  const rows: ManifestRow[] = [];
  const structuralErrors: string[] = [];
  const seen = new Map<string, number>();
  let surface: string | null = null;
  let sectionCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    const heading = SURFACE_HEADING.exec(line);
    if (heading !== null) {
      surface = heading[1] as string;
      sectionCount += 1;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      surface = null;
      continue;
    }
    if (surface === null || !line.startsWith("|")) continue;

    // Separator rows (`| --- | :-: |`) are structure, not data. Requiring an
    // actual dash matters: a looser blank-or-dashes guard also swallows a row
    // whose op cell is EMPTY, which is the silent drop below exists to catch.
    if (/^\|[\s:-]*-[\s:-]*\|/.test(line)) continue;

    const row = MANIFEST_ROW.exec(line);
    if (row === null) {
      // A table line that does not parse would be silently dropped, turning a
      // formatting slip into a phantom missing-row finding for a documented op.
      structuralErrors.push(
        `${MANIFEST_FILE}:${String(i + 1)}: table row under \`${surface}\` does not match the "| OpName | Track | ..." shape — it would be silently dropped`,
      );
      continue;
    }
    const op = row[1] as string;
    if (op === "Op") continue;
    const track = (row[2] ?? "").trim();

    // `T2 (wired)` / `T2 (ready)` → base token `T2`.
    const baseTrack = /^([A-Za-z0-9]+)/.exec(track)?.[1] ?? "";
    if (!CANONICAL_TRACKS.has(baseTrack)) {
      structuralErrors.push(
        `${MANIFEST_FILE}:${String(i + 1)}: \`${op}\` has track "${track}" — not one of ${[...CANONICAL_TRACKS].join(" / ")}`,
      );
    }

    const prior = seen.get(op);
    if (prior !== undefined) {
      structuralErrors.push(
        `${MANIFEST_FILE}:${String(i + 1)}: \`${op}\` already has a row at line ${String(prior)} — ambiguous which disposition is authoritative`,
      );
    } else {
      seen.set(op, i + 1);
    }

    rows.push({ op, surface, track, line: i + 1 });
  }

  if (sectionCount === 0) {
    structuralErrors.push(
      `no "## \`<surface>\` (N ops)" sections found in ${MANIFEST_FILE} — parser or manifest format is stale`,
    );
  } else if (rows.length === 0) {
    structuralErrors.push(
      `${String(sectionCount)} surface section(s) found in ${MANIFEST_FILE} but no op rows parsed — parser or manifest format is stale`,
    );
  }

  return { rows, structuralErrors };
}

/**
 * Walk back from `lineIndex` for the nearest `// wire-routing-exempt:` marker
 * within {@link EXEMPT_SEARCH_WINDOW} lines. Returns the raw reason (possibly
 * empty — the caller decides what an empty one means), or `null` if no marker.
 */
function findExemptMarker(lines: readonly string[], lineIndex: number): { reason: string; line: number } | null {
  const low = Math.max(0, lineIndex - EXEMPT_SEARCH_WINDOW);
  for (let j = lineIndex - 1; j >= low; j--) {
    const m = EXEMPT_RE.exec(lines[j] ?? "");
    if (m !== null) return { reason: (m[1] ?? "").trim(), line: j + 1 };
  }
  return null;
}

// ─── Run ────────────────────────────────────────────────────────────

export function analyzeWireRouting(inputs: ManifestInputs): RunReport {
  const { rows, structuralErrors } = parseManifest(inputs.manifest);
  const errors = [...structuralErrors];
  const markerIssues: string[] = [];

  const invoked = new Map<string, CalledOp>();
  const exempted: Exempted[] = [];
  const exemptOps = new Set<string>();

  for (const file of inputs.coreFiles) {
    const lines = file.content.split("\n");
    for (const op of scanCoreSrcLines(lines, file.path)) {
      // First call site wins for attribution, so the report points at a stable
      // site; exemption is aggregated across sites below (any site exempts).
      if (!invoked.has(op.name)) invoked.set(op.name, op);

      const marker = findExemptMarker(lines, op.line - 1);
      if (marker === null) continue;
      if (marker.reason.length === 0) {
        // An unusable marker must exempt NOTHING: silently honouring it would
        // suppress a genuinely missing row and report only the comment syntax.
        markerIssues.push(`${file.path}:${String(marker.line)}: exemption marker has an empty reason`);
        continue;
      }
      if (!exemptOps.has(op.name)) {
        exemptOps.add(op.name);
        exempted.push({ op: op.name, file: file.path, line: op.line, reason: marker.reason });
      }
    }
  }

  if (invoked.size === 0) {
    // Zero ops over N files means the scan resolved nothing: every op would
    // read as "documented" and the gate would pass on an empty subject.
    errors.push(
      `no GraphQL operations extracted from ${String(inputs.coreFiles.length)} core source file(s) — the scan resolved nothing, so no row could be missing`,
    );
  }

  const rowOps = new Set(rows.map((r) => r.op));
  const findings: Finding[] = [];
  for (const [name, op] of invoked) {
    if (rowOps.has(name) || exemptOps.has(name)) continue;
    findings.push({ op: name, surface: op.surface ?? "<unknown>", file: op.file, line: op.line });
  }
  findings.sort((a, b) => a.surface.localeCompare(b.surface) || a.op.localeCompare(b.op));

  const staleRows: StaleRow[] = rows
    .filter((r) => !invoked.has(r.op))
    .map((r) => ({ op: r.op, surface: r.surface, line: r.line }))
    .sort((a, b) => a.surface.localeCompare(b.surface) || a.op.localeCompare(b.op));

  exempted.sort((a, b) => a.op.localeCompare(b.op));
  markerIssues.sort();

  return {
    findings,
    exempted,
    markerIssues,
    structuralErrors: errors,
    staleRows,
    invokedCount: invoked.size,
    rowCount: rows.length,
  };
}

// ─── Report ─────────────────────────────────────────────────────────

export function formatReport(report: RunReport, strict: boolean): { exitCode: 0 | 1; text: string } {
  const lines: string[] = [];

  if (report.structuralErrors.length > 0) {
    lines.push("\n  structural errors:");
    for (const e of report.structuralErrors) lines.push(`    - ${e}`);
  }
  if (report.findings.length > 0) {
    lines.push("\n  MISSING MANIFEST ROW:");
    for (const f of report.findings) {
      lines.push(`    - ${f.op} (${f.surface}) invoked at ${f.file}:${String(f.line)}`);
    }
  }
  if (report.markerIssues.length > 0) {
    lines.push("\n  marker issues:");
    for (const m of report.markerIssues) lines.push(`    - ${m}`);
  }
  if (report.exempted.length > 0) {
    lines.push(`\n  exempted (${String(report.exempted.length)}):`);
    for (const e of report.exempted) {
      lines.push(`    - ${e.op} (${e.file}:${String(e.line)}): ${e.reason}`);
    }
  }
  if (report.staleRows.length > 0) {
    // Informational: never fails the gate. See the header's stale-rows note.
    lines.push(`\n  stale rows, not gated (${String(report.staleRows.length)}) — documented but no longer invoked:`);
    for (const s of report.staleRows) {
      lines.push(`    - ${s.op} (${s.surface}) at ${MANIFEST_FILE}:${String(s.line)}`);
    }
  }
  if (report.findings.length > 0) {
    lines.push(
      `\n  remedy: add a row to the op's surface section in ${MANIFEST_FILE} with its DERIVED track ` +
        `(T2 iff codegen produced a <OpName>(Query|Mutation|Subscription) type, T1 otherwise), or — for a ` +
        `deliberate divergence — place // wire-routing-exempt: <reason> above the call site`,
    );
  }

  const fails = report.findings.length > 0 || report.structuralErrors.length > 0 || report.markerIssues.length > 0;
  const header = fails
    ? `check-wire-routing-manifest: ${String(report.findings.length)} missing row(s), ${String(report.structuralErrors.length)} structural error(s), ${String(report.markerIssues.length)} marker issue(s)`
    : `check-wire-routing-manifest: all ${String(report.invokedCount)} invoked op(s) documented across ${String(report.rowCount)} manifest row(s)`;
  const exemptedNote = report.exempted.length > 0 ? `, ${String(report.exempted.length)} exempted` : "";
  const staleNote = report.staleRows.length > 0 ? `, ${String(report.staleRows.length)} stale row(s)` : "";
  const mode = strict ? "strict" : "warn";

  return {
    exitCode: strict && fails ? 1 : 0,
    text: `${header}${exemptedNote}${staleNote} [${mode}]${lines.join("\n")}\n`,
  };
}

// ─── Entry point ────────────────────────────────────────────────────

function gitTopLevel(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function listTrackedFiles(repoRoot: string): string[] {
  return execSync("git ls-files", { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function main(): void {
  const repoRoot = gitTopLevel();
  const strict = process.argv.includes("--strict") || process.env["WIRE_ROUTING_STRICT"] === "1";

  const coreFiles: CoreFile[] = [];
  for (const relPath of listTrackedFiles(repoRoot)) {
    if (!isCoreSrcCandidate(relPath)) continue;
    try {
      coreFiles.push({ path: relPath, content: readFileSync(join(repoRoot, relPath), "utf8") });
    } catch {
      // A tracked-but-unreadable file cannot be scanned; surfacing it as a
      // structural error is the pure core's job, so record an empty body and
      // let the degenerate-subject guard speak if the scan resolves nothing.
      coreFiles.push({ path: relPath, content: "" });
    }
  }

  const report = analyzeWireRouting({
    manifest: readFileSync(join(repoRoot, MANIFEST_FILE), "utf8"),
    coreFiles,
  });
  const { exitCode, text } = formatReport(report, strict);
  process.stderr.write(text);
  process.exit(exitCode);
}

/**
 * True when this module is the process entrypoint (`tsx scripts/...`), false
 * when imported (e.g. by the unit test). Compares realpath-normalized native
 * paths rather than URL strings so a Windows drive-letter / slash mismatch
 * cannot make the gate silently no-op (which, in warn mode, would still exit 0
 * and look green).
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
