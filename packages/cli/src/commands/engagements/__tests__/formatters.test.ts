// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { engagements } from "@ttctl/core";

import { formatBreakEntity, formatBreaksTable } from "../breaks.js";
import { formatDate, formatEngagementsTable, shortenEngagementStatus } from "../list.js";
import { formatEngagementDetail } from "../show.js";
import { formatStatsPretty } from "../stats.js";

const LIST_ITEM_FIXTURE: engagements.EngagementListItem = {
  id: "act-eng-1",
  engagementId: "eng-1",
  statusV2: { value: "ACTIVE", verbose: "Active" },
  statusGroupV2: { value: "ACTIVE_ENGAGEMENT", verbose: "Active engagement" },
  statusColor: "#00ff00",
  lastUpdatedAt: "2026-04-01T12:00:00Z",
  job: {
    id: "job-1",
    title: "Senior Engineer",
    url: "https://www.toptal.com/jobs/job-1",
    client: { id: "cli-1", fullName: "Acme Inc." },
  },
  startDate: "2026-02-01",
  endDate: null,
  expectedHours: 40,
  commitment: { slug: "full_time" },
};

const DETAIL_FIXTURE: engagements.EngagementDetail = {
  ...LIST_ITEM_FIXTURE,
  job: {
    ...LIST_ITEM_FIXTURE.job,
    descriptionMd: "Engineering role.\n\nLong-term placement.",
    expectedHours: 40,
    commitment: { slug: "full_time" },
    workType: { slug: "remote" },
    specialization: { title: "Backend" },
    startDate: "2026-01-01",
    isCoaching: false,
    isToptalProject: false,
  },
  currentAgreement: {
    applicationRate: "120.00",
    talentHourlyRate: "100.00",
    talentRate: "100.00",
    commitment: { slug: "full_time" },
  },
  billCycle: { verbose: "Monthly" },
  earning: { paid: { decimal: "5000.00" } },
  eligibleForPayment: true,
  eligibleToViewTimesheets: true,
  eligibleToViewTimeOffs: true,
  proposedEnd: { endDate: null, status: "NONE" },
  breaks: [],
};

const BREAK_FIXTURE: engagements.EngagementBreak = {
  id: "br-1",
  startDate: "2026-06-01",
  endDate: "2026-06-08",
  comment: "Vacation",
  operations: {
    removeEngagementBreak: { callable: "true" },
    rescheduleEngagementBreak: { callable: "true" },
  },
};

describe("shortenEngagementStatus", () => {
  it.each([
    ["ACTIVE_ENGAGEMENT", "Active"],
    ["CLOSED_ENGAGEMENT", "Closed"],
    ["UNKNOWN_GROUP", "UNKNOWN_GROUP"],
  ])("maps %s -> %s", (input, expected) => {
    expect(shortenEngagementStatus(input)).toBe(expected);
  });
});

describe("formatDate", () => {
  it("returns just the YYYY-MM-DD prefix from ISO 8601", () => {
    expect(formatDate("2026-04-01T12:00:00Z")).toBe("2026-04-01");
  });

  it("returns null sentinel for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("returns input as-is when not parseable", () => {
    expect(formatDate("garbage")).toBe("garbage");
  });
});

describe("formatEngagementsTable", () => {
  it("renders an empty table when items is empty", () => {
    const out = formatEngagementsTable([]);
    expect(out).toContain("id");
    expect(out).toContain("status");
    expect(out).toContain("client");
    expect(out).toContain("job");
    expect(out).toContain("starts");
    expect(out).toContain("hours");
  });

  it("renders rows with shortened status, client, title, starts, hours", () => {
    const out = formatEngagementsTable([LIST_ITEM_FIXTURE]);
    expect(out).toContain("act-eng-1");
    expect(out).toContain("Active");
    expect(out).toContain("Acme Inc.");
    expect(out).toContain("Senior Engineer");
    expect(out).toContain("2026-02-01");
    expect(out).toContain("40");
  });

  it("renders empty-state markers when fields are null", () => {
    const noClient: engagements.EngagementListItem = {
      ...LIST_ITEM_FIXTURE,
      job: { ...LIST_ITEM_FIXTURE.job, client: null, title: null },
      startDate: null,
      expectedHours: null,
    };
    const out = formatEngagementsTable([noClient]);
    expect(out).toContain("(no client)");
    expect(out).toContain("(untitled)");
    expect(out).toContain("—");
  });
});

describe("formatEngagementDetail", () => {
  it("renders the engagement, job, agreement, earnings sections", () => {
    const out = formatEngagementDetail(DETAIL_FIXTURE);
    expect(out).toContain("Engagement act-eng-1");
    expect(out).toContain("Engagement-ID: eng-1");
    expect(out).toContain("Status: Active");
    expect(out).toContain("Job");
    expect(out).toContain("Senior Engineer");
    expect(out).toContain("Client: Acme Inc.");
    expect(out).toContain("Engagement");
    expect(out).toContain("Started: 2026-02-01");
    expect(out).toContain("Bill cycle: Monthly");
    expect(out).toContain("Agreement");
    expect(out).toContain("Hourly rate: 100.00");
    expect(out).toContain("Earnings");
    expect(out).toContain("Paid: 5000.00 USD");
  });

  it("omits the Breaks section when no breaks present", () => {
    const out = formatEngagementDetail(DETAIL_FIXTURE);
    expect(out).not.toContain("Breaks (");
  });

  it("renders the Breaks section with each break inline when present", () => {
    const out = formatEngagementDetail({ ...DETAIL_FIXTURE, breaks: [BREAK_FIXTURE] });
    expect(out).toContain("Breaks (1)");
    expect(out).toContain("br-1: 2026-06-01 → 2026-06-08 — Vacation");
  });

  it("preserves description paragraph boundaries", () => {
    const out = formatEngagementDetail(DETAIL_FIXTURE);
    expect(out).toContain("Description:");
    expect(out).toContain("Engineering role.");
    expect(out).toContain("Long-term placement.");
  });
});

describe("formatStatsPretty", () => {
  it("renders the header and per-group counts", () => {
    const out = formatStatsPretty({
      total: 5,
      groups: [
        { name: "ACTIVE_ENGAGEMENT", count: 2 },
        { name: "CLOSED_ENGAGEMENT", count: 3 },
      ],
    });
    expect(out).toContain("2 status groups, 5 total engagements:");
    expect(out).toContain("Active");
    expect(out).toContain("Closed");
    expect(out).toContain("2");
    expect(out).toContain("3");
  });
});

describe("formatBreaksTable", () => {
  it("renders rows with id, starts, ends, comment", () => {
    const out = formatBreaksTable([BREAK_FIXTURE]);
    expect(out).toContain("br-1");
    expect(out).toContain("2026-06-01");
    expect(out).toContain("2026-06-08");
    expect(out).toContain("Vacation");
  });

  it("renders empty header table when items is empty", () => {
    const out = formatBreaksTable([]);
    expect(out).toContain("id");
    expect(out).toContain("starts");
    expect(out).toContain("ends");
    expect(out).toContain("comment");
  });

  it("handles null comment", () => {
    const out = formatBreaksTable([{ ...BREAK_FIXTURE, comment: null }]);
    expect(out).toContain("br-1");
    // No "Vacation" string when comment is null
    expect(out).not.toContain("Vacation");
  });
});

describe("formatBreakEntity", () => {
  it("renders id, starts, ends, comment when present", () => {
    const out = formatBreakEntity(BREAK_FIXTURE);
    expect(out).toContain("Id: br-1");
    expect(out).toContain("Starts: 2026-06-01");
    expect(out).toContain("Ends: 2026-06-08");
    expect(out).toContain("Comment: Vacation");
  });

  it("omits the Comment line when comment is null or empty", () => {
    const out1 = formatBreakEntity({ ...BREAK_FIXTURE, comment: null });
    expect(out1).not.toContain("Comment:");
    const out2 = formatBreakEntity({ ...BREAK_FIXTURE, comment: "" });
    expect(out2).not.toContain("Comment:");
  });
});
