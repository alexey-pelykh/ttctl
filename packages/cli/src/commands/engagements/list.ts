// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { engagements } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { buildEngagementsPageInfo, formatPageFooter, handleEngagementsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl engagements list`. Lists the user's
 * engagements (active by default), filtered to the engagement-bearing
 * status groups.
 *
 * Filters: `--status active|past|all` (default `active`) and
 * `--keywords` (free-text, repeatable; passed through to the gateway).
 *
 * Pagination (#375): `--page` (1-indexed) / `--per-page` are declared
 * on this leaf (per #183, per paginating leaf) and threaded to the
 * service's `jobActivityList.page` / `pageSize` wire args. When
 * neither flag is set, the service applies defaults
 * (`page: 1, perPage: 20`). The JSON / YAML envelope carries
 * `pageInfo` (`currentPage`, `perPage`, `totalPages`, `hasNextPage`);
 * the pretty / table footer renders "Page X of Y (per_page=Z)" when
 * `totalCount > 0`.
 */
export interface EngagementsListOptions {
  status?: engagements.EngagementListStatus;
  keywords?: string[];
  page?: number;
  perPage?: number;
  output: OutputFormat;
}

export async function runEngagementsList(opts: EngagementsListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements list", opts.output);

  const listOpts: engagements.ListOptions = {};
  if (opts.status !== undefined) listOpts.status = opts.status;
  if (opts.keywords !== undefined) listOpts.keywords = opts.keywords;
  if (opts.page !== undefined) listOpts.page = opts.page;
  if (opts.perPage !== undefined) listOpts.perPage = opts.perPage;

  let page: engagements.EngagementListPage;
  try {
    page = await engagements.list(token, listOpts);
  } catch (err) {
    handleEngagementsError("engagements list", err, opts.output);
  }

  const pageInfo = buildEngagementsPageInfo(page);
  emitResult(wrapListEnvelope(page.items, pageInfo), opts.output, {
    pretty: (data) => renderEngagementsListPretty(data.items, page),
    table: (data) => renderEngagementsListPretty(data.items, page),
    empty: { command: "engagements.list" },
  });
}

/**
 * Render the engagements table plus the pretty-mode pagination footer
 * underneath (#375). Mirrors `renderJobsListPretty` in
 * `jobs/list.ts`: the footer is appended only when `totalCount > 0` —
 * empty pages route through the empty-state CTA wrapper BEFORE this
 * renderer fires, so the defensive `if` here preserves the
 * direct-call surface (tests, future programmatic use).
 */
function renderEngagementsListPretty(
  items: engagements.EngagementListItem[],
  page: engagements.EngagementListPage,
): string {
  const table = formatEngagementsTable(items);
  if (page.totalCount <= 0) return table;
  return `${table}\n${formatPageFooter(page.page, page.perPage, page.totalCount)}`;
}

/**
 * Render the engagements list as a `cli-table3` table sized to the
 * current terminal width. Columns: id, status, client, job title,
 * starts, hours.
 *
 * `client` and `job title` together carry the engagement identity for
 * the human reader; `starts` (engagement start date) and `hours`
 * (expected hours per week) are the most diagnostic fields for
 * day-to-day use.
 */
export function formatEngagementsTable(
  items: engagements.EngagementListItem[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "status", "client", "job", "starts", "hours"] });
    return empty.toString();
  }
  const idWidth = 22;
  const statusWidth = 12;
  const clientWidth = 18;
  const startsWidth = 12;
  const hoursWidth = 7;
  // 6 columns × 2 padding-char + 7 borders ≈ 19
  const remaining = Math.max(20, terminalWidth - idWidth - statusWidth - clientWidth - startsWidth - hoursWidth - 19);
  const titleWidth = Math.max(20, remaining);
  const table = new Table({
    head: ["id", "status", "client", "job", "starts", "hours"],
    colWidths: [idWidth, statusWidth, clientWidth, titleWidth, startsWidth, hoursWidth],
    colAligns: ["left", "left", "left", "left", "left", "right"],
    wordWrap: true,
  });
  for (const it of items) {
    table.push([
      it.id,
      shortenEngagementStatus(it.statusGroupV2.value),
      it.job.client?.fullName ?? "(no client)",
      it.job.title ?? "(untitled)",
      formatDate(it.startDate),
      it.expectedHours !== null ? it.expectedHours.toString() : "—",
    ]);
  }
  return table.toString();
}

/**
 * Shorten the engagement-bearing status group for column display.
 * Other status groups (which the engagements service shouldn't return,
 * but defend against) fall through with the full enum value.
 */
export function shortenEngagementStatus(value: string): string {
  switch (value) {
    case "ACTIVE_ENGAGEMENT":
      return "Active";
    case "CLOSED_ENGAGEMENT":
      return "Closed";
    default:
      return value;
  }
}

/**
 * Render an ISO 8601 timestamp or `Date` string as just the date
 * portion (YYYY-MM-DD) for table compactness. Returns `"—"` for
 * `null` and the input as-is when it doesn't parse.
 */
export function formatDate(value: string | null): string {
  if (value === null || value === "") return "—";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m?.[1] ?? value;
}
