// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatEmploymentTable, formatEmploymentText } from "../index.js";

/**
 * Pure-formatter unit tests for the `employment show` pretty + table
 * renderers. Added with #344, which extended the renderers to surface
 * `publicationPermit`, `reportingTo`, `industries`, and
 * `primaryGeography` (the read/write-parity fields). Both the
 * present-on-row and absent-on-row branches are covered — the pretty
 * formatter renders the #344 fields conditionally (mirroring the
 * existing `if (e.highlight)` style), the table formatter renders them
 * unconditionally as key/value rows.
 */

const FULL: profile.employment.Employment = {
  id: "V1-Employment-9",
  company: "Globex",
  position: "Staff Engineer",
  companyWebsite: "https://globex.test",
  noWebsite: false,
  startDate: 2019,
  endDate: null,
  experienceItems: ["Led the platform team"],
  highlight: true,
  showViaToptal: true,
  toptalRelated: false,
  publicationPermit: false,
  reportingTo: "VP Engineering",
  industries: [
    { id: "V1-Industry-1", name: "Software" },
    { id: "V1-Industry-2", name: "Fintech" },
  ],
  primaryGeography: { id: "V1-Geo-1", code: "US", name: "United States" },
};

const BARE: profile.employment.Employment = {
  id: "V1-Employment-10",
  company: "Acme",
  position: "Engineer",
  companyWebsite: null,
  noWebsite: true,
  startDate: 2015,
  endDate: 2018,
  experienceItems: null,
  highlight: false,
  showViaToptal: false,
  toptalRelated: false,
  publicationPermit: null,
  reportingTo: null,
  industries: [],
  primaryGeography: null,
};

describe("formatEmploymentText (#344 fields)", () => {
  it("renders reports-to, industries, geography, and the public flag when present", () => {
    const out = formatEmploymentText(FULL);
    expect(out).toContain("reports to: VP Engineering");
    expect(out).toContain("industries: Software, Fintech");
    expect(out).toContain("geography: United States");
    expect(out).toContain("public: no");
  });

  it("omits the #344 lines when the row carries null / empty values", () => {
    const out = formatEmploymentText(BARE);
    expect(out).not.toContain("reports to:");
    expect(out).not.toContain("industries:");
    expect(out).not.toContain("geography:");
    expect(out).not.toContain("public:");
  });

  it("falls back to geography code then id when name is null", () => {
    const out = formatEmploymentText({
      ...FULL,
      primaryGeography: { id: "V1-Geo-2", code: "FR", name: null },
    });
    expect(out).toContain("geography: FR");
  });

  it("falls back to geography id when both name and code are null", () => {
    const out = formatEmploymentText({
      ...FULL,
      primaryGeography: { id: "V1-Geo-3", code: null, name: null },
    });
    expect(out).toContain("geography: V1-Geo-3");
  });
});

describe("formatEmploymentTable (#344 fields)", () => {
  it("emits the four #344 key/value rows with values", () => {
    const out = formatEmploymentTable(FULL);
    expect(out).toContain("publicationPermit\tfalse");
    expect(out).toContain("reportingTo\tVP Engineering");
    expect(out).toContain("industries\tSoftware, Fintech");
    expect(out).toContain("primaryGeography\tUnited States");
  });

  it("emits empty values for the #344 rows when the row is bare", () => {
    const out = formatEmploymentTable(BARE);
    expect(out).toContain("publicationPermit\t");
    expect(out).toContain("reportingTo\t");
    expect(out).toContain("industries\t");
    expect(out).toContain("primaryGeography\t");
  });

  it("primaryGeography row falls back to id when name and code are null", () => {
    const out = formatEmploymentTable({
      ...FULL,
      primaryGeography: { id: "V1-Geo-3", code: null, name: null },
    });
    expect(out).toContain("primaryGeography\tV1-Geo-3");
  });
});
