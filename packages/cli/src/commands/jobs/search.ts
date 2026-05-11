// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { jobs } from "@ttctl/core";

import { emitRemoveSuccess, emitUpdateSuccess, wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleJobsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Wire-shape note (R2): the platform exposes a SINGLE
 * `viewer.searchSubscription` per user — there is no list of named
 * subscriptions. The CLI's `search list / save --name / remove <id>`
 * surface adapts to this cardinality:
 *
 * - `list` returns a 0-or-1 envelope (envelope-compatible).
 * - `save` accepts `--name <name>` as advisory (cosmetic, no wire
 *   field). Starts/replaces THE subscription.
 * - `remove` accepts an optional `<id>` argument (ignored — there's
 *   only one subscription).
 *
 * The CLI help text and the issue PR body surface this caveat.
 */

/**
 * Action handler for `ttctl jobs search list`. Returns the current
 * subscription wrapped in a list envelope (0 or 1 item) so the
 * surface stays consistent with the AC's `list` verb expectations.
 */
export async function runJobsSearchList(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs search list", output);

  let state: jobs.SearchSubscriptionState;
  try {
    state = await jobs.searchSubscriptionShow(token);
  } catch (err) {
    handleJobsError("jobs search list", err, output);
  }

  const items: SearchSubscriptionRow[] = state.active && state.filters !== null ? [renderRow(state.filters)] : [];

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatSubscriptionTable(data.items),
    table: (data) => formatSubscriptionTable(data.items),
    empty: { command: "jobs.search.list" },
  });
}

/**
 * Action handler for `ttctl jobs search save`. Starts (or replaces)
 * the search subscription. `--name` is accepted but advisory (the
 * wire doesn't carry a name field).
 */
export interface JobsSearchSaveOptions {
  name?: string;
  skills?: string[];
  keywords?: string[];
  excludeSkills?: string[];
  excludeKeywords?: string[];
  commitments?: string[];
  workTypes?: string[];
  estimatedLengths?: string[];
  excludeUnspecifiedBudget?: boolean;
  output: OutputFormat;
}

export async function runJobsSearchSave(opts: JobsSearchSaveOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs search save", opts.output);

  const filters: jobs.SearchSubscriptionFilters = {};
  if (opts.skills !== undefined) filters.skills = opts.skills;
  if (opts.keywords !== undefined) filters.keywords = opts.keywords;
  if (opts.excludeSkills !== undefined) filters.excludeSkills = opts.excludeSkills;
  if (opts.excludeKeywords !== undefined) filters.excludeKeywords = opts.excludeKeywords;
  if (opts.commitments !== undefined) filters.commitments = opts.commitments;
  if (opts.workTypes !== undefined) filters.workTypes = opts.workTypes;
  if (opts.estimatedLengths !== undefined) filters.estimatedLengths = opts.estimatedLengths;
  if (opts.excludeUnspecifiedBudget !== undefined) filters.excludeUnspecifiedBudget = opts.excludeUnspecifiedBudget;

  let state: jobs.SearchSubscriptionState;
  try {
    state = await jobs.searchSubscriptionSave(token, filters);
  } catch (err) {
    handleJobsError("jobs search save", err, opts.output);
  }

  const row: SearchSubscriptionRow | InactiveRow =
    state.active && state.filters !== null ? renderRow(state.filters) : { active: false, filters: null };
  const nameNote = opts.name !== undefined ? ` (advisory name "${opts.name}" not stored server-side)` : "";

  emitUpdateSuccess({
    operation: "jobs.search.save",
    format: opts.output,
    updated: row,
    prettySummary: `job-search subscription started${nameNote}`,
    prettyEntity: (r) => formatSubscriptionEntity(r),
  });
}

/**
 * Action handler for `ttctl jobs search remove`. Terminates the
 * active subscription. The optional `<id>` argument is ignored — the
 * wire has only one subscription per viewer.
 */
export async function runJobsSearchRemove(id: string | undefined, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs search remove", output);

  try {
    await jobs.searchSubscriptionRemove(token);
  } catch (err) {
    handleJobsError("jobs search remove", err, output);
  }

  const idNote = id !== undefined ? ` (supplied id "${id}" ignored — only one subscription exists per user)` : "";

  emitRemoveSuccess({
    operation: "jobs.search.remove",
    format: output,
    id: id ?? "(single)",
    prettySummary: `job-search subscription terminated${idNote}`,
  });
}

/**
 * Row shape returned by `search list`. Flattens the
 * `SearchSubscriptionFilters` into an envelope-compatible row.
 */
interface SearchSubscriptionRow {
  active: true;
  skills: string[];
  keywords: string[];
  excludeSkills: string[];
  excludeKeywords: string[];
  commitments: string[];
  workTypes: string[];
  estimatedLengths: string[];
  excludeUnspecifiedBudget: boolean | null;
}

interface InactiveRow {
  active: false;
  filters: null;
}

function renderRow(filters: jobs.SearchSubscriptionFilters): SearchSubscriptionRow {
  return {
    active: true,
    skills: filters.skills ?? [],
    keywords: filters.keywords ?? [],
    excludeSkills: filters.excludeSkills ?? [],
    excludeKeywords: filters.excludeKeywords ?? [],
    commitments: filters.commitments ?? [],
    workTypes: filters.workTypes ?? [],
    estimatedLengths: filters.estimatedLengths ?? [],
    excludeUnspecifiedBudget: filters.excludeUnspecifiedBudget ?? null,
  };
}

/**
 * Render the subscription rows (0 or 1) as a multi-line pretty block.
 * Used for both `pretty` and `table` slots — a table doesn't add
 * value for a single multi-field row.
 */
export function formatSubscriptionTable(rows: SearchSubscriptionRow[]): string {
  const first = rows[0];
  if (first === undefined) return "(no active job-search subscription)";
  return formatSubscriptionEntity(first);
}

function formatSubscriptionEntity(row: SearchSubscriptionRow | InactiveRow): string {
  if (!row.active) return "(no active subscription)";
  const lines: string[] = [];
  lines.push("Status: active");
  if (row.skills.length > 0) lines.push(`Skills: ${row.skills.join(", ")}`);
  if (row.keywords.length > 0) lines.push(`Keywords: ${row.keywords.join(", ")}`);
  if (row.excludeSkills.length > 0) lines.push(`Exclude skills: ${row.excludeSkills.join(", ")}`);
  if (row.excludeKeywords.length > 0) lines.push(`Exclude keywords: ${row.excludeKeywords.join(", ")}`);
  if (row.commitments.length > 0) lines.push(`Commitments: ${row.commitments.join(", ")}`);
  if (row.workTypes.length > 0) lines.push(`Work types: ${row.workTypes.join(", ")}`);
  if (row.estimatedLengths.length > 0) lines.push(`Estimated lengths: ${row.estimatedLengths.join(", ")}`);
  if (row.excludeUnspecifiedBudget !== null) {
    lines.push(`Exclude unspecified budget: ${row.excludeUnspecifiedBudget ? "yes" : "no"}`);
  }
  return lines.join("\n");
}
