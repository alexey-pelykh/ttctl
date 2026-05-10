// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { formatAdvancedWizardTable, formatAdvancedWizardText } from "../advanced-wizard-show.js";
import { formatSetResult } from "../custom-requirements-set.js";
import { formatCustomRequirementsTable, formatCustomRequirementsText } from "../custom-requirements-show.js";
import { formatReadinessTable, formatReadinessText } from "../readiness.js";
import { formatRecommendationsTable, formatRecommendationsText } from "../recommendations.js";
import { formatUpdateResult } from "../update.js";

/**
 * These tests cover the pure formatters in each external-leaf file. The
 * action handlers themselves do I/O (config load, transport, stdout/stderr)
 * and are covered indirectly through the core service tests; the formatters
 * are pure functions and warrant direct unit coverage so output stability
 * (text shape, json keys, table tab-separated layout) is regression-tested.
 */

describe("formatUpdateResult (external update)", () => {
  const sample = {
    profile: {
      id: "p1",
      updatedByTalentAt: "2026-05-07T12:00:00Z",
      linkedin: "https://linkedin.com/in/ada",
      github: "https://github.com/ada",
      website: null,
      behance: null,
      dribbble: null,
    },
    notice: "Saved.",
  };

  it("renders pretty mode with confirmation + non-null fields", () => {
    const out = formatUpdateResult(sample, "pretty");
    expect(out).toContain("External profiles updated.");
    expect(out).toContain("linkedin: https://linkedin.com/in/ada");
    expect(out).toContain("github: https://github.com/ada");
    expect(out).not.toContain("website:");
    expect(out).toContain("Saved.");
  });

  it("renders json mode as pretty-printed JSON of the result object", () => {
    const out = formatUpdateResult(sample, "json");
    expect(JSON.parse(out)).toEqual(sample);
  });

  it("renders yaml mode as block-style YAML with the typed payload", () => {
    const out = formatUpdateResult(sample, "yaml");
    expect(out).toContain("notice: Saved.");
    expect(out).toContain("linkedin: https://linkedin.com/in/ada");
    expect(out).toContain("github: https://github.com/ada");
    expect(out).toContain("website: null");
  });
});

describe("formatCustomRequirementsText / Table", () => {
  it("renders all three booleans + (unset) for nulls", () => {
    const out = formatCustomRequirementsText({
      backgroundCheck: true,
      drugTest: false,
      timeTrackingTools: null,
    });
    expect(out).toContain("background-check:    yes");
    expect(out).toContain("drug-test:           no");
    expect(out).toContain("time-tracking-tools: (unset)");
  });

  it("renders table mode with consistent labels", () => {
    const out = formatCustomRequirementsTable({
      backgroundCheck: true,
      drugTest: false,
      timeTrackingTools: null,
    });
    const lines = out.split("\n");
    expect(lines).toEqual(["background-check\tyes", "drug-test\tno", "time-tracking-tools\t(unset)"]);
  });
});

describe("formatSetResult (custom requirements set)", () => {
  const sample = {
    profile: {
      id: "p1",
      updatedByTalentAt: "2026-05-07T12:00:00Z",
      customRequirements: {
        backgroundCheck: true,
        drugTest: false,
        timeTrackingTools: false,
      },
    },
    notice: null,
  };

  it("renders pretty mode with the post-update boolean trio", () => {
    const out = formatSetResult(sample, "pretty");
    expect(out).toContain("Custom requirements updated.");
    expect(out).toContain("background-check:    yes");
    expect(out).toContain("drug-test:           no");
    expect(out).toContain("time-tracking-tools: no");
  });

  it("renders json mode as the full result object", () => {
    const out = formatSetResult(sample, "json");
    expect(JSON.parse(out)).toEqual(sample);
  });
});

describe("formatReadinessText / Table", () => {
  const sample = {
    isPhotoResolutionSatisfied: true,
    isBasicInfoSatisfied: true,
    isCertificationsSatisfied: false,
    isEmploymentsCountSatisfied: true,
    isEmploymentConnectionsSatisfied: false,
    isSkillValidationsSatisfied: true,
    isPortfolioItemsCountSatisfied: false,
    isPortfolioItemConnectionsSatisfied: false,
    isWorkingHoursSatisfied: true,
    submitAvailable: false,
    updatedByTalentAt: "2026-05-07T12:00:00Z",
  };

  it("renders text mode with submit-available header + per-section rows", () => {
    const out = formatReadinessText(sample);
    expect(out).toContain("Profile readiness — submit-available: ✗");
    expect(out).toContain("photo-resolution");
    expect(out).toContain("certifications");
    expect(out).toContain("updated-by-talent-at");
  });

  it("renders table mode with one tab-separated row per field", () => {
    const out = formatReadinessTable(sample);
    const lines = out.split("\n");
    expect(lines[0]).toBe("submit-available\t✗");
    expect(lines).toContain("photo-resolution\t✓");
    expect(lines).toContain("certifications\t✗");
    expect(lines).toContain("updated-by-talent-at\t2026-05-07T12:00:00Z");
  });
});

describe("formatRecommendationsText / Table", () => {
  it("renders 'No recommendations.' on empty input (text mode)", () => {
    expect(formatRecommendationsText([])).toBe("No recommendations.");
  });

  it("renders one bullet per recommendation with payload summary (text mode)", () => {
    const out = formatRecommendationsText([
      { type: "EmploymentsCountRecommendation", payload: { minimumCount: 3 } },
      { type: "AdvancedProfileRecommendation", payload: {} },
    ]);
    expect(out).toContain("Recommendations (2):");
    expect(out).toContain("- EmploymentsCountRecommendation: minimumCount=3");
    expect(out).toContain("- AdvancedProfileRecommendation");
  });

  it("renders header-only table mode on empty input", () => {
    expect(formatRecommendationsTable([])).toBe("type\tpayload");
  });

  it("renders one tab-separated row per recommendation in table mode", () => {
    const out = formatRecommendationsTable([{ type: "EmploymentsCountRecommendation", payload: { minimumCount: 3 } }]);
    const lines = out.split("\n");
    expect(lines).toEqual(["type\tpayload", "EmploymentsCountRecommendation\tminimumCount=3"]);
  });
});

describe("formatAdvancedWizardText / Table", () => {
  it("renders text mode with status + visa preview", () => {
    const out = formatAdvancedWizardText({
      wizardStatus: "IN_PROGRESS",
      travelVisaCount: 7,
      travelVisaIds: ["v1", "v2", "v3", "v4", "v5", "v6", "v7"],
    });
    expect(out).toContain("Advanced profile wizard status: IN_PROGRESS");
    expect(out).toContain("travel-visa-count: 7");
    expect(out).toContain("travel-visa-ids:   v1, v2, v3, v4, v5 (+2 more)");
  });

  it("renders unset wizard status as `(unset)`", () => {
    const out = formatAdvancedWizardText({ wizardStatus: null, travelVisaCount: 0, travelVisaIds: [] });
    expect(out).toContain("Advanced profile wizard status: (unset)");
    expect(out).not.toContain("travel-visa-ids:");
  });

  it("renders table mode with three rows", () => {
    const out = formatAdvancedWizardTable({
      wizardStatus: "DONE",
      travelVisaCount: 2,
      travelVisaIds: ["v1", "v2"],
    });
    const lines = out.split("\n");
    expect(lines).toEqual(["wizard-status\tDONE", "travel-visa-count\t2", "travel-visa-ids\tv1,v2"]);
  });
});
