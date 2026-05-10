// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { formatApproveResult } from "../approve-item.js";
import { formatReviewsTable, formatReviewsText } from "../list.js";
import { formatSubmitResult } from "../submit-for-review.js";

/**
 * Pure-formatter unit tests for the reviews leaves. Mirrors the
 * external/__tests__/formatters.test.ts layout — see that file's header
 * for the rationale on testing formatters directly rather than action
 * handlers.
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

describe("formatApproveResult", () => {
  const SAMPLE = {
    sectionReviews: [
      {
        id: "sr1",
        section: "EDUCATION",
        requestedAt: null,
        items: [{ id: "sri-other", itemId: "edu-other", requestedAt: null }],
      },
    ],
    notice: "Approved.",
  };

  it("pretty: renders confirmation + remaining-pending count", () => {
    const out = formatApproveResult(SAMPLE, "pretty");
    expect(out).toContain("Item approved.");
    expect(out).toContain("pending-reviews remaining: 1");
    expect(out).toContain("Approved.");
  });

  it("json: renders the full result object", () => {
    const out = formatApproveResult(SAMPLE, "json");
    expect(JSON.parse(out)).toEqual(SAMPLE);
  });

  it("yaml: renders the full result object as block-style YAML", () => {
    const out = formatApproveResult(SAMPLE, "yaml");
    expect(out).toContain("notice: Approved.");
    expect(out).toContain("sectionReviews:");
  });
});

describe("formatSubmitResult", () => {
  it("pretty: renders confirmation + notice", () => {
    const out = formatSubmitResult({ notice: "Profile submitted for review." }, "pretty");
    expect(out).toContain("Profile submitted for review.");
  });

  it("pretty: renders confirmation when no notice is provided", () => {
    const out = formatSubmitResult({ notice: null }, "pretty");
    expect(out).toBe("Profile submitted for review.");
  });

  it("json: renders the full result", () => {
    const out = formatSubmitResult({ notice: "ok" }, "json");
    expect(JSON.parse(out)).toEqual({ notice: "ok" });
  });

  it("yaml: renders the full result as block-style YAML", () => {
    const out = formatSubmitResult({ notice: "ok" }, "yaml");
    expect(out).toBe("notice: ok");
  });
});
