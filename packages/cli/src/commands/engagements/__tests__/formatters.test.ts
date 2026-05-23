// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { engagements } from "@ttctl/core";

import { formatBreakEntity, formatBreaksTable, formatReasonsTable } from "../breaks.js";
import { formatDate, formatEngagementsTable, shortenEngagementStatus } from "../list.js";
import { buildEngagementsPageInfo, formatPageFooter } from "../shared.js";
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
    // Override client with the richer #546 shape (the list fixture's
    // `client` is the identity-only `EngagementJobRef.client`; the detail
    // path widens it via Omit + intersection on `EngagementDetail.job`).
    client: {
      id: "cli-1",
      fullName: "Acme Inc.",
      city: "San Francisco",
      countryName: "United States",
      foundingYear: "2005",
      industry: "Software",
      isEnterprise: false,
      teamSize: { value: "50-200" },
    },
    descriptionMd: "Engineering role.\n\nLong-term placement.",
    expectedHours: 40,
    commitment: { slug: "full_time" },
    workType: { slug: "remote" },
    specialization: { title: "Backend" },
    startDate: "2026-01-01",
    isCoaching: false,
    isToptalProject: false,
    contacts: [
      {
        id: "rep-1",
        email: "jane@acme.com",
        fullName: "Jane Doe",
        phoneNumber: "+1-555-0100",
        position: "Hiring Manager",
        timeZone: { location: "America/New_York", name: "Eastern Time (US & Canada)", value: "EST" },
      },
    ],
    pointsOfContact: {
      current: {
        id: "rec-1",
        fullName: "Alex Recruiter",
        contactFields: {
          communitySlackId: "alex.slack",
          email: "alex@toptal.com",
          phoneNumber: "+1-555-0200",
          skype: "alex.skype",
        },
        photo: { small: "https://cdn.example/alex-small.jpg" },
        vacation: { id: "vac-1", startDate: "2026-07-01", endDate: "2026-07-08" },
        timeZone: { location: "Europe/London", name: "London", value: "GMT" },
      },
      handoff: null,
      kind: "standard",
    },
  },
  currentAgreement: {
    applicationRate: "120.00",
    talentHourlyRate: "100.00",
    talentRate: "100.00",
    marketplaceMargin: "20.00",
    timePeriod: "Monthly",
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
    // Client context (#546) renders as its own "Client" section (mirrors
    // jobs.show). DETAIL_FIXTURE's client carries the rich shape, so both
    // the section header and the name appear here; the section-content
    // edge cases are covered by the dedicated #546 tests below.
    expect(out).toContain("Client");
    expect(out).toContain("Acme Inc.");
    expect(out).toContain("Engagement");
    expect(out).toContain("Started: 2026-02-01");
    expect(out).toContain("Bill cycle: Monthly");
    expect(out).toContain("Agreement");
    expect(out).toContain("Hourly rate: 100.00");
    expect(out).toContain("Marketplace margin: 20.00");
    expect(out).toContain("Time period: Monthly");
    expect(out).toContain("Earnings");
    expect(out).toContain("Paid: 5000.00 USD");
  });

  it("renders the Client section with city, countryName, foundingYear, industry, teamSize, isEnterprise (#546)", () => {
    const out = formatEngagementDetail({
      ...DETAIL_FIXTURE,
      job: {
        ...DETAIL_FIXTURE.job,
        client: {
          id: "cli-2",
          fullName: "Globex Corp.",
          city: "Berlin",
          countryName: "Germany",
          foundingYear: "1989",
          industry: "Manufacturing",
          isEnterprise: true,
          teamSize: { value: "1000+" },
        },
      },
    });
    expect(out).toContain("Client");
    expect(out).toContain("Globex Corp.");
    expect(out).toContain("Industry: Manufacturing");
    expect(out).toContain("Location: Berlin, Germany");
    expect(out).toContain("Founded: 1989");
    expect(out).toContain("Team size: 1000+");
    expect(out).toContain("Enterprise: yes");
  });

  it("renders the Client section header + name when only fullName is populated (#546)", () => {
    const out = formatEngagementDetail({
      ...DETAIL_FIXTURE,
      job: {
        ...DETAIL_FIXTURE.job,
        client: {
          id: "cli-3",
          fullName: "Sparse Client Ltd.",
          city: null,
          countryName: null,
          foundingYear: null,
          industry: null,
          isEnterprise: false,
          teamSize: null,
        },
      },
    });
    // Mirrors jobs.show: the "Client" header always renders when client is
    // non-null; only the populated context lines are added. A sparse client
    // (name only) yields the header + indented name, no context sub-lines.
    expect(out).toContain("Client");
    expect(out).toContain("Sparse Client Ltd.");
    expect(out).not.toContain("Industry:");
    expect(out).not.toContain("Location:");
    expect(out).not.toContain("Founded:");
    expect(out).not.toContain("Team size:");
    expect(out).not.toContain("Enterprise:");
  });

  it("omits the Client section entirely when client is null (#546)", () => {
    const out = formatEngagementDetail({
      ...DETAIL_FIXTURE,
      job: { ...DETAIL_FIXTURE.job, client: null },
    });
    expect(out).not.toContain("Client");
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

  it("renders the Contacts section with name, position, email, time zone (#545)", () => {
    const out = formatEngagementDetail(DETAIL_FIXTURE);
    expect(out).toContain("Contacts (1)");
    expect(out).toContain("• Jane Doe — Hiring Manager");
    expect(out).toContain("Email: jane@acme.com");
    expect(out).toContain("Phone: +1-555-0100");
    expect(out).toContain("Time zone: Eastern Time (US & Canada)");
  });

  it("renders the Points of Contact section with the current recruiter (#545)", () => {
    const out = formatEngagementDetail(DETAIL_FIXTURE);
    expect(out).toContain("Points of Contact");
    expect(out).toContain("Current recruiter: Alex Recruiter");
    expect(out).toContain("Email: alex@toptal.com");
    expect(out).toContain("Slack: alex.slack");
    expect(out).toContain("Time zone: London");
    expect(out).toContain("Kind: standard");
  });

  it("omits Contacts + Points of Contact sections when empty/null (#545)", () => {
    const out = formatEngagementDetail({
      ...DETAIL_FIXTURE,
      job: { ...DETAIL_FIXTURE.job, contacts: [], pointsOfContact: null },
    });
    expect(out).not.toContain("Contacts (");
    expect(out).not.toContain("Points of Contact");
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

describe("formatReasonsTable", () => {
  const REASONS_FIXTURE: engagements.EngagementBreakReason[] = [
    { identifier: "client_needs_preparation", nameForRole: "Client needs preparation" },
    { identifier: "client_on_vacation", nameForRole: "Client on vacation" },
    { identifier: "other", nameForRole: "Other" },
    { identifier: "talent_on_vacation", nameForRole: "On vacation" },
  ];

  it("renders rows with id and label columns", () => {
    const out = formatReasonsTable(REASONS_FIXTURE);
    expect(out).toContain("id");
    expect(out).toContain("label");
    expect(out).toContain("talent_on_vacation");
    expect(out).toContain("On vacation");
    expect(out).toContain("other");
    expect(out).toContain("Other");
  });

  it("renders empty header table when items is empty", () => {
    const out = formatReasonsTable([]);
    expect(out).toContain("id");
    expect(out).toContain("label");
    expect(out).not.toContain("talent_on_vacation");
  });

  it("widens the id column to fit the longest identifier", () => {
    // Identifier longer than the default 12-cap floor; rendering must
    // not truncate it.
    const long = "very_long_break_reason_identifier_xx";
    const out = formatReasonsTable([{ identifier: long, nameForRole: "Long label" }]);
    expect(out).toContain(long);
  });
});

// =======================================================================
// formatPageFooter — pretty-mode pagination footer (issue #375)
// =======================================================================
// Mirrors the jobs precedent (`packages/cli/src/commands/jobs/__tests__/
// formatters.test.ts`) for the domain-local engagement copy of the
// formatter. Same shape, same edge cases.

describe("formatPageFooter", () => {
  it('renders "Page X of Y (per_page=Z)" for a typical mid-list page', () => {
    expect(formatPageFooter(2, 20, 100)).toBe("Page 2 of 5 (per_page=20)");
  });

  it("rounds totalPages UP via Math.ceil (partial last page)", () => {
    // 47 / 20 = 2.35 → ceil → 3 pages
    expect(formatPageFooter(1, 20, 47)).toBe("Page 1 of 3 (per_page=20)");
  });

  it("renders 'Page 1 of 1' for a single-page result (totalCount > 0)", () => {
    expect(formatPageFooter(1, 20, 5)).toBe("Page 1 of 1 (per_page=20)");
  });

  it("floors totalPages to 1 when totalCount is 0 (defensive; caller routes via empty-state)", () => {
    expect(formatPageFooter(1, 20, 0)).toBe("Page 1 of 1 (per_page=20)");
  });
});

// =======================================================================
// buildEngagementsPageInfo — envelope pageInfo derivation (issue #375)
// =======================================================================

describe("buildEngagementsPageInfo", () => {
  it("derives currentPage/perPage/totalPages/hasNextPage from an EngagementListPage", () => {
    const pageInfo = buildEngagementsPageInfo({
      items: [],
      totalCount: 100,
      page: 2,
      perPage: 20,
    });
    expect(pageInfo).toEqual({
      currentPage: 2,
      perPage: 20,
      totalPages: 5,
      hasNextPage: true,
    });
  });

  it("hasNextPage=false on the last page", () => {
    const pageInfo = buildEngagementsPageInfo({
      items: [],
      totalCount: 100,
      page: 5,
      perPage: 20,
    });
    expect(pageInfo.hasNextPage).toBe(false);
    expect(pageInfo.totalPages).toBe(5);
  });

  it("hasNextPage=false when current page exceeds totalPages (user overshot)", () => {
    const pageInfo = buildEngagementsPageInfo({
      items: [],
      totalCount: 100,
      page: 10,
      perPage: 20,
    });
    expect(pageInfo.hasNextPage).toBe(false);
    expect(pageInfo.totalPages).toBe(5);
  });

  it("totalPages=1 when totalCount=0 (defensive minimum)", () => {
    const pageInfo = buildEngagementsPageInfo({
      items: [],
      totalCount: 0,
      page: 1,
      perPage: 20,
    });
    expect(pageInfo.totalPages).toBe(1);
    expect(pageInfo.hasNextPage).toBe(false);
  });
});
