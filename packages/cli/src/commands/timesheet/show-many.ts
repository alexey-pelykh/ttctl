// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { timesheet } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatTimesheetsTable } from "./list.js";
import { handleTimesheetError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl timesheet show-many <id...>`.
 * Batch-fetches several timesheets in one wire round-trip via
 * `timesheet.showMany` (`TimesheetsByIDs`), emitting the found
 * timesheets in input order. Ids that resolve to no timesheet are
 * reported (pretty: a trailing "Not found" line; json / yaml consumers
 * diff the returned `id`s against their input).
 *
 * Returns LIST-ROW fields (the same shape as `timesheet list`), NOT the
 * per-day detail of `timesheet show <id>` — the batch wire op selects
 * list fields only.
 */
export async function runTimesheetShowMany(ids: string[], output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("timesheet show-many", output);

  let items: timesheet.TimesheetListItem[];
  try {
    items = await timesheet.showMany(token, ids);
  } catch (err) {
    handleTimesheetError("timesheet show-many", err, output);
  }

  const found = new Set(items.map((t) => t.id));
  const missing = ids.filter((id) => !found.has(id));
  emitResult(items, output, {
    pretty: (data) => formatTimesheetShowMany(data, missing),
    table: (data) => formatTimesheetShowMany(data, missing),
  });
}

/**
 * Render the batch result as the `timesheet list` table plus a trailing
 * "Not found" line for any requested ids the API did not return. Pure —
 * directly unit-testable.
 */
export function formatTimesheetShowMany(items: timesheet.TimesheetListItem[], missing: string[]): string {
  const table = formatTimesheetsTable(items);
  if (missing.length === 0) return table;
  return `${table}\nNot found (${missing.length.toString()}): ${missing.join(", ")}`;
}
