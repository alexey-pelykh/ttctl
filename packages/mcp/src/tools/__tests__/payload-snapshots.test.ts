// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { DryRunPreview, ProfileShowQuery, profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import {
  buildEmptyProfile,
  buildFullProfile,
  buildSingleItemList,
} from "../../../../core/src/__tests__/fixtures/profile/index.js";
import { domainErrorResponse, dryRunResponse, jsonResponse, unauthenticatedResponse } from "../_shared.js";

/**
 * JSON-shape snapshot tests for the MCP tool response payloads (#152).
 *
 * Every TTCtl MCP tool funnels its happy-path response through
 * `jsonResponse(payload)`, which stringifies the typed payload via
 * `JSON.stringify(payload, null, 2)` (2-space indent — matches the
 * MCP-SDK convention for LLM-readable content). The resulting `text`
 * field on the `CallToolResult` is the byte stream LLM clients consume
 * via `JSON.parse(result.content[0].text)`.
 *
 * These snapshots pin that byte stream so any change to a tool's
 * payload shape — added/renamed field, type change, restructure —
 * fails the snapshot, forcing intentional review.
 *
 * **CLI ↔ MCP drift (#152 § MCP coupling)**: The CLI's `--json` output
 * wraps list payloads in the v0.4 list envelope (`{version, items[]}`),
 * while the MCP tool currently emits the raw payload (skills array,
 * profile object, …). The snapshots capture this state on both sides —
 * a parity contract test is tracked separately (per #121 dependencies);
 * snapshot tests guard the JSON SHAPE stability per side, the parity
 * contract guards CROSS-SIDE equivalence.
 *
 * Sub-domain coverage (11/11 per AC):
 *
 * | Sub-domain      | MCP tool                                          | Wire payload                    |
 * |-----------------|---------------------------------------------------|---------------------------------|
 * | basic           | `ttctl_profile_basic_show`                        | `BasicShowPayload`              |
 * | skills          | `ttctl_profile_skills_list`                       | `ProfileSkillSet[]`             |
 * | portfolio       | (registered via `tools/profile/portfolio.ts`)     | `PortfolioItem[]`               |
 * | employment      | (registered via `tools/profile/employment.ts`)    | `Employment[]`                  |
 * | education       | (registered via `tools/profile/education.ts`)     | `Education[]`                   |
 * | certifications  | (registered via `tools/profile/certifications.ts`) | `Certification[]`              |
 * | industries      | (registered via `tools/profile/industries.ts`)    | `IndustryProfile[]`             |
 * | visas           | (registered via `tools/profile/visas.ts`)         | `TravelVisa[]`                  |
 * | external        | `ttctl_profile_external_readiness`                | `ProfileReadiness`              |
 * | resume          | (registered via `tools/profile/resume.ts`)        | `UploadResumeResult`            |
 * | reviews         | `ttctl_profile_reviews_list`                      | `SectionReview[]`               |
 *
 * Plus envelope shapes shared across every tool: dry-run preview and
 * domain-error responses.
 */

/**
 * Extract the JSON-string payload from an MCP tool response. The
 * response envelope is `{content: [{type: "text", text}]}` — the
 * snapshot anchor is `text` because the wrapper is fixed by the MCP
 * SDK and not part of TTCtl's contract.
 */
function extractText(response: ReturnType<typeof jsonResponse>): string {
  return response.content[0].text;
}

// =======================================================================
// basic — show payload (merged BasicShowPayload from mobile-gateway +
// talent-profile, matching the CLI's two-call shape; closed in #340)
// =======================================================================

describe("MCP profile_basic_show — payload snapshots", () => {
  const PROFILE: ProfileShowQuery = {
    viewer: {
      __typename: "Viewer",
      id: "v_test_001",
      appliedAt: "2020-01-15T00:00:00+00:00",
      hasSearchSubscription: false,
      availabilityRequestTalentCardEnabled: true,
      coachingEligibility: "QUICK",
      referralUrl: {
        __typename: "ReferralUrl",
        legacySlug: "test-user",
        pathSuffix: "/test-user",
        shortenedUrl: "https://tpt.al/test-user",
        url: "https://www.toptal.com/r/test-user",
      },
      hireMeBanner: {
        __typename: "HireMeBanner",
        enabled: true,
        submitted: false,
        experimentVariant: "control",
        referralUrl: "https://www.toptal.com/r/test-user",
        personalWebsiteUrl: "",
        verificationStatus: "IDLE",
        verifiedCount: 0,
      },
      codeOfConduct: {
        __typename: "CodeOfConduct",
        id: "coc_test_001",
        acceptedAt: "2024-01-01T00:00:00+00:00",
        title: "Code of Conduct",
        revisedOn: "2024-01-01",
      },
      termsOfService: {
        __typename: "TermsOfService",
        id: "tos_test_001",
        title: "Terms of Service",
        revisedOn: "2024-01-01",
        requiredAction: "NONE",
      },
      preliminarySearchSetting: { __typename: "PreliminarySearchSetting", enabled: false },
      viewerRole: {
        __typename: "ViewerRole",
        activatedAt: "2020-03-01T00:00:00+00:00",
        askExpertMenuVisible: true,
        blockedStatus: { __typename: "BlockedStatus", isBlocked: false },
        roleId: 99999,
        profileId: "p_test_001",
        availability: "FULL_TIME",
        allocatedHours: 40,
        hiredHours: 30,
        fullName: "Test User",
        firstName: "Test",
        phoneNumber: "+1 555 0100",
        email: "test@example.com",
        toptalEmail: "test@toptal.com",
        toptalEmailSuspended: false,
        sendNotificationsToPrivateEmail: false,
        specializationType: "CORE_WITH_MARKETPLACE",
        specializations: [
          {
            __typename: "TalentSpecialization",
            id: "sp_test_001",
            slug: "core",
            title: "Core",
            deliveryModel: { __typename: "TalentEngagementDeliveryModel", id: "dm_test_001", identifier: "CORE" },
          },
        ],
        photo: {
          __typename: "Photo",
          large: "https://example.com/photo-large.jpg",
          small: "https://example.com/photo-small.jpg",
        },
        postActivationStepsStatus: "COMPLETED",
        publicResumeUrl: "https://www.toptal.com/resume/test-user",
        timeZone: {
          __typename: "TimeZone",
          name: "(UTC+00:00) UTC",
          value: "Etc/UTC",
        },
        location: {
          __typename: "Location",
          city: "San Francisco",
          regionId: "us-ca",
          regionName: "California",
          countryName: "United States",
          countryCode: "US",
        },
        canBeFinanciallyVerified: true,
        showFinancialVerification: false,
        memberSince: "2020-03-01",
        seniorityLevel: "SENIOR",
        profile: {
          __typename: "Profile",
          id: "p_test_001",
          highlightedSkillSets: [
            {
              __typename: "ProfileSkillSet",
              id: "sk_test_001",
              experience: 96,
              rating: "EXPERT",
              public: true,
              skill: { __typename: "Skill", id: "skill_cat_ts", name: "TypeScript" },
            },
          ],
        },
      },
    },
  };

  const BASIC_INFO: profile.basic.BasicInfo = {
    profileId: "p_test_001",
    bio: "Senior engineer focused on developer experience.\n\nBuilt CLIs for three different startups.",
    headline: "Reliable systems, calm rollouts.",
    languages: [
      { id: "lang_en", name: "English" },
      { id: "lang_uk", name: "Ukrainian" },
    ],
    fullName: "Test User",
    legalName: "Test User",
    city: "Kyiv",
    placeIdentity: "ChIJ-place-kyiv",
    countryId: "country_ua",
    citizenshipId: "country_ua",
    phoneNumber: "+380 50 000 0000",
    twitter: "testuser",
    // #604 — social URLs + skype read-preserved by basic.set's merge.
    linkedin: "https://www.linkedin.com/in/testuser",
    github: "https://github.com/testuser",
    website: "https://testuser.example",
    behance: null,
    dribbble: null,
    skype: "testuser.skype",
    softwareSkills: [{ id: "ss_typescript", name: "TypeScript" }],
  };

  it("payload: full BasicShowPayload (profile + basicInfo with bio/headline/languages)", () => {
    expect(extractText(jsonResponse({ profile: PROFILE, basicInfo: BASIC_INFO }))).toMatchSnapshot();
  });

  it("payload: BasicShowPayload with null bio and headline, empty languages", () => {
    const emptyBasicInfo: profile.basic.BasicInfo = {
      profileId: "p_test_001",
      bio: null,
      headline: null,
      languages: [],
      fullName: null,
      legalName: null,
      city: null,
      placeIdentity: null,
      countryId: null,
      citizenshipId: null,
      phoneNumber: null,
      twitter: null,
      linkedin: null,
      github: null,
      website: null,
      behance: null,
      dribbble: null,
      skype: null,
      softwareSkills: [],
    };
    expect(extractText(jsonResponse({ profile: PROFILE, basicInfo: emptyBasicInfo }))).toMatchSnapshot();
  });

  it("payload: BasicShowPayload with basicInfo: null (secondary call failed non-fatally)", () => {
    expect(extractText(jsonResponse({ profile: PROFILE, basicInfo: null }))).toMatchSnapshot();
  });
});

// =======================================================================
// skills — ProfileSkillSet[] (raw array, NO list envelope wrapper)
// =======================================================================

describe("MCP profile_skills_list — payload snapshots", () => {
  it("payload: empty array (no skills)", () => {
    expect(extractText(jsonResponse(buildEmptyProfile().skills))).toMatchSnapshot();
  });

  it("payload: single skill", () => {
    expect(extractText(jsonResponse(buildSingleItemList("skills").skills))).toMatchSnapshot();
  });

  it("payload: full profile skills (4 skills)", () => {
    expect(extractText(jsonResponse(buildFullProfile().skills))).toMatchSnapshot();
  });
});

// =======================================================================
// portfolio — PortfolioItem[]
// =======================================================================

describe("MCP profile_portfolio — payload snapshots", () => {
  it("payload: empty array", () => {
    expect(extractText(jsonResponse(buildEmptyProfile().portfolio))).toMatchSnapshot();
  });

  it("payload: single portfolio item", () => {
    expect(extractText(jsonResponse(buildSingleItemList("portfolio").portfolio))).toMatchSnapshot();
  });

  it("payload: full profile portfolio (3 items, paragraph-bearing)", () => {
    expect(extractText(jsonResponse(buildFullProfile().portfolio))).toMatchSnapshot();
  });
});

// =======================================================================
// employment — Employment[]
// =======================================================================

describe("MCP profile_employment — payload snapshots", () => {
  it("payload: empty array", () => {
    expect(extractText(jsonResponse(buildEmptyProfile().employment))).toMatchSnapshot();
  });

  it("payload: full profile employment (2 entries)", () => {
    expect(extractText(jsonResponse(buildFullProfile().employment))).toMatchSnapshot();
  });
});

// =======================================================================
// education — Education[]
// =======================================================================

describe("MCP profile_education — payload snapshots", () => {
  it("payload: empty array", () => {
    expect(extractText(jsonResponse(buildEmptyProfile().education))).toMatchSnapshot();
  });

  it("payload: full profile education (1 entry)", () => {
    expect(extractText(jsonResponse(buildFullProfile().education))).toMatchSnapshot();
  });
});

// =======================================================================
// certifications — Certification[]
// =======================================================================

describe("MCP profile_certifications — payload snapshots", () => {
  it("payload: empty array", () => {
    expect(extractText(jsonResponse(buildEmptyProfile().certifications))).toMatchSnapshot();
  });

  it("payload: full profile certifications (2)", () => {
    expect(extractText(jsonResponse(buildFullProfile().certifications))).toMatchSnapshot();
  });
});

// =======================================================================
// industries — IndustryProfile[]
// =======================================================================

describe("MCP profile_industries — payload snapshots", () => {
  it("payload: empty array", () => {
    expect(extractText(jsonResponse(buildEmptyProfile().industries))).toMatchSnapshot();
  });

  it("payload: full profile industries (2)", () => {
    expect(extractText(jsonResponse(buildFullProfile().industries))).toMatchSnapshot();
  });
});

// =======================================================================
// visas — TravelVisa[]
// =======================================================================

describe("MCP profile_visas — payload snapshots", () => {
  it("payload: empty array", () => {
    expect(extractText(jsonResponse(buildEmptyProfile().visas))).toMatchSnapshot();
  });

  it("payload: full profile visas (1)", () => {
    expect(extractText(jsonResponse(buildFullProfile().visas))).toMatchSnapshot();
  });
});

// =======================================================================
// external — ProfileReadiness
// =======================================================================

describe("MCP profile_external_readiness — payload snapshots", () => {
  const READINESS: profile.external.ProfileReadiness = {
    isPhotoResolutionSatisfied: true,
    isBasicInfoSatisfied: true,
    isCertificationsSatisfied: false,
    isEmploymentsCountSatisfied: true,
    isEmploymentConnectionsSatisfied: false,
    isSkillValidationsSatisfied: true,
    isPortfolioItemsCountSatisfied: true,
    isPortfolioItemConnectionsSatisfied: false,
    isWorkingHoursSatisfied: true,
    submitAvailable: false,
    updatedByTalentAt: "2026-05-01T12:00:00Z",
  };

  it("payload: ProfileReadiness (partial — submitAvailable: false)", () => {
    expect(extractText(jsonResponse(READINESS))).toMatchSnapshot();
  });
});

// =======================================================================
// resume — UploadResumeResult
// =======================================================================

describe("MCP profile_resume — payload snapshots", () => {
  it("upload payload: success: true", () => {
    const result: profile.resume.UploadResumeResult = { success: true };
    expect(extractText(jsonResponse(result))).toMatchSnapshot();
  });

  it("cancel-upload payload: success: true", () => {
    const result: profile.resume.CancelResumeUploadResult = { success: true };
    expect(extractText(jsonResponse(result))).toMatchSnapshot();
  });
});

// =======================================================================
// reviews — SectionReview[]
// =======================================================================

describe("MCP profile_reviews_list — payload snapshots", () => {
  const SECTION_REVIEW: profile.reviews.SectionReview = {
    id: "review_test_001",
    section: "EDUCATION",
    requestedAt: "2026-05-01T14:30:00Z",
    items: [{ id: "item_test_001", itemId: "edu_test_001", requestedAt: "2026-05-01T14:30:00Z" }],
  };

  it("payload: empty array", () => {
    expect(extractText(jsonResponse([] as profile.reviews.SectionReview[]))).toMatchSnapshot();
  });

  it("payload: single SectionReview", () => {
    expect(extractText(jsonResponse([SECTION_REVIEW]))).toMatchSnapshot();
  });
});

// =======================================================================
// Cross-cutting envelopes (#165 dry-run, all-tool error responses)
// =======================================================================

describe("MCP shared envelopes — payload snapshots", () => {
  const PREVIEW: DryRunPreview = {
    operationName: "getSkillSetsWithConnectionsWithConnectionsCount",
    surface: "mobile-gateway",
    transport: "stock",
    endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
    variables: { profileId: "<resolved-at-apply-time>" },
    headers: {
      authorization: "Token token=<redacted>",
      "content-type": "application/json",
    },
  };

  it("dry-run response: single-preview envelope", () => {
    expect(extractText(dryRunResponse(PREVIEW))).toMatchSnapshot();
  });

  it("domain-error response: ProfileError-shaped", () => {
    const errResp = domainErrorResponse("ttctl_profile_skills_list", {
      code: "NO_VIEWER",
      message: "No profile id bound to this session.",
    });
    expect(errResp.content[0].text).toMatchSnapshot();
  });

  it("unauthenticated response: no-token error", () => {
    const errResp = unauthenticatedResponse("ttctl_profile_basic_show");
    expect(errResp.content[0].text).toMatchSnapshot();
  });
});
