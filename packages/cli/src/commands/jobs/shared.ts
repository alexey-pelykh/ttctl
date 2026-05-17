// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { jobs } from "@ttctl/core";

import { handleDomainError } from "../../lib/error-routing.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `jobs.JobsError`. The router applies the envelope ABI (#128)
 * branching uniformly across sub-domains. No per-code hint adapter —
 * `JobsError` codes do not carry actionable next-step hints today.
 */
export function handleJobsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, jobs.JobsError, format);
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

/**
 * Render the pretty-format pagination footer "Page X of Y (per_page=Z)"
 * appended below the table for paginated list outputs (#138). The
 * footer is appended ONLY when the server returned `totalCount > 0` —
 * empty pages route through the existing empty-state CTA wrapper
 * BEFORE per-format dispatch, so this helper never fires on
 * `items.length === 0`.
 *
 * `totalPages` is derived as `Math.max(1, Math.ceil(totalCount /
 * perPage))` so a single-page result with `totalCount > 0` renders
 * "Page 1 of 1". When `currentPage > totalPages` (user overshot — the
 * server returned an empty entities array on a non-existent page), the
 * caller's `items.length === 0` triggers empty-state before we reach
 * here; no special handling needed.
 *
 * Pure — directly unit-testable.
 */
export function formatPageFooter(currentPage: number, perPage: number, totalCount: number): string {
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  return `Page ${currentPage.toString()} of ${totalPages.toString()} (per_page=${perPage.toString()})`;
}

/**
 * Build the offset-style `pageInfo` block for the list envelope (#138)
 * from the service-layer's {@link jobs.JobListPage}. Wraps the
 * arithmetic for `totalPages` and `hasNextPage` derivation so the
 * action handler and the unit tests share one source of truth.
 *
 * - `currentPage`, `perPage`: passed through verbatim (the service
 *   returns the values actually used in the query).
 * - `totalPages`: `Math.max(1, Math.ceil(totalCount / perPage))`.
 * - `hasNextPage`: `currentPage < totalPages`.
 *
 * Pure — directly unit-testable.
 */
export function buildJobsPageInfo(page: jobs.JobListPage): {
  currentPage: number;
  perPage: number;
  totalPages: number;
  hasNextPage: boolean;
} {
  const totalPages = Math.max(1, Math.ceil(page.totalCount / page.perPage));
  return {
    currentPage: page.page,
    perPage: page.perPage,
    totalPages,
    hasNextPage: page.page < totalPages,
  };
}
