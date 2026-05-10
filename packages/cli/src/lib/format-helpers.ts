// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Shared rendering helpers for the post-#126 `pretty` format. Centralised
 * so every sub-domain formatter applies the same null convention and
 * paragraph layout — the audit at
 * `docs/audit/2026-05-output-format-formatter-audit.md` flagged at least
 * four distinct null-rendering conventions across the 11 sub-domains.
 *
 * Used today by the rewritten `formatProfilePretty` (basic) and
 * `formatPortfolioPretty` (portfolio) per #129. Other sub-domains adopt
 * these helpers as their formatters are revisited.
 */

/**
 * Default placeholder for fields the user CAN set but hasn't. Renders
 * verbatim in `pretty` per the audit's standardisation recommendation
 * (§ Standardization Recommendation for `pretty`). The placeholder is
 * intentionally bracketed so it cannot collide with a value the user
 * stored — `(` / `)` are not valid leading characters in any of the
 * Toptal profile fields we render.
 */
export const UNSET_PLACEHOLDER = "(unset)";

/**
 * Coerce a `string | null | undefined | ""` value into either the value
 * itself (when present) or a placeholder. The empty string is treated as
 * "unset" because the talent-profile API returns `""` for fields the
 * user has explicitly cleared (e.g., a deleted bio surfaces as
 * `about: ""`, not `about: null`) — empirically observed in the
 * `UPDATE_BASIC_INFO` round-trip and the `Profile.city` server contract.
 *
 * Pass an explicit `fallback` when the formatter wants a CTA-style
 * placeholder (e.g., `"(unset — set with: ttctl profile basic update --bio
 * \"<text>\")"`); the default `"(unset)"` is the audit-standardised
 * convention.
 */
export function unsetOr(value: string | null | undefined, fallback: string = UNSET_PLACEHOLDER): string {
  if (value === null || value === undefined || value === "") return fallback;
  return value;
}

/**
 * Indent every line of `text` by `indent` (default: two spaces). Empty
 * lines stay empty so paragraph breaks survive verbatim — the audit's
 * `pretty` contract requires `\n\n` in a source field to render as
 * actual blank lines, not escaped strings.
 *
 * Caller-controlled indent string lets a formatter compose nested
 * indentation (e.g., a portfolio item already indented two spaces from
 * the list marker can pass `"    "` to indent its description body four
 * spaces total).
 */
export function indentLines(text: string, indent: string = "  "): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `${indent}${line}`))
    .join("\n");
}

/**
 * Render a multi-paragraph field for `pretty` output: emit the prefix on
 * its own line, then the body indented one level deeper. Paragraph breaks
 * (`\n\n` in source) survive as actual blank lines via {@link indentLines}.
 *
 * The two-line shape ("Header:" then indented body) matches the audit's
 * recommendation for paragraph-bearing fields — single-line prefixes
 * collapse hierarchy and force the user to scan past the prefix to find
 * the start of the value.
 *
 * `outerIndent` is the indent of the prefix line itself (the surrounding
 * formatter's indent level); the body is indented `outerIndent + "  "`.
 *
 * @example
 *   renderMultiParagraph("Bio", "Hello.\n\nWorld.", "  ")
 *   // "  Bio:\n    Hello.\n\n    World."
 */
export function renderMultiParagraph(prefix: string, body: string, outerIndent: string = "  "): string {
  const innerIndent = `${outerIndent}  `;
  return `${outerIndent}${prefix}:\n${indentLines(body, innerIndent)}`;
}
