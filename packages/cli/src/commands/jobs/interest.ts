// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { jobs } from "@ttctl/core";

import { emitRemoveSuccess, emitUpdateSuccess } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatFlags, handleJobsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl jobs save <id>`. Marks the job as saved
 * (bookmark). Emits the v0.4 update-success envelope (the mutation
 * conceptually updates the job's interest-state flags rather than
 * creating a new resource).
 */
export async function runJobsSave(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs save", output);

  let state: jobs.JobInterestState;
  try {
    state = await jobs.save(token, id);
  } catch (err) {
    handleJobsError("jobs save", err, output);
  }

  emitUpdateSuccess({
    operation: "jobs.save",
    format: output,
    updated: state,
    prettySummary: `job ${id} saved (flags: ${formatFlags(state) || "—"})`,
    prettyEntity: (s) => formatInterestEntity(s),
  });
}

/**
 * Action handler for `ttctl jobs unsave <id>`. Clears the interest
 * flags on a job — the wire's only "remove saved" path. Note that
 * this also clears `not-interested` (single wire mutation covers
 * both); see {@link jobs.unsave} for the rationale.
 *
 * Emits the v0.4 remove-success envelope.
 */
export async function runJobsUnsave(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs unsave", output);

  try {
    await jobs.unsave(token, id);
  } catch (err) {
    handleJobsError("jobs unsave", err, output);
  }

  emitRemoveSuccess({
    operation: "jobs.unsave",
    format: output,
    id,
    prettySummary: `job ${id} interest cleared`,
  });
}

/**
 * Action handler for `ttctl jobs not-interested <id>`. Marks the job
 * as not-interested with the supplied reason. The reason is required
 * by the wire (`reason: String!`, rejects empty strings).
 */
export interface JobsNotInterestedOptions {
  reason: string;
  output: OutputFormat;
}

export async function runJobsNotInterested(id: string, opts: JobsNotInterestedOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs not-interested", opts.output);

  let state: jobs.JobInterestState;
  try {
    state = await jobs.notInterested(token, id, { reason: opts.reason });
  } catch (err) {
    handleJobsError("jobs not-interested", err, opts.output);
  }

  emitUpdateSuccess({
    operation: "jobs.not-interested",
    format: opts.output,
    updated: state,
    prettySummary: `job ${id} marked not-interested (flags: ${formatFlags(state) || "—"})`,
    prettyEntity: (s) => formatInterestEntity(s),
  });
}

/**
 * Action handler for `ttctl jobs clear-interest <id>`. Aliases
 * `unsave` semantically (calls the same wire mutation) but uses the
 * explicit name so users who marked a job not-interested can undo it
 * without thinking about the "unsave" naming.
 */
export async function runJobsClearInterest(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs clear-interest", output);

  let state: jobs.JobInterestState;
  try {
    state = await jobs.clearInterest(token, id);
  } catch (err) {
    handleJobsError("jobs clear-interest", err, output);
  }

  emitUpdateSuccess({
    operation: "jobs.clear-interest",
    format: output,
    updated: state,
    prettySummary: `job ${id} interest cleared`,
    prettyEntity: (s) => formatInterestEntity(s),
  });
}

/**
 * Action handler for `ttctl jobs mark-viewed <id>`. Explicitly marks
 * the job as viewed. Not in the issue AC but exposed for completeness
 * — the UI normally auto-marks on detail-page open.
 */
export async function runJobsMarkViewed(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs mark-viewed", output);

  let state: jobs.JobInterestState;
  try {
    state = await jobs.markViewed(token, id);
  } catch (err) {
    handleJobsError("jobs mark-viewed", err, output);
  }

  emitUpdateSuccess({
    operation: "jobs.mark-viewed",
    format: output,
    updated: state,
    prettySummary: `job ${id} marked viewed`,
    prettyEntity: (s) => formatInterestEntity(s),
  });
}

/**
 * Render the interest-state as a multi-line entity. Used as the
 * `prettyEntity` slot for the update-success envelope.
 */
export function formatInterestEntity(state: jobs.JobInterestState): string {
  const lines: string[] = [];
  lines.push(`Id: ${state.id}`);
  lines.push(`Saved: ${state.saved === true ? "yes" : "no"}`);
  lines.push(`Not interested: ${state.notInterested === true ? "yes" : "no"}`);
  lines.push(`Viewed: ${state.viewed === true ? "yes" : "no"}`);
  return lines.join("\n");
}
