// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { stringify as yamlStringify } from "yaml";

import { emptyStateProse, isEmptyCollection } from "./empty-state-cta.js";

/**
 * Cross-CLI output format for `show` and `list` commands.
 *
 * - `pretty`: human-formatted layout (default; trimmed/laid out for direct
 *   terminal reading). Internally dispatches on shape — `show` verbs render
 *   a curated key:value layout via the caller-supplied `pretty` formatter,
 *   `list` verbs render a column-aligned table via the caller-supplied
 *   `table` formatter, and paragraph-bearing lists render a curated
 *   multi-line layout (the override registry at
 *   `lib/format-overrides.ts` carries the strategy classification; the
 *   shape dispatch is internal — `pretty` is the only user-visible name
 *   for the human layout).
 * - `json`: stable single-line JSON, suitable for piping to `jq` or `yq`.
 * - `yaml`: block-style YAML rendered via `yaml.stringify` with
 *   `customTags: []` (no `!!timestamp` auto-parse on roundtrip),
 *   `aliasDuplicateObjects: false` (no `&anchor`/`*alias` noise on
 *   duplicate references), and `lineWidth: 0` (no line wrapping —
 *   preserves field-level semantic boundaries; the terminal wraps if
 *   needed). Multi-paragraph string fields surface as `|` literal block
 *   scalars; lists as block style (`- item`, not `[item]`). The data
 *   layer is responsible for shaping `Date` values to ISO 8601 strings
 *   BEFORE invoking the helper — explicit conversion is safer than
 *   relying on the YAML lib's date handling.
 *
 * The JSON shape commitment is "may break across 0.x" pre-1.0 and
 * "stable across majors per semver" at 1.0+; the helper enforces
 * single-line JSON to keep that contract observable to downstream tools.
 *
 * The pre-#126 enum carried `text` and `table` as user-visible values;
 * both were collapsed into the single `pretty` name with internal shape
 * dispatch. Pre-launch is free moves — there are no backward-compat
 * aliases.
 */
export type OutputFormat = "pretty" | "json" | "yaml";

/**
 * All valid `OutputFormat` values, intended for `commander`'s
 * `Option#choices()`. Frozen at the type level via `readonly` so callers
 * cannot mutate the shared array.
 */
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["pretty", "json", "yaml"];

/**
 * Caller-supplied formatters per format. Each returns the exact string
 * to emit on stdout (the helper appends a single trailing newline). The
 * `json` and `yaml` formats have no formatter slot — the helper
 * stringifies the data directly via `JSON.stringify(data)` /
 * `formatYaml(data)`.
 *
 * `pretty` is the user-visible human-layout slot used by `show` verbs
 * for curated key:value renderings. `table` is an internal-only slot
 * used by `list` verbs to provide a column-aligned table rendering.
 * The user-visible `pretty` format internally dispatches on data shape
 * (per #126):
 *
 * - data is array-shaped or `{items: [...]}`-shaped (list) → prefer
 *   `table`, fall back to `pretty`.
 * - data is object-shaped (show) → prefer `pretty`, fall back to
 *   `table`.
 * - neither formatter present → fall through to
 *   `JSON.stringify(_, null, 2)` plus a stderr warning.
 *
 * The shape dispatch is internal — `pretty` is the only user-visible
 * name for the human layout. Show / list / paragraph-bearing-list
 * routing is the dispatcher's job, not the user's.
 *
 * `empty` opts the call site into the empty-state wrapper (#122). When
 * present AND `isEmptyCollection(data)` returns true, the wrapper
 * short-circuits BEFORE per-format dispatch and emits a per-format
 * empty payload — `[]` (single-line) for `json`; the prose+CTA from
 * `emptyStateProse(empty.command)` for `pretty` (deliberately AVOIDS a
 * header-only `cli-table3` grid, which the v0.4 reframe categorised
 * as a "looks broken" pattern). The wrapper is opt-in (not auto-fire on
 * every call) so search leaves like `autocomplete` — which return
 * arrays but want a query-aware "no matches" line, not a create-CTA —
 * can keep their custom empty handling without overriding.
 */
export interface OutputFormatters<T> {
  pretty?: (data: T) => string;
  table?: (data: T) => string;
  empty?: { command: string };
}

/**
 * Detect whether `data` is list-shaped — an array (current top-level
 * shape) or `{items: [...]}` (the future `{items, pageInfo?}` envelope
 * reserved by the v0.4 reframe). Used by the `pretty` dispatcher to
 * pick `table` vs `pretty` formatter on shape (`list` → `table`,
 * `show` → `pretty`).
 *
 * Returns `false` for `null`, scalars, and objects without an `items`
 * field — those collapse to the show branch. Note this is a
 * NON-emptiness signal: `[]` is still list-shape (the empty-state
 * wrapper handles the empty case BEFORE the dispatcher fires; once it
 * passes through to dispatch, the array's emptiness no longer matters).
 */
function isListShape(data: unknown): boolean {
  if (Array.isArray(data)) return true;
  if (typeof data !== "object" || data === null) return false;
  if (!Object.prototype.hasOwnProperty.call(data, "items")) return false;
  return Array.isArray((data as { items: unknown }).items);
}

/**
 * Stderr hint surfaced when the helper falls through to pretty-printed
 * JSON because no `pretty` or `table` formatter was provided. Exposed as
 * a constant so tests can assert on the exact wording without
 * duplicating it.
 */
export const PRETTY_FALLBACK_HINT = "note: no pretty formatter provided; falling back to pretty-printed JSON.";

/**
 * Configuration object passed to `yaml.stringify` for the `yaml` output
 * format. Module-private; `const`-declared so callers cannot rebind
 * (the yaml lib's options type is mutable, so we cannot deep-freeze
 * without a type cast — module isolation is sufficient).
 *
 * - `customTags: []` — disable the lib's optional tags (`!!timestamp`,
 *   `!!binary`, etc.) so dates/datetimes encoded as ISO 8601 strings by
 *   the data layer surface verbatim instead of being re-emitted with
 *   tag prefixes (which would break roundtrip parsers configured to
 *   reject custom tags).
 * - `aliasDuplicateObjects: false` — emit duplicate object references
 *   inline rather than as `&anchor`/`*alias` pairs, keeping output
 *   readable for non-YAML-savvy consumers.
 * - `lineWidth: 0` — disable line wrapping. Field-level semantic
 *   boundaries stay intact; the terminal wraps for display if needed.
 */
const YAML_STRINGIFY_OPTIONS = {
  customTags: [],
  aliasDuplicateObjects: false,
  lineWidth: 0,
};

/**
 * Render `data` as block-style YAML.
 *
 * Behavior:
 *
 * - Multi-paragraph strings surface as `|` literal block scalars (the
 *   YAML lib's default for strings containing newlines), preserving
 *   paragraph breaks visually rather than escaping them as `\n`.
 * - Strings already shaped as ISO 8601 by the data layer (e.g.,
 *   `"2026-05-10T05:45:00Z"`) render quoted, NOT auto-converted to a
 *   `!!timestamp` tag — `customTags: []` ensures stability of the
 *   roundtrip contract.
 * - Numeric fields render as their natural YAML scalar type (numbers,
 *   not strings).
 * - Lists and maps render in block style (`- item`, `key: value`),
 *   never flow style (`[item]`, `{key: value}`).
 *
 * The yaml lib's `stringify` always appends a trailing newline; this
 * helper strips it so the formatter contract matches `JSON.stringify`'s
 * (no trailing newline). `emitResult` then appends exactly one trailing
 * newline when writing to stdout.
 *
 * The helper does NOT validate `data` for YAML-safe shapes (cycles,
 * `BigInt`, `Date` objects, `undefined`, etc.); callers shape data into
 * YAML-friendly form before invoking. In particular: convert `Date` to
 * ISO 8601 strings at the data layer.
 */
export function formatYaml(data: unknown): string {
  const out = yamlStringify(data, YAML_STRINGIFY_OPTIONS);
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}

/**
 * Result of resolving a `(data, format, options)` triple to a string for
 * stdout. The optional `warning` field is present only when the helper
 * fell through to a default branch worth surfacing on stderr (currently:
 * `pretty` with neither `pretty` nor `table` formatter). Callers using
 * `formatResult` directly can inspect this field instead of letting
 * `emitResult` write to stderr.
 *
 * `exactOptionalPropertyTypes` is enabled, so `warning` is either absent
 * or a string — never `undefined`.
 */
export type FormatResult = { output: string } | { output: string; warning: string };

/**
 * Format `data` per `format` and return the string to emit, plus an
 * optional `warning` line suitable for stderr. Pure — no I/O.
 *
 * Behavior summary:
 *
 * - `json` → `JSON.stringify(data)` (single-line; no extra whitespace)
 * - `yaml` → `formatYaml(data)` (block-style YAML; no formatter slot —
 *   the helper is the single source of truth for `yaml` rendering)
 * - `pretty` → shape-dispatched human layout:
 *   - list-shape data (array, `{items: [...]}`) → prefer
 *     `options.table`, fall back to `options.pretty`
 *   - show-shape data (single object) → prefer `options.pretty`, fall
 *     back to `options.table`
 *   - neither formatter present → `JSON.stringify(data, null, 2)` plus
 *     a stderr warning
 *
 * The helper does NOT validate `data` for JSON/YAML-safe shapes
 * (cycles, `undefined`, `Date`, `BigInt`, etc.); callers are
 * responsible for shaping data into a serialization-friendly form
 * before passing it.
 *
 * The `format` parameter defaults to `"pretty"` so the spec's "default
 * format is pretty" behavior holds even when commander defaults aren't
 * available (e.g., direct programmatic use).
 */
export function formatResult<T>(
  data: T,
  format: OutputFormat = "pretty",
  options: OutputFormatters<T> = {},
): FormatResult {
  // Empty-state wrapper (#122): fires BEFORE per-format dispatch when
  // the caller opts in via `options.empty` AND `data` is detected as an
  // empty collection (`[]` or `{items: []}`). Pretty mode renders the
  // CTA prose; JSON / YAML fall through to normal serialization so the
  // list envelope (`{version, items: []}`, per #128) is preserved on
  // empty collections — the pre-#147 behavior of emitting a literal
  // "[]" on the JSON path silently dropped the envelope wrapper, which
  // tripped E2E suites that read `.items` (surfaced by #147 round-trip).
  if (options.empty !== undefined && isEmptyCollection(data)) {
    if (format === "pretty") {
      return { output: emptyStateProse(options.empty.command) };
    }
    // json / yaml: fall through to normal serialization
  }
  if (format === "json") {
    return { output: JSON.stringify(data) };
  }
  if (format === "yaml") {
    return { output: formatYaml(data) };
  }
  // pretty branch — internal shape dispatch (per #126 AC):
  // - list-shape data → table formatter (the column-aligned default for
  //   list verbs; matches pre-#126 `--output=table` behavior)
  // - show-shape data → pretty formatter (the curated key:value layout
  //   for show verbs; matches pre-#126 `--output=text` behavior)
  // - missing formatters fall through to JSON pretty-print + warning
  if (isListShape(data)) {
    if (options.table !== undefined) return { output: options.table(data) };
    if (options.pretty !== undefined) return { output: options.pretty(data) };
  } else {
    if (options.pretty !== undefined) return { output: options.pretty(data) };
    if (options.table !== undefined) return { output: options.table(data) };
  }
  return { output: JSON.stringify(data, null, 2), warning: PRETTY_FALLBACK_HINT };
}

/**
 * Format `data` per `format` and write the result to `process.stdout`
 * (with a trailing newline). When `formatResult` surfaces a `warning`
 * (`pretty` fall-through with neither formatter), it's written to
 * `process.stderr` BEFORE the stdout payload — keeping stdout
 * structured for downstream consumers.
 *
 * Tests can spy on `process.stdout.write` and `process.stderr.write` to
 * assert the exact bytes emitted.
 */
export function emitResult<T>(data: T, format: OutputFormat = "pretty", options: OutputFormatters<T> = {}): void {
  const result = formatResult(data, format, options);
  if ("warning" in result) {
    process.stderr.write(`${result.warning}\n`);
  }
  process.stdout.write(`${result.output}\n`);
}
