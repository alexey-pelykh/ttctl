// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { jobs } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatJobsTable, handleJobsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl jobs list`. Browse current job
 * opportunities with optional filters (skills, keywords, commitments,
 * work types, estimated lengths). Returns a list envelope
 * (`{version, items, pageInfo?}`) on `json` / `yaml`.
 *
 * **Pagination not exposed in v1** — the wire supports `page` /
 * `pageSize` but the v1 surface keeps the default first-page scope to
 * stay consistent with #15 / #146 / #147. Will land via #138.
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

  const listOpts: jobs.ListOptions = {};
  if (opts.skills !== undefined) listOpts.skills = opts.skills;
  if (opts.keywords !== undefined) listOpts.keywords = opts.keywords;
  if (opts.excludeSkills !== undefined) listOpts.excludeSkills = opts.excludeSkills;
  if (opts.excludeKeywords !== undefined) listOpts.excludeKeywords = opts.excludeKeywords;
  if (opts.commitments !== undefined) listOpts.commitments = opts.commitments;
  if (opts.workTypes !== undefined) listOpts.workTypes = opts.workTypes;
  if (opts.estimatedLengths !== undefined) listOpts.estimatedLengths = opts.estimatedLengths;
  if (opts.sortTarget !== undefined) listOpts.sortTarget = opts.sortTarget;

  let items: jobs.JobListItem[];
  try {
    items = await jobs.list(token, listOpts);
  } catch (err) {
    handleJobsError("jobs list", err, opts.output);
  }

  emitResult(wrapListEnvelope(items), opts.output, {
    pretty: (data) => formatJobsTable(data.items),
    table: (data) => formatJobsTable(data.items),
    empty: { command: "jobs.list" },
  });
}

/**
 * Action handler for `ttctl jobs saved`. Wraps `jobs.saved()` (which
 * issues `eligibleJobs(filter: {saved: true})`).
 */
export async function runJobsSaved(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs saved", output);

  let items: jobs.JobListItem[];
  try {
    items = await jobs.saved(token);
  } catch (err) {
    handleJobsError("jobs saved", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatJobsTable(data.items),
    table: (data) => formatJobsTable(data.items),
    empty: { command: "jobs.saved" },
  });
}

/**
 * Action handler for `ttctl jobs viewed`. Wraps `jobs.viewedList()`
 * (which fetches the first page and filters client-side on `viewed`).
 *
 * **Wire-shape gap (R1)**: `eligibleJobs` has no `viewed: BooleanFilter`
 * parameter. The output is scoped to the first page (≤20 jobs). A
 * follow-up issue tracks the wire-level filter.
 */
export async function runJobsViewed(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs viewed", output);

  let items: jobs.JobListItem[];
  try {
    items = await jobs.viewedList(token);
  } catch (err) {
    handleJobsError("jobs viewed", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatJobsTable(data.items),
    table: (data) => formatJobsTable(data.items),
    empty: { command: "jobs.viewed" },
  });
}

/**
 * Action handler for `ttctl jobs not-interested-list`. Wraps
 * `jobs.notInterestedList()` (issues `eligibleJobs(filter:
 * {notInterested: true})`).
 */
export async function runJobsNotInterestedList(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs not-interested-list", output);

  let items: jobs.JobListItem[];
  try {
    items = await jobs.notInterestedList(token);
  } catch (err) {
    handleJobsError("jobs not-interested-list", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatJobsTable(data.items),
    table: (data) => formatJobsTable(data.items),
    empty: { command: "jobs.not-interested-list" },
  });
}
