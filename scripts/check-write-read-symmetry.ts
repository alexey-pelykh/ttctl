#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Class B gap defense — write-input ⊆ read-output symmetry check
 * (issue #350).
 *
 * Class B is the recurring pattern where a service's write function
 * accepts a field on its input interface but the matching read function
 * (or, when no read fn exists, the write fn's own response interface)
 * does NOT echo that field on its output interface. Result: the agent
 * can SET the value but cannot VERIFY it persisted or DISPLAY it
 * afterwards. The four known instances at first-run authoring time:
 *
 *   - #340 (now symmetric post-#127): basic.set bio/headline ↔ basic.show.
 *     (Detected only at the MCP-output layer; the core service is paired.)
 *   - #344: employment.update {publicationPermit, industryIds,
 *     primaryGeographyId, reportingTo} ↔ Employment read shape.
 *   - #345: external.update twitter ↔ UpdateExternalProfilesResult.profile.
 *   - #346: engagements.breaks.add reasonIdentifier ↔ EngagementBreak.
 *
 * This script is the structural CI-time defense against regression of
 * the gap class. It walks the typed service modules under
 *
 *   - packages/core/src/services/profile/**\/index.ts
 *   - packages/core/src/services/engagements/**\/index.ts
 *   - packages/core/src/services/payments/**\/index.ts
 *
 * parses `export interface Foo { … }` declarations and `export (async)?
 * function name(…): RetType` signatures (including method-shorthand
 * properties inside `export const namespace = { … }` blocks for the
 * engagements.breaks pattern), pairs each write fn with the appropriate
 * echo interface, and asserts every field on the write input also
 * appears in the echo interface's recursive field-name set (depth 2 —
 * top + one nested level, sufficient for the wrapper-shape patterns
 * used today such as `UpdateExternalProfilesResult { profile: { … } }`).
 *
 * ## Detection scope
 *
 *   - **Write functions**: name matches `^(add|set|update|change|save|
 *     upsert|create|reschedule)$` (top-level OR namespace method
 *     shorthand). The "write input" is the FIRST non-token parameter
 *     whose type is a non-scalar capitalized identifier, with a small
 *     exclusion list for runtime-options interfaces that are NOT
 *     write-shape inputs (`DryRunOptions`, `SetOptions`, `ListOptions`,
 *     `PaginationOptions`). The exclusion list lives in
 *     `INTERNAL_OPTIONS_TYPES` — extend it if a sibling option-bag
 *     interface is added.
 *   - **Read functions**: name matches `^(show|list|get)` (prefix).
 *     The "read output" is the return type with `Promise<X>`, `X[]`,
 *     and `X | null` unwrapped to `X`.
 *   - **Echo fallback**: when a write fn's pairing scope has no read fn
 *     (e.g., `profile.external.update` writes to URLs that have no
 *     `show()`), the write fn's OWN unwrapped return type is the echo.
 *     This is what catches #345 (UpdateExternalProfilesResult omits
 *     `twitter`).
 *   - **Pairing scope**: per file by default, OR per namespace when a
 *     write fn sits inside an `export const NAME = { … }` block. The
 *     engagements/index.ts file uses this pattern for `breaks`,
 *     `engagements`, etc.; pairing within the namespace prevents
 *     cross-namespace false positives (`AddBreakOptions` is paired with
 *     `breaks.list()` returning `EngagementBreak[]`, NOT with the
 *     top-level `list()` returning `EngagementListItem[]`).
 *
 * ## Field-name extraction
 *
 *   - **Write input field set**: top-level (interface body depth 1)
 *     property NAMES only. Nested object types' inner property names
 *     are NOT included — `metadata: { source: string }` contributes
 *     `metadata`, not `source`.
 *   - **Echo field set**: ALL property NAMES at any depth within the
 *     interface body (up to `ECHO_REACHABILITY_DEPTH`), PLUS the
 *     top-level field names of every interface referenced by name in
 *     a property's type expression — expanded transitively with cycle
 *     protection. This handles BOTH wrapper-shape patterns like
 *     `UpdateExternalProfilesResult { profile: { id, linkedin, …,
 *     dribbble }, notice }` (inline nesting) AND named-reference
 *     patterns like `RateProjection { lastChange: RateChangeRequest
 *     | null, … }` where the echoed leaf names live inside a separately
 *     declared interface (the reference-expansion pass merges
 *     `RateChangeRequest`'s top-level fields — `desiredRate`,
 *     `talentComment`, etc. — into `RateProjection`'s reachable set).
 *     Built-in generics (`Promise`, `Record`, `Array`, etc., per
 *     `BUILTIN_TYPE_NAMES`) are filtered out.
 *
 * The comparison key is the FIELD NAME ONLY. Type-shape comparison is
 * out of scope — the gap class is "field not echoed at all", not "field
 * echoed with a narrower / different type". A write field whose name
 * appears at ANY depth in the echo interface's reachable name set is
 * considered "echoed".
 *
 * ## Exemption mechanism
 *
 *   - **Per-field**: place `// write-only: <reason>` on the line
 *     immediately above the field declaration in the write-input
 *     interface body. The reason is mandatory and surfaces in the
 *     report so reviewers can audit it. Use cases: passwords, tokens,
 *     file-upload payloads, dry-run / preview flags, anything where
 *     round-tripping the value through a read makes no semantic sense.
 *
 *     ```ts
 *     export interface PasswordChangeInput {
 *       currentPassword: string;  // write-only: secret, never echoed
 *       newPassword: string;      // write-only: secret, never echoed
 *     }
 *     ```
 *
 *   - **Per-pair override**: place `// write-read-pair: WriteName =>
 *     ReadName` anywhere within a file (typically near the write fn
 *     declaration). Forces the pairing to use the named echo interface
 *     instead of the auto-detected one. Useful when the auto-detection
 *     picks the wrong read fn (e.g., when a file has multiple read fns
 *     for different shapes and the script's first-match heuristic picks
 *     the wrong one). Cross-FILE pairings are NOT supported today; for
 *     those, add the override on a function declared in the same file
 *     as the write fn (typically by re-exporting the echo interface).
 *
 *     ```ts
 *     // write-read-pair: RateChangeOptions => RateChangeRequest
 *     export async function rate.change(…): Promise<…>
 *     ```
 *
 * ## Modes
 *
 *   - **warn** (default): always exits 0. Asymmetries are reported to
 *     stderr for visibility. Suitable for the initial gap-paydown wave.
 *   - **strict** (`--strict` flag or `WRITE_READ_SYMMETRY_STRICT=1`
 *     env): exits non-zero if any non-exempt asymmetry is detected.
 *     Flip to strict once the existing gaps are closed (per AC #5/#6
 *     of #350).
 *
 * ## Output
 *
 *   - stdout: per-pair report — `WRITE_NAME ↔ ECHO_NAME (scope) : N/M
 *     echoed` lines with per-field disposition (`echoed` / `write-only:
 *     <reason>` / `GAP`).
 *   - stderr: gap lines for non-exempt missing fields, plus a summary
 *     in warn mode.
 *
 * ## Exit codes
 *
 *   - 0 — warn-mode (always) OR strict-mode with zero non-exempt gaps.
 *   - 1 — strict-mode with at least one non-exempt gap.
 *
 * Wired into the root `lint` script via `package.json` so PR CI runs
 * it on every push, in parallel with `check-secret-leakage`,
 * `check-e2e-coverage`, and `check-dep-confusion`.
 *
 * ## Limitations (v1)
 *
 *   - Type-shape comparison is not performed (see "Field-name
 *     extraction" above — names only).
 *   - Cross-file pairing requires moving / re-exporting the echo
 *     interface into the same file as the write fn. A YAML config
 *     (`.write-read-pairs.yaml`) is scaffolded-out of v1 for
 *     simplicity; promote to YAML if cross-file pairings accumulate.
 *   - `interface A extends B { … }` does NOT pull `B`'s fields into
 *     `A`'s reachable set today; the linter only walks `A`'s literal
 *     body and follows named references appearing in property TYPES
 *     (not in the `extends` clause). If a pattern emerges where a
 *     read-output interface relies on `extends` to inherit echoed
 *     fields, extend the parser. The current target services don't
 *     use this pattern at the echo surface.
 *   - Cross-file interface references are NOT resolved — the
 *     reference-expansion pass operates on file-local interfaces only.
 *     If an echo type pulls fields from an interface declared in a
 *     sibling file, those fields appear as gaps unless the referenced
 *     interface is moved into the same file or covered by a
 *     `// write-read-pair:` override.
 *   - Index signatures (`[key: string]: …`) and mapped types are
 *     ignored — they don't carry named field declarations.
 *
 * Sibling pattern: see `scripts/check-e2e-coverage.ts` for the same
 * file-walk + tracked-files + warn/strict + comment-directive
 * architecture (issue #63).
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Path prefixes that contribute service-module scans. */
const SCAN_PREFIXES: readonly string[] = [
  "packages/core/src/services/profile/",
  "packages/core/src/services/engagements/",
  "packages/core/src/services/payments/",
];

/** Write-fn names. */
const WRITE_FN_NAMES = new Set<string>(["add", "set", "update", "change", "save", "upsert", "create", "reschedule"]);

/** Read-fn name PREFIXES (e.g. `show`, `list`, `getXxx`). */
const READ_FN_PREFIXES: readonly string[] = ["show", "list", "get"];

/**
 * Param interface names that are runtime call-options, NOT write-shape
 * inputs. Extend if a new sibling option-bag interface is added.
 */
const INTERNAL_OPTIONS_TYPES = new Set<string>(["DryRunOptions", "SetOptions", "ListOptions", "PaginationOptions"]);

/** Scalar / built-in type names that are never write-input interfaces. */
const SCALAR_TYPES = new Set<string>([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "void",
  "null",
  "undefined",
  "any",
  "unknown",
  "never",
  "Date",
  "Buffer",
  "Uint8Array",
]);

/** Max recursion depth when walking nested object-type bodies for echo field-names. */
const ECHO_REACHABILITY_DEPTH = 2;

/**
 * Built-in TypeScript and ambient type names that may legitimately
 * appear as capitalized identifiers in a property's type expression
 * but are NOT user-declared interfaces. The reference-expansion pass
 * skips these so they're not treated as interface references.
 */
const BUILTIN_TYPE_NAMES = new Set<string>([
  "Promise",
  "Array",
  "Record",
  "Readonly",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "Parameters",
  "Awaited",
  "Map",
  "Set",
  "Date",
  "Error",
  "RegExp",
  "Buffer",
  "Uint8Array",
  "ArrayBuffer",
  "URL",
  "URLSearchParams",
]);

/** Matches a capitalized identifier token (start with upper case ASCII). */
const CAPITALIZED_IDENT_RE = /\b([A-Z][A-Za-z0-9_]*)\b/g;

interface InterfaceDecl {
  /** Interface name as declared. */
  name: string;
  /** 1-indexed line where the `export interface Name {` opening appears. */
  line: number;
  /** Top-level (depth 1) property names. */
  topFieldNames: string[];
  /**
   * All property names reachable up to {@link ECHO_REACHABILITY_DEPTH}
   * (top + nested inline-object types). Expanded post-extraction to
   * also include the top-level field names of REFERENCED interfaces
   * (e.g. `RateProjection.lastChange: RateChangeRequest | null` pulls
   * `RateChangeRequest`'s top-level fields into `RateProjection`'s
   * reachable set). Used for echo comparison.
   */
  reachableFieldNames: Set<string>;
  /**
   * Capitalized identifier tokens appearing on the type-expression side
   * of each top-level property declaration. Used by the post-extraction
   * reference-expansion pass to merge referenced interfaces' fields
   * into this interface's `reachableFieldNames`. Includes only names
   * resolvable to interfaces in the same file's parsed table (built-in
   * generics like `Promise` / `Record` / `Array` and ambient types are
   * filtered out at use-site via the {@link BUILTIN_TYPE_NAMES} skip
   * list).
   */
  referencedTypeNames: Set<string>;
  /** Per-top-level-field `// write-only: <reason>` markers. Keyed by field name. */
  writeOnlyMarkers: Map<string, string>;
}

interface FunctionDecl {
  /** Function name (e.g. `update`, `list`, `breaks.add`). Namespace-prefixed when inside `export const ns = { … }`. */
  name: string;
  /** Bare name without namespace prefix. */
  bareName: string;
  /** Namespace scope, or `null` for top-level. */
  scope: string | null;
  /** 1-indexed line of the signature. */
  line: number;
  /** Parameter type-name list, in declaration order. */
  paramTypes: string[];
  /** Return type with `Promise<…>`, `…[]`, `… | null/undefined` unwrapped. */
  returnTypeName: string | null;
}

interface ParsedFile {
  /** Repo-relative POSIX path. */
  file: string;
  interfaces: Map<string, InterfaceDecl>;
  functions: FunctionDecl[];
  /** Inline pair overrides: WRITE_NAME → READ_NAME. */
  pairOverrides: Map<string, string>;
}

interface PairFinding {
  file: string;
  scope: string | null;
  writeName: string;
  echoName: string;
  echoSource: "read-fn" | "write-return" | "override";
  /** Per-field disposition. */
  fields: { name: string; status: "echoed" | "write-only" | "gap"; reason?: string }[];
}

interface RunReport {
  pairs: PairFinding[];
  /** Diagnostic warnings (e.g. unresolved interface, malformed override). */
  warnings: string[];
}

/** Matches any run of CR/LF — used to flatten multi-line parameter lists into a single string for splitting. */
const NEWLINE_RUN_RE = /[\r\n]+/g;

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

function isInScopeFile(relPath: string): boolean {
  if (!relPath.endsWith(".ts")) return false;
  if (relPath.endsWith(".d.ts")) return false;
  if (relPath.endsWith(".test.ts")) return false;
  if (relPath.includes("/__tests__/")) return false;
  if (relPath.endsWith("/shared.ts") || relPath.endsWith("/_shared.ts")) return false;
  return SCAN_PREFIXES.some((pfx) => relPath.startsWith(pfx));
}

function readSourceLines(absPath: string): string[] | null {
  try {
    const stat = statSync(absPath);
    if (stat.size > 4 * 1024 * 1024) return null;
    return readFileSync(absPath, "utf8").split("\n");
  } catch {
    return null;
  }
}

/**
 * Mask block-comment spans line-by-line. Mirrors the implementation in
 * `scripts/check-e2e-coverage.ts` (kept in sync for behavioural parity
 * — both scripts treat JSDoc bodies as comment lines).
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

const INTERFACE_OPEN_RE = /^\s*export\s+interface\s+([A-Z][A-Za-z0-9_]*)\s*(?:extends\s+[^{]+)?\{/;
const INTERFACE_PROP_RE = /^\s*(\w+)\??\s*:/;
const WRITE_ONLY_MARKER_RE = /^\s*\/\/\s*write-only\s*:\s*(.+?)\s*$/;
const PAIR_OVERRIDE_RE = /^\s*\/\/\s*write-read-pair\s*:\s*([A-Z][A-Za-z0-9_]*)\s*=>\s*([A-Z][A-Za-z0-9_]*)\s*$/;
const EXPORT_FN_RE = /^\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/;
const NS_OPEN_RE = /^\s*export\s+const\s+([a-zA-Z_][\w]*)\s*=\s*\{/;
const NS_METHOD_RE = /^\s+(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/;

/**
 * Count net `{`/`}` brace delta on `line`, IGNORING braces inside string
 * literals and line-comment tails. The interface and namespace parsers
 * use this to track scope depth precisely without a full AST.
 */
function braceDeltaForLine(line: string): number {
  const code = stripLineComment(line);
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let delta = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") {
      inSingle = !inSingle;
    } else if (!inSingle && !inTemplate && ch === '"') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble && ch === "`") {
      inTemplate = !inTemplate;
    } else if (!inSingle && !inDouble && !inTemplate) {
      if (ch === "{") delta += 1;
      else if (ch === "}") delta -= 1;
    }
    i += 1;
  }
  return delta;
}

function extractInterfaces(lines: readonly string[], inComment: readonly boolean[]): Map<string, InterfaceDecl> {
  const interfaces = new Map<string, InterfaceDecl>();
  for (let i = 0; i < lines.length; i++) {
    if (inComment[i]) continue;
    const codeLine = stripLineComment(lines[i] ?? "");
    const open = INTERFACE_OPEN_RE.exec(codeLine);
    if (open === null) continue;
    const name = open[1];
    if (name === undefined) continue;

    // Walk forward, tracking brace depth starting at 1 (we just passed
    // the opening `{` on the signature line). Keep BOTH the raw line
    // (for `// write-only:` marker detection — line-comment-bearing)
    // AND the stripped line (for property + brace detection).
    let depth = braceDeltaForLine(codeLine);
    const bodyLines: { raw: string; stripped: string }[] = [];
    let endLine = -1;
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      const rawLine = lines[j] ?? "";
      if (!inComment[j]) {
        bodyLines.push({ raw: rawLine, stripped: stripLineComment(rawLine) });
        // Only count braces in CODE lines — a JSDoc body containing `{` or `}`
        // (e.g. `{@link X}` or a multi-line example) must not perturb depth.
        // Mirrors the Phase B namespace parser in extractFunctions.
        depth += braceDeltaForLine(rawLine);
      } else {
        bodyLines.push({ raw: rawLine, stripped: "" }); // preserve indexing; JSDoc-style block-comment lines yield no code
      }
      if (depth === 0) {
        endLine = j;
        break;
      }
    }
    if (endLine === -1) continue; // unclosed; skip

    // Field-name extraction: track depth WITHIN the body so we can
    // distinguish top-level (depth 1) properties from nested-object
    // property names.
    const topFieldNames: string[] = [];
    const reachableFieldNames = new Set<string>();
    const referencedTypeNames = new Set<string>();
    const writeOnlyMarkers = new Map<string, string>();

    let bodyDepth = 1;
    let pendingWriteOnly: string | null = null;
    for (const bline of bodyLines) {
      const stripped = bline.stripped;
      const trimmed = stripped.replace(/^\s+/, "");

      // Track a `// write-only:` marker for the NEXT non-empty
      // property-bearing line. Marker detection runs on the RAW line
      // (line-comment-bearing); property detection runs on STRIPPED.
      // Lines that are pure-marker carry no brace delta.
      const markerMatch = WRITE_ONLY_MARKER_RE.exec(bline.raw);
      if (markerMatch !== null) {
        pendingWriteOnly = markerMatch[1] ?? null;
        continue;
      }

      // Skip pure-whitespace lines so a marker can survive a blank
      // line between itself and the property declaration.
      if (trimmed.length === 0) {
        // intentionally do NOT clear pendingWriteOnly; allow blank lines.
      } else {
        const propMatch = INTERFACE_PROP_RE.exec(stripped);
        if (propMatch !== null) {
          const propName = propMatch[1];
          if (propName !== undefined) {
            if (bodyDepth <= ECHO_REACHABILITY_DEPTH) reachableFieldNames.add(propName);
            if (bodyDepth === 1) {
              topFieldNames.push(propName);
              if (pendingWriteOnly !== null) {
                writeOnlyMarkers.set(propName, pendingWriteOnly);
              }
              // Scan the type-expression side (everything after the
              // first `:`) for capitalized identifiers — these become
              // candidates for the reference-expansion pass. Built-in
              // generics like `Promise` / `Record` / `Array` are
              // filtered at use-site via BUILTIN_TYPE_NAMES.
              const colonIdx = stripped.indexOf(":");
              if (colonIdx !== -1) {
                const typeExpr = stripped.slice(colonIdx + 1);
                CAPITALIZED_IDENT_RE.lastIndex = 0;
                let refMatch: RegExpExecArray | null;
                while ((refMatch = CAPITALIZED_IDENT_RE.exec(typeExpr)) !== null) {
                  const ref = refMatch[1];
                  if (ref !== undefined && !BUILTIN_TYPE_NAMES.has(ref)) {
                    referencedTypeNames.add(ref);
                  }
                }
              }
            }
          }
          // Clear the marker after first consumption — markers don't
          // carry over to subsequent fields.
          pendingWriteOnly = null;
        } else {
          // Non-property, non-marker line (e.g. a continuation of a
          // multi-line type). Clear the pending marker only if we
          // actually saw substantive code — which we did, otherwise the
          // INTERFACE_PROP_RE would have matched.
          pendingWriteOnly = null;
        }
      }

      bodyDepth += braceDeltaForLine(stripped);
      // Defensive — should not go negative on well-formed source.
      if (bodyDepth < 0) bodyDepth = 0;
    }

    interfaces.set(name, {
      name,
      line: i + 1,
      topFieldNames,
      reachableFieldNames,
      referencedTypeNames,
      writeOnlyMarkers,
    });
  }

  // Reference-expansion pass — for each interface, BFS through its
  // `referencedTypeNames`, merging each referenced interface's
  // `topFieldNames` (depth-1 names only) into THIS interface's
  // `reachableFieldNames`. Cycle-safe via per-source visited set.
  // Limited to file-local interfaces (cross-file references would
  // need full-program parsing; not in v1 scope).
  for (const decl of interfaces.values()) {
    const visited = new Set<string>([decl.name]);
    const queue: string[] = [...decl.referencedTypeNames];
    while (queue.length > 0) {
      const refName = queue.shift();
      if (refName === undefined) continue;
      if (visited.has(refName)) continue;
      visited.add(refName);
      const refDecl = interfaces.get(refName);
      if (refDecl === undefined) continue;
      for (const f of refDecl.topFieldNames) decl.reachableFieldNames.add(f);
      for (const nested of refDecl.referencedTypeNames) {
        if (!visited.has(nested)) queue.push(nested);
      }
    }
  }

  return interfaces;
}

function extractPairOverrides(lines: readonly string[], inComment: readonly boolean[]): Map<string, string> {
  const overrides = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    if (inComment[i]) continue;
    const line = lines[i] ?? "";
    const m = PAIR_OVERRIDE_RE.exec(line);
    if (m === null) continue;
    const write = m[1];
    const read = m[2];
    if (write !== undefined && read !== undefined) {
      overrides.set(write, read);
    }
  }
  return overrides;
}

function extractFunctions(lines: readonly string[], inComment: readonly boolean[]): FunctionDecl[] {
  const functions: FunctionDecl[] = [];

  // Phase A — top-level `export (async)? function name(…): RetType` declarations.
  for (let i = 0; i < lines.length; i++) {
    if (inComment[i]) continue;
    // Some signatures span multiple lines; join up to 8 forward lines
    // to capture the full param + return-type portion.
    const joined = joinForward(lines, inComment, i, 8);
    const m = EXPORT_FN_RE.exec(joined);
    if (m === null) continue;
    const name = m[1];
    const paramsRaw = m[2];
    const returnRaw = m[3];
    if (name === undefined || paramsRaw === undefined) continue;

    const fnDecl: FunctionDecl = {
      name,
      bareName: name,
      scope: null,
      line: i + 1,
      paramTypes: extractParamTypes(paramsRaw),
      returnTypeName: returnRaw !== undefined ? unwrapReturnType(returnRaw) : null,
    };
    functions.push(fnDecl);
  }

  // Phase B — namespace blocks: `export const NAME = { async method(…) { … }, … }`.
  // Track depth from the opening `{` to find the matching `}` and
  // enumerate method-shorthand declarations at depth 1.
  for (let i = 0; i < lines.length; i++) {
    if (inComment[i]) continue;
    const code = stripLineComment(lines[i] ?? "");
    const nsOpen = NS_OPEN_RE.exec(code);
    if (nsOpen === null) continue;
    const nsName = nsOpen[1];
    if (nsName === undefined) continue;

    let depth = braceDeltaForLine(code);
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      if (!inComment[j]) {
        const childCode = stripLineComment(lines[j] ?? "");
        // Methods at scope-depth 1 within the namespace.
        if (depth === 1) {
          const joined = joinForward(lines, inComment, j, 8);
          // Re-match against the joined snippet so multi-line method
          // signatures are captured. Indentation pattern in source is
          // 2-space; the regex requires at least one leading space to
          // avoid matching top-level functions.
          const mm = NS_METHOD_RE.exec(joined);
          if (mm !== null) {
            const bareName = mm[1];
            const paramsRaw = mm[2];
            const returnRaw = mm[3];
            if (bareName !== undefined && paramsRaw !== undefined) {
              functions.push({
                name: `${nsName}.${bareName}`,
                bareName,
                scope: nsName,
                line: j + 1,
                paramTypes: extractParamTypes(paramsRaw),
                returnTypeName: returnRaw !== undefined ? unwrapReturnType(returnRaw) : null,
              });
            }
          }
        }
        depth += braceDeltaForLine(childCode);
      }
      if (depth === 0) break;
    }
  }

  return functions;
}

function joinForward(
  lines: readonly string[],
  inComment: readonly boolean[],
  startIdx: number,
  window: number,
): string {
  const pieces: string[] = [stripLineComment(lines[startIdx] ?? "")];
  for (let k = 1; k <= window && startIdx + k < lines.length; k++) {
    if (inComment[startIdx + k]) {
      pieces.push("");
      continue;
    }
    pieces.push(stripLineComment(lines[startIdx + k] ?? ""));
  }
  return pieces.join("\n");
}

/**
 * Split a parameter list (the bit between `(` and `)`) into individual
 * declarations and return each declaration's TYPE NAME. Generic
 * arguments and union/intersection details are preserved verbatim and
 * then post-processed to extract the "primary" type-name token.
 */
function extractParamTypes(paramsRaw: string): string[] {
  // Replace newlines with spaces so the splitter operates on a flat string.
  const flat = paramsRaw.replace(NEWLINE_RUN_RE, " ");
  const decls = splitOnTopLevelComma(flat);
  const types: string[] = [];
  for (const decl of decls) {
    const trimmed = decl.trim();
    if (trimmed.length === 0) continue;
    // `name: Type` or `name: Type = default` or `name?: Type`.
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      types.push("");
      continue;
    }
    let after = trimmed.slice(colon + 1).trim();
    const eqIdx = after.indexOf("=");
    if (eqIdx !== -1) after = after.slice(0, eqIdx).trim();
    // Extract the leading capitalized identifier (best-effort primary type).
    const headMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(after);
    types.push(headMatch !== null ? headMatch[0] : "");
  }
  return types;
}

function splitOnTopLevelComma(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inSingle || inDouble || inTemplate) continue;
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/**
 * Unwrap a return-type expression to the inner type-name.
 * `Promise<X>` → `X`, `Promise<X[]>` → `X`, `Promise<X | null>` → `X`,
 * `X[]` → `X`, `X | null` → `X`. Conservative — falls back to the
 * leading identifier if shape doesn't match a known unwrap pattern.
 */
function unwrapReturnType(raw: string): string | null {
  let s = raw.trim();
  // Strip trailing `;` or `,` if any.
  s = s.replace(/[;,]\s*$/, "");
  // `Promise<X>` — unwrap once.
  const promiseMatch = /^Promise\s*<\s*([\s\S]+)\s*>\s*$/.exec(s);
  if (promiseMatch !== null) {
    const inner = promiseMatch[1];
    if (inner !== undefined) s = inner.trim();
  }
  // `X | null`, `X | undefined`, `X | null | undefined` — drop nullable union arms.
  s = s
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p !== "null" && p !== "undefined")
    .join(" | ");
  // `X[]` — drop array suffix.
  s = s.replace(/\[\s*\]\s*$/, "").trim();
  // Take the leading capitalized identifier.
  const headMatch = /^[A-Z][A-Za-z0-9_]*/.exec(s);
  return headMatch !== null ? headMatch[0] : null;
}

/**
 * Return the FIRST non-scalar, non-options parameter type from a write
 * fn's parameter list. Skips `INTERNAL_OPTIONS_TYPES` (DryRunOptions
 * etc.) and `SCALAR_TYPES`. Returns `null` if none qualifies.
 */
function pickWriteInputType(paramTypes: readonly string[]): string | null {
  for (const t of paramTypes) {
    if (t === "") continue;
    if (SCALAR_TYPES.has(t)) continue;
    if (INTERNAL_OPTIONS_TYPES.has(t)) continue;
    if (!/^[A-Z]/.test(t)) continue;
    return t;
  }
  // Defensive fallback — if EVERY non-scalar candidate is in
  // INTERNAL_OPTIONS_TYPES (only DryRunOptions / SetOptions / ListOptions /
  // PaginationOptions today), accept one rather than silently dropping the
  // pair. Not expected to fire on the current corpus — write fns always
  // carry a domain-shape input alongside any options bag — but kept so a
  // future refactor that demotes the input doesn't drop the pair from the
  // report entirely.
  for (const t of paramTypes) {
    if (t === "") continue;
    if (SCALAR_TYPES.has(t)) continue;
    if (!/^[A-Z]/.test(t)) continue;
    return t;
  }
  return null;
}

function classifyFunction(fn: FunctionDecl): "write" | "read" | "other" {
  if (WRITE_FN_NAMES.has(fn.bareName)) return "write";
  for (const pfx of READ_FN_PREFIXES) {
    if (fn.bareName === pfx || fn.bareName.startsWith(pfx)) return "read";
  }
  return "other";
}

function pickEchoForWrite(
  writeFn: FunctionDecl,
  scopeFunctions: readonly FunctionDecl[],
  override: string | null,
  parsed: ParsedFile,
  warnings: string[],
): { echoName: string; source: "read-fn" | "write-return" | "override" } | null {
  if (override !== null) {
    if (!parsed.interfaces.has(override)) {
      warnings.push(
        `${parsed.file}:${String(writeFn.line)}: write-read-pair override target "${override}" not found in file's interfaces.`,
      );
      return null;
    }
    return { echoName: override, source: "override" };
  }

  // Prefer the first read fn in the same scope.
  for (const fn of scopeFunctions) {
    if (fn === writeFn) continue;
    if (classifyFunction(fn) !== "read") continue;
    if (fn.returnTypeName === null) continue;
    if (!parsed.interfaces.has(fn.returnTypeName)) continue;
    return { echoName: fn.returnTypeName, source: "read-fn" };
  }

  // Fallback to the write fn's own return type.
  if (writeFn.returnTypeName !== null && parsed.interfaces.has(writeFn.returnTypeName)) {
    return { echoName: writeFn.returnTypeName, source: "write-return" };
  }

  return null;
}

function findingsForPair(input: InterfaceDecl, echo: InterfaceDecl): PairFinding["fields"] {
  const out: PairFinding["fields"] = [];
  for (const fieldName of input.topFieldNames) {
    if (echo.reachableFieldNames.has(fieldName)) {
      out.push({ name: fieldName, status: "echoed" });
      continue;
    }
    const writeOnly = input.writeOnlyMarkers.get(fieldName);
    if (writeOnly !== undefined) {
      out.push({ name: fieldName, status: "write-only", reason: writeOnly });
      continue;
    }
    out.push({ name: fieldName, status: "gap" });
  }
  return out;
}

function buildPairings(parsed: ParsedFile, warnings: string[]): PairFinding[] {
  // Group functions by scope (null = file-level top-level).
  const byScope = new Map<string | null, FunctionDecl[]>();
  for (const fn of parsed.functions) {
    const arr = byScope.get(fn.scope) ?? [];
    arr.push(fn);
    byScope.set(fn.scope, arr);
  }

  const findings: PairFinding[] = [];
  for (const [scope, fns] of byScope) {
    for (const writeFn of fns) {
      if (classifyFunction(writeFn) !== "write") continue;
      const inputTypeName = pickWriteInputType(writeFn.paramTypes);
      if (inputTypeName === null) continue;
      const inputDecl = parsed.interfaces.get(inputTypeName);
      if (inputDecl === undefined) continue;
      const override = parsed.pairOverrides.get(inputTypeName) ?? null;
      const echoPick = pickEchoForWrite(writeFn, fns, override, parsed, warnings);
      if (echoPick === null) continue;
      const echoDecl = parsed.interfaces.get(echoPick.echoName);
      if (echoDecl === undefined) continue;

      findings.push({
        file: parsed.file,
        scope,
        writeName: inputTypeName,
        echoName: echoPick.echoName,
        echoSource: echoPick.source,
        fields: findingsForPair(inputDecl, echoDecl),
      });
    }
  }

  // Dedupe — multiple write fns may resolve to the same (input, echo)
  // pair (e.g. employment.add and employment.update both take
  // EmploymentFields and echo to Employment). Keep the first.
  const seen = new Set<string>();
  const deduped: PairFinding[] = [];
  for (const f of findings) {
    const key = `${f.file}|${f.scope ?? ""}|${f.writeName}|${f.echoName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  return deduped;
}

function parseFile(absPath: string, relPath: string): ParsedFile {
  const lines = readSourceLines(absPath) ?? [];
  const inComment = maskBlockComments(lines);
  const interfaces = extractInterfaces(lines, inComment);
  const functions = extractFunctions(lines, inComment);
  const pairOverrides = extractPairOverrides(lines, inComment);
  return { file: relPath, interfaces, functions, pairOverrides };
}

function formatReport(
  report: RunReport,
  strict: boolean,
): { gapCount: number; stdoutLines: string[]; stderrLines: string[] } {
  const out: string[] = [];
  const err: string[] = [];

  let totalPairs = 0;
  let totalFields = 0;
  let echoedCount = 0;
  let writeOnlyCount = 0;
  let gapCount = 0;
  const pairsWithGaps: PairFinding[] = [];

  for (const pair of report.pairs) {
    totalPairs += 1;
    let pairGaps = 0;
    for (const f of pair.fields) {
      totalFields += 1;
      if (f.status === "echoed") echoedCount += 1;
      else if (f.status === "write-only") writeOnlyCount += 1;
      else {
        gapCount += 1;
        pairGaps += 1;
      }
    }
    if (pairGaps > 0) pairsWithGaps.push(pair);
  }

  out.push(
    `Write-read symmetry — services/{profile,engagements,payments}\n` +
      `  ${String(totalPairs)} pair(s) examined, ` +
      `${String(totalFields)} field(s) total, ` +
      `${String(echoedCount)} echoed, ` +
      `${String(writeOnlyCount)} write-only (exempt), ` +
      `${String(gapCount)} gap(s).\n`,
  );

  for (const pair of report.pairs) {
    const scopeLabel = pair.scope !== null ? `[${pair.scope}]` : `[<file>]`;
    const echoSrcLabel = pair.echoSource;
    const echoedHere = pair.fields.filter((f) => f.status === "echoed").length;
    const writeOnlyHere = pair.fields.filter((f) => f.status === "write-only").length;
    const gapsHere = pair.fields.filter((f) => f.status === "gap").length;
    out.push(
      `  ${pair.file}${scopeLabel} ${pair.writeName} ↔ ${pair.echoName} (${echoSrcLabel}) — ` +
        `${String(echoedHere)} echoed, ${String(writeOnlyHere)} write-only, ${String(gapsHere)} gap(s)`,
    );
    for (const f of pair.fields) {
      if (f.status === "echoed") {
        out.push(`      ✓ ${f.name}`);
      } else if (f.status === "write-only") {
        out.push(`      • ${f.name}  (write-only: ${f.reason ?? ""})`);
      } else {
        out.push(`      ✗ ${f.name}  (GAP — not echoed)`);
      }
    }
  }

  if (gapCount > 0) {
    err.push(
      `\nWrite-read symmetry gate — ${String(gapCount)} non-exempt asymmetry(ies) across ${String(pairsWithGaps.length)} pair(s).\n` +
        `Each line below is a write-input field whose name does not appear at any\n` +
        `level of the matched echo interface's reachable field set, and which carries\n` +
        `no \`// write-only: <reason>\` exemption marker. Either extend the echo\n` +
        `interface to surface the field (so an agent can verify the write), or\n` +
        `add an exemption marker with a justified reason.\n` +
        `See scripts/check-write-read-symmetry.ts header for the exemption protocol.\n`,
    );
    for (const pair of pairsWithGaps) {
      for (const f of pair.fields) {
        if (f.status !== "gap") continue;
        const scopeLabel = pair.scope !== null ? `[${pair.scope}]` : "[<file>]";
        err.push(`GAP  ${pair.file}${scopeLabel}  ${pair.writeName}.${f.name}  ↔  ${pair.echoName}`);
      }
    }
    if (!strict) {
      err.push(
        `\nNote: gate is in WARN mode. Exit code 0. Set WRITE_READ_SYMMETRY_STRICT=1 (or pass\n` +
          `--strict) to fail on non-exempt asymmetries once the existing gaps are paid down.\n`,
      );
    }
  }

  for (const w of report.warnings) {
    err.push(`warn: ${w}`);
  }

  return { gapCount, stdoutLines: out, stderrLines: err };
}

function main(): void {
  const repoRoot = process.cwd();
  const args = new Set(process.argv.slice(2));
  const strict = args.has("--strict") || process.env["WRITE_READ_SYMMETRY_STRICT"] === "1";

  const tracked = listTrackedFiles(repoRoot);
  const pairs: PairFinding[] = [];
  const warnings: string[] = [];

  for (const relPath of tracked) {
    if (!isInScopeFile(relPath)) continue;
    const parsed = parseFile(join(repoRoot, relPath), relPath);
    pairs.push(...buildPairings(parsed, warnings));
  }

  pairs.sort((a, b) => a.file.localeCompare(b.file) || a.writeName.localeCompare(b.writeName));

  const report: RunReport = { pairs, warnings };
  const { gapCount, stdoutLines, stderrLines } = formatReport(report, strict);

  for (const line of stdoutLines) process.stdout.write(`${line}\n`);
  for (const line of stderrLines) process.stderr.write(`${line}\n`);

  if (strict && gapCount > 0) {
    process.exit(1);
  }
}

main();
