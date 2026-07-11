// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { timesheet } from "@ttctl/core";

import { formatTimesheetsTable, formatWeek } from "../list.js";
import { formatTimesheetDetail } from "../show.js";

const LIST_FIXTURE: timesheet.TimesheetListItem = {
  id: "bc-1",
  startDate: "2026-05-01",
  endDate: "2026-05-15",
  hours: "40.0",
  minimumCommitment: { applicable: true, minimumHours: 20, reasonNotApplicable: null },
  timesheetOverdue: false,
  timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
  timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
  timesheetSubmitted: false,
  timesheetApproved: false,
  timesheetRequiresApproval: true,
  status: "open",
  engagement: {
    id: "eng-1",
    job: {
      id: "job-1",
      title: "Senior Backend Engineer",
      client: { id: "cli-1", fullName: "Acme Inc." },
    },
  },
};

const DETAIL_FIXTURE: timesheet.TimesheetDetail = {
  ...LIST_FIXTURE,
  timesheetUrl: "https://www.toptal.com/timesheet/bc-1",
  timesheetComment: "Worked on auth refactor",
  timesheetRecords: [
    // `duration` is string-minutes (480.0 = 8h); `hours` is the
    // server-rendered hour form the CLI renders verbatim.
    { date: "2026-05-12", duration: "480.0", hours: "8.0", note: "auth refactor", isDayOff: false, persisted: true },
    { date: "2026-05-13", duration: "0.0", hours: "0.0", note: null, isDayOff: true, persisted: true },
  ],
  actualAgreement: { applicationRate: "120.00", talentHourlyRate: "100.00", marketplaceMargin: "20.00" },
  engagement: {
    ...LIST_FIXTURE.engagement,
    expectedHours: 40,
  },
};

describe("formatWeek", () => {
  it("joins start and end with an arrow", () => {
    expect(formatWeek("2026-05-01", "2026-05-15")).toBe("2026-05-01 → 2026-05-15");
  });
});

describe("formatTimesheetsTable", () => {
  it("returns a header-only table for an empty list (no rows)", () => {
    const out = formatTimesheetsTable([]);
    expect(out).toContain("id");
    expect(out).toContain("engagement");
    expect(out).toContain("week");
    expect(out).toContain("submitted");
    expect(out).toContain("approved");
    expect(out).not.toContain("bc-1");
  });

  it("renders one row with id, client, title, week, hours, status glyphs (wide terminal)", () => {
    // Pass a wide terminal so word-wrap doesn't split cells across lines.
    const out = formatTimesheetsTable([LIST_FIXTURE], 200);
    expect(out).toContain("bc-1");
    expect(out).toContain("Acme Inc.");
    expect(out).toContain("Senior Backend Engineer");
    // Week column may word-wrap on the arrow even at wide terminal widths
    // depending on cli-table3's segmentation — assert both ends separately.
    expect(out).toContain("2026-05-01");
    expect(out).toContain("2026-05-15");
    expect(out).toContain("40.0");
    expect(out).toContain("·"); // not submitted glyph
    // overdue is false → blank column (no `!`)
  });

  it("renders submitted glyph (✓) when timesheetSubmitted is true", () => {
    const submitted = { ...LIST_FIXTURE, timesheetSubmitted: true };
    const out = formatTimesheetsTable([submitted], 200);
    expect(out).toContain("✓");
  });

  it("renders overdue glyph (!) when timesheetOverdue is true", () => {
    const overdue = { ...LIST_FIXTURE, timesheetOverdue: true };
    const out = formatTimesheetsTable([overdue], 200);
    expect(out).toContain("!");
  });

  it("renders the approved glyph (✓) in the approved column when timesheetApproved is true", () => {
    // timesheetSubmitted:false → submitted column is `·`, so the only `✓`
    // in the row must come from the approved column.
    const approved = { ...LIST_FIXTURE, timesheetSubmitted: false, timesheetApproved: true };
    const out = formatTimesheetsTable([approved], 200);
    expect(out).toContain("✓");
  });

  it("renders the not-required approval glyph (—) when timesheetRequiresApproval is false", () => {
    const notRequired = { ...LIST_FIXTURE, timesheetApproved: false, timesheetRequiresApproval: false };
    const out = formatTimesheetsTable([notRequired], 200);
    expect(out).toContain("—");
  });

  it("handles null client and title gracefully", () => {
    const noClient: timesheet.TimesheetListItem = {
      ...LIST_FIXTURE,
      engagement: {
        ...LIST_FIXTURE.engagement,
        job: { id: "job-1", title: null, client: null },
      },
    };
    const out = formatTimesheetsTable([noClient], 200);
    expect(out).toContain("(no client)");
    expect(out).toContain("(untitled)");
  });
});

describe("formatTimesheetDetail", () => {
  it("renders the header section with id, week, hours, submitted, overdue", () => {
    const out = formatTimesheetDetail(DETAIL_FIXTURE);
    expect(out).toContain("Timesheet bc-1");
    expect(out).toContain("Week: 2026-05-01 → 2026-05-15");
    expect(out).toContain("Hours: 40.0");
    expect(out).toContain("Submitted: false");
    expect(out).toContain("Overdue: false");
    expect(out).toContain("URL: https://www.toptal.com/timesheet/bc-1");
  });

  it("renders approval state (requires-approval, approved, status)", () => {
    const out = formatTimesheetDetail(DETAIL_FIXTURE);
    expect(out).toContain("Requires approval: true");
    expect(out).toContain("Approved: false");
    expect(out).toContain("Status: open");
  });

  it("omits the Status line when status is null", () => {
    const out = formatTimesheetDetail({ ...DETAIL_FIXTURE, status: null });
    expect(out).not.toContain("Status:");
  });

  it("renders the engagement section", () => {
    const out = formatTimesheetDetail(DETAIL_FIXTURE);
    expect(out).toContain("Engagement");
    expect(out).toContain("Senior Backend Engineer");
    expect(out).toContain("Client: Acme Inc.");
    expect(out).toContain("TalentEngagement id: eng-1");
    expect(out).toContain("Expected hours: 40");
  });

  it("renders the agreement section when present", () => {
    const out = formatTimesheetDetail(DETAIL_FIXTURE);
    expect(out).toContain("Agreement");
    expect(out).toContain("Application rate: 120.00");
    expect(out).toContain("Hourly rate: 100.00");
    expect(out).toContain("Marketplace margin: 20.00");
  });

  it("renders the records section with the server-provided hours", () => {
    const out = formatTimesheetDetail(DETAIL_FIXTURE);
    expect(out).toContain("Records (2)");
    expect(out).toContain("2026-05-12: 8.0h");
    expect(out).toContain("2026-05-13: 0.0h [day off]");
    expect(out).toContain("auth refactor");
  });

  it("falls back to deriving hours from duration when server hours is null", () => {
    const fixture: timesheet.TimesheetDetail = {
      ...DETAIL_FIXTURE,
      timesheetRecords: [
        { date: "2026-05-14", duration: "450.0", hours: null, note: null, isDayOff: false, persisted: false },
      ],
    };
    const out = formatTimesheetDetail(fixture);
    expect(out).toContain("2026-05-14: 7.50h");
  });

  it("omits the comment section when null/empty", () => {
    const noComment = { ...DETAIL_FIXTURE, timesheetComment: null };
    const out = formatTimesheetDetail(noComment);
    expect(out).not.toContain("Comment");
  });

  it("omits the records section when empty", () => {
    const noRecords = { ...DETAIL_FIXTURE, timesheetRecords: [] };
    const out = formatTimesheetDetail(noRecords);
    expect(out).not.toContain("Records");
  });

  it("omits the agreement section when actualAgreement is null", () => {
    const noAgreement = { ...DETAIL_FIXTURE, actualAgreement: null };
    const out = formatTimesheetDetail(noAgreement);
    expect(out).not.toContain("Agreement\n");
  });

  it("omits the minimum-commitment section when not applicable", () => {
    const naCommitment: timesheet.TimesheetDetail = {
      ...DETAIL_FIXTURE,
      minimumCommitment: { applicable: false, minimumHours: null, reasonNotApplicable: "fixed-bid" },
    };
    const out = formatTimesheetDetail(naCommitment);
    expect(out).not.toContain("Minimum commitment");
  });
});
