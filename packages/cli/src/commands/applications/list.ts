// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { applications } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl applications list`. Reads the user's
 * activity items (applications, availability requests, interviews,
 * engagements) and emits via the cross-CLI output helper, wrapped in
 * the v0.4 list envelope (`{version, items, pageInfo?}` from #128) for
 * `json` / `yaml`.
 *
 * Filters: `--keywords` (free-text, repeatable) and `--status-group`
 * (one of the five `JobActivityItemStatusGroupEnum` values, repeatable
 * — server-side AND across instances).
 *
 * **Pagination & date filters not exposed** — the captured
 * `JobActivityItems` operation accepts neither. Per #183, pagination
 * flags are declared PER paginating leaf (jobs only); this leaf
 * does not declare `--page` / `--per-page`, so Commander emits its
 * standard `error: unknown option '--page'` (exit 1) when a user
 * passes either flag. Date filters remain out of scope per #15
 * § Open Questions (RESOLVED) in `.tmp/workitem-15.md`.
 */
export interface ApplicationsListOptions {
  keywords?: string[];
  statusGroups?: applications.StatusGroup[];
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

  let items: applications.JobActivityItem[];
  try {
    items = await applications.list(token, listOpts);
  } catch (err) {
    handleApplicationsError("applications list", err, opts.output);
  }

  emitResult(wrapListEnvelope(items), opts.output, {
    pretty: (data) => formatApplicationsTable(data.items),
    table: (data) => formatApplicationsTable(data.items),
    empty: { command: "applications.list" },
  });
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
