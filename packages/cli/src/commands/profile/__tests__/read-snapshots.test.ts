// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { ProfileShowQuery, profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import {
  buildEmptyProfile,
  buildFullProfile,
  buildSingleItemList,
} from "../../../../../core/src/__tests__/fixtures/profile/index.js";
import { wrapListEnvelope } from "../../../lib/envelopes.js";
import type { BasicShowPayload } from "../basic/show.js";

/**
 * Per-sub-domain JSON-shape snapshot tests for the 11 profile sub-domain
 * read commands (#152 AC § "At minimum, all 11 profile sub-domain
 * commands' read snapshots in place").
 *
 * Each test stringifies the envelope object via `JSON.stringify(env)` —
 * matching `formatResult`'s `json` branch verbatim — and snapshots the
 * resulting byte stream. Any change to a sub-domain's wire payload (an
 * added/renamed/reordered/typed-differently field) fails the snapshot,
 * forcing the contributor to either revert OR run `pnpm test -u` and
 * commit the diff (signaling a deliberate evolution; post-1.0 triggers
 * semver-major review).
 *
 * Sub-domain coverage (11/11 per AC):
 *
 * | Sub-domain      | Read shape                          |
 * |-----------------|-------------------------------------|
 * | basic           | `BasicShowPayload` (object — show)  |
 * | skills          | `{version, items: SkillSet[]}`      |
 * | portfolio       | `{version, items: PortfolioItem[]}` |
 * | employment      | `{version, items: Employment[]}`    |
 * | education       | `{version, items: Education[]}`     |
 * | certifications  | `{version, items: Certification[]}` |
 * | industries      | `{version, items: IndustryProfile[]}` |
 * | visas           | `{version, items: TravelVisa[]}`    |
 * | external        | `ProfileReadiness` (object)         |
 * | resume          | `UploadResumeResult` (object)       |
 * | reviews         | `{version, items: SectionReview[]}` |
 *
 * Fixture strategy:
 *
 * - List shapes use the `@ttctl/core` test fixture builders from
 *   `__tests__/fixtures/profile` (per #125). The empty / single-item /
 *   full variants exercise the three rendering edge cases the
 *   formatter audit (#124) flagged.
 * - Object shapes (basic show, external readiness, resume upload)
 *   inline minimal but realistic fixtures because the relevant fixture
 *   builders live in their respective per-package test files and
 *   re-exporting them as a shared utility is out of scope for #152.
 *
 * The fixtures import via relative path because `@ttctl/core` only
 * publishes `src/index.ts` exports; the test fixtures live under
 * `src/__tests__/fixtures/profile` outside the public API. Vitest's
 * relative-path resolution traverses package boundaries fine at test
 * time.
 */

// =======================================================================
// basic — show payload (object shape, NOT a list envelope)
// =======================================================================

describe("profile.basic — read snapshots", () => {
  /**
   * Minimal but realistic `ProfileShowQuery` — captures enough viewer /
   * viewerRole detail to lock the envelope's nested shape without
   * exhausting every optional field in the codegen-derived type. The
   * full-fidelity fixture in `basic/__tests__/show.test.ts` is used by
   * the formatter tests; this one is the snapshot anchor for the JSON
   * `--json` wire payload.
   */
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
              experience: 8,
              rating: "EXPERT",
              public: true,
              skill: { __typename: "Skill", id: "skill_cat_ts", name: "TypeScript" },
            },
          ],
        },
      },
    },
  };

  const BASIC_INFO_FULL: profile.basic.BasicInfo = {
    profileId: "p_test_001",
    bio: "Senior backend engineer.\n\n8 years of TypeScript + PostgreSQL.",
    headline: "Senior software engineer",
    languages: [
      { id: "lang_en", name: "English" },
      { id: "lang_es", name: "Spanish" },
    ],
    fullName: "Test User",
    legalName: "Test User",
    city: "San Francisco",
    placeIdentity: "ChIJ-place-sf",
    countryId: "country_us",
    citizenshipId: "country_us",
    phoneNumber: "+1 555 0100",
    twitter: "testuser",
    // #604 — social URLs + skype read-preserved by basic.set's merge.
    linkedin: "https://www.linkedin.com/in/testuser",
    github: "https://github.com/testuser",
    website: "https://testuser.example",
    behance: null,
    dribbble: null,
    skype: "testuser.skype",
    softwareSkills: [
      { id: "ss_typescript", name: "TypeScript" },
      { id: "ss_postgres", name: "PostgreSQL" },
    ],
  };

  const BASIC_INFO_EMPTY: profile.basic.BasicInfo = {
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

  it("show payload: full profile + full basic info", () => {
    const payload: BasicShowPayload = { profile: PROFILE, basicInfo: BASIC_INFO_FULL };
    expect(JSON.stringify(payload)).toMatchSnapshot();
  });

  it("show payload: full profile + empty basic info (null fields, empty languages)", () => {
    const payload: BasicShowPayload = { profile: PROFILE, basicInfo: BASIC_INFO_EMPTY };
    expect(JSON.stringify(payload)).toMatchSnapshot();
  });

  it("show payload: full profile + basicInfo: null (talent-profile call failed gracefully)", () => {
    const payload: BasicShowPayload = { profile: PROFILE, basicInfo: null };
    expect(JSON.stringify(payload)).toMatchSnapshot();
  });
});

// =======================================================================
// skills — list envelope
// =======================================================================

describe("profile.skills — read snapshots", () => {
  it("list envelope: empty (no skills)", () => {
    const env = wrapListEnvelope(buildEmptyProfile().skills);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single skill", () => {
    const env = wrapListEnvelope(buildSingleItemList("skills").skills);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: full profile (4 skills)", () => {
    const env = wrapListEnvelope(buildFullProfile().skills);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// portfolio — list envelope (paragraph-bearing)
// =======================================================================

describe("profile.portfolio — read snapshots", () => {
  it("list envelope: empty", () => {
    const env = wrapListEnvelope(buildEmptyProfile().portfolio);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single portfolio item", () => {
    const env = wrapListEnvelope(buildSingleItemList("portfolio").portfolio);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: full profile (3 portfolio items, paragraph-bearing)", () => {
    const env = wrapListEnvelope(buildFullProfile().portfolio);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// employment — list envelope (paragraph-bearing experienceItems)
// =======================================================================

describe("profile.employment — read snapshots", () => {
  it("list envelope: empty", () => {
    const env = wrapListEnvelope(buildEmptyProfile().employment);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single employment entry", () => {
    const env = wrapListEnvelope(buildSingleItemList("employment").employment);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: full profile (2 employment entries)", () => {
    const env = wrapListEnvelope(buildFullProfile().employment);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// education — list envelope
// =======================================================================

describe("profile.education — read snapshots", () => {
  it("list envelope: empty", () => {
    const env = wrapListEnvelope(buildEmptyProfile().education);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single education entry", () => {
    const env = wrapListEnvelope(buildSingleItemList("education").education);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: full profile (1 education entry)", () => {
    const env = wrapListEnvelope(buildFullProfile().education);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// certifications — list envelope
// =======================================================================

describe("profile.certifications — read snapshots", () => {
  it("list envelope: empty", () => {
    const env = wrapListEnvelope(buildEmptyProfile().certifications);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single certification", () => {
    const env = wrapListEnvelope(buildSingleItemList("certifications").certifications);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: full profile (2 certifications)", () => {
    const env = wrapListEnvelope(buildFullProfile().certifications);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// industries — list envelope
// =======================================================================

describe("profile.industries — read snapshots", () => {
  it("list envelope: empty", () => {
    const env = wrapListEnvelope(buildEmptyProfile().industries);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single industry", () => {
    const env = wrapListEnvelope(buildSingleItemList("industries").industries);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: full profile (2 industries)", () => {
    const env = wrapListEnvelope(buildFullProfile().industries);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// visas — list envelope
// =======================================================================

describe("profile.visas — read snapshots", () => {
  it("list envelope: empty", () => {
    const env = wrapListEnvelope(buildEmptyProfile().visas);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single visa", () => {
    const env = wrapListEnvelope(buildSingleItemList("visas").visas);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: full profile (1 visa)", () => {
    const env = wrapListEnvelope(buildFullProfile().visas);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// external — readiness payload (object shape, NOT a list envelope)
// =======================================================================

describe("profile.external.readiness — read snapshots", () => {
  const READINESS_READY: profile.external.ProfileReadiness = {
    isPhotoResolutionSatisfied: true,
    isBasicInfoSatisfied: true,
    isCertificationsSatisfied: true,
    isEmploymentsCountSatisfied: true,
    isEmploymentConnectionsSatisfied: true,
    isSkillValidationsSatisfied: true,
    isPortfolioItemsCountSatisfied: true,
    isPortfolioItemConnectionsSatisfied: true,
    isWorkingHoursSatisfied: true,
    submitAvailable: true,
    updatedByTalentAt: "2026-05-01T12:00:00Z",
  };

  const READINESS_PARTIAL: profile.external.ProfileReadiness = {
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

  const READINESS_UNKNOWN: profile.external.ProfileReadiness = {
    isPhotoResolutionSatisfied: null,
    isBasicInfoSatisfied: null,
    isCertificationsSatisfied: null,
    isEmploymentsCountSatisfied: null,
    isEmploymentConnectionsSatisfied: null,
    isSkillValidationsSatisfied: null,
    isPortfolioItemsCountSatisfied: null,
    isPortfolioItemConnectionsSatisfied: null,
    isWorkingHoursSatisfied: null,
    submitAvailable: null,
    updatedByTalentAt: null,
  };

  it("readiness payload: all sections satisfied (submit available)", () => {
    expect(JSON.stringify(READINESS_READY)).toMatchSnapshot();
  });

  it("readiness payload: partial (submitAvailable: false)", () => {
    expect(JSON.stringify(READINESS_PARTIAL)).toMatchSnapshot();
  });

  it("readiness payload: all signals null (server returned no profileReadiness)", () => {
    expect(JSON.stringify(READINESS_UNKNOWN)).toMatchSnapshot();
  });
});

// =======================================================================
// resume — UploadResumeResult (object shape, NOT a list envelope)
// =======================================================================

describe("profile.resume — read/write snapshots", () => {
  it("upload result: success: true", () => {
    const result: profile.resume.UploadResumeResult = { success: true };
    expect(JSON.stringify(result)).toMatchSnapshot();
  });

  it("cancel-upload result: success: true", () => {
    const result: profile.resume.CancelResumeUploadResult = { success: true };
    expect(JSON.stringify(result)).toMatchSnapshot();
  });
});

// =======================================================================
// reviews — list envelope (SectionReview[])
// =======================================================================

describe("profile.reviews — read snapshots", () => {
  const SECTION_REVIEW_PENDING: profile.reviews.SectionReview = {
    id: "review_test_001",
    section: "EDUCATION",
    requestedAt: "2026-05-01T14:30:00Z",
    items: [{ id: "item_test_001", itemId: "edu_test_001", requestedAt: "2026-05-01T14:30:00Z" }],
  };

  const SECTION_REVIEW_MULTI_ITEM: profile.reviews.SectionReview = {
    id: "review_test_002",
    section: "SKILLS",
    requestedAt: "2026-05-01T14:30:00Z",
    items: [
      { id: "item_test_010", itemId: "sk_test_001", requestedAt: "2026-05-01T14:30:00Z" },
      { id: "item_test_011", itemId: "sk_test_002", requestedAt: "2026-05-01T14:30:00Z" },
      { id: "item_test_012", itemId: "sk_test_003", requestedAt: null },
    ],
  };

  const SECTION_REVIEW_NULL_SECTION: profile.reviews.SectionReview = {
    id: "review_test_003",
    section: null,
    requestedAt: null,
    items: [],
  };

  it("list envelope: empty (no pending reviews)", () => {
    const env = wrapListEnvelope([] as profile.reviews.SectionReview[]);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single section review with one item", () => {
    const env = wrapListEnvelope([SECTION_REVIEW_PENDING]);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: multiple section reviews (multi-item + null-section fallback)", () => {
    const env = wrapListEnvelope([SECTION_REVIEW_PENDING, SECTION_REVIEW_MULTI_ITEM, SECTION_REVIEW_NULL_SECTION]);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});
