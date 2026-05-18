// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { engagements } from "@ttctl/core";

import { handleDomainError } from "../../lib/error-routing.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `engagements.EngagementsError` and {@link hintForEngagementsCode}.
 * The router applies the envelope ABI (#128) branching uniformly across
 * sub-domains.
 */
export function handleEngagementsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, engagements.EngagementsError, format, hintForEngagementsCode);
}

/**
 * Per-code recovery hints. Not every code carries one — only the ones
 * where a concrete next step is clearly actionable for the user.
 */
function hintForEngagementsCode(code: engagements.EngagementsErrorCode): string | undefined {
  switch (code) {
    case "NOT_FOUND":
      return "Verify the engagement id (use `ttctl engagements list` to discover it).";
    case "NO_ENGAGEMENT":
      return "This activity item is not an engagement (likely an application or interview). Use `ttctl applications show` instead.";
    case "MUTATION_ERROR":
      return "The mutation was rejected by the server (often: overlapping break dates or validation). Check the message above.";
    default:
      return undefined;
  }
}

/**
 * Render the pretty-format pagination footer "Page X of Y
 * (per_page=Z)" appended below the table for `engagements list`
 * (#375). The footer is appended ONLY when the server returned
 * `totalCount > 0` — empty pages route through the empty-state CTA
 * wrapper BEFORE per-format dispatch, so this helper never fires on
 * `items.length === 0`.
 *
 * `totalPages` is `Math.max(1, Math.ceil(totalCount / perPage))` so a
 * single-page result with `totalCount > 0` renders "Page 1 of 1".
 *
 * Domain-local copy of the `jobs/shared.ts` formatter — per #183 each
 * paginating domain owns its pagination primitives rather than
 * cross-importing (the jobs surface is already merged; promoting this
 * to a shared lib is a separate refactor out of #375's scope). Pure —
 * directly unit-testable.
 */
export function formatPageFooter(currentPage: number, perPage: number, totalCount: number): string {
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  return `Page ${currentPage.toString()} of ${totalPages.toString()} (per_page=${perPage.toString()})`;
}

/**
 * Build the offset-style `pageInfo` block for the list envelope
 * (#375) from the service-layer's {@link
 * engagements.EngagementListPage}. Wraps the `totalPages` /
 * `hasNextPage` arithmetic so the action handler and the unit tests
 * share one source of truth. Mirrors `buildJobsPageInfo` in
 * `jobs/shared.ts`.
 *
 * - `currentPage`, `perPage`: passed through verbatim (the service
 *   returns the values actually used in the query, after defaults).
 * - `totalPages`: `Math.max(1, Math.ceil(totalCount / perPage))`.
 * - `hasNextPage`: `currentPage < totalPages`.
 *
 * Pure — directly unit-testable.
 */
export function buildEngagementsPageInfo(page: engagements.EngagementListPage): {
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
