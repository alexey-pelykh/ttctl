// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Cross-CLI output format for `show` and `list` commands.
 *
 * - `text`: human-formatted multi-line summary (default; trimmed/laid out
 *   for direct terminal reading)
 * - `json`: stable single-line JSON, suitable for piping to `jq` or `yq`
 * - `table`: rendered table (consumers typically use cli-table3) that
 *   respects terminal width
 *
 * The JSON shape commitment is "may break across 0.x" pre-1.0 and
 * "stable across majors per semver" at 1.0+; the helper enforces
 * single-line JSON to keep that contract observable to downstream tools.
 */
export type OutputFormat = "text" | "json" | "table";

/**
 * All valid `OutputFormat` values, intended for `commander`'s
 * `Option#choices()`. Frozen at the type level via `readonly` so callers
 * cannot mutate the shared array.
 */
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "table"];

/**
 * Caller-supplied formatters per format. Each returns the exact string
 * to emit on stdout (the helper appends a single trailing newline). The
 * `json` format has no formatter slot — the helper stringifies the data
 * directly via `JSON.stringify(data)`.
 *
 * Both fields are optional; the helper falls through the format lattice
 * (`table → text → JSON.stringify(_, null, 2)`) when a formatter is
 * missing.
 */
export interface OutputFormatters<T> {
  text?: (data: T) => string;
  table?: (data: T) => string;
}

/**
 * Stderr hint surfaced when the helper falls through to pretty-printed
 * JSON because no `text` formatter was provided. Exposed as a constant so
 * tests can assert on the exact wording without duplicating it.
 */
export const TEXT_FALLBACK_HINT = "note: no text formatter provided; falling back to pretty-printed JSON.";

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
 * - `text` with `options.text` → `options.text(data)`
 * - `text` without `options.text` → `JSON.stringify(data, null, 2)` plus
 *   a `warning` describing the fallthrough
 * - `table` with `options.table` → `options.table(data)`
 * - `table` without `options.table` → falls through to the `text` branch
 *   above (the warning surfaces if `options.text` is also absent)
 *
 * The helper does NOT validate `data` for JSON-safe shapes (cycles,
 * `undefined`, `Date`, `BigInt`, etc.); callers are responsible for
 * shaping data into JSON-friendly form before passing it.
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
  if (format === "json") {
    return { output: JSON.stringify(data) };
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
