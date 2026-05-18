// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { payments } from "@ttctl/core";

import { buildPayoutsPageInfo, formatPayoutsPageFooter } from "../payouts.js";

/**
 * Pure-helper coverage for the offset-style pagination surface added to
 * `payments payouts list` (#373). Parallels
 * `commands/jobs/__tests__/formatters.test.ts` (the #138 jobs
 * equivalents) — same arithmetic contract:
 *   - `totalPages = Math.max(1, Math.ceil(totalCount / perPage))`
 *   - `hasNextPage = currentPage < totalPages`
 */

function result(over: Partial<payments.PayoutsListResult> = {}): payments.PayoutsListResult {
  return {
    items: [],
    summary: {
      totalDisputed: "0",
      totalDue: "0",
      totalOnHold: "0",
      totalOutstanding: "0",
      totalOverdue: "0",
      totalPaid: "0",
    },
    totalCount: 100,
    page: 1,
    perPage: 20,
    ...over,
  };
}

describe("formatPayoutsPageFooter", () => {
  it('renders "Page X of Y (per_page=Z)" for a typical mid-list page', () => {
    expect(formatPayoutsPageFooter(2, 20, 100)).toBe("Page 2 of 5 (per_page=20)");
  });

  it("rounds totalPages UP via Math.ceil (partial last page)", () => {
    // 47 / 20 = 2.35 → ceil → 3 pages
    expect(formatPayoutsPageFooter(1, 20, 47)).toBe("Page 1 of 3 (per_page=20)");
  });

  it("renders 'Page 1 of 1' for a single-page result (totalCount > 0)", () => {
    expect(formatPayoutsPageFooter(1, 20, 5)).toBe("Page 1 of 1 (per_page=20)");
  });

  it("floors totalPages to 1 when totalCount is 0 (defensive; caller routes via empty-state)", () => {
    expect(formatPayoutsPageFooter(1, 20, 0)).toBe("Page 1 of 1 (per_page=20)");
  });
});

describe("buildPayoutsPageInfo", () => {
  it("derives currentPage/perPage/totalPages/hasNextPage from a PayoutsListResult", () => {
    expect(buildPayoutsPageInfo(result({ totalCount: 100, page: 2, perPage: 20 }))).toEqual({
      currentPage: 2,
      perPage: 20,
      totalPages: 5,
      hasNextPage: true,
    });
  });

  it("hasNextPage=false on the last page", () => {
    const info = buildPayoutsPageInfo(result({ totalCount: 100, page: 5, perPage: 20 }));
    expect(info.hasNextPage).toBe(false);
    expect(info.totalPages).toBe(5);
  });

  it("hasNextPage=false when current page exceeds totalPages (user overshot)", () => {
    const info = buildPayoutsPageInfo(result({ totalCount: 40, page: 9, perPage: 20 }));
    expect(info.totalPages).toBe(2);
    expect(info.hasNextPage).toBe(false);
  });

  it("clamps totalPages to a minimum of 1 when totalCount is 0", () => {
    expect(buildPayoutsPageInfo(result({ totalCount: 0, page: 1, perPage: 20 }))).toEqual({
      currentPage: 1,
      perPage: 20,
      totalPages: 1,
      hasNextPage: false,
    });
  });

  it("rounds totalPages UP via Math.ceil for a partial last page", () => {
    // 137 / 20 = 6.85 → ceil → 7
    expect(buildPayoutsPageInfo(result({ totalCount: 137, page: 7, perPage: 20 })).totalPages).toBe(7);
  });
});
