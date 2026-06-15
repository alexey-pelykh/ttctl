// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { jobs } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { buildJobsPageInfo, formatDate, formatPageFooter, handleJobsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Options for `ttctl jobs dashboard` — the talent's "my activity"
 * list (`viewer.jobActivityList`). Pagination only, mirroring
 * `jobs recommended`.
 */
export interface JobsDashboardOptions {
  page?: number;
  perPage?: number;
  output: OutputFormat;
}

/**
 * Action handler for `ttctl jobs dashboard`. Lists dashboard activity
 * items (engagements / applications / pending actions) in the same list
 * envelope + pretty footer as the other paginated jobs leaves.
 */
export async function runJobsDashboard(opts: JobsDashboardOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs dashboard", opts.output);

  const listOpts: jobs.DashboardListOptions = {};
  if (opts.page !== undefined) listOpts.page = opts.page;
  if (opts.perPage !== undefined) listOpts.perPage = opts.perPage;

  let page: jobs.DashboardJobPage;
  try {
    page = await jobs.getJobsForDashboard(token, listOpts);
  } catch (err) {
    handleJobsError("jobs dashboard", err, opts.output);
  }

  const pageInfo = buildJobsPageInfo(page);
  emitResult(wrapListEnvelope(page.items, pageInfo), opts.output, {
    pretty: (data) => renderDashboardPretty(data.items, page),
    table: (data) => renderDashboardPretty(data.items, page),
    empty: { command: "jobs.dashboard" },
  });
}

/**
 * Action handler for `ttctl jobs dashboard-count <status-group>`. The
 * wire op requires a status group (e.g. `ACTIVE_ENGAGEMENT`), so the
 * group is a required positional. Emits `{ statusGroup, count }` on
 * `json` / `yaml`; pretty renders a one-line summary.
 */
export async function runJobsDashboardCount(statusGroup: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs dashboard-count", output);

  let count: number;
  try {
    count = await jobs.getJobsCountForDashboard(token, statusGroup);
  } catch (err) {
    handleJobsError("jobs dashboard-count", err, output);
  }

  emitResult({ statusGroup, count }, output, {
    pretty: (data) => `Dashboard jobs (${data.statusGroup}): ${data.count.toString()}`,
  });
}

/**
 * Render the dashboard activity list as a table. The `job id` column is
 * the actionable id (feed it to `jobs show`); the activity-level `id`
 * lives in the JSON envelope only.
 *
 * Pure — directly unit-testable.
 */
export function formatDashboardTable(
  items: jobs.DashboardJobItem[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  const head = ["job id", "title", "client", "status", "group", "updated"];
  if (items.length === 0) return new Table({ head }).toString();
  const idWidth = 22;
  const clientWidth = 22;
  const statusWidth = 16;
  const groupWidth = 20;
  const updatedWidth = 12;
  const remaining = Math.max(20, terminalWidth - idWidth - clientWidth - statusWidth - groupWidth - updatedWidth - 20);
  const table = new Table({
    head,
    colWidths: [idWidth, Math.max(20, remaining), clientWidth, statusWidth, groupWidth, updatedWidth],
    wordWrap: true,
  });
  for (const it of items) {
    table.push([
      it.job.id,
      it.job.title ?? "(untitled)",
      it.job.client?.fullName ?? "",
      it.status?.verbose ?? it.status?.value ?? "",
      it.statusGroup ?? "",
      formatDate(it.lastUpdatedAt),
    ]);
  }
  return table.toString();
}

function renderDashboardPretty(items: jobs.DashboardJobItem[], page: jobs.DashboardJobPage): string {
  const table = formatDashboardTable(items);
  if (page.totalCount <= 0) return table;
  return `${table}\n${formatPageFooter(page.page, page.perPage, page.totalCount)}`;
}
