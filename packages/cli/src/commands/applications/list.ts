// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { applications } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import {
  buildApplicationsPageInfo,
  formatApplicationsPageFooter,
  handleApplicationsError,
  loadAuthTokenOrExit,
} from "./shared.js";

/**
 * Action handler for `ttctl applications list`. Reads the user's
 * activity items (applications, availability requests, interviews,
 * engagements) and emits via the cross-CLI output helper, wrapped in
 * the v0.4 list envelope (`{version, items, pageInfo}` from #128) for
 * `json` / `yaml`.
 *
 * Filters: `--keywords` (free-text, repeatable) and `--status-group`
 * (one of the five `JobActivityItemStatusGroupEnum` values, repeatable
 * — server-side AND across instances).
 *
 * **Pagination (#377, per-command flags per #183)**: reads `--page` /
 * `--per-page` directly from the leaf's parsed options. When neither
 * flag is set, the service applies defaults (`page: 1, perPage: 20`).
 * `#377` added `$page` / `$pageSize` to the hand-authored
 * `JobActivityItems` document — a wire-shape change gated by the
 * mandatory live E2E (schema/contract rule). `pageInfo` is always
 * surfaced (the service always returns the resolved page metadata),
 * mirroring the post-#138 jobs behavior. Date filters (`--from` /
 * `--to`) remain out of scope per #15 § Open Questions (RESOLVED).
 */
export interface ApplicationsListOptions {
  keywords?: string[];
  statusGroups?: applications.StatusGroup[];
  page?: number;
  perPage?: number;
  output: OutputFormat;
}

export async function runApplicationsList(opts: ApplicationsListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("applications list", opts.output);

  // `exactOptionalPropertyTypes: true` requires us to OMIT optional
  // fields rather than pass them as `undefined`; build the input
  // additively per the project pattern (see `runProfileVisasAdd`).
  const listOpts: applications.ListOptions = {};
  if (opts.keywords !== undefined) listOpts.keywords = opts.keywords;
  if (opts.statusGroups !== undefined) listOpts.statusGroups = opts.statusGroups;
  if (opts.page !== undefined) listOpts.page = opts.page;
  if (opts.perPage !== undefined) listOpts.perPage = opts.perPage;

  let page: applications.JobActivityListPage;
  try {
    page = await applications.list(token, listOpts);
  } catch (err) {
    handleApplicationsError("applications list", err, opts.output);
  }

  const pageInfo = buildApplicationsPageInfo(page);
  emitResult(wrapListEnvelope(page.items, pageInfo), opts.output, {
    pretty: (data) => renderApplicationsListPretty(data.items, page),
    table: (data) => renderApplicationsListPretty(data.items, page),
    empty: { command: "applications.list" },
  });
}

/**
 * Render the activity table plus the pretty-mode pagination footer
 * underneath (#377). Single source of truth for the `pretty` / `table`
 * slots so footer styling stays uniform — structural twin of jobs'
 * `renderJobsListPretty`.
 *
 * The footer is appended only when `totalCount > 0` — empty pages
 * route through the empty-state CTA wrapper BEFORE this renderer
 * fires, so the `items.length === 0` branch in `formatApplicationsTable`
 * is unreachable from this path. The defensive `if` preserves the
 * direct-call surface (tests, future programmatic use).
 */
function renderApplicationsListPretty(
  items: applications.JobActivityItem[],
  page: applications.JobActivityListPage,
): string {
  const table = formatApplicationsTable(items);
  if (page.totalCount <= 0) return table;
  return `${table}\n${formatApplicationsPageFooter(page.page, page.perPage, page.totalCount)}`;
}

/**
 * Render the activity list as a `cli-table3` table sized to the
 * current terminal width. Columns: id, status (verbose), group, job
 * title, last updated.
 *
 * Used by both `pretty` and `table` slots — the table layout is the
 * primary human view; per the format-overrides registry pattern, lists
 * with one-line-per-row data prefer `table`. Multi-line per-item
 * formatting (`pretty` block) is reserved for sub-domains where one or
 * more fields are paragraph-length (`description`, `accomplishment`).
 * Activity rows have no such field at the list level — `descriptionMd`
 * is on the detail view only.
 */
export function formatApplicationsTable(
  items: applications.JobActivityItem[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "status", "group", "job", "updated"] });
    return empty.toString();
  }
  // Fixed widths: id (≤20 chars usually), updated (10 chars for YYYY-MM-DD).
  // Status / group are short-enum values verbose-rendered (~20 chars).
  // Remaining width goes to job title.
  const idWidth = 22;
  const statusWidth = 18;
  const groupWidth = 16;
  const updatedWidth = 12;
  // 5 columns × 2 padding-char each + 6 borders ≈ 16
  const remaining = Math.max(20, terminalWidth - idWidth - statusWidth - groupWidth - updatedWidth - 16);
  const titleWidth = Math.max(20, remaining);
  const table = new Table({
    head: ["id", "status", "group", "job", "updated"],
    colWidths: [idWidth, statusWidth, groupWidth, titleWidth, updatedWidth],
    wordWrap: true,
  });
  for (const it of items) {
    table.push([
      it.id,
      it.statusV2.verbose,
      shortenStatusGroup(it.statusGroupV2.value),
      it.job.title ?? "(untitled)",
      formatDate(it.lastUpdatedAt),
    ]);
  }
  return table.toString();
}

/**
 * Shorten the `JobActivityItemStatusGroupEnum` value for column display.
 * `ACTIVE_ENGAGEMENT` → `Active`, `ON_RECRUITER_REVIEW` → `Recruiter`,
 * etc. The full value is preserved in `--json` / `--yaml` output via
 * the unmodified `statusGroupV2.value`.
 */
export function shortenStatusGroup(value: string): string {
  switch (value) {
    case "ACTIVE_ENGAGEMENT":
      return "Active";
    case "ARCHIVED":
      return "Archived";
    case "CLOSED_ENGAGEMENT":
      return "Closed";
    case "ON_CLIENT_REVIEW":
      return "Client";
    case "ON_RECRUITER_REVIEW":
      return "Recruiter";
    default:
      return value;
  }
}

/**
 * Render an ISO 8601 timestamp as just the date portion (YYYY-MM-DD)
 * for table compactness. Returns the input as-is when it doesn't parse
 * — defensive against future server-format drift.
 */
export function formatDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m?.[1] ?? iso;
}
