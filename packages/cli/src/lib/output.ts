// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { stringify as yamlStringify } from "yaml";

import { emptyStateProse, isEmptyCollection } from "./empty-state-cta.js";

/**
 * Cross-CLI output format for `show` and `list` commands.
 *
 * - `text`: human-formatted multi-line summary (default; trimmed/laid out
 *   for direct terminal reading)
 * - `json`: stable single-line JSON, suitable for piping to `jq` or `yq`
 * - `table`: rendered table (consumers typically use cli-table3) that
 *   respects terminal width
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
 */
export type OutputFormat = "text" | "json" | "table" | "yaml";

/**
 * All valid `OutputFormat` values, intended for `commander`'s
 * `Option#choices()`. Frozen at the type level via `readonly` so callers
 * cannot mutate the shared array.
 */
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "table", "yaml"];

/**
 * Caller-supplied formatters per format. Each returns the exact string
 * to emit on stdout (the helper appends a single trailing newline). The
 * `json` format has no formatter slot — the helper stringifies the data
 * directly via `JSON.stringify(data)`.
 *
 * `text` and `table` are optional; the helper falls through the format
 * lattice (`table → text → JSON.stringify(_, null, 2)`) when a
 * formatter is missing.
 *
 * `empty` opts the call site into the empty-state wrapper (#122). When
 * present AND `isEmptyCollection(data)` returns true, the wrapper
 * short-circuits BEFORE per-format dispatch and emits a per-format
 * empty payload — `[]` (single-line) for `json`; the prose+CTA from
 * `emptyStateProse(empty.command)` for `text` and `table` (the latter
 * deliberately AVOIDS a header-only `cli-table3` grid, which the
 * v0.4 reframe categorised as a "looks broken" pattern).
 *
 * The wrapper is opt-in (not auto-fire on every call) so search
 * leaves like `autocomplete` — which return arrays but want a
 * query-aware "no matches" line, not a create-CTA — can keep their
 * custom empty handling without overriding.
 */
export interface OutputFormatters<T> {
  text?: (data: T) => string;
  table?: (data: T) => string;
  empty?: { command: string };
}

/**
 * Stderr hint surfaced when the helper falls through to pretty-printed
 * JSON because no `text` formatter was provided. Exposed as a constant so
 * tests can assert on the exact wording without duplicating it.
 */
export const TEXT_FALLBACK_HINT = "note: no text formatter provided; falling back to pretty-printed JSON.";

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
 * `text` with no formatter). Callers using `formatResult` directly can
 * inspect this field instead of letting `emitResult` write to stderr.
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
 * - `text` with `options.text` → `options.text(data)`
 * - `text` without `options.text` → `JSON.stringify(data, null, 2)` plus
 *   a `warning` describing the fallthrough
 * - `table` with `options.table` → `options.table(data)`
 * - `table` without `options.table` → falls through to the `text` branch
 *   above (the warning surfaces if `options.text` is also absent)
 *
 * The helper does NOT validate `data` for JSON/YAML-safe shapes
 * (cycles, `undefined`, `Date`, `BigInt`, etc.); callers are
 * responsible for shaping data into a serialization-friendly form
 * before passing it.
 *
 * The `format` parameter defaults to `"text"` so the spec's "default
 * format is text" behavior holds even when commander defaults aren't
 * available (e.g., direct programmatic use).
 */
export function formatResult<T>(
  data: T,
  format: OutputFormat = "text",
  options: OutputFormatters<T> = {},
): FormatResult {
  // Empty-state wrapper (#122): fires BEFORE per-format dispatch when
  // the caller opts in via `options.empty` AND `data` is detected as an
  // empty collection (`[]` or `{items: []}`). Single-source per-format
  // empty output — text/table render the same prose+CTA from the
  // registry; json renders a stable single-line `[]`.
  if (options.empty !== undefined && isEmptyCollection(data)) {
    if (format === "json") {
      return { output: "[]" };
    }
    return { output: emptyStateProse(options.empty.command) };
  }
  if (format === "json") {
    return { output: JSON.stringify(data) };
  }
  if (format === "yaml") {
    return { output: formatYaml(data) };
  }
  if (format === "table" && options.table !== undefined) {
    return { output: options.table(data) };
  }
  // text branch — reached directly for `format === "text"` and as the
  // fall-through for `format === "table"` without a `table` formatter.
  if (options.text !== undefined) {
    return { output: options.text(data) };
  }
  return { output: JSON.stringify(data, null, 2), warning: TEXT_FALLBACK_HINT };
}

/**
 * Format `data` per `format` and write the result to `process.stdout`
 * (with a trailing newline). When `formatResult` surfaces a `warning`
 * (`text` fall-through with no formatter), it's written to
 * `process.stderr` BEFORE the stdout payload — keeping stdout
 * structured for downstream consumers.
 *
 * Tests can spy on `process.stdout.write` and `process.stderr.write` to
 * assert the exact bytes emitted.
 */
export function emitResult<T>(data: T, format: OutputFormat = "text", options: OutputFormatters<T> = {}): void {
  const result = formatResult(data, format, options);
  if ("warning" in result) {
    process.stderr.write(`${result.warning}\n`);
  }
  process.stdout.write(`${result.output}\n`);
}
