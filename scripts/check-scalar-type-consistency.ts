#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Scalar type-consistency gate (issue #782).
 *
 * Structural PR-time defense against the **#275 scalar-mistype class**: a
 * hand-authored TypeScript field type that contradicts the wire scalar. The
 * class recurred 3+ times — #275 `TimesheetRecord.duration`, #779
 * `Payments.paymentGroupId` (`string|null` vs wire `number|null`), #779 sweep
 * `AvailabilityTimeZone.utcOffset`/`.stdOffset` — each caught only by hand. The
 * wire-shape snapshots diff live-vs-snapshot, never snapshot-vs-hand-authored-TS,
 * so the divergence stays invisible until a populated live cycle happens to hit it.
 *
 * The codegen + Zod outputs ARE the authority that would catch it: every op in
 * the trusted catalog produces a `Maybe<Int>` / `z.number()` for an integer wire
 * field. A hand-authored interface field typed `string` where the generated type
 * says `number` (or the inverse) is a mechanically-detectable contradiction —
 * this gate makes that check, mirroring exactly what the #779 sweep did by hand.
 *
 * Sibling of the other seven `check-*` gates; same pure-core + injected-reader
 * shape, same warn/strict gating, same exemption-marker discipline.
 *
 * Authority (the generated "what the wire actually is"):
 *
 *   - Files: `packages/core/src/__generated__/*.ts` (`gateway`,
 *     `talent-profile`, and the two `*-zod-schemas` — the Zod files are
 *     dual-content, carrying both the TS types and the `z.*` schemas).
 *   - Two parseable shapes per file, unioned into a `fieldName → {primitive…}`
 *     map keyed by the bare field name:
 *       1. codegen TS named-type fields — `paymentGroupId: Maybe<Scalars['Int']['output']>;`
 *          (the `Scalars` block resolves `Int/Float → number`,
 *          `String/ID/BigDecimal/Date/DateTime/Time → string`, `Boolean → boolean`;
 *          `JSON`/`Unknown`/`Upload`/… are non-primitive and contribute nothing).
 *       2. codegen-Zod fields — `paymentGroupId: z.number().nullable(),`.
 *   - OUTPUT shapes only: TS fields referencing `['input']` / `InputMaybe<…>` and
 *     Zod fields inside `*InputSchema()` functions are skipped — service response
 *     interfaces are output shapes, and folding inputs in would invite false
 *     pairings. Inline operation-result projections (the giant single-line
 *     `export type XxxQuery = { … }`) are NOT parsed field-by-field; they are
 *     projections of the same named types, which the gate already covers.
 *
 * Subject (the hand-authored "what we declared"):
 *
 *   - `export interface` declarations under `packages/core/src/services/**`
 *     (excluding `__tests__` / `*.test.ts`). Services use `export interface`
 *     exclusively for response shapes.
 *   - Only plain scalar fields are checked: a type that reduces to exactly one of
 *     `string` / `number` / `boolean` (after dropping `| null` / `| undefined`
 *     and a trailing `?`). Type references, arrays, literal unions, and
 *     primitive unions (`string | number`) are not scalars → skipped.
 *
 * Match + verdict (field-name based, per the issue):
 *
 *   - A field is flagged **MISMATCH** iff its name resolves in the authority to a
 *     SINGLE unambiguous primitive that differs from the hand-authored one. When
 *     the authority holds two primitives for the same name across different
 *     generated types (**AMBIGUOUS**) the gate cannot adjudicate and skips —
 *     this is the false-positive guard that lets generic names (`value`, `name`)
 *     through untouched. A name absent from the authority is **NO-AUTHORITY**
 *     (the issue's "where a generated operation type exists" clause).
 *   - Field-name matching can in principle pair semantically-distinct same-named
 *     fields; warn-by-default + the exemption marker absorb that, exactly as the
 *     issue specifies.
 *
 * Exemption: `// scalar-consistency-exempt: <reason>` on the line directly above
 * the field declaration (or above the `export interface` header to cover every
 * field in that interface; per-field markers override). The reason is mandatory
 * and surfaces in the report. Use for a deliberately-divergent representation
 * (e.g. a numeric wire scalar intentionally surfaced as a `string`).
 *
 * Modes:
 *
 *   - **warn** (default): always exits 0; MISMATCHes print to stderr for
 *     visibility. The package.json wiring runs warn-mode, mirroring the
 *     coverage/symmetry/merge siblings.
 *   - **strict** (`--strict` or `SCALAR_CONSISTENCY_STRICT=1`): exits non-zero on
 *     any non-exempt MISMATCH. Flip on once the corpus is clean.
 *
 * Exit codes: 0 — warn-mode (always) OR strict with no mismatches. 1 — strict
 * with one or more mismatches.
 */

import { execSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads a repo-relative POSIX path; returns split lines, or null if unreadable. */
type FileReader = (relPath: string) => string[] | null;

/** The three TS scalar primitives the gate adjudicates. */
type Primitive = "string" | "number" | "boolean";

const GENERATED_PREFIX = "packages/core/src/__generated__/";
const SERVICES_PREFIX = "packages/core/src/services/";

/** How far above a declaration to look for the exemption marker. */
const EXEMPT_SEARCH_WINDOW = 1;

const EXEMPT_RE = /^\s*\/\/\s*scalar-consistency-exempt:\s*(.+?)\s*$/;
const IFACE_RE = /^export\s+interface\s+([A-Za-z_$][\w$]*)[^{]*\{/;
const FIELD_RE = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??:\s*(.+?);\s*$/;
const SCALARS_OPEN_RE = /^export\s+type\s+Scalars\s*=\s*\{/;
const SCALAR_ENTRY_RE = /^\s*([A-Za-z_$][\w$]*):\s*\{[^}]*\boutput:\s*([^;}]+?)\s*;?\s*\}/;
const ZOD_FN_RE = /^export\s+function\s+([A-Za-z_$][\w$]*)Schema\s*\(/;
const ZOD_FIELD_RE = /^\s*([A-Za-z_$][\w$]*):\s*z\.(string|number|boolean)\b/;

export type Disposition = "OK" | "MISMATCH" | "EXEMPT" | "AMBIGUOUS" | "NO-AUTHORITY";

export interface HandField {
  /** Declaring interface name. */
  iface: string;
  /** Field name (the match key against the generated authority). */
  field: string;
  /** Hand-authored primitive. */
  primitive: Primitive;
  /** Tracked path of the declaring file (POSIX, repo-relative). */
  file: string;
  /** 1-indexed line of the field declaration. */
  line: number;
  /** Reason from `// scalar-consistency-exempt:`, or null. */
  exempt: string | null;
}

export interface FieldAnalysis {
  hand: HandField;
  disposition: Disposition;
  /** The authoritative primitive when unambiguous, else null. */
  expected: Primitive | null;
}

export interface ScalarFinding {
  iface: string;
  field: string;
  file: string;
  line: number;
  handPrimitive: Primitive;
  generatedPrimitive: Primitive;
}

export interface ScalarAnalysis {
  fields: FieldAnalysis[];
  findings: ScalarFinding[];
  /** Count of distinct field names with at least one generated primitive. */
  authoritySize: number;
}

// ── Comment masking (lifted from check-surface-coverage.ts; same trade-offs) ──

/** Flag lines inside a block comment / JSDoc body so declarations there are ignored. */
function maskBlockComments(lines: readonly string[]): boolean[] {
  const inComment: boolean[] = new Array<boolean>(lines.length).fill(false);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let scanFrom = 0;
    const startsInComment = depth > 0;
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
    inComment[i] = startsInComment || depth > 0 || /^\s*\*/.test(line);
  }
  return inComment;
}

/** Strip the trailing `//` line-comment, respecting quoted regions. */
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

/** Nearest `// scalar-consistency-exempt:` within the tight window above `lineIndex`. */
function findExemptMarker(lines: readonly string[], lineIndex: number): string | null {
  const low = Math.max(0, lineIndex - EXEMPT_SEARCH_WINDOW);
  for (let j = lineIndex - 1; j >= low; j--) {
    const m = EXEMPT_RE.exec(lines[j] ?? "");
    if (m !== null) return m[1] ?? null;
  }
  return null;
}

/** Net `{` minus `}` on a code line (strings in these files carry no braces). */
function countBraces(code: string): number {
  let depth = 0;
  for (const ch of code) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

// ── Type-expression → primitive resolution ──

function asPrimitive(token: string | undefined): Primitive | null {
  if (token === "string" || token === "number" || token === "boolean") return token;
  return null;
}

/**
 * Reduce a TS union (or bare type) to a single primitive, dropping `null` /
 * `undefined`. Returns null unless exactly one non-null member survives and it
 * is a primitive — so `number | null` → `number`, `string | number` → null,
 * `"a" | "b"` → null, `Foo | null` → null.
 */
function reduceUnionToPrimitive(typeExpr: string): Primitive | null {
  const parts = typeExpr
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "null" && s !== "undefined");
  if (parts.length !== 1) return null;
  return asPrimitive(parts[0]);
}

/**
 * Resolve a generated TS type expression to its OUTPUT primitive, or null when
 * it is not a scalar output. Input-side expressions (`InputMaybe<…>`,
 * `['input']`) and arrays are rejected; `Maybe<…>` wrappers are peeled;
 * `Scalars['X']['output']` is resolved through the scalar map.
 */
function generatedTsPrimitive(typeExpr: string, scalarMap: ReadonlyMap<string, Primitive | null>): Primitive | null {
  let t = typeExpr.trim();
  if (t.includes("InputMaybe<") || t.includes("['input']")) return null;
  let prev = "";
  while (prev !== t) {
    prev = t;
    const m = /^Maybe<(.+)>$/.exec(t);
    if (m?.[1] !== undefined) t = m[1].trim();
  }
  if (/^(?:Readonly)?Array<.+>$/.test(t) || t.endsWith("[]")) return null;
  const sm = /^Scalars\['([A-Za-z_$][\w$]*)'\]\['output'\]$/.exec(t);
  if (sm?.[1] !== undefined) return scalarMap.get(sm[1]) ?? null;
  return reduceUnionToPrimitive(t);
}

// ── Generated authority ──

/** Parse one file's `export type Scalars = { … }` block into `name → output primitive`. */
function parseScalarsInto(
  lines: readonly string[],
  inComment: readonly boolean[],
  scalarMap: Map<string, Primitive | null>,
): void {
  for (let i = 0; i < lines.length; i++) {
    if (inComment[i]) continue;
    if (!SCALARS_OPEN_RE.test(lines[i] ?? "")) continue;
    let depth = countBraces(lines[i] ?? "");
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      if (inComment[j]) continue;
      const code = lines[j] ?? "";
      const m = SCALAR_ENTRY_RE.exec(code);
      if (m?.[1] !== undefined && m[2] !== undefined) {
        scalarMap.set(m[1], asPrimitive(m[2].trim()));
      }
      depth += countBraces(code);
    }
    return; // one Scalars block per file
  }
}

function addAuthority(authority: Map<string, Set<Primitive>>, field: string, primitive: Primitive): void {
  const existing = authority.get(field);
  if (existing === undefined) authority.set(field, new Set([primitive]));
  else existing.add(primitive);
}

/**
 * Collect generated scalar fields from one file into the authority map. Walks
 * both shapes: codegen TS named-type fields (resolved via `scalarMap`) and
 * codegen-Zod fields (`z.string/number/boolean`). Zod fields inside an
 * `*InputSchema()` function are skipped (input shapes).
 */
function collectFieldsInto(
  lines: readonly string[],
  inComment: readonly boolean[],
  scalarMap: ReadonlyMap<string, Primitive | null>,
  authority: Map<string, Set<Primitive>>,
): void {
  let inInputSchema = false;
  for (let j = 0; j < lines.length; j++) {
    if (inComment[j]) continue;
    const code = stripLineComment(lines[j] ?? "");

    const fn = ZOD_FN_RE.exec(code);
    if (fn !== null) {
      inInputSchema = (fn[1] ?? "").endsWith("Input");
      continue;
    }

    const zm = ZOD_FIELD_RE.exec(code);
    if (zm?.[1] !== undefined && zm[2] !== undefined) {
      if (!inInputSchema) addAuthority(authority, zm[1], zm[2] as Primitive);
      continue;
    }

    const fm = FIELD_RE.exec(code);
    if (fm?.[1] !== undefined && fm[2] !== undefined) {
      const prim = generatedTsPrimitive(fm[2], scalarMap);
      if (prim !== null) addAuthority(authority, fm[1], prim);
    }
  }
}

interface GeneratedAuthority {
  scalarMap: Map<string, Primitive | null>;
  authority: Map<string, Set<Primitive>>;
}

function collectGeneratedAuthority(genFiles: readonly string[], readFile: FileReader): GeneratedAuthority {
  const cached = new Map<string, string[]>();
  for (const f of genFiles) {
    const lines = readFile(f);
    if (lines !== null) cached.set(f, lines);
  }
  const scalarMap = new Map<string, Primitive | null>();
  for (const lines of cached.values()) {
    parseScalarsInto(lines, maskBlockComments(lines), scalarMap);
  }
  const authority = new Map<string, Set<Primitive>>();
  for (const lines of cached.values()) {
    collectFieldsInto(lines, maskBlockComments(lines), scalarMap, authority);
  }
  return { scalarMap, authority };
}

// ── Hand-authored interface fields ──

/** Walk every `export interface` body for plain scalar fields (depth-1 members only). */
function parseInterfaceFields(lines: readonly string[], relPath: string, inComment: readonly boolean[]): HandField[] {
  const out: HandField[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (inComment[i]) continue;
    const opener = IFACE_RE.exec(stripLineComment(lines[i] ?? ""));
    if (opener === null) continue;
    const iface = opener[1];
    if (iface === undefined) continue;
    const ifaceExempt = findExemptMarker(lines, i);

    let depth = countBraces(stripLineComment(lines[i] ?? ""));
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      if (inComment[j]) continue;
      const code = stripLineComment(lines[j] ?? "");
      if (depth === 1) {
        const fm = FIELD_RE.exec(code);
        if (fm?.[1] !== undefined && fm[2] !== undefined) {
          const prim = reduceUnionToPrimitive(fm[2]);
          if (prim !== null) {
            out.push({
              iface,
              field: fm[1],
              primitive: prim,
              file: relPath,
              line: j + 1,
              exempt: findExemptMarker(lines, j) ?? ifaceExempt,
            });
          }
        }
      }
      depth += countBraces(code);
    }
  }
  return out;
}

// ── Pure core ──

function isGeneratedFile(path: string): boolean {
  return (
    path.startsWith(GENERATED_PREFIX) && path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.endsWith(".test.ts")
  );
}

function isServiceInterfaceFile(path: string): boolean {
  if (!path.startsWith(SERVICES_PREFIX)) return false;
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.includes("/__tests__/")) return false;
  return true;
}

function classify(hand: HandField, authority: ReadonlyMap<string, Set<Primitive>>): FieldAnalysis {
  if (hand.exempt !== null) return { hand, disposition: "EXEMPT", expected: null };
  const set = authority.get(hand.field);
  if (set === undefined || set.size === 0) return { hand, disposition: "NO-AUTHORITY", expected: null };
  if (set.size > 1) return { hand, disposition: "AMBIGUOUS", expected: null };
  const expected = [...set][0] ?? null;
  const disposition: Disposition = expected === hand.primitive ? "OK" : "MISMATCH";
  return { hand, disposition, expected };
}

/**
 * Pure core: given the tracked file list and a {@link FileReader}, build the
 * generated authority and classify every hand-authored scalar field. No git, no
 * `process` — `main` injects a repo-backed reader; tests inject a fixture map.
 */
export function analyzeScalarConsistency(tracked: readonly string[], readFile: FileReader): ScalarAnalysis {
  const genFiles = tracked.filter(isGeneratedFile);
  const svcFiles = tracked.filter(isServiceInterfaceFile);

  const { authority } = collectGeneratedAuthority(genFiles, readFile);

  const handFields: HandField[] = [];
  for (const f of svcFiles) {
    const lines = readFile(f);
    if (lines === null) continue;
    handFields.push(...parseInterfaceFields(lines, f, maskBlockComments(lines)));
  }

  const fields = handFields.map((h) => classify(h, authority));
  const findings: ScalarFinding[] = [];
  for (const fa of fields) {
    if (fa.disposition === "MISMATCH" && fa.expected !== null) {
      findings.push({
        iface: fa.hand.iface,
        field: fa.hand.field,
        file: fa.hand.file,
        line: fa.hand.line,
        handPrimitive: fa.hand.primitive,
        generatedPrimitive: fa.expected,
      });
    }
  }
  return { fields, findings, authoritySize: authority.size };
}

// ── Reporting ──

export interface RunReport {
  stdoutLines: string[];
  stderrLines: string[];
  exitCode: number;
}

export function formatReport(analysis: ScalarAnalysis, strict: boolean): RunReport {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const counts: Record<Disposition, number> = { OK: 0, MISMATCH: 0, EXEMPT: 0, AMBIGUOUS: 0, "NO-AUTHORITY": 0 };
  for (const fa of analysis.fields) counts[fa.disposition] += 1;

  stdout.push(`Scalar type-consistency gate — codegen + Zod vs hand-authored service interfaces`);
  stdout.push(
    `  ${String(analysis.fields.length)} scalar field(s) checked against ` +
      `${String(analysis.authoritySize)} generated field name(s): ` +
      `${String(counts.OK)} consistent, ` +
      `${String(counts.MISMATCH)} mismatch, ` +
      `${String(counts.AMBIGUOUS)} ambiguous, ` +
      `${String(counts["NO-AUTHORITY"])} no-authority, ` +
      `${String(counts.EXEMPT)} exempt.`,
  );

  const exemptRows = analysis.fields
    .filter((fa) => fa.disposition === "EXEMPT")
    .sort((a, b) => `${a.hand.iface}.${a.hand.field}`.localeCompare(`${b.hand.iface}.${b.hand.field}`));
  if (exemptRows.length > 0) {
    stdout.push("");
    for (const fa of exemptRows) {
      stdout.push(`  EXEMPT  ${`${fa.hand.iface}.${fa.hand.field}`.padEnd(48)} ${fa.hand.exempt ?? ""}`);
    }
  }

  const findings = [...analysis.findings].sort((a, b) =>
    `${a.iface}.${a.field}`.localeCompare(`${b.iface}.${b.field}`),
  );

  if (findings.length > 0) {
    stderr.push(`\nScalar type-consistency gate — ${String(findings.length)} mismatch(es) detected.`);
    stderr.push(`Each row is a hand-authored service-interface field whose primitive contradicts`);
    stderr.push(`the generated codegen/Zod scalar for that field name. Align the hand-authored`);
    stderr.push(`type to the wire (the #779 fix), or mark a deliberate divergence with`);
    stderr.push(`\`// scalar-consistency-exempt: <reason>\` directly above the field.`);
    stderr.push("");
    for (const f of findings) {
      stderr.push(
        `  ${`${f.iface}.${f.field}`.padEnd(48)} hand=${f.handPrimitive.padEnd(7)} ` +
          `generated=${f.generatedPrimitive.padEnd(7)} ${f.file}:${String(f.line)}`,
      );
    }
    if (!strict) {
      stderr.push("");
      stderr.push(`Note: gate is in WARN mode. Exit code 0. Set SCALAR_CONSISTENCY_STRICT=1 (or`);
      stderr.push(`pass --strict) to fail on mismatches once the corpus is clean.`);
    }
  }

  return { stdoutLines: stdout, stderrLines: stderr, exitCode: strict && findings.length > 0 ? 1 : 0 };
}

// ── Repo-backed entrypoint ──

function listTrackedFiles(repoRoot: string): string[] {
  const stdout = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readSourceLines(absPath: string): string[] | null {
  try {
    if (statSync(absPath).size > 8 * 1024 * 1024) return null; // 8 MiB guard (generated files run large)
    return readFileSync(absPath, "utf8").split("\n");
  } catch {
    return null;
  }
}

function main(): void {
  const repoRoot = process.cwd();
  const args = new Set(process.argv.slice(2));
  const strict = args.has("--strict") || process.env["SCALAR_CONSISTENCY_STRICT"] === "1";

  const tracked = listTrackedFiles(repoRoot);
  const readFile: FileReader = (relPath) => readSourceLines(join(repoRoot, relPath));

  const analysis = analyzeScalarConsistency(tracked, readFile);
  const { stdoutLines, stderrLines, exitCode } = formatReport(analysis, strict);

  for (const line of stdoutLines) process.stdout.write(`${line}\n`);
  for (const line of stderrLines) process.stderr.write(`${line}\n`);

  if (exitCode !== 0) process.exit(exitCode);
}

/**
 * True when this module is the process entrypoint. Compares realpath-normalized
 * native paths (not URL strings) so Windows casing / slash differences cannot
 * make the gate silently no-op (which, in warn mode, would still exit 0).
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
