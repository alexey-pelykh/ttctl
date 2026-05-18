// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { handleDomainError } from "../../lib/error-routing.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `applications.ApplicationsError`. The router applies the envelope ABI
 * (#128) branching uniformly across sub-domains.
 *
 * `commandLabel` is the user-visible prefix (e.g. `"applications show"`);
 * the envelope `operation` is derived by replacing spaces with dots
 * (`"applications.show"`). No per-code hint adapter — `ApplicationsError`
 * codes do not carry actionable next-step hints today.
 */
export function handleApplicationsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, applications.ApplicationsError, format);
}

/**
 * Render the pretty-format pagination footer "Page X of Y
 * (per_page=Z)" appended below the activity table for `applications
 * list` (#377). Domain-local twin of `jobs/shared.ts`'s
 * `formatPageFooter` — per the project's one-copy-per-CLI-surface
 * convention (no cross-domain import). Appended ONLY when the server
 * returned `totalCount > 0`; empty pages route through the empty-state
 * CTA wrapper before per-format dispatch.
 *
 * `totalPages = Math.max(1, Math.ceil(totalCount / perPage))` so a
 * single-page non-empty result renders "Page 1 of 1". Pure — directly
 * unit-testable.
 */
export function formatApplicationsPageFooter(currentPage: number, perPage: number, totalCount: number): string {
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  return `Page ${currentPage.toString()} of ${totalPages.toString()} (per_page=${perPage.toString()})`;
}

/**
 * Build the offset-style `pageInfo` block for the list envelope (#377)
 * from the service-layer's {@link applications.JobActivityListPage}.
 * Structural twin of `jobs/shared.ts`'s `buildJobsPageInfo`; centralises
 * the `totalPages` / `hasNextPage` arithmetic so the action handler and
 * unit tests share one source of truth.
 *
 * - `currentPage`, `perPage`: verbatim from the service (the effective
 *   values used in the query, after defaults).
 * - `totalPages`: `Math.max(1, Math.ceil(totalCount / perPage))`.
 * - `hasNextPage`: `currentPage < totalPages`.
 *
 * Pure — directly unit-testable.
 */
export function buildApplicationsPageInfo(page: applications.JobActivityListPage): {
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
