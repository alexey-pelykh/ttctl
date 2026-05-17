// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { formatAdvancedWizardTable, formatAdvancedWizardText } from "../advanced-wizard-show.js";
import { formatSetPrettyEntity } from "../custom-requirements-set.js";
import { formatCustomRequirementsTable, formatCustomRequirementsText } from "../custom-requirements-show.js";
import { formatReadinessTable, formatReadinessText } from "../readiness.js";
import { formatRecommendationsTable, formatRecommendationsText } from "../recommendations.js";
import { formatExternalShowTable, formatExternalShowText } from "../show.js";
import { formatUpdatePrettyEntity } from "../update.js";

/**
 * Pure-formatter unit tests for each external-leaf file. Post-#128 the
 * `update` and `custom-requirements set` action handlers emit envelopes
 * via the side-effecting `emitUpdateSuccess` rather than a pure
 * `formatXxxResult` helper — the wire-shape assertions for the envelope
 * itself live in `lib/__tests__/envelopes.test.ts`. The pure
 * `formatXxxPrettyEntity` helpers preserved on the action handlers keep
 * their direct unit coverage here. The remaining show-shape leaves
 * (`custom-requirements-show`, `readiness`, `recommendations`,
 * `advanced-wizard-show`) are read-only and continue to use direct
 * `formatXxxText/Table` formatters.
 */

describe("formatUpdatePrettyEntity (external update)", () => {
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

  it("renders the non-null URL set, omits the null ones", () => {
    const out = formatUpdatePrettyEntity(sample);
    expect(out).toContain("linkedin: https://linkedin.com/in/ada");
    expect(out).toContain("github: https://github.com/ada");
    expect(out).not.toContain("website:");
    expect(out).not.toContain("behance:");
    expect(out).not.toContain("dribbble:");
  });

  it("does not include the leading confirmation line — that's the envelope header's job", () => {
    const out = formatUpdatePrettyEntity(sample);
    expect(out).not.toContain("External profiles updated.");
    expect(out).not.toContain("✓");
  });

  it("does not include the notice — that flows through the envelope's notice slot", () => {
    const out = formatUpdatePrettyEntity(sample);
    expect(out).not.toContain("Saved.");
  });
});

describe("formatExternalShowText / Table (#343 external show)", () => {
  const allSet = {
    id: "p1",
    updatedByTalentAt: "2026-05-07T12:00:00Z",
    linkedin: "https://linkedin.com/in/ada",
    github: "https://github.com/ada",
    website: "https://ada.dev",
    twitter: "https://twitter.com/ada",
    behance: "https://behance.net/ada",
    dribbble: "https://dribbble.com/ada",
  };
  const noneSet = {
    id: "p1",
    updatedByTalentAt: null,
    linkedin: null,
    github: null,
    website: null,
    twitter: null,
    behance: null,
    dribbble: null,
  };

  it("text: renders all six URLs plus the timestamp when everything is set", () => {
    const out = formatExternalShowText(allSet);
    expect(out).toContain("linkedin: https://linkedin.com/in/ada");
    expect(out).toContain("github: https://github.com/ada");
    expect(out).toContain("website: https://ada.dev");
    expect(out).toContain("twitter: https://twitter.com/ada");
    expect(out).toContain("behance: https://behance.net/ada");
    expect(out).toContain("dribbble: https://dribbble.com/ada");
    expect(out).toContain("updated-by-talent-at: 2026-05-07T12:00:00Z");
  });

  it("text: renders (unset) for every null field", () => {
    const out = formatExternalShowText(noneSet);
    // Six URL lines + the timestamp line all read (unset).
    expect(out.match(/\(unset\)/g)).toHaveLength(7);
    expect(out).toContain("linkedin: (unset)");
    expect(out).toContain("updated-by-talent-at: (unset)");
  });

  it("table: emits tab-separated key/value rows, empty string for nulls", () => {
    const out = formatExternalShowTable(allSet);
    expect(out).toContain("linkedin\thttps://linkedin.com/in/ada");
    expect(out).toContain("twitter\thttps://twitter.com/ada");
    expect(out).toContain("updated-by-talent-at\t2026-05-07T12:00:00Z");

    const empty = formatExternalShowTable(noneSet);
    expect(empty).toContain("linkedin\t");
    expect(empty).toContain("updated-by-talent-at\t");
    expect(empty).not.toContain("(unset)");
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

describe("formatSetPrettyEntity (custom requirements set)", () => {
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

  it("renders the post-update boolean trio", () => {
    const out = formatSetPrettyEntity(sample);
    expect(out).toContain("background-check:    yes");
    expect(out).toContain("drug-test:           no");
    expect(out).toContain("time-tracking-tools: no");
  });

  it("does not include the leading confirmation line — that's the envelope header's job", () => {
    const out = formatSetPrettyEntity(sample);
    expect(out).not.toContain("Custom requirements updated.");
    expect(out).not.toContain("✓");
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
