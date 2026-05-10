// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `show` runs against mobile-gateway via `stockTransport` (no Cloudflare,
// no impersonation needed). `set` runs against talent-profile via
// `impersonatedTransport` (Cloudflare-protected). Mocks need to be split so a
// single `set()` call exercises BOTH (stock → impersonated chain).
vi.mock("../../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport.js")>("../../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
  };
});

import { ProfileError, getBasicInfo, set, show } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { Cf403Error, impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-abc-123";

interface MockResponse {
  status?: number;
  body: unknown;
}

function replyStock(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedStock.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

function replyImpersonated(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedImpersonated.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

/**
 * Minimal-but-complete fixture matching the rich `ProfileShowQuery` shape.
 * Every selected field is populated because codegen runs with
 * `avoidOptionals: true` — missing keys would be a TS error in the cast.
 */
const PROFILE_OK = {
  data: {
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
        email: "user@example.com",
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
          email: "user@example.com",
          phoneNumber: "+1 555 0001",
          skype: null as string | null,
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
            ],
          },
        },
      },
    },
  },
};

describe("show", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
  });

  it("targets the mobile-gateway surface with the ProfileShow operation", async () => {
    replyStock({ body: PROFILE_OK });

    await show(TOKEN);

    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).not.toHaveBeenCalled();
    const call = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("mobile-gateway");
    expect(call.body.operationName).toBe("ProfileShow");
    expect(call.body.query).toContain("query ProfileShow");
    expect(call.body.query).toContain("viewerRole");
    expect(call.body.query).toContain("profile");
    // Sanity: rich shape includes the talent-portal-grade fields the issue
    // calls for ("most rich and expanded" — see workitem #66).
    expect(call.body.query).toContain("specializations");
    expect(call.body.query).toContain("hourlyRate");
    expect(call.body.query).toContain("timeZone");
  });

  it("forwards the auth token via Authorization: Token token=... (authToken field)", async () => {
    replyStock({ body: PROFILE_OK });

    await show(TOKEN);

    const call = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    expect(call.authToken).toBe(TOKEN);
  });

  it("returns the typed `data` payload on a 200 response with viewer present", async () => {
    replyStock({ body: PROFILE_OK });

    const result = await show(TOKEN);

    expect(result.viewer?.id).toBe("v1");
    expect(result.viewer?.viewerRole.email).toBe("user@example.com");
    expect(result.viewer?.viewerRole.fullName).toBe("Ada Lovelace");
    expect(result.viewer?.viewerRole.profileId).toBe("p1");
    expect(result.viewer?.viewerRole.allocatedHours).toBe(40);
    expect(result.viewer?.viewerRole.availability).toBe("PART_TIME");
    expect(result.viewer?.viewerRole.hourlyRate.verbose).toBe("$110.00");
    expect(result.viewer?.viewerRole.timeZone.value).toBe("Etc/UTC");
    expect(result.viewer?.viewerRole.profile.city).toBe("London");
    expect(result.viewer?.viewerRole.profile.skillSets.nodes).toHaveLength(1);
    expect(result.viewer?.viewerRole.profile.skillSets.nodes[0]?.skill.name).toBe("Analytical Engine");
  });

  it("throws AuthRevokedError on HTTP 401 (#77 — uniform typed-error contract)", async () => {
    replyStock({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(show(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("wraps generic transport throws as ProfileError NETWORK_ERROR", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const promise = show(TOKEN);
    await expect(promise).rejects.toBeInstanceOf(ProfileError);
    await expect(promise).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("throws ProfileError GRAPHQL_ERROR when the response body has a non-empty `errors` array", async () => {
    replyStock({
      body: {
        errors: [{ message: "Schema field not found", extensions: { code: "VALIDATION" } }],
      },
    });

    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("Schema field not found"),
    });
  });

  it("routes errors[0].extensions.code='UNAUTHENTICATED' (talent-profile form) to AuthRevokedError (Toptal returns HTTP 200 + this code, not 401)", async () => {
    replyStock({
      status: 200,
      body: {
        errors: [
          {
            message: "Your credentials don't match an existing talent account in our system",
            extensions: { code: "UNAUTHENTICATED", login_url: "https://www.toptal.com/users/login" },
          },
        ],
      },
    });

    await expect(show(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("routes errors[0].extensions.code='AUTHENTICATION_REQUIRED' (gateway form) to AuthRevokedError", async () => {
    replyStock({
      status: 200,
      body: {
        errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_REQUIRED" } }],
      },
    });

    await expect(show(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  // Regression for issue #89 — empirical capture of an invalid bearer token
  // shows the federated `talent_schema` subgraph emits `'UNAUTHORIZED'` (with
  // a top-level `status: 403`) on the mobile-gateway surface, not the
  // documented `'AUTHENTICATION_REQUIRED'`. See
  // `research/notes/14-auth-error-extensions-code.md`.
  it("routes errors[0].extensions.code='UNAUTHORIZED' (mobile-gateway empirical, issue #89) to AuthRevokedError", async () => {
    replyStock({
      status: 200,
      body: {
        errors: [
          {
            message:
              "That account isn't in our system. Make sure you're using a valid email and try again, or contact support.",
            extensions: { code: "UNAUTHORIZED", status: 403, serviceName: "talent_schema" },
            status: 403,
          },
        ],
        data: null,
      },
    });

    await expect(show(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError NO_VIEWER when data.viewer is null on a 200 response", async () => {
    replyStock({ body: { data: { viewer: null } } });

    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NO_VIEWER",
    });
  });

  it("throws ProfileError UNKNOWN when the response has no data field", async () => {
    replyStock({ body: { data: null } });

    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNKNOWN",
    });
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx status codes (e.g., 500)", async () => {
    replyStock({ status: 500, body: "<html>internal server error</html>" });

    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNKNOWN",
      message: expect.stringContaining("500"),
    });
  });
});

const UPDATE_OK = {
  data: {
    updateBasicInfo: {
      success: true,
      notice: null as string | null,
      errors: [] as { message: string; field?: string | null }[],
      profile: {
        id: "p1",
        about: "new bio",
        quote: "new headline",
      },
    },
  },
};

describe("set", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
  });

  it("rejects calls with neither bio nor headline (CLI/contract guard)", async () => {
    await expect(set(TOKEN, {})).rejects.toMatchObject({
      name: "ProfileError",
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/at least one of/i),
    });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("fetches the profile (mobile-gateway/stock) first, then issues UpdateBasicInfo (talent-profile/impersonated)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    await set(TOKEN, { bio: "new bio" });

    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    const showCall = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(showCall.surface).toBe("mobile-gateway");
    expect(showCall.body.operationName).toBe("ProfileShow");
    expect(updateCall.surface).toBe("talent-profile");
    expect(updateCall.body.operationName).toBe("UPDATE_BASIC_INFO");
    expect(updateCall.body.query).toContain("mutation UPDATE_BASIC_INFO");
    expect(updateCall.body.query).toContain("updateBasicInfo(input: $input)");
  });

  it("forwards the auth token on both the read and write call", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    await set(TOKEN, { bio: "x" });

    const showCall = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(showCall.authToken).toBe(TOKEN);
    expect(updateCall.authToken).toBe(TOKEN);
  });

  it("maps `bio` -> `about` and `headline` -> `quote` in the mutation input", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    await set(TOKEN, { bio: "long-form bio text", headline: "short tagline" });

    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(updateCall.body.variables).toEqual({
      input: {
        profileId: "p1",
        profile: {
          about: "long-form bio text",
          quote: "short tagline",
        },
      },
    });
  });

  it("omits unset fields from the mutation input (partial updates)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    await set(TOKEN, { headline: "only headline" });

    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    expect(variables.input.profile).toEqual({ quote: "only headline" });
    expect(variables.input.profile).not.toHaveProperty("about");
  });

  it("preserves empty-string updates (clearing a field is a real intent, not an unset)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    await set(TOKEN, { bio: "" });

    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    expect(variables.input.profile).toEqual({ about: "" });
  });

  it("returns the updated bio/headline values from the server's confirmation payload", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    const result = await set(TOKEN, { bio: "new bio", headline: "new headline" });

    expect(result.profile.id).toBe("p1");
    expect(result.profile.about).toBe("new bio");
    expect(result.profile.quote).toBe("new headline");
  });

  it("normalizes a missing `notice` to null (callers can branch cleanly)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    const result = await set(TOKEN, { bio: "x" });
    expect(result.notice).toBeNull();
  });

  it("propagates Cf403Error from the write-side mutation call (talent-profile is Cloudflare-protected)", async () => {
    replyStock({ body: PROFILE_OK });
    mockedImpersonated.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(Cf403Error);
    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("throws ProfileError USER_ERROR when the mutation payload returns a non-empty errors array", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          updateBasicInfo: {
            success: false,
            notice: null,
            errors: [{ message: "About is too long", field: "about" }],
            profile: null,
          },
        },
      },
    });

    await expect(set(TOKEN, { bio: "x".repeat(10000) })).rejects.toMatchObject({
      name: "ProfileError",
      code: "USER_ERROR",
      message: expect.stringContaining("About is too long"),
    });
  });

  it("includes the field name in USER_ERROR messages when the server reports one", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          updateBasicInfo: {
            success: false,
            errors: [{ message: "is required", field: "quote" }],
            profile: null,
          },
        },
      },
    });

    await expect(set(TOKEN, { headline: "" })).rejects.toMatchObject({
      message: expect.stringContaining("(quote)"),
    });
  });

  it("throws ProfileError USER_ERROR when payload.success === false (no errors array)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          updateBasicInfo: {
            success: false,
            notice: "Something went wrong",
            errors: [],
            profile: null,
          },
        },
      },
    });

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Something went wrong"),
    });
  });

  it("throws AuthRevokedError on errors[0].extensions.code='UNAUTHENTICATED' from the mutation", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      status: 200,
      body: {
        errors: [
          {
            message: "Session expired",
            extensions: { code: "UNAUTHENTICATED" },
          },
        ],
      },
    });

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError on errors[0].extensions.code='AUTHENTICATION_REQUIRED' (gateway form) from the mutation", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      status: 200,
      body: {
        errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_REQUIRED" } }],
      },
    });

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  // Regression for issue #89 — see the matching read-side test for the
  // empirical-capture context.
  it("throws AuthRevokedError on errors[0].extensions.code='UNAUTHORIZED' (issue #89) from the mutation", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      status: 200,
      body: {
        errors: [
          {
            message:
              "That account isn't in our system. Make sure you're using a valid email and try again, or contact support.",
            extensions: { code: "UNAUTHORIZED", status: 403, serviceName: "talent_schema" },
            status: 403,
          },
        ],
        data: null,
      },
    });

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError GRAPHQL_ERROR on top-level errors (non-UNAUTHENTICATED)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        errors: [{ message: "Field 'updateBasicInfo' not defined", extensions: { code: "VALIDATION" } }],
      },
    });

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("not defined"),
    });
  });

  it("throws AuthRevokedError on HTTP 401 response from the mutation", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx (e.g., 500)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ status: 502, body: "<html>bad gateway</html>" });

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("502"),
    });
  });

  it("wraps generic transport throws (e.g., ECONNRESET) as ProfileError NETWORK_ERROR", async () => {
    replyStock({ body: PROFILE_OK });
    mockedImpersonated.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringContaining("ECONNRESET"),
    });
  });

  it("throws ProfileError UNKNOWN when the mutation response has no data.updateBasicInfo", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: { data: {} } });

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringMatching(/no `data\.updateBasicInfo`/),
    });
  });
});

// =======================================================================
// getBasicInfo: read-side companion to show() for talent_profile-only fields
// =======================================================================
//
// `getBasicInfo` follows the two-surface pattern of `photoShow` /
// `set` — it calls `show()` first against mobile-gateway (stockTransport)
// to resolve the profileId, then issues a `GET_BASIC_INFO` query against
// talent-profile (impersonatedTransport). Tests below mirror the chain
// expectations from the `set` block above and add the read-side response
// shape coverage that #127 introduces (bio/headline/languages mapping,
// node-array null-tolerance, USER_ERROR on missing profile).
// =======================================================================

const BASIC_INFO_OK = {
  data: {
    profile: {
      id: "p1",
      about: "Hi, I'm Ada — software engineer interested in analytical engines.",
      quote: "Build for clarity.",
      languages: {
        nodes: [
          { id: "lang-en", name: "English" },
          { id: "lang-fr", name: "French" },
        ],
      },
    },
  },
};

describe("getBasicInfo", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
  });

  it("calls show() (mobile-gateway/stock) first to resolve profileId, then GET_BASIC_INFO (talent-profile/impersonated)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_OK });

    await getBasicInfo(TOKEN);

    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    const showCall = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    const infoCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(showCall.surface).toBe("mobile-gateway");
    expect(showCall.body.operationName).toBe("ProfileShow");
    expect(infoCall.surface).toBe("talent-profile");
    expect(infoCall.body.operationName).toBe("GET_BASIC_INFO");
    expect(infoCall.body.query).toContain("query GET_BASIC_INFO");
    expect(infoCall.body.query).toContain("about");
    expect(infoCall.body.query).toContain("quote");
    expect(infoCall.body.query).toContain("languages");
  });

  it("forwards the auth token on both the read-side show() call and the GET_BASIC_INFO call", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_OK });

    await getBasicInfo(TOKEN);

    const showCall = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    const infoCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(showCall.authToken).toBe(TOKEN);
    expect(infoCall.authToken).toBe(TOKEN);
  });

  it("passes the resolved profileId from show() into the GET_BASIC_INFO variables", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_OK });

    await getBasicInfo(TOKEN);

    const infoCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(infoCall.body.variables).toEqual({ profileId: "p1" });
  });

  it("returns the typed BasicInfo projection on a populated 200 response", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_OK });

    const result = await getBasicInfo(TOKEN);

    expect(result.profileId).toBe("p1");
    expect(result.bio).toBe("Hi, I'm Ada — software engineer interested in analytical engines.");
    expect(result.headline).toBe("Build for clarity.");
    expect(result.languages).toEqual([
      { id: "lang-en", name: "English" },
      { id: "lang-fr", name: "French" },
    ]);
  });

  it("normalizes missing about/quote to null (user hasn't set the field)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            about: null,
            quote: null,
            languages: { nodes: [] },
          },
        },
      },
    });

    const result = await getBasicInfo(TOKEN);
    expect(result.bio).toBeNull();
    expect(result.headline).toBeNull();
    expect(result.languages).toEqual([]);
  });

  it("returns an empty languages array when the server omits the languages.nodes field entirely", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            about: "bio",
            quote: "headline",
            // languages omitted — server may not include the key at all.
          },
        },
      },
    });

    const result = await getBasicInfo(TOKEN);
    expect(result.languages).toEqual([]);
  });

  it("filters out malformed language nodes (null entries, missing id, missing name)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            about: "bio",
            quote: "headline",
            languages: {
              nodes: [
                null,
                { id: "lang-en", name: "English" },
                { id: "", name: "Empty id" },
                { id: "lang-fr" }, // missing name
                { id: "lang-de", name: "German" },
              ],
            },
          },
        },
      },
    });

    const result = await getBasicInfo(TOKEN);
    expect(result.languages).toEqual([
      { id: "lang-en", name: "English" },
      { id: "lang-de", name: "German" },
    ]);
  });

  it("falls back to the show()-resolved profileId when the talent-profile response omits it", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            // id omitted — fallback path
            about: "bio",
            quote: "headline",
            languages: { nodes: [] },
          },
        },
      },
    });

    const result = await getBasicInfo(TOKEN);
    expect(result.profileId).toBe("p1");
  });

  it("propagates Cf403Error from the talent-profile call (Cloudflare-protected surface)", async () => {
    replyStock({ body: PROFILE_OK });
    mockedImpersonated.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(getBasicInfo(TOKEN)).rejects.toBeInstanceOf(Cf403Error);
    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("throws AuthRevokedError on HTTP 401 from the talent-profile call", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(getBasicInfo(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError on errors[0].extensions.code='UNAUTHENTICATED' (talent-profile form)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      status: 200,
      body: {
        errors: [{ message: "Session expired", extensions: { code: "UNAUTHENTICATED" } }],
      },
    });

    await expect(getBasicInfo(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError GRAPHQL_ERROR on a non-auth-revoked errors array", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        errors: [{ message: "Field 'about' not defined", extensions: { code: "VALIDATION" } }],
      },
    });

    await expect(getBasicInfo(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("not defined"),
    });
  });

  it("throws ProfileError USER_ERROR when the server returns data.profile === null (id didn't resolve)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: { data: { profile: null } } });

    await expect(getBasicInfo(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "USER_ERROR",
      message: expect.stringContaining('"p1"'),
    });
  });

  it("throws ProfileError UNKNOWN when the response has no `data` field", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: { data: null } });

    await expect(getBasicInfo(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNKNOWN",
      message: expect.stringContaining("no `data`"),
    });
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx status (e.g., 500)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ status: 500, body: "<html>internal server error</html>" });

    await expect(getBasicInfo(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNKNOWN",
      message: expect.stringContaining("500"),
    });
  });

  it("wraps generic transport throws as ProfileError NETWORK_ERROR", async () => {
    replyStock({ body: PROFILE_OK });
    mockedImpersonated.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(getBasicInfo(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NETWORK_ERROR",
      message: expect.stringContaining("ECONNRESET"),
    });
  });

  it("propagates show() errors verbatim (read-side prerequisite failure)", async () => {
    // No viewer bound: show() raises NO_VIEWER, getBasicInfo never reaches the second call.
    replyStock({ body: { data: { viewer: null } } });

    await expect(getBasicInfo(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NO_VIEWER",
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });
});
