// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { jobs } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { getCliPagination } from "../../lib/pagination.js";
import {
  buildJobsPageInfo,
  formatJobsTable,
  formatPageFooter,
  handleJobsError,
  loadAuthTokenOrExit,
} from "./shared.js";

/**
 * Action handler for `ttctl jobs list`. Browse current job
 * opportunities with optional filters (skills, keywords, commitments,
 * work types, estimated lengths). Returns a list envelope
 * (`{version, items, pageInfo}`) on `json` / `yaml`.
 *
 * Pagination (#138): reads the global `--page` / `--per-page` flags
 * through `getCliPagination()` and threads them into the service
 * layer's `jobs.list({page?, perPage?})`. The service returns a
 * `JobListPage` carrying `totalCount`; the action handler builds the
 * offset-style `pageInfo` block via `buildJobsPageInfo()` and appends
 * a "Page X of Y (per_page=Z)" footer in pretty mode. When neither
 * flag is set, the service applies defaults (`page: 1, perPage: 20`)
 * — the same behavior as the pre-#138 hardcoded `eligibleJobs(page:
 * 0, pageSize: 20)` wire call.
 */
export interface JobsListOptions {
  skills?: string[];
  keywords?: string[];
  excludeSkills?: string[];
  excludeKeywords?: string[];
  commitments?: string[];
  workTypes?: string[];
  estimatedLengths?: string[];
  sortTarget?: string;
  output: OutputFormat;
}

export async function runJobsList(opts: JobsListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs list", opts.output);

  const pagination = getCliPagination();
  const listOpts: jobs.ListOptions = {};
  if (opts.skills !== undefined) listOpts.skills = opts.skills;
  if (opts.keywords !== undefined) listOpts.keywords = opts.keywords;
  if (opts.excludeSkills !== undefined) listOpts.excludeSkills = opts.excludeSkills;
  if (opts.excludeKeywords !== undefined) listOpts.excludeKeywords = opts.excludeKeywords;
  if (opts.commitments !== undefined) listOpts.commitments = opts.commitments;
  if (opts.workTypes !== undefined) listOpts.workTypes = opts.workTypes;
  if (opts.estimatedLengths !== undefined) listOpts.estimatedLengths = opts.estimatedLengths;
  if (opts.sortTarget !== undefined) listOpts.sortTarget = opts.sortTarget;
  if (pagination.page !== undefined) listOpts.page = pagination.page;
  if (pagination.perPage !== undefined) listOpts.perPage = pagination.perPage;

  let page: jobs.JobListPage;
  try {
    page = await jobs.list(token, listOpts);
  } catch (err) {
    handleJobsError("jobs list", err, opts.output);
  }

  const pageInfo = buildJobsPageInfo(page);
  emitResult(wrapListEnvelope(page.items, pageInfo), opts.output, {
    pretty: (data) => renderJobsListPretty(data.items, page),
    table: (data) => renderJobsListPretty(data.items, page),
    empty: { command: "jobs.list" },
  });
}

/**
 * Action handler for `ttctl jobs saved`. Wraps `jobs.saved()` (which
 * issues `eligibleJobs(filter: {saved: true})`).
 *
 * Pagination (#138): reads `--page` / `--per-page` from the global
 * holder; surfaces `pageInfo` and the pretty footer on the same shape
 * as `jobs list`.
 */
export async function runJobsSaved(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs saved", output);

  const pagination = getCliPagination();
  const listOpts: jobs.ListOptions = {};
  if (pagination.page !== undefined) listOpts.page = pagination.page;
  if (pagination.perPage !== undefined) listOpts.perPage = pagination.perPage;

  let page: jobs.JobListPage;
  try {
    page = await jobs.saved(token, listOpts);
  } catch (err) {
    handleJobsError("jobs saved", err, output);
  }

  const pageInfo = buildJobsPageInfo(page);
  emitResult(wrapListEnvelope(page.items, pageInfo), output, {
    pretty: (data) => renderJobsListPretty(data.items, page),
    table: (data) => renderJobsListPretty(data.items, page),
    empty: { command: "jobs.saved" },
  });
}

/**
 * Action handler for `ttctl jobs viewed`. Wraps `jobs.viewedList()`
 * (which fetches the requested page and filters client-side on
 * `viewed`).
 *
 * **Wire-shape gap (R1)**: `eligibleJobs` has no `viewed:
 * BooleanFilter`. The output is scoped to the requested page; the
 * post-filter list can be shorter than `--per-page`. A follow-up issue
 * tracks the wire-level filter.
 *
 * **Pagination (#138)**: the `totalCount` in `pageInfo` reflects the
 * UNDERLYING fetch (pre-filter). When the post-filter `items.length`
 * differs from `pageInfo.perPage`, that's the R1 narrowing — not a
 * pagination error.
 */
export async function runJobsViewed(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs viewed", output);

  const pagination = getCliPagination();
  const listOpts: jobs.ListOptions = {};
  if (pagination.page !== undefined) listOpts.page = pagination.page;
  if (pagination.perPage !== undefined) listOpts.perPage = pagination.perPage;

  let page: jobs.JobListPage;
  try {
    page = await jobs.viewedList(token, listOpts);
  } catch (err) {
    handleJobsError("jobs viewed", err, output);
  }

  const pageInfo = buildJobsPageInfo(page);
  emitResult(wrapListEnvelope(page.items, pageInfo), output, {
    pretty: (data) => renderJobsListPretty(data.items, page),
    table: (data) => renderJobsListPretty(data.items, page),
    empty: { command: "jobs.viewed" },
  });
}

/**
 * Action handler for `ttctl jobs not-interested-list`. Wraps
 * `jobs.notInterestedList()` (issues `eligibleJobs(filter:
 * {notInterested: true})`).
 *
 * Pagination (#138): same shape as `runJobsList` and `runJobsSaved`.
 */
export async function runJobsNotInterestedList(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs not-interested-list", output);

  const pagination = getCliPagination();
  const listOpts: jobs.ListOptions = {};
  if (pagination.page !== undefined) listOpts.page = pagination.page;
  if (pagination.perPage !== undefined) listOpts.perPage = pagination.perPage;

  let page: jobs.JobListPage;
  try {
    page = await jobs.notInterestedList(token, listOpts);
  } catch (err) {
    handleJobsError("jobs not-interested-list", err, output);
  }

  const pageInfo = buildJobsPageInfo(page);
  emitResult(wrapListEnvelope(page.items, pageInfo), output, {
    pretty: (data) => renderJobsListPretty(data.items, page),
    table: (data) => renderJobsListPretty(data.items, page),
    empty: { command: "jobs.not-interested-list" },
  });
}

/**
 * Render the jobs table plus the pretty-mode pagination footer
 * underneath. Single source of truth for the four jobs-domain list
 * leaves (`list`, `saved`, `viewed`, `not-interested-list`) so the
 * post-#138 footer styling stays uniform across the group.
 *
 * The footer is appended only when `totalCount > 0` — empty pages
 * route through the empty-state CTA wrapper BEFORE this renderer
 * fires, so the `items.length === 0` branch in `formatJobsTable` is
 * unreachable from this path. Defensive `if` here preserves the
 * direct-call surface (tests, future programmatic use).
 */
function renderJobsListPretty(items: jobs.JobListItem[], page: jobs.JobListPage): string {
  const table = formatJobsTable(items);
  if (page.totalCount <= 0) return table;
  return `${table}\n${formatPageFooter(page.page, page.perPage, page.totalCount)}`;
}
