// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { jobs } from "@ttctl/core";

import { formatInterestEntity } from "../interest.js";
import { formatJobDetail } from "../show.js";
import {
  buildJobsPageInfo,
  formatDate,
  formatFlags,
  formatJobsTable,
  formatPageFooter,
  formatRate,
} from "../shared.js";

const LIST_ITEM_FIXTURE: jobs.JobListItem = {
  id: "job-1",
  title: "Senior React Engineer",
  url: "https://www.toptal.com/jobs/job-1",
  client: { id: "cli-1", fullName: "Acme Inc." },
  commitment: { slug: "full_time" },
  workType: { slug: "remote" },
  specialization: { title: "Frontend" },
  expectedHours: 40,
  maxRate: 120,
  startDate: "2026-06-01",
  postedWhen: "2 days ago",
  viewed: false,
  saved: false,
  notInterested: false,
};

const DETAIL_FIXTURE: jobs.JobDetail = {
  ...LIST_ITEM_FIXTURE,
  descriptionMd: "We're hiring.\n\nLong-term role.",
  minimumHoursPerBillingCycle: 80,
  isCoaching: false,
  isToptalProject: false,
  semiMonthlyBilling: false,
  positionsCount: 1,
  jobTimeZone: {
    verbose: "UTC+0",
    hoursOverlap: 4,
    workingTimeFrom: "09:00",
    workingTimeTo: "17:00",
  },
  client: {
    id: "cli-1",
    fullName: "Acme Inc.",
    city: "San Francisco",
    countryName: "United States",
    industry: "Software",
    isEnterprise: false,
    website: "https://acme.example",
    linkedin: "https://linkedin.com/company/acme",
    teamSize: { value: "50-200" },
  },
  skills: [{ id: "sk-1", name: "React", rating: 5, isOptional: false }],
  languages: [{ id: "lang-1", name: "English" }],
};

const INTEREST_STATE_FIXTURE: jobs.JobInterestState = {
  id: "job-1",
  saved: true,
  notInterested: false,
  viewed: false,
};

describe("formatDate", () => {
  it("returns the YYYY-MM-DD prefix", () => {
    expect(formatDate("2026-04-15T12:00:00Z")).toBe("2026-04-15");
  });
  it("returns empty string for null", () => {
    expect(formatDate(null)).toBe("");
  });
  it("returns input as-is on non-matching shape", () => {
    expect(formatDate("not a date")).toBe("not a date");
  });
});

describe("formatRate", () => {
  it("formats a numeric rate with $/h suffix", () => {
    expect(formatRate(120)).toBe("$120/h");
  });
  it("returns empty string for null", () => {
    expect(formatRate(null)).toBe("");
  });
});

describe("formatFlags", () => {
  it("returns combined letters for set flags", () => {
    expect(formatFlags({ saved: true, notInterested: false, viewed: true })).toBe("SV");
  });
  it("returns empty string when no flags set", () => {
    expect(formatFlags({ saved: false, notInterested: false, viewed: false })).toBe("");
  });
  it("returns N for not-interested only", () => {
    expect(formatFlags({ saved: false, notInterested: true, viewed: false })).toBe("N");
  });
});

describe("formatJobsTable", () => {
  it("renders an empty table when items is empty", () => {
    const output = formatJobsTable([], 100);
    expect(output).toContain("id");
    expect(output).toContain("title");
  });

  it("renders job rows with title and client", () => {
    // Use a wider terminal so the title doesn't wrap inside the table cell —
    // the wrap logic in cli-table3 inserts a literal newline mid-title at
    // narrow widths, breaking simple substring assertions. The on-screen
    // output still renders correctly; this is purely a test-affordance.
    const output = formatJobsTable([LIST_ITEM_FIXTURE], 200);
    expect(output).toContain("job-1");
    expect(output).toContain("Senior React Engineer");
    expect(output).toContain("Acme Inc.");
    expect(output).toContain("$120/h");
  });

  it("renders untitled placeholder when title is null", () => {
    const output = formatJobsTable([{ ...LIST_ITEM_FIXTURE, title: null }], 100);
    expect(output).toContain("(untitled)");
  });
});

// =======================================================================
// formatPageFooter — pretty-mode pagination footer (issue #138)
// =======================================================================

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
// buildJobsPageInfo — envelope pageInfo derivation (issue #138)
// =======================================================================

describe("buildJobsPageInfo", () => {
  it("derives currentPage/perPage/totalPages/hasNextPage from a JobListPage", () => {
    const pageInfo = buildJobsPageInfo({
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
    const pageInfo = buildJobsPageInfo({
      items: [],
      totalCount: 100,
      page: 5,
      perPage: 20,
    });
    expect(pageInfo.hasNextPage).toBe(false);
    expect(pageInfo.totalPages).toBe(5);
  });

  it("hasNextPage=false when current page exceeds totalPages (user overshot)", () => {
    const pageInfo = buildJobsPageInfo({
      items: [],
      totalCount: 100,
      page: 10,
      perPage: 20,
    });
    expect(pageInfo.hasNextPage).toBe(false);
    expect(pageInfo.totalPages).toBe(5);
  });

  it("totalPages=1 when totalCount=0 (defensive minimum)", () => {
    const pageInfo = buildJobsPageInfo({
      items: [],
      totalCount: 0,
      page: 1,
      perPage: 20,
    });
    expect(pageInfo.totalPages).toBe(1);
    expect(pageInfo.hasNextPage).toBe(false);
  });
});

describe("formatJobDetail", () => {
  it("renders job, client, skills, languages, description sections", () => {
    const output = formatJobDetail(DETAIL_FIXTURE);
    expect(output).toContain("Job job-1");
    expect(output).toContain("Senior React Engineer");
    expect(output).toContain("Acme Inc.");
    expect(output).toContain("Industry: Software");
    expect(output).toContain("Location: San Francisco, United States");
    expect(output).toContain("Team size: 50-200");
    expect(output).toContain("React");
    expect(output).toContain("Languages: English");
    expect(output).toContain("We're hiring.");
  });

  it("omits Client section when client is null", () => {
    const noClient: jobs.JobDetail = { ...DETAIL_FIXTURE, client: null };
    const output = formatJobDetail(noClient);
    expect(output).not.toContain("Industry:");
  });

  it("omits flag line when no flags are set", () => {
    const output = formatJobDetail({ ...DETAIL_FIXTURE, saved: false, notInterested: false, viewed: false });
    expect(output).not.toContain("Status: saved");
  });

  it("renders the Status line when at least one flag is set", () => {
    const output = formatJobDetail({ ...DETAIL_FIXTURE, saved: true });
    expect(output).toContain("Status: saved");
  });

  it("renders coaching tag when isCoaching=true", () => {
    const output = formatJobDetail({ ...DETAIL_FIXTURE, isCoaching: true });
    expect(output).toContain("Type: coaching");
  });
});

describe("formatInterestEntity", () => {
  it("renders the interest state as multi-line", () => {
    const output = formatInterestEntity(INTEREST_STATE_FIXTURE);
    expect(output).toContain("Id: job-1");
    expect(output).toContain("Saved: yes");
    expect(output).toContain("Not interested: no");
    expect(output).toContain("Viewed: no");
  });
});
