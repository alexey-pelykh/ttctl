// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatSpecializationsTable, formatSpecializationsText } from "../show.js";

const SAMPLE: profile.specializations.Specialization = {
  id: "spec-core-uuid",
  slug: "core",
  title: "Core",
  description: "Flagship Toptal Core network.",
  logoUrl: "https://example.com/badge.png",
  applicationStatus: "ACCEPTED",
  eligibleJobsCount: 0,
  applicationCompletedAt: "2024-01-15T12:00:00Z",
  operations: {
    apply: { callable: "DISABLED", messages: ["Already accepted."] },
  },
};

describe("formatSpecializationsText (profile specializations show pretty)", () => {
  it("renders the headline + all label-aligned fields for a single accepted row", () => {
    const out = formatSpecializationsText([SAMPLE]);
    expect(out).toContain("Core (core)");
    expect(out).toContain("id:                       spec-core-uuid");
    expect(out).toContain("status:                   ACCEPTED");
    expect(out).toContain("applicationCompletedAt:   2024-01-15T12:00:00Z");
    expect(out).toContain("eligibleJobsCount:        0");
    expect(out).toContain("logoUrl:                  https://example.com/badge.png");
    expect(out).toContain("apply.callable:           DISABLED");
    expect(out).toContain("apply.messages:");
    expect(out).toContain("- Already accepted.");
    expect(out).toContain("description:              Flagship Toptal Core network.");
  });

  it("renders `(unset)` placeholders for null/missing fields", () => {
    const sparse: profile.specializations.Specialization = {
      ...SAMPLE,
      description: null,
      logoUrl: null,
      eligibleJobsCount: null,
      applicationCompletedAt: null,
      operations: { apply: { callable: "ENABLED", messages: [] } },
    };
    const out = formatSpecializationsText([sparse]);
    expect(out).toContain("applicationCompletedAt:   (unset)");
    expect(out).toContain("eligibleJobsCount:        (unset)");
    expect(out).toContain("logoUrl:                  (unset)");
    expect(out).toContain("apply.callable:           ENABLED");
    expect(out).not.toContain("apply.messages:"); // empty list → skip the section
    expect(out).not.toContain("description:"); // null description → skip the line
  });

  it("renders `(unset)` for an empty `callable` (defensive default for a missing wire field)", () => {
    const missingCallable: profile.specializations.Specialization = {
      ...SAMPLE,
      operations: { apply: { callable: "", messages: [] } },
    };
    const out = formatSpecializationsText([missingCallable]);
    expect(out).toContain("apply.callable:           (unset)");
  });

  it("renders the explanatory empty-list line when no specializations are recorded", () => {
    const out = formatSpecializationsText([]);
    expect(out).toBe("No specializations recorded on this profile.");
  });

  it("separates multiple rows with a blank line", () => {
    const second: profile.specializations.Specialization = {
      ...SAMPLE,
      id: "spec-marketplace",
      slug: "marketplace",
      title: "Marketplace",
    };
    const out = formatSpecializationsText([SAMPLE, second]);
    expect(out).toContain("Core (core)");
    expect(out).toContain("Marketplace (marketplace)");
    expect(out.indexOf("Marketplace") - out.indexOf("Core")).toBeGreaterThan(0);
    // Sections are separated by a blank line (two `\n`).
    expect(out).toContain("\n\n");
  });
});

describe("formatSpecializationsTable (profile specializations show table)", () => {
  it("emits a header row + one data row per specialization with tab separation", () => {
    const out = formatSpecializationsTable([SAMPLE]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("slug\ttitle\tstatus\tapplicationCompletedAt\teligibleJobsCount\tapply.callable");
    expect(lines[1]).toBe("core\tCore\tACCEPTED\t2024-01-15T12:00:00Z\t0\tDISABLED");
  });

  it("blank-fills nullable fields rather than printing `null`", () => {
    const sparse: profile.specializations.Specialization = {
      ...SAMPLE,
      applicationCompletedAt: null,
      eligibleJobsCount: null,
    };
    const out = formatSpecializationsTable([sparse]);
    const row = out.split("\n")[1] ?? "";
    const fields = row.split("\t");
    expect(fields[3]).toBe(""); // applicationCompletedAt
    expect(fields[4]).toBe(""); // eligibleJobsCount
  });

  it("returns just the header row for an empty list", () => {
    const out = formatSpecializationsTable([]);
    expect(out).toBe("slug\ttitle\tstatus\tapplicationCompletedAt\teligibleJobsCount\tapply.callable");
  });
});
