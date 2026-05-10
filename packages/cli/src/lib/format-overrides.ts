// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Per-command output-strategy overrides for the post-reframe `pretty`
 * format dispatch (#121 epic, audit at
 * `docs/audit/2026-05-output-format-formatter-audit.md`).
 *
 * The default `pretty` strategy is `"default"` — one row per
 * field, key/value layout. Some commands carry paragraph-length
 * fields that don't fit a row layout (reviewer comments, portfolio
 * descriptions, employment experience items). Those commands register
 * a `"multi-line"` strategy so the dispatch pipeline routes them to
 * the curated multi-line renderer instead.
 *
 * The registry is keyed by the **canonical command path** —
 * sub-domain verbs only, no Commander.js aliases. Aliases (`certs`
 * for `certifications`, `experience` for `employment`, `rm` for
 * `remove`) MUST collapse to the canonical form before lookup. The
 * dispatch layer (added in a downstream issue) is responsible for
 * the alias collapse.
 *
 * The registry intentionally ships small. Adding an entry should be
 * a deliberate decision tied to a specific defect (e.g., an audit
 * row in the triage report) — not a forward-looking guess.
 */

/**
 * Output strategy alternatives the `pretty` dispatcher can select.
 *
 * - `"default"` — fall through to the per-command formatter
 *   registered alongside the action handler. The dispatcher does not
 *   intervene.
 * - `"multi-line"` — route through the curated multi-line renderer.
 *   Used for commands whose entity carries paragraph-length text that
 *   would overflow a row-based layout.
 *
 * Future strategies (e.g., `"compact"` for inline single-line lists)
 * land as additional union members.
 */
export type FormatStrategy = "default" | "multi-line";

/**
 * Per-command-path strategy registry. Lookup is by canonical command
 * path (e.g., `"profile reviews list"`). Unknown paths fall through
 * to {@link DEFAULT_STRATEGY}.
 *
 * The registry is `ReadonlyMap` to discourage mutation at the call
 * site; tests that need to override entries should construct a fresh
 * map and pass it through a dependency-injected lookup function (the
 * registry is not a global singleton in spirit — `resolveStrategy`
 * accepts an explicit map for testability).
 *
 * Initial entries (per § Override Registry Decisions in the audit):
 *
 * - `profile reviews list`: forward-looking. The current entity
 *   (`SectionReview`) carries no paragraph-length fields, but #127
 *   may surface reviewer-comment / rejection-reason fields, at which
 *   point a row-based table breaks. Registering today is no-cost
 *   (multi-line still reads fine on short data) and forward-safe.
 *
 * Two further candidates are tracked as TODO comments below for the
 * downstream issue (#129 — formatter rewrites) to enroll once their
 * formatters are reshaped:
 *
 * - `profile employment list`: `experienceItems` is paragraph-length
 *   today; current table renders only a count.
 * - `profile portfolio list`: `description` and `accomplishment` are
 *   paragraph-length post-#129 fix.
 */
export const FORMAT_OVERRIDES: ReadonlyMap<string, FormatStrategy> = new Map<string, FormatStrategy>([
  ["profile reviews list", "multi-line"],
  // TODO(#129): enroll "profile employment list" → "multi-line" once
  // the formatter is rewritten to render `experienceItems` content.
  // TODO(#129): enroll "profile portfolio list" → "multi-line" once
  // the formatter is rewritten to render `description` and
  // `accomplishment`.
]);

/**
 * Default strategy when a command path has no registered override.
 * Exported so callers and tests can reference the same constant.
 */
export const DEFAULT_STRATEGY: FormatStrategy = "default";

/**
 * Resolve the format strategy for a canonical command path. Pure —
 * no I/O. The optional `overrides` parameter lets tests inject an
 * alternate registry without touching the module-level constant.
 *
 * Lookup is case-sensitive and exact-match. Aliases must collapse to
 * the canonical form upstream.
 */
export function resolveStrategy(
  commandPath: string,
  overrides: ReadonlyMap<string, FormatStrategy> = FORMAT_OVERRIDES,
): FormatStrategy {
  return overrides.get(commandPath) ?? DEFAULT_STRATEGY;
}
