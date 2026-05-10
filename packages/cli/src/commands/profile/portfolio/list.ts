// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { profile } from "@ttctl/core";

import { renderMultiParagraph, unsetOr } from "../../../lib/format-helpers.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio list`. Reads the user's
 * portfolio collection and emits it via the cross-CLI output helper
 * (`packages/cli/src/lib/output.ts` from #71). The pretty branch emits a
 * curated multi-line summary surfacing every editable field;
 * json/yaml stringify the typed array.
 *
 * Per #129, only the `pretty` slot is registered with `emitResult`.
 * `formatResult`'s shape dispatcher prefers the `table` slot for
 * list-shape data when present; omitting the slot routes the user-
 * visible `--output=pretty` to {@link formatPortfolioPretty} — the
 * curated multi-line layout that surfaces `description`,
 * `accomplishment`, `coverImage`, and `clientOrCompanyName` (the
 * audit-confirmed dropped fields from #124). The audit's Override
 * Registry Decisions endorse routing portfolio list to multi-line
 * because `description`/`accomplishment` are paragraph-length and
 * the row-based table layout collapses them. {@link formatPortfolioTable}
 * stays exported for direct test use and future dispatcher wiring.
 *
 * Empty case is handled by the shared empty-state wrapper (#122) via
 * `empty: { command: "profile.portfolio.list" }` — the wrapper short-
 * circuits BEFORE per-format dispatch and emits `"No portfolio items
 * found. Add one with: ttctl profile portfolio add"` for `pretty`,
 * `[]` for `json`. The formatters keep a defensive empty-list branch
 * for direct callers (tests, future programmatic use) that bypass the
 * action handler.
 */
export async function runProfilePortfolioList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("portfolio list");

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.list(token);
  } catch (err) {
    handlePortfolioError("portfolio list", err);
    return;
  }

  emitResult(items, format, {
    pretty: formatPortfolioPretty,
    empty: { command: "profile.portfolio.list" },
  });
}

/**
 * Format the portfolio list as the post-#129 `pretty` summary. Pure —
 * no I/O — directly unit-testable.
 *
 * Per-item layout, indented two spaces from the count header:
 *
 *   <id>[ ★] <title>
 *     Client: <clientOrCompanyName>     // skip-if-null
 *     URL: <link>                        // skip-if-null
 *     Cover: <coverImage>                // skip-if-null
 *     Description:                       // always (renders (unset) on null)
 *       <body, paragraph breaks preserved>
 *     Accomplishment:                    // skip-if-null (multi-paragraph)
 *       <body>
 *
 * Items are separated by a single blank line. Field ordering for each
 * item: identity (id, highlight star, title) first, then user-edited
 * narrative (client, url, cover, description, accomplishment) — most
 * user-edited last because they're the multi-line block fields that
 * benefit from sticking to the bottom of the item.
 *
 * Closes the audit-confirmed formatter-root-cause defect from #124:
 * `description`, `accomplishment`, `coverImage`, and
 * `clientOrCompanyName` are now visible in the default output (the
 * pre-#129 formatter dropped 7 of 12 entity fields).
 *
 * `tags` and `media` are NOT on the wire `PortfolioItem` — neither the
 * mobile-gateway nor the talent-profile schema declares them. The audit
 * flagged them as suspect; #127 verified absence empirically. They are
 * deliberately omitted here.
 *
 * Pretty does NOT truncate (per the issue AC: "For long URLs / IDs:
 * don't truncate (this is `pretty`, not `table`)"); the terminal wraps
 * if the user's window is narrow.
 */
export function formatPortfolioPretty(items: profile.portfolio.PortfolioItem[]): string {
  if (items.length === 0) return "(no portfolio items)";

  const headerLine = `${items.length.toString()} portfolio item${items.length === 1 ? "" : "s"}:`;
  const itemBlocks: string[] = items.map((it) => renderPortfolioItem(it));
  return [headerLine, "", ...joinWithSeparator(itemBlocks, "")].join("\n");
}

/**
 * Format the portfolio list as a `cli-table3`-rendered table sized to
 * the current terminal width. Restores the `clientOrCompanyName` column
 * dropped by the pre-#129 formatter (audit-confirmed asymmetric drop:
 * `text` had it, `table` didn't).
 *
 * Long-form fields (`description`, `accomplishment`) are NOT in the
 * table — paragraph-length text doesn't fit a row layout. The override
 * registry in `lib/format-overrides.ts` flags `profile portfolio list`
 * as a candidate for the `multi-line` strategy; users wanting the full
 * detail land on `pretty` (the post-#126 default).
 */
export function formatPortfolioTable(
  items: profile.portfolio.PortfolioItem[],
  terminalWidth: number = process.stdout.columns || 80,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "title", "highlight", "client", "link"] });
    return empty.toString();
  }
  const idWidth = 14;
  const highlightWidth = 12;
  // Three text columns share the remaining width: title, client, link.
  // Borders + outer padding consume ~7 chars total.
  const remaining = Math.max(60, terminalWidth - idWidth - highlightWidth - 7);
  const titleWidth = Math.max(15, Math.floor(remaining / 3));
  const clientWidth = Math.max(15, Math.floor(remaining / 3));
  const linkWidth = Math.max(15, remaining - titleWidth - clientWidth);
  const table = new Table({
    head: ["id", "title", "highlight", "client", "link"],
    colWidths: [idWidth, titleWidth, highlightWidth, clientWidth, linkWidth],
    wordWrap: true,
  });
  for (const it of items) {
    table.push([it.id, it.title ?? "", it.highlight ? "★" : "", it.clientOrCompanyName ?? "", it.link ?? ""]);
  }
  return table.toString();
}

/**
 * Render one portfolio item as a multi-line block. The block is indented
 * two spaces from the count header; the per-field detail is indented
 * four spaces total (block indent + nested indent).
 */
function renderPortfolioItem(it: profile.portfolio.PortfolioItem): string {
  const blockIndent = "  ";
  const detailIndent = "    ";
  const star = it.highlight ? " ★" : "";
  const title = it.title ?? "(untitled)";
  const lines: string[] = [`${blockIndent}${it.id}${star} ${title}`];

  if (it.clientOrCompanyName !== null) {
    lines.push(`${detailIndent}Client: ${it.clientOrCompanyName}`);
  }
  if (it.link !== null) {
    lines.push(`${detailIndent}URL: ${it.link}`);
  }
  if (it.coverImage !== null) {
    lines.push(`${detailIndent}Cover: ${it.coverImage}`);
  }

  // Description always emits — it's the primary user-edited field, so
  // the (unset) marker is itself the "you can edit this" signal. Multi-
  // paragraph rendering preserves `\n\n` as actual blank lines.
  if (it.description !== null && it.description !== "") {
    lines.push(renderMultiParagraph("Description", it.description, detailIndent));
  } else {
    lines.push(`${detailIndent}Description: ${unsetOr(null)}`);
  }

  // Accomplishment is skip-if-null per the AC's "if present" qualifier
  // — it's secondary narrative content; rendering (unset) for every
  // item without one would clutter long lists.
  if (it.accomplishment !== null && it.accomplishment !== "") {
    lines.push(renderMultiParagraph("Accomplishment", it.accomplishment, detailIndent));
  }

  return lines.join("\n");
}

/**
 * Interleave `parts` with `separator` between every adjacent pair, like
 * `parts.join(separator)` but yielding a string array suitable for
 * splicing into a larger `lines` array via the spread operator.
 *
 * Used to produce the visible blank-line delimiter between portfolio
 * items without a trailing separator after the last item.
 */
function joinWithSeparator(parts: string[], separator: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push(separator);
    const part = parts[i];
    if (part !== undefined) out.push(part);
  }
  return out;
}
