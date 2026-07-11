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
 * **Pagination not supported** — the captured wire ops have no
 * pagination args (`PendingTimesheets` has a hard `limit: 50` inline
 * in its document; `Timesheets($jobActivityItemId)` has none). Per
 * #183, pagination flags are declared PER paginating leaf; this leaf
 * does not declare `--page` / `--per-page`.
 */
export interface TimesheetListOptions {
  engagement?: string;
  output: OutputFormat;
}

export async function runTimesheetList(opts: TimesheetListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("timesheet list", opts.output);

  const listOpts: timesheet.ListOptions = {};
  if (opts.engagement !== undefined) listOpts.engagement = opts.engagement;

  let items: timesheet.TimesheetListItem[];
  try {
    items = await timesheet.list(token, listOpts);
  } catch (err) {
    handleTimesheetError("timesheet list", err, opts.output);
  }

  emitResult(wrapListEnvelope(items), opts.output, {
    pretty: (data) => formatTimesheetsTable(data.items),
    table: (data) => formatTimesheetsTable(data.items),
    empty: { command: "timesheet.list" },
  });
}

/**
 * Render the timesheet list as a `cli-table3` table sized to the
 * current terminal width. Columns:
 *
 *   id | engagement | job | week | hours | submitted | approved | overdue
 *
 * `week` shows the cycle's date range (`YYYY-MM-DD → YYYY-MM-DD`).
 * `submitted` is `✓` / `·` for visual scanning; `approved` (#849) is
 * `✓` approved / `·` pending / `—` approval not required; `overdue` is
 * `!` only when overdue (otherwise blank) so non-overdue rows are
 * visually quiet.
 */
export function formatTimesheetsTable(
  items: timesheet.TimesheetListItem[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "engagement", "job", "week", "hours", "submitted", "approved", "overdue"] });
    return empty.toString();
  }
  const idWidth = 22;
  const engagementWidth = 14;
  const weekWidth = 24;
  const hoursWidth = 7;
  const submittedWidth = 10;
  const approvedWidth = 10;
  const overdueWidth = 8;
  // 8 columns × 2 padding-char + 9 borders ≈ 25
  const remaining = Math.max(
    20,
    terminalWidth -
      idWidth -
      engagementWidth -
      weekWidth -
      hoursWidth -
      submittedWidth -
      approvedWidth -
      overdueWidth -
      25,
  );
  const jobWidth = Math.max(20, remaining);
  const table = new Table({
    head: ["id", "engagement", "job", "week", "hours", "submitted", "approved", "overdue"],
    colWidths: [idWidth, engagementWidth, jobWidth, weekWidth, hoursWidth, submittedWidth, approvedWidth, overdueWidth],
    colAligns: ["left", "left", "left", "left", "right", "center", "center", "center"],
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
      it.timesheetApproved ? "✓" : it.timesheetRequiresApproval ? "·" : "—",
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
