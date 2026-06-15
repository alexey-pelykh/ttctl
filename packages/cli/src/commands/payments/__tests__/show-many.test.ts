// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { payments } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatPayoutDetails } from "../show-many.js";

function payout(id: string): payments.Payout {
  return {
    id,
    number: 1,
    amount: "100.00",
    correctionAmount: "0",
    description: null,
    status: "PAID",
    kindCategory: "TALENT_PAYMENT",
    paymentGroupId: null,
    billingCycle: null,
    dueDate: null,
    paidAt: null,
    createdAt: "2026-05-01T12:00:00Z",
    updatedAt: "2026-05-01T12:00:00Z",
    downloadPdfUrl: null,
    job: null,
    memorandums: [],
  };
}

describe("formatPayoutDetails", () => {
  it("renders each payout as a block separated by a rule", () => {
    const out = formatPayoutDetails([payout("pmt-1"), payout("pmt-2")], []);
    expect(out).toContain("Payout pmt-1");
    expect(out).toContain("Payout pmt-2");
    expect(out).toContain("————————————————————————————————");
  });

  it("appends a Not found line listing the missing ids", () => {
    const out = formatPayoutDetails([payout("pmt-1")], ["pmt-x", "pmt-y"]);
    expect(out).toContain("Payout pmt-1");
    expect(out).toContain("Not found (2): pmt-x, pmt-y");
  });

  it("renders the Not found line alone when nothing resolved", () => {
    const out = formatPayoutDetails([], ["pmt-x"]);
    expect(out).toBe("Not found (1): pmt-x");
  });

  it("renders a No payments found message when there is nothing to show", () => {
    expect(formatPayoutDetails([], [])).toBe("No payments found.");
  });
});
