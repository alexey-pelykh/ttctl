// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { profile } from "@ttctl/core";

import { wrapListEnvelope } from "../../../lib/envelopes.js";
import { renderMultiParagraph, unsetOr } from "../../../lib/format-helpers.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio list`. Reads the user's
 * portfolio collection and emits it via the cross-CLI output helper
 * (`packages/cli/src/lib/output.ts` from #71), wrapped in the v0.4
 * list envelope (`{version, items, pageInfo?}` from #128) for
 * json/yaml.
 *
 * Per #129, the `pretty` slot is registered with `emitResult` and
 * unwraps the envelope's `items` field for the curated multi-line
 * layout that surfaces `description`, `accomplishment`, `coverImage`,
 * and `clientOrCompanyName` (the audit-confirmed dropped fields from
 * #124). The `table` slot is also wired (also unwrapping `items`) —
 * `formatResult`'s shape dispatcher prefers `table` for list-shape
 * data when present, but the audit's Override Registry Decisions
 * endorse routing portfolio list to multi-line because
 * `description`/`accomplishment` are paragraph-length and the
 * row-based table layout collapses them. {@link formatPortfolioTable}
 * stays exported for direct test use and future override-dispatch
 * wiring.
 *
 * Empty case is handled by the shared empty-state wrapper (#122) via
 * `empty: { command: "profile.portfolio.list" }`. The wrapper detects
 * both `[]` and `{items: []}` shapes (per #122's `isEmptyCollection`),
 * so the post-#128 envelope wrapping continues to short-circuit
 * BEFORE per-format dispatch — emitting `"No portfolio items found.
 * Add one with: ttctl profile portfolio add"` for `pretty`, `[]` for
 * `json`. The formatters keep a defensive empty-list branch for
 * direct callers (tests, future programmatic use) that bypass the
 * action handler.
 */
export async function runProfilePortfolioList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("portfolio list", format);

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.list(token);
  } catch (err) {
    handlePortfolioError("portfolio list", err, format);
    return;
  }

  emitResult(wrapListEnvelope(items), format, {
    pretty: (data) => formatPortfolioPretty(data.items),
    table: (data) => formatPortfolioTable(data.items),
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

  // `details` (#548) is the structured body block — Image / Text /
  // Video / Gallery. Skip-if-null (most items have no body block).
  // A one-line per-variant summary plus an optional title — the body
  // content (full HAST tree, every gallery item URL) is reserved for
  // a future `portfolio show` deep view; here we keep the list dense.
  if (it.details !== null) {
    lines.push(renderDetailsSummary(it.details, detailIndent));
  }

  // `files` (#549) are the item's attachments — PDF documents and
  // images. Skip-if-empty (most items have none); when present, render
  // a short list: one row per file with its kind, URL, and title.
  if (it.files.length > 0) {
    lines.push(renderFilesSummary(it.files, detailIndent));
  }

  // `kpis` (#550) are the talent-authored quantified outcomes for the
  // project. Skip-if-empty (many items have none); when present, render
  // one row per KPI: `- <value>: <description>` (e.g. `- 40%: page
  // load reduction`). The order in the wire response is preserved.
  if (it.kpis.length > 0) {
    lines.push(renderKpisSummary(it.kpis, detailIndent));
  }

  // `quotes` (#551) are the talent-authored client / stakeholder
  // testimonials for the project. Skip-if-empty (most items have none);
  // when present, render one row per quote: `- "<text>" — <attribution>`
  // where attribution interleaves clientName, clientRole, and company.
  // The order in the wire response is preserved.
  if (it.quotes.length > 0) {
    lines.push(renderQuotesSummary(it.quotes, detailIndent));
  }

  return lines.join("\n");
}

/**
 * Render a one-line `Details:` summary for the variant: `<Kind>: <body>`
 * with an optional ` — <title>` suffix. Kept compact so the list view
 * stays scannable; future `portfolio show` can hydrate the full body
 * (text-block HAST traversal, gallery thumbnails, etc.).
 */
function renderDetailsSummary(d: profile.portfolio.PortfolioItemDetails, indent: string): string {
  const suffix = d.title !== null && d.title !== "" ? ` — ${d.title}` : "";
  switch (d.kind) {
    case "image": {
      const url = d.image?.optimizedUrl ?? d.image?.thumbUrl ?? null;
      const body = url ?? "(no url)";
      return `${indent}Details: Image: ${body}${suffix}`;
    }
    case "text":
      // HAST tree is opaque; surface its presence without serializing it.
      return `${indent}Details: Text${d.contentHast !== null ? " (rich body)" : ""}${suffix}`;
    case "video":
      return `${indent}Details: Video: ${d.videoUrl ?? "(no url)"}${suffix}`;
    case "gallery": {
      const count = d.items.length;
      const noun = count === 1 ? "item" : "items";
      return `${indent}Details: Gallery (${count.toString()} ${noun})${suffix}`;
    }
  }
}

/**
 * Render the attachment list for a portfolio item: a `Files (N):` header
 * followed by one row per file — `- <Kind>: <url> — <title>`. PDF files
 * surface their `fileUrl`; image files surface the optimized (falling
 * back to thumb) URL. Title suffix is appended when present. Callers
 * guard on `files.length > 0`, so this never renders an empty list.
 */
function renderFilesSummary(files: profile.portfolio.PortfolioItemFile[], indent: string): string {
  const count = files.length;
  const noun = count === 1 ? "file" : "files";
  const fileIndent = `${indent}  `;
  const rows = files.map((f) => {
    const suffix = f.title !== null && f.title !== "" ? ` — ${f.title}` : "";
    switch (f.kind) {
      case "pdf":
        return `${fileIndent}- PDF: ${f.fileUrl ?? "(no url)"}${suffix}`;
      case "image": {
        const url = f.image?.optimizedUrl ?? f.image?.thumbUrl ?? null;
        return `${fileIndent}- Image: ${url ?? "(no url)"}${suffix}`;
      }
    }
  });
  return [`${indent}Files (${count.toString()} ${noun}):`, ...rows].join("\n");
}

/**
 * Render the KPI list for a portfolio item: a `KPIs (N):` header followed
 * by one row per KPI — `- <value>: <description>`. Both `value` and
 * `description` are nullable; the row falls back to `(unset)` for either
 * when null/empty so the structural presence of a KPI entry stays visible
 * even when the talent only filled out part of it. Callers guard on
 * `kpis.length > 0`, so this never renders an empty list.
 */
function renderKpisSummary(kpis: profile.portfolio.PortfolioItemKpi[], indent: string): string {
  const count = kpis.length;
  const noun = count === 1 ? "KPI" : "KPIs";
  const kpiIndent = `${indent}  `;
  const rows = kpis.map((k) => {
    const value = k.value !== null && k.value !== "" ? k.value : "(unset)";
    const description = k.description !== null && k.description !== "" ? k.description : "(unset)";
    return `${kpiIndent}- ${value}: ${description}`;
  });
  return [`${indent}KPIs (${count.toString()} ${noun}):`, ...rows].join("\n");
}

/**
 * Render the testimonial list for a portfolio item: a `Quotes (N):` header
 * followed by one row per quote — `- "<text>" — <attribution>`. The
 * attribution interleaves `clientName`, `clientRole`, and `company`
 * (`Jane Doe, VP Engineering @ Acme`), omitting any part that is
 * null/empty; when none are present the ` — <attribution>` suffix is
 * dropped entirely. The testimonial body falls back to `(unset)` when
 * null/empty so the structural presence of a quote entry stays visible
 * even when the talent only filled out the attribution. Callers guard on
 * `quotes.length > 0`, so this never renders an empty list.
 */
function renderQuotesSummary(quotes: profile.portfolio.PortfolioItemQuote[], indent: string): string {
  const count = quotes.length;
  const noun = count === 1 ? "quote" : "quotes";
  const quoteIndent = `${indent}  `;
  const rows = quotes.map((q) => {
    const text = q.text !== null && q.text !== "" ? `"${q.text}"` : "(unset)";
    const namePart = q.clientName !== null && q.clientName !== "" ? q.clientName : null;
    const rolePart = q.clientRole !== null && q.clientRole !== "" ? q.clientRole : null;
    const companyPart = q.company !== null && q.company !== "" ? q.company : null;
    const who = [namePart, rolePart].filter((p): p is string => p !== null).join(", ");
    const attribution = companyPart !== null ? (who !== "" ? `${who} @ ${companyPart}` : companyPart) : who;
    return attribution !== "" ? `${quoteIndent}- ${text} — ${attribution}` : `${quoteIndent}- ${text}`;
  });
  return [`${indent}Quotes (${count.toString()} ${noun}):`, ...rows].join("\n");
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
