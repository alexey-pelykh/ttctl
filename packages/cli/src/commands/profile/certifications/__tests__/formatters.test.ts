// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatCertificationListTable, formatCertificationListText } from "../index.js";

/**
 * Pure-formatter unit tests for the `certifications list` pretty + table
 * renderers (#341). Covers happy path (multi-row), empty list, and the
 * `no expiry` branch of the validity range formatter (the most common
 * shape for certifications without an expiration date).
 */

const ROW_EXPIRES: profile.certifications.Certification = {
  id: "V1-Certification-1",
  certificate: "AWS Solutions Architect",
  institution: "Amazon Web Services",
  link: "https://example.com/aws",
  number: "AWS-12345",
  validFromMonth: 3,
  validFromYear: 2020,
  validToMonth: 3,
  validToYear: 2023,
  highlight: true,
  status: "expired",
};

const ROW_NO_EXPIRY: profile.certifications.Certification = {
  id: "V1-Certification-2",
  certificate: "Certified Scrum Master",
  institution: "Scrum Alliance",
  link: null,
  number: null,
  validFromMonth: 6,
  validFromYear: 2019,
  validToMonth: null,
  validToYear: null,
  highlight: false,
  status: "valid",
};

const ROW_NULL_STATUS: profile.certifications.Certification = {
  id: "V1-Certification-3",
  certificate: "Legacy Certificate",
  institution: "Legacy Inc.",
  link: null,
  number: null,
  validFromMonth: 1,
  validFromYear: 2015,
  validToMonth: null,
  validToYear: null,
  highlight: false,
  status: null,
};

describe("formatCertificationListText (#341, status added #557)", () => {
  it("renders one tab-separated line per row, with status before the id", () => {
    const out = formatCertificationListText([ROW_EXPIRES, ROW_NO_EXPIRY]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("AWS Solutions Architect\tAmazon Web Services\t03/2020–03/2023\texpired\tV1-Certification-1");
    expect(lines[1]).toBe("Certified Scrum Master\tScrum Alliance\t06/2019–no expiry\tvalid\tV1-Certification-2");
  });

  it("renders an em-dash when status is null (#557)", () => {
    const out = formatCertificationListText([ROW_NULL_STATUS]);
    expect(out).toBe("Legacy Certificate\tLegacy Inc.\t01/2015–no expiry\t—\tV1-Certification-3");
  });

  it("renders an empty-list sentinel when the list is empty", () => {
    expect(formatCertificationListText([])).toBe("(no certifications on profile)");
  });
});

describe("formatCertificationListTable (#341, status added #557)", () => {
  it("emits a cli-table3 table with Status column populated from c.status", () => {
    const out = formatCertificationListTable([ROW_EXPIRES, ROW_NO_EXPIRY, ROW_NULL_STATUS]);
    expect(out).toContain("Certificate");
    expect(out).toContain("Issuer");
    expect(out).toContain("Valid");
    expect(out).toContain("Status");
    expect(out).toContain("Highlight");
    expect(out).toContain("AWS Solutions Architect");
    expect(out).toContain("Amazon Web Services");
    expect(out).toContain("03/2020–03/2023");
    expect(out).toContain("expired");
    expect(out).toContain("Certified Scrum Master");
    expect(out).toContain("Scrum Alliance");
    expect(out).toContain("06/2019–no expiry");
    expect(out).toContain("valid");
    expect(out).toContain("Legacy Certificate");
    // The em-dash sentinel for null status.
    expect(out).toContain("—");
    expect(out).toContain("yes");
    expect(out).toContain("no");
  });
});
