#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Full-replacement merge-completeness gate (issue #608).
 *
 * The full-replace bug class: Toptal's `talent_profile` `<Entity>Input`
 * mutations are full-replacement contracts — fields OMITTED from the
 * input get NULLED server-side. ttctl services that send partial inputs
 * silently null unsent fields. Bug instances: #393 / #394 / #487
 * (empirically proven), #604 / #605 / #606 / #607 / #608 (fixed family).
 *
 * This gate is the structural CI-time defense. For each input-roster
 * capture in `../research/captures/web/inputs/*Input.json`, the script:
 *
 *   1. Loads the capture's operation name + payload field roster (the
 *      non-wrapper key in `inferred_inputs`).
 *   2. Finds the ttctl invocation of that operation under
 *      `packages/core/src/services/**\/index.ts` (literal
 *      `operationName: "<OpName>"` or the helper-wrapped
 *      `callTalentProfile(token, "<OpName>", ...)` / `callGateway(token,
 *      "<OpName>", ...)` patterns from `check-e2e-coverage.ts`).
 *   3. Extracts the SENT field set from the merge construction at that
 *      invocation. Three resolution patterns:
 *
 *        - **Inline literal** — `input: { <wrapper>: { f1, f2, ... } }`.
 *          Extract property names directly.
 *        - **Variable** — `input: { <wrapper>: merged }` where `merged`
 *          is declared in the same file as `const merged: T = { ... }`.
 *          Extract the literal's keys + any `merged.<key> = ...`
 *          assignments before the invocation site.
 *        - **Helper call** — `input: { <wrapper>: buildXInput(...) }`
 *          where `buildXInput` is defined in the same file. Resolve the
 *          helper's body: collect property names from every returned
 *          object literal, plus any `<retVar>.<key> = ...` assignments
 *          before the return, plus identifiers spread via `{ ...x }`
 *          (treated as opaque "all caller-supplied fields" — see #605).
 *
 *   4. Compares: every field in the capture's payload roster MUST appear
 *      in the SENT field set. Missing fields are reported.
 *
 * ## Detection scope
 *
 *   - **Capture sources**: `../research/captures/web/inputs/*Input.json`
 *     (the research repo lives as a sibling working copy; see CLAUDE.md
 *     § Reverse-Engineering Artifacts). Captures with no matching
 *     ttctl invocation are reported once at the end and skipped (they
 *     either belong to a not-yet-implemented surface or to an operation
 *     ttctl deliberately doesn't use — e.g. the talent-profile-side
 *     `updateTimeZoneWorkingHours` vs the gateway-side `UpdateWorkingHours`
 *     ttctl uses today).
 *   - **Invocation sites**: scan `packages/core/src/services/**\/index.ts`
 *     for matches against both literal `operationName:` patterns and the
 *     helper-wrapped positional-arg pattern (allowlist mirrors
 *     `check-e2e-coverage.ts` HELPER_SIGNATURES).
 *
 * ## Exemption mechanism
 *
 *   Per-field `// merge-complete-exempt: <field> — <reason>` placed within
 *   the same file as the merge construction (file-level; reason mandatory).
 *   Use cases:
 *     - Field is intentionally write-only (e.g., upload token, ephemeral
 *       password); never round-tripped.
 *     - Operation is empirically partial-merge — see #606 / #607 / #608
 *       where defense-in-depth still ships, but the bug was theoretical.
 *     - Field exists on the input type but ttctl does not surface it
 *       (e.g., legacy / deprecated field with no user-facing API).
 *
 *   Multiple fields can be exempted per file. The reason surfaces in the
 *   report so reviewers can audit.
 *
 * ## Modes
 *
 *   - **warn** (default): always exits 0. Mismatches reported to stderr.
 *     Suitable for the rollout phase before existing gaps are paid down.
 *   - **strict** (`--strict` flag or `MERGE_COMPLETENESS_STRICT=1` env):
 *     exits non-zero if any non-exempt gap exists. Flip to strict once
 *     the existing gap has been paid down. Sibling pattern to the
 *     `E2E_COVERAGE_STRICT` / `SURFACE_COVERAGE_STRICT` / `WRITE_READ_SYMMETRY_STRICT`
 *     env switches.
 *
 * ## Wire-up
 *
 *   Add to root `package.json` `lint` script alongside the existing
 *   `check-*` gates.
 *
 * ## Exit codes
 *
 *   0 — warn-mode (always) OR strict-mode with no gaps.
 *   1 — strict-mode with at least one non-exempt gap.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// ─── Configuration ──────────────────────────────────────────────────

/** Path prefix scanned for ttctl invocations. */
const SERVICES_PREFIX = "packages/core/src/services/";

/** Window for searching `variables:` literal below `operationName:`. */
const VARIABLES_SEARCH_WINDOW = 30;

/** Window for searching helper-wrapped invocations starting from helper name. */
const HELPER_SNIPPET_WINDOW = 8;

/** How far upward to walk for `const <name> ... = {` or `function <name>` resolution. */
const RESOLUTION_WINDOW_UP = 120;

/**
 * Helpers that wrap the transport and accept `operationName` as positional
 * arg 1. Mirrors `HELPER_SIGNATURES` in `check-e2e-coverage.ts` (kept in
 * sync manually — adding a helper there should add it here).
 */
const HELPER_NAMES: ReadonlySet<string> = new Set(["callTalentProfile", "callGateway"]);

/** Built-in identifier names treated as non-resolvable when seen in `<wrapper>: <expr>`. */
const NON_RESOLVABLE_IDENTS: ReadonlySet<string> = new Set(["null", "undefined", "true", "false", "this"]);

// ─── Types ──────────────────────────────────────────────────────────

interface CaptureRoster {
  filePath: string;
  operation: string;
  wrapperKey: string;
  payloadType: string;
  payloadFields: Set<string>;
}

interface InvocationSite {
  filePath: string;
  line: number;
  operation: string;
}

interface MergeAnalysis {
  invocation: InvocationSite;
  wrapperKey: string | null;
  /** Identifier or expression text passed as the wrapper value. */
  payloadExpr: string | null;
  sentFields: Set<string>;
  /** Diagnostic notes that explain why a field set might be incomplete. */
  notes: string[];
}

interface ExemptedField {
  field: string;
  reason: string;
}

interface GapReport {
  capture: CaptureRoster;
  analysis: MergeAnalysis | null;
  missing: string[];
  exempted: ExemptedField[];
}

// ─── Repo + capture discovery ───────────────────────────────────────

function gitTopLevel(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function listTrackedFiles(repoRoot: string): string[] {
  return execSync("git ls-files", { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function findCapturesDir(repoRoot: string): string | null {
  const candidate = resolve(repoRoot, "..", "research", "captures", "web", "inputs");
  return existsSync(candidate) ? candidate : null;
}

function listCaptureFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

interface RawCapture {
  operation?: string;
  inferred_inputs?: Record<string, Record<string, string> | unknown>;
}

/**
 * Load a capture file and project it onto the {@link CaptureRoster} shape.
 *
 * The capture's `inferred_inputs` is a map of `<TypeName>` → field map.
 * One entry is the WRAPPER (`UpdateXInput { idField, payload: PayloadType! }`)
 * and one is the PAYLOAD (`PayloadType { f1, f2, ... }`). The wrapper has
 * exactly 2 fields where one is a `*Input!` type reference; the payload
 * has the actual primitive fields we care about. Cases with N > 2 entries
 * (sub-nested inputs like `SkillRefInput`) are filtered: only the top-level
 * wrapper + its immediate payload are recognized.
 */
function loadCapture(filePath: string): CaptureRoster | null {
  let raw: RawCapture;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as RawCapture;
  } catch {
    return null;
  }

  const op = raw.operation;
  const inferred = raw.inferred_inputs;
  if (typeof op !== "string" || op.length === 0) return null;
  if (typeof inferred !== "object" || inferred === null) return null;

  // Find the wrapper: an entry whose values include a reference to another
  // input type (e.g. `payload: SomeInput!`). The matching reference target
  // is the payload type.
  let wrapperKey: string | null = null;
  let payloadType: string | null = null;
  let wrapperEntry: Record<string, string> | null = null;
  for (const [typeName, fieldsBlob] of Object.entries(inferred)) {
    if (typeof fieldsBlob !== "object" || fieldsBlob === null) continue;
    const fields = fieldsBlob as Record<string, string>;
    for (const [fieldName, typeStr] of Object.entries(fields)) {
      // Pattern: "PayloadType!" or "PayloadType" — reference to another
      // input type in the same capture's roster.
      const refTarget = typeStr.replace(/!$/, "").trim();
      if (refTarget in inferred && refTarget !== typeName) {
        wrapperKey = fieldName;
        payloadType = refTarget;
        wrapperEntry = fields;
        break;
      }
    }
    if (wrapperKey !== null) break;
  }
  if (wrapperKey === null || payloadType === null || wrapperEntry === null) return null;
  void wrapperEntry; // wrapper detection is positional; consumed via wrapperKey

  const payloadFields = inferred[payloadType];
  if (typeof payloadFields !== "object" || payloadFields === null) return null;

  return {
    filePath,
    operation: op,
    wrapperKey,
    payloadType,
    payloadFields: new Set(Object.keys(payloadFields as Record<string, unknown>)),
  };
}

// ─── ttctl invocation site discovery ────────────────────────────────

const OPERATION_NAME_RE = /\boperationName\s*:\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HELPER_NAME_RE = new RegExp(`\\b(${[...HELPER_NAMES].map(escapeRegex).join("|")})\\b`, "g");

/**
 * Mask block comments so `operationName:` literals inside `/* ... *\/`
 * spans don't register as invocations. Same approach as
 * `check-e2e-coverage.ts maskBlockComments`.
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

function isServiceCandidate(path: string): boolean {
  if (!path.startsWith(SERVICES_PREFIX)) return false;
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.includes("/__tests__/")) return false;
  return true;
}

function readSourceLines(abs: string): string[] | null {
  try {
    const stat = statSync(abs);
    if (stat.size > 4 * 1024 * 1024) return null;
    return readFileSync(abs, "utf8").split("\n");
  } catch {
    return null;
  }
}

function findInvocations(serviceFiles: string[], repoRoot: string): InvocationSite[] {
  const sites: InvocationSite[] = [];
  for (const relPath of serviceFiles) {
    const abs = join(repoRoot, relPath);
    const lines = readSourceLines(abs);
    if (lines === null) continue;
    const blockMask = maskBlockComments(lines);
    for (let i = 0; i < lines.length; i++) {
      if (blockMask[i] === true) continue;
      const line = lines[i] ?? "";
      const opMatch = line.match(OPERATION_NAME_RE);
      if (opMatch !== null) {
        sites.push({ filePath: relPath, line: i + 1, operation: opMatch[1] ?? "" });
        continue;
      }
      // Helper-wrapped: scan forward up to HELPER_SNIPPET_WINDOW lines for the
      // `"<OpName>"` literal at positional arg 1.
      HELPER_NAME_RE.lastIndex = 0;
      let helperHit: RegExpExecArray | null;
      while ((helperHit = HELPER_NAME_RE.exec(line)) !== null) {
        // Skip function definition sites (`function callX(`).
        const pre = line.slice(0, helperHit.index);
        if (/\bfunction\s+$/.test(pre)) continue;
        const snippet = lines.slice(i, Math.min(i + HELPER_SNIPPET_WINDOW, lines.length)).join("\n");
        // Match: ( anyFirstArg , "OpName" — tolerate generics like `<T>`.
        const m = /\s*(?:<[^>]*>)?\s*\([^,)]+,\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/.exec(
          snippet.slice(helperHit.index + (helperHit[1]?.length ?? 0)),
        );
        if (m !== null && m[1] !== undefined) {
          sites.push({ filePath: relPath, line: i + 1, operation: m[1] });
        }
      }
    }
  }
  return sites;
}

// ─── Merge construction analysis ────────────────────────────────────

/**
 * Extract top-level property NAMES from an object literal body. Accepts
 * the body text between `{` and the matching `}`. Conservative: counts
 * `name:`, `"name":`, and ES6 shorthand `name,`/`name }` at depth 0.
 */
function extractTopLevelKeys(body: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null;
  let prevCh = "";
  let token = "";
  let expectingKey = true;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (inStr !== null) {
      if (ch === inStr && prevCh !== "\\") inStr = null;
      prevCh = ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      prevCh = ch;
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      // line comment
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < body.length - 1 && !(body[i] === "*" && body[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (depth === 0 && expectingKey) {
      if (/[A-Za-z0-9_$]/.test(ch) || ch === '"' || ch === "'") {
        token += ch === '"' || ch === "'" ? "" : ch;
        if (ch === '"' || ch === "'") {
          // accumulate quoted key
          let j = i + 1;
          while (j < body.length && body[j] !== ch) {
            token += body[j] ?? "";
            j++;
          }
          i = j;
        }
        prevCh = ch;
        continue;
      }
      if (ch === ":") {
        if (token.length > 0) keys.add(token);
        token = "";
        expectingKey = false;
      } else if (ch === "," || ch === "}" || ch === "\n" || ch === " " || ch === "\t") {
        // ES6 shorthand: `name,` or `name }` — accept if a token accumulated.
        if (token.length > 0 && (ch === "," || ch === "}")) {
          keys.add(token);
        }
        if (ch === ",") {
          token = "";
          expectingKey = true;
        }
      }
    } else if (depth === 0 && !expectingKey) {
      if (ch === ",") {
        expectingKey = true;
        token = "";
      }
    }
    prevCh = ch;
  }
  // Flush trailing shorthand token (body slice doesn't include closing `}`).
  if (expectingKey && token.length > 0) keys.add(token);
  return keys;
}

/**
 * Find the matching closing-brace index for a `{` at position `open`. Returns
 * -1 if unbalanced. Handles nested braces and string literals.
 */
function findMatchingBrace(text: string, open: number): number {
  if (text[open] !== "{") return -1;
  let depth = 1;
  let inStr: '"' | "'" | "`" | null = null;
  let prevCh = "";
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inStr !== null) {
      if (ch === inStr && prevCh !== "\\") inStr = null;
      prevCh = ch;
      continue;
    }
    // Skip comments BEFORE string-delimiter detection — backticks/quotes
    // inside comments must not toggle string mode.
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      prevCh = "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      prevCh = "/";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      prevCh = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    prevCh = ch;
  }
  return -1;
}

/**
 * Extract the value expression for `<wrapperKey>: <expr>` in the substring
 * `variablesBody`. Returns the raw expression text (trimmed) or null. The
 * expression terminates at the comma/closing-brace at depth 0.
 */
function extractWrapperValue(variablesBody: string, wrapperKey: string): string | null {
  // Match `<wrapperKey>:` at depth 0. Falls back to ES6 shorthand `{ ..., <wrapperKey> ... }`
  // by treating the shorthand as `<wrapperKey>: <wrapperKey>`.
  const keyColonRe = new RegExp(`\\b${escapeRegex(wrapperKey)}\\s*:\\s*`);
  const m = keyColonRe.exec(variablesBody);
  if (m === null) {
    // Shorthand lookahead tolerates end-of-string and end-of-line as
    // implicit closing-brace context (the body was sliced INSIDE `{}`).
    const shorthandRe = new RegExp(`(?:^|[,{\\s])(${escapeRegex(wrapperKey)})\\s*(?=[,}\\s]|$)`);
    const sh = shorthandRe.exec(variablesBody);
    if (sh !== null) return wrapperKey;
    return null;
  }
  let i = m.index + m[0].length;
  // Scan forward, tracking depth.
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null;
  let prevCh = "";
  let value = "";
  for (; i < variablesBody.length; i++) {
    const ch = variablesBody[i] ?? "";
    if (inStr !== null) {
      value += ch;
      if (ch === inStr && prevCh !== "\\") inStr = null;
      prevCh = ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      value += ch;
      prevCh = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && ch === ",") break;
    value += ch;
    prevCh = ch;
  }
  return value.trim();
}

/**
 * For the invocation site, find the nearest `variables:` literal below and
 * return its body text (between the opening and closing `{`). Falls back
 * to scanning the immediate helper-call form (which doesn't use `variables:`).
 */
function findVariablesBody(lines: readonly string[], invocationLine: number): string | null {
  // The invocation line is 1-indexed; convert to 0-indexed.
  const startIdx = Math.max(0, invocationLine - 1);
  const endIdx = Math.min(lines.length, invocationLine - 1 + VARIABLES_SEARCH_WINDOW);
  const window = lines.slice(startIdx, endIdx).join("\n");

  // Pattern A: `variables: { ... }` (full impersonatedTransport form).
  const varMatch = /\bvariables\s*:\s*\{/.exec(window);
  if (varMatch !== null) {
    const openIdx = varMatch.index + varMatch[0].length - 1;
    const close = findMatchingBrace(window, openIdx);
    if (close !== -1) return window.slice(openIdx + 1, close);
  }

  // Pattern B: helper-call form — `callX(token, "Op", QUERY, { input: { ... } }, ...)`.
  // Look for `{ input:` as a partial.
  const inputMatch = /\{\s*input\s*:\s*\{/.exec(window);
  if (inputMatch !== null) {
    // Re-anchor: the outer brace is the variables body. We want input: { ... }
    // as the wrapper for our search. Return a synthesized "variables-like"
    // body where the input: { ... } literal is the top-level entry.
    const openIdx = inputMatch.index;
    const close = findMatchingBrace(window, openIdx);
    if (close !== -1) return window.slice(openIdx + 1, close);
  }

  return null;
}

/**
 * Resolve an identifier `name` to its construction in the same file. Returns
 * the union of property names from:
 *   - The declaration's RHS object literal (if any).
 *   - Any `name.<key> = ...` assignments before `endLineExclusive`.
 *
 * Walks the entire file (no line ordering restriction on the declaration —
 * helpers can be declared below or above).
 */
function resolveIdentifierFields(
  lines: readonly string[],
  name: string,
  endLineExclusive: number,
  visited: Set<string> = new Set(),
): Set<string> {
  const fields = new Set<string>();
  if (visited.has(`id:${name}`)) return fields;
  visited.add(`id:${name}`);
  const text = lines.join("\n");

  // Find declaration: `(const|let|var)\s+<name>` then scan procedurally
  // past any type annotation to the `=`. Tracks {}[]<>() depth so inline
  // object types `{ ... }`, generics `X<Y>`, indexed types `X["y"]`, and
  // function types `(...) => T` are skipped correctly.
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegex(name)}\\b`, "g");
  let declMatch: RegExpExecArray | null;
  while ((declMatch = declRe.exec(text)) !== null) {
    // Scan forward for the assignment `=` (NOT `=>`).
    let scan = declMatch.index + declMatch[0].length;
    let depth = 0;
    let inStr: '"' | "'" | "`" | null = null;
    let prevCh = "";
    let foundEq = -1;
    while (scan < text.length) {
      const ch = text[scan] ?? "";
      if (inStr !== null) {
        if (ch === inStr && prevCh !== "\\") inStr = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
      } else if (ch === "{" || ch === "[" || ch === "(" || ch === "<") depth++;
      else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") depth--;
      else if (
        depth === 0 &&
        ch === "=" &&
        text[scan + 1] !== ">" &&
        prevCh !== "=" &&
        prevCh !== "!" &&
        prevCh !== "<"
      ) {
        foundEq = scan;
        break;
      } else if (depth === 0 && ch === ";") break;
      prevCh = ch;
      scan++;
    }
    if (foundEq === -1) continue;
    let i = foundEq + 1;
    while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\t")) i++;
    if (text[i] === "{") {
      const close = findMatchingBrace(text, i);
      if (close !== -1) {
        const body = text.slice(i + 1, close);
        for (const k of extractTopLevelKeys(body)) fields.add(k);
      }
    } else if (/[A-Za-z_]/.test(text[i] ?? "")) {
      // Function call form: `buildX(...)`. Try to find the function definition.
      const callRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
      const callMatch = callRe.exec(text.slice(i));
      if (callMatch !== null && callMatch[1] !== undefined) {
        const fnFields = resolveFunctionReturnFields(lines, callMatch[1], visited);
        for (const f of fnFields) fields.add(f);
      }
    }
  }

  // Find `name.<key> = ...` assignments before endLineExclusive.
  const assignRe = new RegExp(`\\b${escapeRegex(name)}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*`, "g");
  let assignMatch: RegExpExecArray | null;
  while ((assignMatch = assignRe.exec(text)) !== null) {
    const upto = text.slice(0, assignMatch.index);
    const lineIdx = upto.split("\n").length - 1;
    if (lineIdx + 1 < endLineExclusive && assignMatch[1] !== undefined) {
      fields.add(assignMatch[1]);
    }
  }
  return fields;
}

/**
 * Find function definition `function <name>(...)` and resolve the fields
 * surfaced by its return statements. Combines:
 *   - Object-literal returns: `return { ... };` — top-level keys.
 *   - Spread returns: `return { ...x, ...y };` — recursively resolves
 *     each spread identifier within the function body.
 *   - Variable returns: `return foo;` — resolves `foo` via the same
 *     identifier pathway, scoped to the function body.
 */
function resolveFunctionReturnFields(
  lines: readonly string[],
  name: string,
  visited: Set<string> = new Set(),
): Set<string> {
  const fields = new Set<string>();
  if (visited.has(`fn:${name}`)) return fields;
  visited.add(`fn:${name}`);
  const text = lines.join("\n");
  // Function definition: `function <name>(...)` or `export function <name>(...)`.
  const fnRe = new RegExp(`\\bfunction\\s+${escapeRegex(name)}\\s*\\(`, "g");
  const fnMatch = fnRe.exec(text);
  if (fnMatch === null) return fields;
  // Find body: scan forward from the `(` to find the matching `)`, then `{`.
  let i = fnMatch.index + fnMatch[0].length;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const ch = text[i] ?? "";
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  // Skip return-type annotation if present.
  while (i < text.length && text[i] !== "{") i++;
  if (text[i] !== "{") return fields;
  const bodyClose = findMatchingBrace(text, i);
  if (bodyClose === -1) return fields;
  const body = text.slice(i + 1, bodyClose);
  // Convert body offset to line range for resolveIdentifierFields scoping.
  const bodyStartLine = text.slice(0, i).split("\n").length;
  const bodyEndLine = text.slice(0, bodyClose).split("\n").length;

  // Find all `return ...;` statements.
  const returnRe = /\breturn\b\s+/g;
  let m: RegExpExecArray | null;
  while ((m = returnRe.exec(body)) !== null) {
    const start = m.index + m[0].length;
    // Object literal?
    let j = start;
    while (j < body.length && (body[j] === " " || body[j] === "\n" || body[j] === "\t")) j++;
    if (body[j] === "{") {
      const close = findMatchingBrace(body, j);
      if (close !== -1) {
        const literalBody = body.slice(j + 1, close);
        for (const k of extractTopLevelKeys(literalBody)) fields.add(k);
        // Also recursively resolve any `...<ident>` spreads inside the literal.
        const spreadRe = /\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g;
        let s: RegExpExecArray | null;
        while ((s = spreadRe.exec(literalBody)) !== null) {
          const ident = s[1];
          if (ident === undefined || NON_RESOLVABLE_IDENTS.has(ident)) continue;
          const spreadFields = resolveIdentifierFields(lines, ident, bodyEndLine, visited);
          for (const f of spreadFields) fields.add(f);
        }
        continue;
      }
    }
    // Identifier return: `return foo;`.
    const identMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*;/.exec(body.slice(j));
    if (identMatch !== null && identMatch[1] !== undefined) {
      const ident = identMatch[1];
      const identFields = resolveIdentifierFields(lines, ident, bodyEndLine, visited);
      for (const f of identFields) fields.add(f);
    }
  }
  // Also handle direct `<varName>.<key> = ...` assignments within the body
  // when the function returns that variable.
  void bodyStartLine;
  return fields;
}

/**
 * Given an invocation site, analyse the merge construction and return the
 * sent-field set.
 */
function analyseMerge(lines: string[], invocation: InvocationSite, wrapperKey: string): MergeAnalysis {
  const analysis: MergeAnalysis = {
    invocation,
    wrapperKey,
    payloadExpr: null,
    sentFields: new Set<string>(),
    notes: [],
  };

  const variablesBody = findVariablesBody(lines, invocation.line);
  if (variablesBody === null) {
    analysis.notes.push("variables-literal-not-found");
    return analysis;
  }

  // Locate `input: { ... }` inside the variables body (the wrapper's parent).
  const inputRe = /\binput\s*:\s*\{/;
  const inputMatch = inputRe.exec(variablesBody);
  let wrapperParentBody: string;
  if (inputMatch !== null) {
    const openIdx = inputMatch.index + inputMatch[0].length - 1;
    const close = findMatchingBrace(variablesBody, openIdx);
    if (close === -1) {
      analysis.notes.push("input-literal-unbalanced");
      return analysis;
    }
    wrapperParentBody = variablesBody.slice(openIdx + 1, close);
  } else {
    // Already inside the input body (helper-call pattern returned input: { ... } content).
    wrapperParentBody = variablesBody;
  }

  const payloadExpr = extractWrapperValue(wrapperParentBody, wrapperKey);
  if (payloadExpr === null) {
    analysis.notes.push(`wrapper-key-${wrapperKey}-not-found`);
    return analysis;
  }
  analysis.payloadExpr = payloadExpr;

  // Case A: inline literal `{ ... }`.
  if (payloadExpr.startsWith("{")) {
    const close = findMatchingBrace(payloadExpr, 0);
    if (close === -1) {
      analysis.notes.push("payload-literal-unbalanced");
      return analysis;
    }
    const body = payloadExpr.slice(1, close);
    for (const k of extractTopLevelKeys(body)) analysis.sentFields.add(k);
    // Resolve any spreads inside the literal too.
    const spreadRe = /\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let s: RegExpExecArray | null;
    while ((s = spreadRe.exec(body)) !== null) {
      const ident = s[1];
      if (ident === undefined || NON_RESOLVABLE_IDENTS.has(ident)) continue;
      const spreadFields = resolveIdentifierFields(lines, ident, invocation.line);
      for (const f of spreadFields) analysis.sentFields.add(f);
    }
    return analysis;
  }

  // Case B/C: identifier expression. Scan for ALL identifier tokens and
  // resolve each — this handles simple variables (`merged`), function calls
  // (`buildX(...)`), and fallback expressions (`a ?? b`, `a || b`, ternaries).
  const idents = extractIdentifiers(payloadExpr);
  if (idents.length === 0) {
    analysis.notes.push("payload-expr-no-identifiers");
    return analysis;
  }
  const callRe = new RegExp(`\\b(${idents.map(escapeRegex).join("|")})\\s*\\(`);
  for (const ident of idents) {
    if (NON_RESOLVABLE_IDENTS.has(ident)) continue;
    const isCall = callRe.exec(payloadExpr)?.[1] === ident;
    if (isCall) {
      const fnFields = resolveFunctionReturnFields(lines, ident);
      for (const f of fnFields) analysis.sentFields.add(f);
    } else {
      const idFields = resolveIdentifierFields(lines, ident, invocation.line + RESOLUTION_WINDOW_UP);
      for (const f of idFields) analysis.sentFields.add(f);
    }
  }
  if (analysis.sentFields.size === 0) {
    analysis.notes.push(`payload-expr-unresolved:${idents.join(",")}`);
  }
  return analysis;
}

/**
 * Extract identifier-like tokens from an expression (member-access roots
 * like `input.transformation` contribute `input`; nullish-coalescing fallbacks
 * `a ?? b` contribute both `a` and `b`).
 */
function extractIdentifiers(expr: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const t = m[1];
    if (t === undefined) continue;
    if (t === "null" || t === "undefined" || t === "true" || t === "false") continue;
    // Skip member-access continuations: `foo.bar` should yield only `foo`.
    const prevCh = expr[m.index - 1];
    if (prevCh === ".") continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// ─── Exemption parsing ──────────────────────────────────────────────

const EXEMPT_RE = /\/\/\s*merge-complete-exempt:\s*([A-Za-z_][A-Za-z0-9_]*)\s*[-—:]\s*(.+?)\s*$/;

function loadExemptions(filePath: string, repoRoot: string): ExemptedField[] {
  const abs = join(repoRoot, filePath);
  const lines = readSourceLines(abs);
  if (lines === null) return [];
  const out: ExemptedField[] = [];
  for (const line of lines) {
    const m = EXEMPT_RE.exec(line);
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      out.push({ field: m[1], reason: m[2] });
    }
  }
  return out;
}

// ─── Main ───────────────────────────────────────────────────────────

interface RunReport {
  gaps: GapReport[];
  unmatchedCaptures: CaptureRoster[];
  invocationsScanned: number;
  capturesScanned: number;
}

function run(): RunReport {
  const repoRoot = gitTopLevel();
  const tracked = listTrackedFiles(repoRoot);
  const serviceFiles = tracked.filter(isServiceCandidate);

  const capturesDir = findCapturesDir(repoRoot);
  if (capturesDir === null) {
    process.stderr.write(
      `[check-merge-completeness] research repo not found at ../research/captures/web/inputs — skipping.\n`,
    );
    return { gaps: [], unmatchedCaptures: [], invocationsScanned: 0, capturesScanned: 0 };
  }
  const captureFiles = listCaptureFiles(capturesDir);
  const captures: CaptureRoster[] = [];
  for (const cf of captureFiles) {
    const c = loadCapture(cf);
    if (c !== null) captures.push(c);
  }

  const invocations = findInvocations(serviceFiles, repoRoot);

  const gaps: GapReport[] = [];
  const unmatchedCaptures: CaptureRoster[] = [];

  for (const capture of captures) {
    const match = invocations.find((i) => i.operation === capture.operation);
    if (match === undefined) {
      unmatchedCaptures.push(capture);
      continue;
    }
    const abs = join(repoRoot, match.filePath);
    const lines = readSourceLines(abs);
    if (lines === null) {
      gaps.push({ capture, analysis: null, missing: [...capture.payloadFields], exempted: [] });
      continue;
    }
    const analysis = analyseMerge(lines, match, capture.wrapperKey);
    const exemptions = loadExemptions(match.filePath, repoRoot);
    const exemptedNames = new Set(exemptions.map((e) => e.field));
    const missing: string[] = [];
    const exempted: ExemptedField[] = [];
    for (const f of capture.payloadFields) {
      if (analysis.sentFields.has(f)) continue;
      if (exemptedNames.has(f)) {
        const ex = exemptions.find((e) => e.field === f);
        if (ex !== undefined) exempted.push(ex);
        continue;
      }
      missing.push(f);
    }
    gaps.push({ capture, analysis, missing, exempted });
  }

  return {
    gaps,
    unmatchedCaptures,
    invocationsScanned: invocations.length,
    capturesScanned: captures.length,
  };
}

function formatReport(report: RunReport, strict: boolean): { exitCode: 0 | 1; text: string } {
  const lines: string[] = [];
  let nonExemptGapCount = 0;
  let withGap = 0;

  for (const g of report.gaps) {
    const hasGap = g.missing.length > 0;
    const hasExempted = g.exempted.length > 0;
    if (!hasGap && !hasExempted && (g.analysis === null || g.analysis.notes.length === 0)) continue;
    withGap++;
    const captureRel = relative(gitTopLevel(), g.capture.filePath);
    const siteRel =
      g.analysis === null ? "?" : `${g.analysis.invocation.filePath}:${String(g.analysis.invocation.line)}`;
    lines.push(`\n  ${g.capture.operation}  (capture: ${captureRel})`);
    lines.push(`    site: ${siteRel}    payload-type: ${g.capture.payloadType}`);
    if (g.analysis !== null && g.analysis.notes.length > 0) {
      lines.push(`    notes: ${g.analysis.notes.join(", ")}`);
    }
    if (g.exempted.length > 0) {
      lines.push(`    exempted (${String(g.exempted.length)}):`);
      for (const e of g.exempted) lines.push(`      - ${e.field}: ${e.reason}`);
    }
    if (g.missing.length > 0) {
      nonExemptGapCount += g.missing.length;
      lines.push(`    MISSING (${String(g.missing.length)}): ${g.missing.join(", ")}`);
    }
  }

  let header: string;
  if (lines.length === 0) {
    header = `check-merge-completeness: ${String(report.capturesScanned)} captures scanned, ${String(report.invocationsScanned)} invocations, no gaps`;
  } else {
    header = `check-merge-completeness: ${String(nonExemptGapCount)} non-exempt gaps across ${String(withGap)} operation(s)`;
  }
  const unmatched = report.unmatchedCaptures.length;
  const unmatchedNote = unmatched > 0 ? `, ${String(unmatched)} capture(s) with no matching ttctl invocation` : "";
  const mode = strict ? "strict" : "warn";

  return {
    exitCode: strict && nonExemptGapCount > 0 ? 1 : 0,
    text: `${header}${unmatchedNote} [${mode}]${lines.join("\n")}\n`,
  };
}

function main(): void {
  const strict = process.argv.includes("--strict") || process.env["MERGE_COMPLETENESS_STRICT"] === "1";
  const report = run();
  const { exitCode, text } = formatReport(report, strict);
  process.stderr.write(text);
  process.exit(exitCode);
}

// Avoid running on import (e.g., for ad-hoc tooling reuse).
const invokedAsScript = (() => {
  try {
    const argv1 = process.argv[1];
    if (argv1 === undefined) return false;
    const here = dirname(new URL(import.meta.url).pathname);
    return resolve(argv1).startsWith(here);
  } catch {
    return true;
  }
})();
if (invokedAsScript) main();
