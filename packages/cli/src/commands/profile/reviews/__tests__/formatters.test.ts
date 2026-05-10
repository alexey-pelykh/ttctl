// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { formatApproveEntity } from "../approve-item.js";
import { formatReviewsTable, formatReviewsText } from "../list.js";

/**
 * Pure-formatter unit tests for the reviews leaves. Post-#128 the
 * approve-item / approve-section / submit-for-review handlers emit
 * envelopes via the side-effecting `emitUpdateSuccess` rather than a
 * pure `formatXxxResult` helper — the wire-shape assertions for the
 * envelope itself live in `lib/__tests__/envelopes.test.ts`. The pure
 * helpers preserved on the action handlers (`formatApproveEntity`,
 * `formatReviewsText/Table`) keep their direct unit coverage here.
 */

describe("formatReviewsText / Table", () => {
  const SAMPLE = [
    {
      id: "sr1",
      section: "EDUCATION",
      requestedAt: "2026-05-01T10:00:00Z",
      items: [
        { id: "sri-1", itemId: "edu-100", requestedAt: "2026-05-01T10:00:00Z" },
        { id: "sri-2", itemId: "edu-200", requestedAt: null },
      ],
    },
    {
      id: "sr2",
      section: "EMPLOYMENT",
      requestedAt: null,
      items: [],
    },
  ];

  it("text: renders empty list", () => {
    expect(formatReviewsText([])).toBe("No pending section reviews.");
  });

  it("text: renders header + section block + indented item rows", () => {
    const out = formatReviewsText(SAMPLE);
    expect(out).toContain("Pending section reviews (2):");
    expect(out).toContain("section: EDUCATION");
    expect(out).toContain("reviewId: sr1");
    expect(out).toContain("item: id=sri-1  itemId=edu-100");
    // Section with no items should still appear.
    expect(out).toContain("section: EMPLOYMENT");
  });

  it("table: renders header-only on empty list", () => {
    const out = formatReviewsTable([]);
    expect(out).toBe("section\treviewId\titemId\tsectionItemId\trequestedAt");
  });

  it("table: emits one row per item, plus a row for empty sections", () => {
    const out = formatReviewsTable(SAMPLE);
    const lines = out.split("\n");
    expect(lines[0]).toBe("section\treviewId\titemId\tsectionItemId\trequestedAt");
    expect(lines).toContain("EDUCATION\tsr1\tedu-100\tsri-1\t2026-05-01T10:00:00Z");
    expect(lines).toContain("EDUCATION\tsr1\tedu-200\tsri-2\t");
    // Empty-items section keeps a placeholder row.
    expect(lines.some((l) => l.startsWith("EMPLOYMENT\tsr2\t"))).toBe(true);
  });
});

describe("formatApproveEntity (#128 envelope pretty body)", () => {
  it("renders the remaining-pending count from sectionReviews length", () => {
    const result = {
      sectionReviews: [
        {
          id: "sr1",
          section: "EDUCATION",
          requestedAt: null,
          items: [{ id: "sri-other", itemId: "edu-other", requestedAt: null }],
        },
      ],
      notice: null,
    };
    expect(formatApproveEntity(result)).toBe("pending-reviews remaining: 1");
  });

  it("renders zero when no pending reviews remain", () => {
    expect(formatApproveEntity({ sectionReviews: [], notice: null })).toBe("pending-reviews remaining: 0");
  });
});
