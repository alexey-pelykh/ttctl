#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Snapshot degeneracy gate (issue #735).
 *
 * `captureWireShape` collapses an empty array (and the rare mixed-kind
 * element list) to `{ kind: "array", item: { kind: "unknown" } }` — a
 * committed snapshot carrying that shape asserts nothing about element
 * shape. The live-run drift that prompts re-capture (#692) only fires
 * when an E2E run happens to hit a populated cycle; until then the
 * degenerate contract sits invisible in the corpus. This gate makes the
 * re-capture debt visible at lint time.
 *
 * For each git-tracked `packages/e2e/src/wire-snapshots/*.snapshot.json`,
 * the script walks the `shape` tree and reports every `array` node whose
 * item — after peeling `nullable` / `optional` wrappers — is
 * `{ kind: "unknown" }`. (`array<nullable<unknown>>` arises from a
 * mixed-kind-plus-null element list and is equally contract-free.)
 * Paths use the `assertWireShapeStable` diff syntax: dot-joined object
 * fields, `[]` for array elements, `<root>` for a root-position array.
 *
 * ## Exemption mechanism
 *
 *   Known-unpopulatable columns (feature-gated on the capture account —
 *   e.g. portfolio file upload) never organically re-capture richer.
 *   Exempt them in the sidecar registry
 *   `packages/e2e/src/wire-snapshots/degeneracy-exemptions.json`:
 *
 *     { "<OpName>": { "<path>": "<reason — mandatory, non-empty>" } }
 *
 *   The registry is a SIDECAR file rather than an in-snapshot field or
 *   comment: snapshots are generated JSON (comments cannot survive
 *   parse/stringify), and an in-snapshot field would be silently wiped
 *   by the next `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` refresh — exempt
 *   columns are precisely the ones that stay empty across re-captures.
 *   Reasons surface in the report so reviewers can audit. Entries that
 *   no longer match a degenerate node are reported STALE (the column
 *   got populated or the path is wrong) and fail strict mode.
 *
 * ## Modes
 *
 *   - **warn** (default): always exits 0. Findings reported to stderr.
 *   - **strict** (`--strict` flag or `SNAPSHOT_DEGENERACY_STRICT=1`
 *     env): exits non-zero on any non-exempt degenerate node, registry
 *     issue (stale / reason-less / malformed entry), or unparseable
 *     snapshot. Flip once the corpus is triaged. Sibling pattern to the
 *     `E2E_COVERAGE_STRICT` / `SURFACE_COVERAGE_STRICT` /
 *     `WRITE_READ_SYMMETRY_STRICT` / `MERGE_COMPLETENESS_STRICT`
 *     switches.
 *
 * ## Exit codes
 *
 *   0 — warn-mode (always) OR strict-mode with no findings.
 *   1 — strict-mode with at least one finding.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// ─── Configuration ──────────────────────────────────────────────────

/** Directory holding committed wire snapshots (repo-relative). */
const SNAPSHOT_DIR = "packages/e2e/src/wire-snapshots";

/** Sidecar exemption registry (repo-relative). */
const EXEMPTIONS_FILE = `${SNAPSHOT_DIR}/degeneracy-exemptions.json`;

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Structural mirror of the `WireShape` union in
 * `packages/e2e/src/wire-snapshots/captureWireShape.ts`. Re-declared
 * locally because the walk operates on freshly parsed JSON, where a
 * loose structural type with optional members is the honest shape.
 */
interface ShapeNode {
  readonly kind: string;
  readonly item?: ShapeNode;
  readonly inner?: ShapeNode;
  readonly fields?: Readonly<Record<string, ShapeNode>>;
}

interface SnapshotFinding {
  readonly path: string;
  readonly rendered: string;
}

interface ExemptedFinding {
  readonly path: string;
  readonly reason: string;
}

interface SnapshotReport {
  readonly operation: string;
  readonly filePath: string;
  readonly degenerate: SnapshotFinding[];
  readonly exempted: ExemptedFinding[];
  readonly parseError: string | null;
}

interface RegistryIssue {
  readonly kind: "STALE" | "INVALID-REASON" | "MALFORMED";
  readonly detail: string;
}

interface RunReport {
  readonly snapshots: SnapshotReport[];
  readonly registryIssues: RegistryIssue[];
  readonly scanned: number;
}

// ─── Git helpers ────────────────────────────────────────────────────

function gitTopLevel(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function listTrackedSnapshots(repoRoot: string): string[] {
  return execSync(`git ls-files -- "${SNAPSHOT_DIR}/*.snapshot.json"`, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ─── Shape walk ─────────────────────────────────────────────────────

/** Peel `nullable` / `optional` wrappers down to the core shape. */
function peelWrappers(shape: ShapeNode): ShapeNode {
  let s = shape;
  while ((s.kind === "nullable" || s.kind === "optional") && s.inner !== undefined) {
    s = s.inner;
  }
  return s;
}

/** Compact type rendering — mirrors `renderShape` in `assertWireShapeStable.ts`. */
function renderShape(shape: ShapeNode): string {
  switch (shape.kind) {
    case "array":
      return `array<${shape.item === undefined ? "?" : renderShape(shape.item)}>`;
    case "nullable":
      return `nullable<${shape.inner === undefined ? "?" : renderShape(shape.inner)}>`;
    case "optional":
      return `optional<${shape.inner === undefined ? "?" : renderShape(shape.inner)}>`;
    case "object":
      return "object";
    default:
      return shape.kind;
  }
}

/**
 * Collect every `array` node whose wrapper-peeled item is `unknown`.
 * The path addresses the ARRAY node (the column to re-capture), not
 * its item.
 */
function findDegenerateArrays(shape: ShapeNode, path: string, out: SnapshotFinding[]): void {
  switch (shape.kind) {
    case "object": {
      if (shape.fields === undefined) return;
      for (const [key, child] of Object.entries(shape.fields)) {
        findDegenerateArrays(child, path === "" ? key : `${path}.${key}`, out);
      }
      return;
    }
    case "array": {
      if (shape.item === undefined) return;
      if (peelWrappers(shape.item).kind === "unknown") {
        out.push({ path: path === "" ? "<root>" : path, rendered: renderShape(shape) });
      }
      findDegenerateArrays(shape.item, path === "" ? "[]" : `${path}[]`, out);
      return;
    }
    case "nullable":
    case "optional": {
      if (shape.inner !== undefined) {
        findDegenerateArrays(shape.inner, path, out);
      }
      return;
    }
    default:
      return;
  }
}

// ─── Exemption registry ─────────────────────────────────────────────

interface Registry {
  readonly byOp: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly issues: RegistryIssue[];
}

function loadRegistry(repoRoot: string): Registry {
  const abs = join(repoRoot, EXEMPTIONS_FILE);
  const issues: RegistryIssue[] = [];
  const byOp = new Map<string, ReadonlyMap<string, string>>();
  if (!existsSync(abs)) return { byOp, issues };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    issues.push({ kind: "MALFORMED", detail: e instanceof Error ? e.message : String(e) });
    return { byOp, issues };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    issues.push({ kind: "MALFORMED", detail: "top level must be an object of <OpName>: { <path>: <reason> }" });
    return { byOp, issues };
  }
  for (const [op, entry] of Object.entries(parsed)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push({ kind: "MALFORMED", detail: `${op}: entry must be an object of <path>: <reason>` });
      continue;
    }
    const paths = new Map<string, string>();
    for (const [p, reason] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof reason !== "string" || reason.trim().length === 0) {
        issues.push({ kind: "INVALID-REASON", detail: `${op} → ${p}: reason must be a non-empty string` });
        continue;
      }
      paths.set(p, reason);
    }
    byOp.set(op, paths);
  }
  return { byOp, issues };
}

// ─── Run ────────────────────────────────────────────────────────────

function run(): RunReport {
  const repoRoot = gitTopLevel();
  const snapshotFiles = listTrackedSnapshots(repoRoot);
  const registry = loadRegistry(repoRoot);
  const registryIssues = [...registry.issues];
  const usedExemptions = new Set<string>();
  const snapshots: SnapshotReport[] = [];

  for (const rel of snapshotFiles) {
    const operation = basename(rel).replace(/\.snapshot\.json$/, "");
    let shape: ShapeNode | null = null;
    let parseError: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as { shape?: ShapeNode };
      if (parsed.shape === undefined || typeof parsed.shape.kind !== "string") {
        parseError = "missing `shape` member";
      } else {
        shape = parsed.shape;
      }
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }

    const findings: SnapshotFinding[] = [];
    if (shape !== null) {
      findDegenerateArrays(shape, "", findings);
      findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }

    const opExemptions = registry.byOp.get(operation);
    const degenerate: SnapshotFinding[] = [];
    const exempted: ExemptedFinding[] = [];
    for (const f of findings) {
      const reason = opExemptions?.get(f.path);
      if (reason !== undefined) {
        exempted.push({ path: f.path, reason });
        usedExemptions.add(`${operation} ${f.path}`);
      } else {
        degenerate.push(f);
      }
    }
    snapshots.push({ operation, filePath: rel, degenerate, exempted, parseError });
  }

  for (const [op, paths] of registry.byOp) {
    for (const p of paths.keys()) {
      if (!usedExemptions.has(`${op} ${p}`)) {
        registryIssues.push({
          kind: "STALE",
          detail: `${op} → ${p}: no matching degenerate node — remove or fix the entry`,
        });
      }
    }
  }

  return { snapshots, registryIssues, scanned: snapshotFiles.length };
}

// ─── Report ─────────────────────────────────────────────────────────

function formatReport(report: RunReport, strict: boolean): { exitCode: 0 | 1; text: string } {
  const lines: string[] = [];
  let degenerateCount = 0;
  let exemptedCount = 0;
  let affected = 0;
  let parseErrors = 0;

  for (const s of report.snapshots) {
    if (s.degenerate.length === 0 && s.exempted.length === 0 && s.parseError === null) continue;
    affected++;
    lines.push(`\n  ${s.operation}  (${s.filePath})`);
    if (s.parseError !== null) {
      parseErrors++;
      lines.push(`    PARSE ERROR: ${s.parseError}`);
    }
    if (s.exempted.length > 0) {
      exemptedCount += s.exempted.length;
      lines.push(`    exempted (${String(s.exempted.length)}):`);
      for (const e of s.exempted) lines.push(`      - ${e.path}: ${e.reason}`);
    }
    if (s.degenerate.length > 0) {
      degenerateCount += s.degenerate.length;
      lines.push(`    DEGENERATE (${String(s.degenerate.length)}):`);
      for (const f of s.degenerate) lines.push(`      - ${f.path}: ${f.rendered}`);
    }
  }

  if (report.registryIssues.length > 0) {
    lines.push(`\n  exemption registry (${EXEMPTIONS_FILE}):`);
    for (const issue of report.registryIssues) {
      lines.push(`    ${issue.kind}: ${issue.detail}`);
    }
  }

  if (degenerateCount > 0) {
    lines.push(
      `\n  remedy: re-capture from a populated subject (TTCTL_UPDATE_WIRE_SNAPSHOTS=1) or exempt with a reason in ${EXEMPTIONS_FILE}`,
    );
  }

  let header: string;
  if (lines.length === 0) {
    header = `check-snapshot-degeneracy: ${String(report.scanned)} snapshots scanned, no degenerate array items`;
  } else {
    header = `check-snapshot-degeneracy: ${String(degenerateCount)} degenerate array<unknown> node(s) across ${String(affected)} snapshot(s)`;
  }
  const exemptedNote = exemptedCount > 0 ? `, ${String(exemptedCount)} exempted` : "";
  const registryNote =
    report.registryIssues.length > 0 ? `, ${String(report.registryIssues.length)} registry issue(s)` : "";
  const mode = strict ? "strict" : "warn";

  const fails = degenerateCount > 0 || report.registryIssues.length > 0 || parseErrors > 0;
  return {
    exitCode: strict && fails ? 1 : 0,
    text: `${header}${exemptedNote}${registryNote} [${mode}]${lines.join("\n")}\n`,
  };
}

function main(): void {
  const strict = process.argv.includes("--strict") || process.env["SNAPSHOT_DEGENERACY_STRICT"] === "1";
  const report = run();
  const { exitCode, text } = formatReport(report, strict);
  process.stderr.write(text);
  process.exit(exitCode);
}

main();
