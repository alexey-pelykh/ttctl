// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { engagements } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleEngagementsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl engagements list`. Lists the user's
 * engagements (active by default), filtered to the engagement-bearing
 * status groups.
 *
 * Filters: `--status active|past|all` (default `active`) and
 * `--keywords` (free-text, repeatable; passed through to the gateway).
 *
 * **Pagination not supported** — the captured `JobActivityItems`
 * operation has no `page` / `pageSize` args. Per #183, pagination
 * flags are declared PER paginating leaf; this leaf does not declare
 * `--page` / `--per-page`, so Commander emits its standard
 * `error: unknown option '--page'` (exit 1) when a user passes
 * either flag. If the wire ever gains pagination args, declare the
 * flags on this leaf and extend `engagements.list()` to accept
 * `{page?, perPage?}`.
 */
export interface EngagementsListOptions {
  status?: engagements.EngagementListStatus;
  keywords?: string[];
  output: OutputFormat;
}

export async function runEngagementsList(opts: EngagementsListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements list", opts.output);

  const listOpts: engagements.ListOptions = {};
  if (opts.status !== undefined) listOpts.status = opts.status;
  if (opts.keywords !== undefined) listOpts.keywords = opts.keywords;

  let items: engagements.EngagementListItem[];
  try {
    items = await engagements.list(token, listOpts);
  } catch (err) {
    handleEngagementsError("engagements list", err, opts.output);
  }

  emitResult(wrapListEnvelope(items), opts.output, {
    pretty: (data) => formatEngagementsTable(data.items),
    table: (data) => formatEngagementsTable(data.items),
    empty: { command: "engagements.list" },
  });
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
