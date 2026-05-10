// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { profile } from "@ttctl/core";

import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio list`. Reads the user's
 * portfolio collection and emits it via the cross-CLI output helper
 * (`packages/cli/src/lib/output.ts` from #71). The text branch emits a
 * one-line-per-item summary; table prints a `cli-table3` view; json
 * stringifies the typed array.
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
    pretty: formatPortfolioText,
    table: formatPortfolioTable,
    empty: { command: "profile.portfolio.list" },
  });
}

/**
 * Format the portfolio list as a human-readable summary. The empty case
 * surfaces a clear `(none)` marker so users don't read a blank stdout
 * as a failed call.
 */
export function formatPortfolioText(items: profile.portfolio.PortfolioItem[]): string {
  if (items.length === 0) return "(no portfolio items)";
  const lines: string[] = [`${items.length.toString()} portfolio item${items.length === 1 ? "" : "s"}:`];
  for (const it of items) {
    const star = it.highlight ? " ★" : "";
    lines.push(`  ${it.id}${star} ${it.title ?? "(untitled)"}`);
    if (it.link !== null) lines.push(`    ${it.link}`);
    if (it.clientOrCompanyName !== null) lines.push(`    Client: ${it.clientOrCompanyName}`);
  }
  return lines.join("\n");
}

/**
 * Format the portfolio list as a `cli-table3`-rendered table sized to
 * the current terminal width.
 */
export function formatPortfolioTable(
  items: profile.portfolio.PortfolioItem[],
  terminalWidth: number = process.stdout.columns || 80,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "title", "highlight", "link"] });
    return empty.toString();
  }
  const idWidth = 14;
  const highlightWidth = 11;
  const titleWidth = Math.max(20, Math.floor((terminalWidth - idWidth - highlightWidth - 5) / 2));
  const linkWidth = Math.max(20, terminalWidth - idWidth - titleWidth - highlightWidth - 8);
  const table = new Table({
    head: ["id", "title", "highlight", "link"],
    colWidths: [idWidth, titleWidth, highlightWidth, linkWidth],
    wordWrap: true,
  });
  for (const it of items) {
    table.push([it.id, it.title ?? "", it.highlight ? "★" : "", it.link ?? ""]);
  }
  return table.toString();
}
