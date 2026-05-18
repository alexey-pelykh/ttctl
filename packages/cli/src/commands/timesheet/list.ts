// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { timesheet } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleTimesheetError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl timesheet list`. Default scope is
 * viewer-wide pending timesheets (whatever the user owes Toptal right
 * now); `--engagement <id>` switches to listing all billing cycles
 * for one engagement.
 *
 * Pretty rendering: column-aligned table; pretty empty-state CTA via
 * the `empty` opt-in in `emitResult` (#122 reframe).
 *
 * **Pagination (#374)**: `--page` / `--per-page` thread through to the
 * wire's offset-style `billingCycles(pagination: { limit, offset })`
 * input on BOTH variants (viewer-wide `PendingTimesheets` and
 * per-engagement `Timesheets`). When omitted, the service applies
 * defaults (`page: 1, perPage: 50`) — `50` preserves the pre-#374
 * hardcoded viewer-wide window, so flag-less behaviour is unchanged.
 *
 * **`pageInfo` is a SUBSET** of the offset-style envelope: the wire
 * `BillingCycleConnection` exposes no `totalCount`, so `pageInfo`
 * carries `currentPage` + `perPage` + `hasNextPage` but NOT
 * `totalPages`. `hasNextPage` is the heuristic `items.length ===
 * perPage` (a full page implies a possible next page). This diverges
 * from `jobs list` (whose wire reports `totalCount`); see
 * {@link timesheet.TimesheetListPage}.
 */
export interface TimesheetListOptions {
  engagement?: string;
  page?: number;
  perPage?: number;
  output: OutputFormat;
}

export async function runTimesheetList(opts: TimesheetListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("timesheet list", opts.output);

  const listOpts: timesheet.ListOptions = {};
  if (opts.engagement !== undefined) listOpts.engagement = opts.engagement;
  if (opts.page !== undefined) listOpts.page = opts.page;
  if (opts.perPage !== undefined) listOpts.perPage = opts.perPage;

  let page: timesheet.TimesheetListPage;
  try {
    page = await timesheet.list(token, listOpts);
  } catch (err) {
    handleTimesheetError("timesheet list", err, opts.output);
  }

  const pageInfo = buildTimesheetPageInfo(page);
  emitResult(wrapListEnvelope(page.items, pageInfo), opts.output, {
    pretty: (data) => renderTimesheetsListPretty(data.items, page),
    table: (data) => renderTimesheetsListPretty(data.items, page),
    empty: { command: "timesheet.list" },
  });
}

/**
 * Build the offset-style `pageInfo` block for the list envelope from
 * the service-layer {@link timesheet.TimesheetListPage}.
 *
 * **Subset of {@link import("../../lib/envelopes.js").EnvelopePageInfo}**:
 * the wire `BillingCycleConnection` ({ ids, nodes }) carries no
 * `totalCount`, so `totalPages` is intentionally OMITTED (with
 * `exactOptionalPropertyTypes`, an absent optional is omitted, not set
 * to `undefined`). `hasNextPage` is derived heuristically — a full
 * page (`items.length === perPage`) implies a possible next page;
 * a short page is definitively the last. This is the standard
 * offset-without-total pattern (`EnvelopePageInfo` documents the
 * cursor-style / no-`totalCount` subset case explicitly).
 *
 * Pure — directly unit-testable.
 */
export function buildTimesheetPageInfo(page: timesheet.TimesheetListPage): {
  currentPage: number;
  perPage: number;
  hasNextPage: boolean;
} {
  return {
    currentPage: page.page,
    perPage: page.perPage,
    hasNextPage: page.items.length === page.perPage,
  };
}

/**
 * Render the timesheet table plus a pretty-mode pagination footer.
 * The footer omits the "of Y" total (no wire `totalCount`); it shows
 * the current page, the page size, and a `(more available)` hint when
 * the page is full. The footer is appended only when the page is
 * non-empty — empty pages route through the empty-state CTA wrapper
 * BEFORE this renderer fires.
 */
function renderTimesheetsListPretty(items: timesheet.TimesheetListItem[], page: timesheet.TimesheetListPage): string {
  const table = formatTimesheetsTable(items);
  if (items.length === 0) return table;
  const more = items.length === page.perPage ? " (more available — use --page)" : "";
  return `${table}\nPage ${page.page.toString()} (per_page=${page.perPage.toString()})${more}`;
}

/**
 * Render the timesheet list as a `cli-table3` table sized to the
 * current terminal width. Columns:
 *
 *   id | engagement | job | week | hours | submitted | overdue
 *
 * `week` shows the cycle's date range (`YYYY-MM-DD → YYYY-MM-DD`).
 * `submitted` is `✓` / `·` for visual scanning; `overdue` is
 * `!` only when overdue (otherwise blank) so non-overdue rows are
 * visually quiet.
 */
export function formatTimesheetsTable(
  items: timesheet.TimesheetListItem[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "engagement", "job", "week", "hours", "submitted", "overdue"] });
    return empty.toString();
  }
  const idWidth = 22;
  const engagementWidth = 14;
  const weekWidth = 24;
  const hoursWidth = 7;
  const submittedWidth = 10;
  const overdueWidth = 8;
  // 7 columns × 2 padding-char + 8 borders ≈ 22
  const remaining = Math.max(
    20,
    terminalWidth - idWidth - engagementWidth - weekWidth - hoursWidth - submittedWidth - overdueWidth - 22,
  );
  const jobWidth = Math.max(20, remaining);
  const table = new Table({
    head: ["id", "engagement", "job", "week", "hours", "submitted", "overdue"],
    colWidths: [idWidth, engagementWidth, jobWidth, weekWidth, hoursWidth, submittedWidth, overdueWidth],
    colAligns: ["left", "left", "left", "left", "right", "center", "center"],
    wordWrap: true,
  });
  for (const it of items) {
    const client = it.engagement.job.client?.fullName ?? "(no client)";
    const title = it.engagement.job.title ?? "(untitled)";
    table.push([
      it.id,
      client,
      title,
      formatWeek(it.startDate, it.endDate),
      it.hours,
      it.timesheetSubmitted ? "✓" : "·",
      it.timesheetOverdue ? "!" : "",
    ]);
  }
  return table.toString();
}

/**
 * Render the cycle's date range. Wire dates are already ISO `YYYY-MM-DD`
 * strings — render verbatim with a separator.
 */
export function formatWeek(startDate: string, endDate: string): string {
  return `${startDate} → ${endDate}`;
}
