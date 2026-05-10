// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { ProfileShowQuery, profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatYaml } from "../../../../lib/output.js";
import { formatProfilePretty, formatProfileTable } from "../show.js";
import type { BasicShowPayload } from "../show.js";

/**
 * Rich `ProfileShowQuery` fixture mirroring the mobile-gateway-native
 * selection set rolled out in #66. Every selected field must be populated
 * because codegen runs with `avoidOptionals: true` — missing keys are TS
 * errors at the cast site. The shape mirrors the one in
 * `@ttctl/core` `services/profile/basic/__tests__/index.test.ts`; updating
 * one without the other will surface as either a TS error here or a test
 * divergence — the duplication is deliberate to keep packages independent.
 */
const PROFILE: ProfileShowQuery = {
  viewer: {
    __typename: "Viewer",
    id: "v1",
    appliedAt: "2020-01-01T00:00:00+00:00",
    hasSearchSubscription: false,
    availabilityRequestTalentCardEnabled: true,
    coachingEligibility: "QUICK",
    referralUrl: {
      __typename: "ReferralUrl",
      legacySlug: "ada",
      pathSuffix: "/ada",
      shortenedUrl: "https://tpt.al/ada",
      url: "https://www.toptal.com/r/ada",
    },
    hireMeBanner: {
      __typename: "HireMeBanner",
      enabled: true,
      submitted: false,
      experimentVariant: "control",
      referralUrl: "https://www.toptal.com/r/ada",
      personalWebsiteUrl: "",
      verificationStatus: "IDLE",
      verifiedCount: 0,
    },
    codeOfConduct: {
      __typename: "CodeOfConduct",
      id: "coc-1",
      acceptedAt: "2024-01-01T00:00:00+00:00",
      title: "Code of Conduct",
      revisedOn: "2024-01-01",
    },
    termsOfService: {
      __typename: "TermsOfService",
      id: "tos-1",
      title: "Terms of Service",
      revisedOn: "2024-01-01",
      requiredAction: "NONE",
    },
    preliminarySearchSetting: { __typename: "PreliminarySearchSetting", enabled: false },
    viewerRole: {
      __typename: "ViewerRole",
      activatedAt: "2018-06-15T00:00:00+00:00",
      askExpertMenuVisible: true,
      blockedStatus: { __typename: "BlockedStatus", isBlocked: false },
      roleId: 12345,
      profileId: "p1",
      availability: "PART_TIME",
      allocatedHours: 40,
      hiredHours: 30,
      fullName: "Ada Lovelace",
      firstName: "Ada",
      phoneNumber: "+1 555 0001",
      email: "ada@example.com",
      toptalEmail: "ada@toptal.com",
      toptalEmailSuspended: false,
      sendNotificationsToPrivateEmail: false,
      specializationType: "CORE_WITH_MARKETPLACE",
      specializations: [
        {
          __typename: "TalentSpecialization",
          id: "sp1",
          slug: "core",
          title: "Core",
          deliveryModel: { __typename: "TalentEngagementDeliveryModel", id: "dm1", identifier: "CORE" },
        },
        {
          __typename: "TalentSpecialization",
          id: "sp2",
          slug: "marketplace-core",
          title: "Marketplace Core",
          deliveryModel: { __typename: "TalentEngagementDeliveryModel", id: "dm2", identifier: "MARKETPLACE" },
        },
      ],
      photo: { __typename: "Photo", large: "https://cdn/large.jpg", small: "https://cdn/small.jpg" },
      postActivationStepsStatus: "COMPLETED",
      publicResumeUrl: "https://www.toptal.com/resume/ada",
      timeZone: {
        __typename: "TimeZone",
        name: "(UTC+00:00) UTC",
        value: "Etc/UTC",
        location: "UTC",
        utcOffset: 0,
        stdOffset: 0,
      },
      hourlyRate: { __typename: "Money", verbose: "$110.00", decimal: "110.0" },
      isPassThroughTalent: false,
      isFakeSession: false,
      availableShiftRangeFrom: "08:00:00",
      availableShiftRangeTo: "20:00:00",
      workingTimeFrom: "09:00:00",
      workingTimeTo: "18:00:00",
      contactFields: {
        __typename: "ContactFields",
        communitySlackId: "U123",
        email: "ada@example.com",
        phoneNumber: "+1 555 0001",
        skype: null,
      },
      talentVerticals: [
        { __typename: "TalentVertical", isApiAllowed: true, name: "Engineering", roleId: 1, slug: "eng" },
      ],
      vertical: {
        __typename: "TalentVertical",
        name: "Engineering",
        slug: "eng",
        hasSingleSpecialization: false,
        isMarketplaceAccessEnabled: true,
        profileHandbookUrl: "https://www.toptal.com/handbook",
        minPortfolioItems: 0,
        marketCondition: { __typename: "VerticalMarketCondition", condition: "POOR" },
        globalMarketCondition: {
          __typename: "VerticalGlobalMarketCondition",
          condition: "POOR",
          conditionVerbose: "Poor",
          conditionColor: "WARNING",
          reportUrl: "",
        },
        talentJobApplicationConfig: {
          __typename: "TalentJobApplicationConfig",
          portfolioRequired: false,
          careerHighlightRequired: false,
          highlightFields: ["EMPLOYMENTS", "EXPERIENCE"],
        },
      },
      lastAllocatedHoursChangeRequest: {
        __typename: "AllocatedHoursChangeRequest",
        id: "ahcr-1",
        allocatedHours: 40,
        comment: "",
        reviewedManually: false,
        statusV2: { __typename: "AllocatedHoursChangeRequestStatus", value: "ACCEPTED", verbose: "Accepted" },
      },
      lastMobileAccess: {
        __typename: "MobileAccess",
        deviceType: "IOS",
        startedAt: "2025-01-01T00:00:00+00:00",
      },
      rateInsight: {
        __typename: "TalentRateInsight",
        hourly: {
          __typename: "TalentRateInsightForCommitment",
          currentRateCompetitive: true,
          recentApplicationRate: "108.0",
          recommendedRate: "115.0",
        },
      },
      operations: {
        __typename: "ViewerRoleOperations",
        createRateChangeRequest: { __typename: "Operation", callable: "ENABLED" },
        startSearchSubscription: { __typename: "Operation", callable: "DISABLED" },
        promoteGigs: { __typename: "ViewerRoleOperationsPromoteGigs", callable: "ENABLED" },
      },
      permissions: {
        __typename: "TalentPermissions",
        canApplyToJobs: true,
        canFillInAdvancedProfile: true,
        canHaveReferrals: true,
        canViewAskAnExpert: true,
        canViewCoachingRequests: true,
        canViewCommunity: true,
        canViewConsultations: true,
        canViewEligibleJobs: true,
        canViewPayments: true,
        canViewRateInsights: true,
        canViewRecognitionBadges: true,
        canViewRecommendedJobs: true,
        canViewSlackCommunity: true,
        canViewSpecializations: true,
      },
      profile: {
        __typename: "Profile",
        id: "p1",
        fullName: "Ada Lovelace",
        city: "London",
        photo: { __typename: "ProfilePhotoType", large: "https://cdn/p-large.jpg" },
        skillSets: {
          __typename: "ProfileSkillSetConnection",
          nodes: [
            {
              __typename: "ProfileSkillSet",
              id: "s1",
              experience: 12,
              rating: "EXPERT",
              public: true,
              skill: { __typename: "Skill", id: "sk1", name: "Analytical Engine" },
            },
            {
              __typename: "ProfileSkillSet",
              id: "s2",
              experience: 5,
              rating: "PROFICIENT",
              public: true,
              skill: { __typename: "Skill", id: "sk2", name: "Difference Engine" },
            },
            {
              __typename: "ProfileSkillSet",
              id: "s3",
              experience: 3,
              rating: "BEGINNER",
              public: false,
              skill: { __typename: "Skill", id: "sk3", name: "Mechanical Computing" },
            },
          ],
        },
      },
    },
  },
};

const PROFILE_NO_VIEWER: ProfileShowQuery = { viewer: null };

/**
 * Talent-profile-side `BasicInfo` projection (post-#127). Independent of
 * `ProfileShowQuery` because the two payloads target different surfaces;
 * the formatter merges them at render time.
 */
const BASIC_INFO_FULL: profile.basic.BasicInfo = {
  profileId: "p1",
  bio: "I built the Analytical Engine.\n\nLater, I wrote the first algorithm.",
  headline: "Mathematician & first programmer",
  languages: [
    { id: "lang1", name: "English" },
    { id: "lang2", name: "French" },
  ],
};

const BASIC_INFO_EMPTY: profile.basic.BasicInfo = {
  profileId: "p1",
  bio: null,
  headline: null,
  languages: [],
};

function payloadOf(
  profilePayload: ProfileShowQuery,
  basicInfo: profile.basic.BasicInfo | null = BASIC_INFO_FULL,
): BasicShowPayload {
  return { profile: profilePayload, basicInfo };
}

/**
 * Strip ANSI escape sequences (color codes) so test assertions can
 * measure the visible width of cli-table3 rows without worrying about
 * the surrounding control bytes. cli-table3 emits ANSI by default for
 * border colors; line-width assertions count visible characters only.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

describe("formatProfilePretty", () => {
  it("renders identity, narrative (bio/headline/languages), role metadata, and photo URL", () => {
    const out = formatProfilePretty(payloadOf(PROFILE));
    const lines = out.split("\n");

    expect(lines[0]).toBe("Ada Lovelace");
    expect(lines).toContain("  ada@example.com");
    expect(lines).toContain("  +1 555 0001");
    expect(lines).toContain("  London");
    expect(lines).toContain("  Headline: Mathematician & first programmer");
    expect(lines).toContain("  Bio:");
    expect(lines).toContain("    I built the Analytical Engine.");
    expect(lines).toContain("    Later, I wrote the first algorithm.");
    expect(lines).toContain("  Languages: English, French");
    expect(lines).toContain("  Vertical: Engineering");
    expect(lines).toContain("  Specializations: Core, Marketplace Core");
    expect(lines).toContain("  Availability: PART_TIME (30/40h)");
    expect(lines).toContain("  Rate: $110.00/hr");
    expect(lines).toContain("  TimeZone: Etc/UTC");
    expect(lines).toContain("  Skills: Analytical Engine, Difference Engine");
    expect(lines).toContain("  Photo: https://cdn/large.jpg");
  });

  it("preserves multi-paragraph bio breaks as actual blank lines (no `\\n\\n` literal escape leak)", () => {
    const out = formatProfilePretty(payloadOf(PROFILE));
    // The bio fixture has two paragraphs joined by "\n\n"; the rendered
    // form must include an empty line between the two paragraph bodies.
    expect(out).not.toContain("\\n\\n");
    expect(out).toContain("    I built the Analytical Engine.\n\n    Later, I wrote the first algorithm.");
  });

  it("does NOT include private (public=false) skills in the pretty summary", () => {
    const out = formatProfilePretty(payloadOf(PROFILE));
    expect(out).not.toContain("Mechanical Computing");
  });

  it("does NOT truncate long values to 80 columns (pretty is not table)", () => {
    const longSkill = "x".repeat(200);
    const wide: ProfileShowQuery = structuredClone(PROFILE);
    if (wide.viewer !== null) {
      wide.viewer.viewerRole.profile.skillSets.nodes = [
        {
          __typename: "ProfileSkillSet",
          id: "s1",
          experience: 1,
          rating: "EXPERT",
          public: true,
          skill: { __typename: "Skill", id: "sk1", name: longSkill },
        },
      ];
    }
    const out = formatProfilePretty(payloadOf(wide));
    const skillLine = out.split("\n").find((l) => l.includes("Skills:"));
    expect(skillLine).toBeDefined();
    expect(skillLine?.length).toBeGreaterThan(80);
    expect(skillLine).not.toContain("…");
  });

  it("omits the city line when the profile has no city set (empty string)", () => {
    const noCity: ProfileShowQuery = structuredClone(PROFILE);
    if (noCity.viewer !== null) noCity.viewer.viewerRole.profile.city = "";

    const out = formatProfilePretty(payloadOf(noCity));
    expect(out).not.toContain("\n  London");
  });

  it("omits the phone line when the role has no phoneNumber set (empty string)", () => {
    const noPhone: ProfileShowQuery = structuredClone(PROFILE);
    if (noPhone.viewer !== null) noPhone.viewer.viewerRole.phoneNumber = "";

    const out = formatProfilePretty(payloadOf(noPhone));
    expect(out).not.toContain("+1 555 0001");
  });

  it("omits the skills line when there are no public skills", () => {
    const noSkills: ProfileShowQuery = structuredClone(PROFILE);
    if (noSkills.viewer !== null) {
      noSkills.viewer.viewerRole.profile.skillSets.nodes = [];
    }

    const out = formatProfilePretty(payloadOf(noSkills));
    expect(out).not.toContain("Skills:");
  });

  it("renders a CTA-style `(unset — set with: …)` placeholder for empty bio", () => {
    const out = formatProfilePretty(payloadOf(PROFILE, BASIC_INFO_EMPTY));
    expect(out).toContain(`  Bio: (unset — set with: ttctl profile basic update --bio "<text>")`);
  });

  it("renders bare `(unset)` for empty headline and languages", () => {
    const out = formatProfilePretty(payloadOf(PROFILE, BASIC_INFO_EMPTY));
    expect(out).toContain("  Headline: (unset)");
    expect(out).toContain("  Languages: (unset)");
  });

  it("renders `(unset)` for bio/headline/languages when basicInfo is null (talent-profile call failed)", () => {
    const out = formatProfilePretty(payloadOf(PROFILE, null));
    expect(out).toContain(`  Bio: (unset — set with: ttctl profile basic update --bio "<text>")`);
    expect(out).toContain("  Headline: (unset)");
    expect(out).toContain("  Languages: (unset)");
  });

  it("wraps a >3-language list onto a sub-list (one entry per indented line)", () => {
    const manyLanguages: profile.basic.BasicInfo = {
      ...BASIC_INFO_FULL,
      languages: [
        { id: "1", name: "English" },
        { id: "2", name: "French" },
        { id: "3", name: "Italian" },
        { id: "4", name: "German" },
      ],
    };
    const out = formatProfilePretty(payloadOf(PROFILE, manyLanguages));
    expect(out).toContain("  Languages:\n    - English\n    - French\n    - Italian\n    - German");
  });

  it("renders `(unset)` for empty photo url", () => {
    const noPhoto: ProfileShowQuery = structuredClone(PROFILE);
    if (noPhoto.viewer !== null) noPhoto.viewer.viewerRole.photo.large = "";
    const out = formatProfilePretty(payloadOf(noPhoto));
    expect(out).toContain("  Photo: (unset)");
  });

  it("falls back to a placeholder line when the viewer is null", () => {
    const out = formatProfilePretty(payloadOf(PROFILE_NO_VIEWER, null));
    expect(out).toContain("(no viewer bound to this session)");
  });
});

describe("formatProfileTable", () => {
  it("renders a cli-table3 table containing every curated field including bio/headline/languages/photo", () => {
    const out = formatProfileTable(payloadOf(PROFILE), 120);
    // cli-table3 box-drawing characters confirm we're not seeing the prior tab-separated output
    expect(out).toMatch(/[┌┬┐├┼┤└┴┘─│]/);
    // Identity + role keys preserved
    expect(out).toContain("name");
    expect(out).toContain("email");
    expect(out).toContain("phone");
    expect(out).toContain("city");
    expect(out).toContain("vertical");
    expect(out).toContain("specializations");
    expect(out).toContain("availability");
    expect(out).toContain("allocated_hours");
    expect(out).toContain("hired_hours");
    expect(out).toContain("hours");
    expect(out).toContain("hourly_rate");
    expect(out).toContain("time_zone");
    expect(out).toContain("public_resume_url");
    expect(out).toContain("skills");
    // New keys post-#129
    expect(out).toContain("headline");
    expect(out).toContain("bio");
    expect(out).toContain("languages");
    expect(out).toContain("photo_url");
    // Values
    expect(out).toContain("Ada Lovelace");
    expect(out).toContain("ada@example.com");
    expect(out).toContain("+1 555 0001");
    expect(out).toContain("London");
    expect(out).toContain("Engineering");
    expect(out).toContain("PART_TIME");
    expect(out).toContain("30/40h");
    expect(out).toContain("$110.00");
    expect(out).toContain("Etc/UTC");
    expect(out).toContain("Mathematician & first programmer");
    expect(out).toContain("English, French");
  });

  it("respects the supplied terminal width (AC: respects terminal width)", () => {
    const wideOut = formatProfileTable(payloadOf(PROFILE), 200);
    const narrowOut = formatProfileTable(payloadOf(PROFILE), 60);
    const wideLines = wideOut.split("\n").map(stripAnsi);
    const narrowLines = narrowOut.split("\n").map(stripAnsi);

    const maxWide = Math.max(...wideLines.map((l) => l.length));
    const maxNarrow = Math.max(...narrowLines.map((l) => l.length));

    // Every line of the wide rendering fits within the wide terminal …
    expect(maxWide).toBeLessThanOrEqual(200);
    // … and the narrow rendering is materially narrower.
    expect(maxNarrow).toBeLessThan(maxWide);
  });

  it("wraps long values inside the table rather than overflowing the requested width", () => {
    const longSkill = "x".repeat(200);
    const wide: ProfileShowQuery = structuredClone(PROFILE);
    if (wide.viewer !== null) {
      wide.viewer.viewerRole.profile.skillSets.nodes = [
        {
          __typename: "ProfileSkillSet",
          id: "s1",
          experience: 1,
          rating: "EXPERT",
          public: true,
          skill: { __typename: "Skill", id: "sk1", name: longSkill },
        },
      ];
    }

    const out = formatProfileTable(payloadOf(wide), 80);
    for (const line of out.split("\n").map(stripAnsi)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("uses `(unset)` placeholder for empty city / bio / headline / languages / photo in table mode", () => {
    const noCity: ProfileShowQuery = structuredClone(PROFILE);
    if (noCity.viewer !== null) {
      noCity.viewer.viewerRole.profile.city = "";
      noCity.viewer.viewerRole.photo.large = "";
    }

    const out = formatProfileTable(payloadOf(noCity, BASIC_INFO_EMPTY), 120);
    // cli-table3 wordWrap may break a long string; count occurrences instead
    const unsetCount = (out.match(/\(unset\)/g) ?? []).length;
    expect(unsetCount).toBeGreaterThanOrEqual(5);
  });

  it("renders a single `name → (no viewer)` row when the viewer is null", () => {
    const out = formatProfileTable(payloadOf(PROFILE_NO_VIEWER, null), 80);
    expect(out).toContain("name");
    expect(out).toContain("(no viewer)");
    // Other curated keys MUST NOT appear in the no-viewer fallback.
    expect(out).not.toContain("email");
    expect(out).not.toContain("vertical");
  });

  it("floors the value column at 20 chars on very narrow terminals so the table stays readable", () => {
    // Terminal width 30 would otherwise compute valueWidth = 30 - 20 - 5 = 5,
    // which collapses values to a few characters per row. The floor of 20
    // keeps the table usable.
    const out = formatProfileTable(payloadOf(PROFILE), 30);
    const lines = out.split("\n").map(stripAnsi);
    const maxLine = Math.max(...lines.map((l) => l.length));
    // Total layout: fieldWidth 20 + valueWidth ≥ 20 + ~3 chars of borders ≈ ≥ 43.
    expect(maxLine).toBeGreaterThanOrEqual(40);
  });
});

describe("BasicShowPayload — JSON / YAML serialization", () => {
  it("preserves multi-paragraph bio as a proper JSON-encoded string (no double-escaped `\\\\n\\\\n`)", () => {
    const payload = payloadOf(PROFILE);
    const json = JSON.stringify(payload);
    // Round-trip integrity — the `\n\n` in the source bio survives as
    // a single-level JSON escape, not double-escaped to `\\n\\n`.
    const reparsed = JSON.parse(json) as BasicShowPayload;
    expect(reparsed.basicInfo?.bio).toBe("I built the Analytical Engine.\n\nLater, I wrote the first algorithm.");
    // No double-escape — the JSON output contains `\n` (backslash-n) once,
    // not `\\n` (backslash-backslash-n).
    expect(json).toContain("\\n\\n");
    expect(json).not.toContain("\\\\n\\\\n");
  });

  it("renders multi-paragraph bio as a YAML literal block scalar with paragraph breaks visible", () => {
    const payload = payloadOf(PROFILE);
    const yaml = formatYaml(payload);
    // YAML stringify uses `|` literal block scalar for multi-line strings;
    // paragraph breaks appear as actual blank lines, not `\n` escapes.
    expect(yaml).toContain("bio:");
    expect(yaml).not.toContain("\\n\\n");
    // The two paragraphs render on separate visible lines.
    expect(yaml).toContain("I built the Analytical Engine.");
    expect(yaml).toContain("Later, I wrote the first algorithm.");
  });
});
