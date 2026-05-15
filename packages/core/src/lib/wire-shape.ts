// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Shared wire-shape validation helper for the hybrid runtime
 * field-level validation model (ADR-006). Used by every per-service
 * `callGateway` / `callTalentProfile` helper to convert a
 * {@link z.ZodError} from a failed `schema.parse(body.data)` call into
 * the structured payload required by the project's `WIRE_SHAPE_ERROR`
 * UX (see `docs/wire-validation-error-format.md`, M2 / #281).
 *
 * Operationally a `WIRE_SHAPE_ERROR` means Toptal changed the wire
 * shape (the schemas were synthesized from APK decompilation + live
 * captures and lag behind server-side updates). The CLI / MCP surfaces
 * render the diff so an operator can file an actionable bug.
 *
 * Z-3 (#286) wires this helper through the call path. No production op
 * has `schema` wired yet — that's Z-4 (#288)'s beachhead.
 *
 * Zod v4 note: in v4 the public `error.issues[]` does NOT carry the
 * raw input value (`input` is stripped from the user-facing
 * {@link z.core.$ZodIssue} despite being present on the internal
 * {@link z.core.$ZodRawIssue}). To recover the wire value for the
 * `actual` and `value` slots of a {@link WireShapeDiffEntry}, the
 * caller passes the original wire data (`body.data`) as the second
 * argument to {@link buildWireShapeError} / {@link projectZodErrorToDiff};
 * we walk the issue's `path` against that snapshot. When the wire
 * value can't be resolved (e.g., the schema rejected the entire
 * top-level shape), the entry falls back to a path-only render.
 */
import type { z } from "zod";

/**
 * One field-level diff entry in a {@link WireShapeErrorPayload}. Wire
 * shape matches the JSON contract in `docs/wire-validation-error-format.md`:
 *
 *   - `op` — `"+"` schema-unknown wire field (strict mode unrecognized
 *     keys) / `"-"` schema-required missing on wire / `"~"` type
 *     mismatch.
 *   - `path` — JSON path from operation root with zero-indexed bracket
 *     notation for arrays (`billingCycle.records[0].duration`) so it
 *     matches `jq` semantics.
 *   - `expected` — schema type as a short string (`"number"`,
 *     `"string"`, `"undefined"`, …).
 *   - `actual` — wire value type as a short string.
 *   - `value?` — raw wire value rendered to a string, truncated to
 *     {@link MAX_VALUE_LENGTH} chars with `…` on overflow. Omitted for
 *     `+` (key absent from schema, value undefined) and `-` (field
 *     absent from wire, value undefined). `body.data` never contains
 *     the bearer, so no redaction is needed.
 */
export interface WireShapeDiffEntry {
  op: "+" | "-" | "~";
  path: string;
  expected: string;
  actual: string;
  value?: string;
}

/**
 * Structured payload returned by {@link buildWireShapeError}. Each
 * service-level `WIRE_SHAPE_ERROR` carries this payload through its
 * own domain-error class via the `cause` field. The CLI / MCP layers
 * lift `message`, `hint`, and `diff` into the user-visible envelope.
 */
export interface WireShapeErrorPayload {
  message: string;
  hint: string;
  diff: WireShapeDiffEntry[];
}

/**
 * Maximum rendered length of a {@link WireShapeDiffEntry.value} field
 * (per `docs/wire-validation-error-format.md` § Diff entries).
 * Truncation appends `…` (a single ellipsis character, not three
 * dots) to mark overflow.
 */
export const MAX_VALUE_LENGTH = 32;

/**
 * Verbatim hint string emitted alongside every `WIRE_SHAPE_ERROR`.
 * Lifted into the CLI envelope's `hint` slot and the MCP error-text
 * `Hint:` block; identical across all surfaces so an operator pattern-
 * matches the message regardless of where it's encountered. The text
 * comes directly from `docs/wire-validation-error-format.md` § Code +
 * base fields (M2 / #281).
 */
export const WIRE_SHAPE_HINT =
  "wire shape doesn't match expected — this typically means Toptal changed the API; please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the operation name and timestamp.";

/**
 * Walk a JSON path against a wire snapshot, returning the value at
 * that path or {@link MISSING} when any segment doesn't resolve. The
 * sentinel is distinct from `undefined` so callers can distinguish
 * "value is undefined on the wire" (data present, field absent) from
 * "path doesn't resolve" (entire branch missing or wireData omitted).
 */
const MISSING = Symbol("wire-shape:missing");

function walkPath(wireData: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = wireData;
  for (const segment of path) {
    if (current === null || current === undefined) return MISSING;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return MISSING;
      if (segment < 0 || segment >= current.length) return MISSING;
      current = current[segment];
    } else if (typeof segment === "string") {
      if (typeof current !== "object" || Array.isArray(current)) return MISSING;
      const key = segment;
      const obj = current as Record<string, unknown>;
      if (!(key in obj)) return MISSING;
      current = obj[key];
    } else {
      // Symbol — Zod permits in record/map keys though wire payloads
      // never carry symbol keys. Fail closed: cannot walk a symbol
      // path against a JSON wire snapshot.
      return MISSING;
    }
  }
  return current;
}

/**
 * Render an unknown value into a short type tag for the `expected` /
 * `actual` slots of a {@link WireShapeDiffEntry}. Pre-`typeof` array
 * branch keeps `[]` from rendering as `"object"`.
 */
function typeNameOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Render an unknown wire value into a string for the
 * {@link WireShapeDiffEntry.value} slot. Strings round-trip verbatim
 * (no surrounding quotes — the pretty renderer adds them); primitives
 * use `String(value)`; arrays/objects use `JSON.stringify`. Output is
 * truncated to {@link MAX_VALUE_LENGTH} characters with `…` on
 * overflow.
 */
function renderValue(value: unknown): string {
  let rendered: string;
  if (typeof value === "string") {
    rendered = value;
  } else if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    rendered = String(value);
  } else if (typeof value === "bigint") {
    rendered = `${value.toString()}n`;
  } else {
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = "[unstringifiable]";
    }
  }
  if (rendered.length <= MAX_VALUE_LENGTH) return rendered;
  return `${rendered.slice(0, MAX_VALUE_LENGTH - 1)}…`;
}

/**
 * Format a Zod issue path (array of `PropertyKey` segments) into the
 * JSON path syntax required by {@link WireShapeDiffEntry.path}.
 * Numeric segments fold into the preceding key as bracket-notation
 * indices (`["records", 0, "duration"]` → `"records[0].duration"`).
 *
 * The empty-path case (top-level / refinement errors) returns the
 * empty string. Callers handle prepending a base path when applicable
 * (used by the `unrecognized_keys` branch in {@link issueToDiffEntries}).
 */
function formatJsonPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "";
  const parts: string[] = [];
  for (const segment of path) {
    if (typeof segment === "number") {
      const head = parts.length === 0 ? "" : (parts[parts.length - 1] ?? "");
      const next = `${head}[${segment.toString()}]`;
      if (parts.length === 0) {
        parts.push(next);
      } else {
        parts[parts.length - 1] = next;
      }
    } else if (typeof segment === "string") {
      parts.push(segment);
    } else {
      // Symbol — Zod allows it in record/map keys though wire payloads
      // never carry symbol keys. Render via .toString() so the message
      // is still readable rather than dropping the segment.
      parts.push(segment.toString());
    }
  }
  return parts.join(".");
}

/**
 * Parse a path string back into segments for deterministic sorting.
 * Numeric segments compare numerically (`[2]` before `[10]`); string
 * segments compare lexicographically. The string `"records[0].duration"`
 * decomposes into `["records", 0, "duration"]`.
 */
function parsePathSegments(path: string): (string | number)[] {
  if (path.length === 0) return [];
  const segments: (string | number)[] = [];
  for (const chunk of path.split(".")) {
    const headEnd = chunk.indexOf("[");
    const head = headEnd === -1 ? chunk : chunk.slice(0, headEnd);
    if (head.length > 0) segments.push(head);
    const indexMatcher = /\[(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = indexMatcher.exec(chunk)) !== null) {
      segments.push(Number(match[1]));
    }
  }
  return segments;
}

/**
 * Compare two diff entries by `path` for deterministic ordering.
 * Numeric path segments compare numerically (`records[2]` before
 * `records[10]`); string segments compare lexicographically. When
 * paths differ only in trailing segments, the shorter path sorts
 * first. The result is byte-identical output across runs — essential
 * for snapshot tests and human pattern-matching of repeat failures
 * across logs.
 */
function compareDiffEntries(a: WireShapeDiffEntry, b: WireShapeDiffEntry): number {
  const segA = parsePathSegments(a.path);
  const segB = parsePathSegments(b.path);
  const minLen = Math.min(segA.length, segB.length);
  for (let i = 0; i < minLen; i++) {
    const sa = segA[i];
    const sb = segB[i];
    if (sa === undefined || sb === undefined) break;
    if (typeof sa === "number" && typeof sb === "number") {
      if (sa !== sb) return sa - sb;
    } else {
      const saStr = String(sa);
      const sbStr = String(sb);
      if (saStr !== sbStr) return saStr < sbStr ? -1 : 1;
    }
  }
  if (segA.length !== segB.length) return segA.length - segB.length;
  // Paths equal — preserve insertion order via tie-break on the diff
  // entry fields so the comparator is total (required by `Array.sort`
  // contract for stable cross-engine output).
  if (a.op !== b.op) return a.op < b.op ? -1 : 1;
  return 0;
}

/**
 * Extract `received <type>` from a Zod v4 `invalid_type` message
 * (`"Invalid input: expected number, received string"`). Returns the
 * received-type string when present, or `null` when the message
 * doesn't match the expected pattern (locale change, custom error
 * map). Used as a fallback when the wire snapshot isn't available
 * via {@link walkPath}.
 */
function extractReceivedFromMessage(message: string): string | null {
  const m = /received\s+(\S+)/.exec(message);
  return m ? (m[1] ?? null) : null;
}

/**
 * Project a single Zod issue into one or more {@link WireShapeDiffEntry}
 * rows. The mapping is per `docs/wire-validation-error-format.md` §
 * Diff entries:
 *
 *   - `invalid_type` where the wire value at the issue path is
 *     `undefined` (or unresolvable) → `-` (schema-required field
 *     missing on wire). `value` omitted.
 *   - `invalid_type` otherwise → `~` (type mismatch). `value` is the
 *     raw wire value (extracted from the snapshot), truncated.
 *   - `unrecognized_keys` (strict-mode objects) → one `+` entry per
 *     unknown key. `value` omitted (Zod surfaces the key list but not
 *     each key's value).
 *   - `invalid_value`, `invalid_union`, and other codes → `~` with
 *     wire snapshot-derived `actual` / `value`.
 *
 * Fallback for unrecognized codes is `~` rather than skipping the
 * issue — a future Zod release adding a new issue code shouldn't drop
 * the diagnostic.
 */
function issueToDiffEntries(issue: z.core.$ZodIssue, wireData: unknown): WireShapeDiffEntry[] {
  const basePath = formatJsonPath(issue.path);
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      op: "+" as const,
      path: basePath.length === 0 ? key : `${basePath}.${key}`,
      expected: "<unset>",
      actual: "unknown",
    }));
  }
  const resolved = walkPath(wireData, issue.path);
  if (issue.code === "invalid_type") {
    // Field absent on wire OR resolved value is undefined → "-".
    if (resolved === MISSING || resolved === undefined) {
      const actualFromMessage = extractReceivedFromMessage(issue.message);
      return [
        {
          op: "-",
          path: basePath,
          expected: issue.expected,
          actual: actualFromMessage ?? "undefined",
        },
      ];
    }
    return [
      {
        op: "~",
        path: basePath,
        expected: issue.expected,
        actual: typeNameOf(resolved),
        value: renderValue(resolved),
      },
    ];
  }
  if (issue.code === "invalid_value") {
    const expected =
      issue.values.length === 1 ? renderValue(issue.values[0]) : issue.values.map((v) => renderValue(v)).join(" | ");
    if (resolved === MISSING) {
      return [
        {
          op: "~",
          path: basePath,
          expected,
          actual: "unknown",
        },
      ];
    }
    return [
      {
        op: "~",
        path: basePath,
        expected,
        actual: typeNameOf(resolved),
        value: renderValue(resolved),
      },
    ];
  }
  // invalid_union, invalid_format, too_big, too_small, custom, …
  // Fall back to a structural diff entry. `actual` reflects the wire
  // shape when resolvable; `expected` lifts the issue message so the
  // operator sees the constraint that failed.
  if (resolved === MISSING) {
    return [
      {
        op: "~",
        path: basePath,
        expected: issue.message,
        actual: "unknown",
      },
    ];
  }
  return [
    {
      op: "~",
      path: basePath,
      expected: issue.message,
      actual: typeNameOf(resolved),
      value: renderValue(resolved),
    },
  ];
}

/**
 * Build the field-level diff from a {@link z.ZodError}. Issues are
 * projected per {@link issueToDiffEntries} and sorted deterministically
 * per {@link compareDiffEntries} so two runs against the same drifted
 * wire response produce byte-identical output (load-bearing for
 * snapshot tests and CI grep-fu).
 *
 * `wireData` is the original `body.data` snapshot that failed
 * validation — walking it against each issue's `path` recovers the
 * actual wire value (Zod v4 strips `input` from public issues; see
 * file header). Pass `undefined` only in tests / migration paths
 * where the snapshot is unavailable; entries will degrade to path-
 * only render in that case.
 *
 * Exported for unit tests; callers should prefer
 * {@link buildWireShapeError} which composes the full payload.
 */
export function projectZodErrorToDiff(error: z.ZodError, wireData?: unknown): WireShapeDiffEntry[] {
  const entries: WireShapeDiffEntry[] = [];
  for (const issue of error.issues) {
    entries.push(...issueToDiffEntries(issue, wireData));
  }
  entries.sort(compareDiffEntries);
  return entries;
}

/**
 * Compose the `message` line of a `WIRE_SHAPE_ERROR` per
 * `docs/wire-validation-error-format.md` § Code + base fields. The
 * pluralisation is wire-stable (`1 field issue` vs `2 field issues`)
 * so snapshot tests don't need locale-aware matchers.
 *
 * Exported for unit tests; callers should prefer
 * {@link buildWireShapeError} which composes the full payload.
 */
export function buildWireShapeMessage(operationName: string, diffEntryCount: number): string {
  const noun = diffEntryCount === 1 ? "issue" : "issues";
  return `Wire shape doesn't match expected schema for operation \`${operationName}\` (${diffEntryCount.toString()} field ${noun}).`;
}

/**
 * Convert a {@link z.ZodError} from a failed `schema.parse(body.data)`
 * call into the full {@link WireShapeErrorPayload}. The payload is
 * stable across surfaces (CLI envelope, MCP error text) and round-
 * trips through JSON without redaction (body.data never carries the
 * bearer).
 *
 * Each service's `callGateway` / `callTalentProfile` helper wraps the
 * payload's `message` into its own domain-error class with
 * `code: "WIRE_SHAPE_ERROR"` and `cause: zodError`; the CLI / MCP
 * layers reconstruct the diff from `cause` when rendering.
 *
 * Pass `wireData` (the original `body.data` snapshot) so the diff
 * can recover actual wire values via path walk — Zod v4 strips the
 * `input` field from public issues, so the snapshot is the only way
 * to render `actual` / `value` for non-`unrecognized_keys` entries.
 *
 * Z-3 (#286) wires the mechanism; no production op has `schema`
 * passed in yet (Z-4 / #288 ships the first beachhead).
 */
export function buildWireShapeError(
  operationName: string,
  error: z.ZodError,
  wireData?: unknown,
): WireShapeErrorPayload {
  const diff = projectZodErrorToDiff(error, wireData);
  return {
    message: buildWireShapeMessage(operationName, diff.length),
    hint: WIRE_SHAPE_HINT,
    diff,
  };
}
