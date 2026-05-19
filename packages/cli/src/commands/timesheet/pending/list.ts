// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { timesheet } from "@ttctl/core";

import { wrapListEnvelope } from "../../../lib/envelopes.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { formatTimesheetsTable } from "../list.js";
import { handleTimesheetError, loadAuthTokenOrExit } from "../shared.js";

/**
 * Action handler for `ttctl timesheet pending list [--limit N]` (#374,
 * per ADR-007 row 3 — "limit-only wrapper").
 *
 * **Surface-honest pagination divergence** from the other four
 * paginated services (`jobs list`, `applications list`,
 * `engagements list`, `payments payouts list`): those wires expose
 * offset-style pagination and surface `--page` / `--per-page` flags;
 * the underlying `PendingTimesheets` wire op accepts ONLY a
 * `pagination: { limit: Int }` input (`LimitPagination` field — no
 * `offset`, no cursor) so the CLI surfaces `--limit N` to mirror the
 * wire arg name exactly. Documented in ADR-007.
 *
 * The original re-spike attempt (PR #383, closed) added
 * `--page` / `--per-page` and tried to translate to
 * `pagination: { limit, offset }`. The wire rejected this with HTTP
 * 400 across 8 E2E tests. This sub-command is the canonical surface
 * for viewer-wide pending pagination going forward.
 *
 * Existing `ttctl timesheet list` (with `--engagement` for per-engagement
 * mode) is unchanged.
 *
 * Pretty rendering reuses `formatTimesheetsTable` from the sibling
 * `list.ts`: column-aligned table; pretty empty-state CTA via the
 * `empty` opt-in in `emitResult` (#122 reframe).
 */
export interface TimesheetPendingListOptions {
  limit?: number;
  output: OutputFormat;
}

export async function runTimesheetPendingList(opts: TimesheetPendingListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("timesheet pending list", opts.output);

  const listOpts: timesheet.ListOptions = {};
  if (opts.limit !== undefined) listOpts.limit = opts.limit;

  let items: timesheet.TimesheetListItem[];
  try {
    items = await timesheet.list(token, listOpts);
  } catch (err) {
    handleTimesheetError("timesheet pending list", err, opts.output);
  }

  emitResult(wrapListEnvelope(items), opts.output, {
    pretty: (data) => formatTimesheetsTable(data.items),
    table: (data) => formatTimesheetsTable(data.items),
    empty: { command: "timesheet.pending.list" },
  });
}
