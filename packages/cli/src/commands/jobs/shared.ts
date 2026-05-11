// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { TtctlError, jobs } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";
import { emitErrorAndExit } from "../../lib/envelopes.js";
import type { EnvelopeError } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Route service errors through the envelope ABI (#128) — mirrors
 * `handleApplicationsError` / `handleEngagementsError`. Branches:
 *
 * - `TtctlError` subclasses keep their dedicated 3-block pretty
 *   rendering on `pretty` (Recovery / Code / message).
 * - `JobsError` codes always flow through the envelope.
 * - Anything else collapses into `INTERNAL_ERROR`.
 */
export function handleJobsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof jobs.JobsError) {
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: commandLabel.replace(/ /g, "."),
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${commandLabel} failed: ${message}`,
  });
}

/**
 * Render an ISO 8601 timestamp as just the date portion (YYYY-MM-DD).
 */
export function formatDate(iso: string | null): string {
  if (iso === null) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m?.[1] ?? iso;
}

/**
 * Render a job rate (server-side `maxRate` is the upper-bound on
 * hourly rate, in USD). Returns the empty string when null.
 */
export function formatRate(rate: number | null): string {
  if (rate === null) return "";
  return `$${rate.toString()}/h`;
}

/**
 * Render the jobs list as a `cli-table3` table sized to the current
 * terminal width. Columns: id, title, client, commitment, rate, flags
 * (saved / not-interested / viewed). Used by `list`, `saved`,
 * `viewed`, `not-interested-list`.
 */
export function formatJobsTable(
  items: jobs.JobListItem[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "title", "client", "commitment", "rate", "flags"] });
    return empty.toString();
  }
  const idWidth = 22;
  const commitmentWidth = 14;
  const rateWidth = 10;
  const flagsWidth = 8;
  const clientWidth = 24;
  // 6 columns x 2 padding + 7 borders ≈ 19
  const remaining = Math.max(20, terminalWidth - idWidth - clientWidth - commitmentWidth - rateWidth - flagsWidth - 19);
  const titleWidth = Math.max(20, remaining);
  const table = new Table({
    head: ["id", "title", "client", "commitment", "rate", "flags"],
    colWidths: [idWidth, titleWidth, clientWidth, commitmentWidth, rateWidth, flagsWidth],
    wordWrap: true,
  });
  for (const it of items) {
    table.push([
      it.id,
      it.title ?? "(untitled)",
      it.client?.fullName ?? "",
      it.commitment?.slug ?? "",
      formatRate(it.maxRate),
      formatFlags(it),
    ]);
  }
  return table.toString();
}

/**
 * Render the interest-status flags as a compact one-line tag string.
 * Used in list rows and in interest-mutation success summaries.
 *
 * - `S` — saved
 * - `N` — not-interested
 * - `V` — viewed
 *
 * Empty when no flag is set.
 */
export function formatFlags(state: {
  saved: boolean | null;
  notInterested: boolean | null;
  viewed: boolean | null;
}): string {
  const parts: string[] = [];
  if (state.saved === true) parts.push("S");
  if (state.notInterested === true) parts.push("N");
  if (state.viewed === true) parts.push("V");
  return parts.join("");
}
