// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `getProfile` runs against mobile-gateway via `stockTransport` (no Cloudflare,
// no impersonation needed). `updateProfile` runs against talent-profile via
// `impersonatedTransport` (Cloudflare-protected). Mocks need to be split so a
// single `updateProfile()` call exercises BOTH (stock → impersonated chain).
vi.mock("../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../transport.js")>("../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
  };
});

import { getProfile, ProfileError, updateProfile } from "../profile.js";
import { Cf403Error, impersonatedTransport, stockTransport } from "../transport.js";
import type { TransportRequest, TransportResponse } from "../transport.js";

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

describe("getProfile", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
  });

  it("targets the mobile-gateway surface with the ProfileShow operation", async () => {
    replyStock({ body: PROFILE_OK });

    await getProfile(TOKEN);

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

    await getProfile(TOKEN);

    const call = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    expect(call.authToken).toBe(TOKEN);
  });

  it("returns the typed `data` payload on a 200 response with viewer present", async () => {
    replyStock({ body: PROFILE_OK });

    const result = await getProfile(TOKEN);

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

  it("throws ProfileError UNAUTHENTICATED on HTTP 401", async () => {
    replyStock({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNAUTHENTICATED",
      message: expect.stringContaining("ttctl auth signin"),
    });
  });

  it("wraps generic transport throws as ProfileError NETWORK_ERROR", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const promise = getProfile(TOKEN);
    await expect(promise).rejects.toBeInstanceOf(ProfileError);
    await expect(promise).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("throws ProfileError GRAPHQL_ERROR when the response body has a non-empty `errors` array", async () => {
    replyStock({
      body: {
        errors: [{ message: "Schema field not found", extensions: { code: "VALIDATION" } }],
      },
    });

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("Schema field not found"),
    });
  });

  it("routes errors[0].extensions.code='UNAUTHENTICATED' to ProfileError UNAUTHENTICATED (Toptal returns HTTP 200 + this code, not 401)", async () => {
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

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNAUTHENTICATED",
      message: expect.stringContaining("ttctl auth signin"),
    });
  });

  it("throws ProfileError NO_VIEWER when data.viewer is null on a 200 response", async () => {
    replyStock({ body: { data: { viewer: null } } });

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NO_VIEWER",
    });
  });

  it("throws ProfileError UNKNOWN when the response has no data field", async () => {
    replyStock({ body: { data: null } });

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNKNOWN",
    });
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx status codes (e.g., 500)", async () => {
    replyStock({ status: 500, body: "<html>internal server error</html>" });

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
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

describe("updateProfile", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
  });

  it("rejects calls with neither bio nor headline (CLI/contract guard)", async () => {
    await expect(updateProfile(TOKEN, {})).rejects.toMatchObject({
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

    await updateProfile(TOKEN, { bio: "new bio" });

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

    await updateProfile(TOKEN, { bio: "x" });

    const showCall = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(showCall.authToken).toBe(TOKEN);
    expect(updateCall.authToken).toBe(TOKEN);
  });

  it("maps `bio` -> `about` and `headline` -> `quote` in the mutation input", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    await updateProfile(TOKEN, { bio: "long-form bio text", headline: "short tagline" });

    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(updateCall.body.variables).toEqual({
      input: {
        profileId: "p1",
        basicInfo: {
          about: "long-form bio text",
          quote: "short tagline",
        },
      },
    });
  });

  it("omits unset fields from the mutation input (partial updates)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    await updateProfile(TOKEN, { headline: "only headline" });

    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { basicInfo: Record<string, unknown> } };
    expect(variables.input.basicInfo).toEqual({ quote: "only headline" });
    expect(variables.input.basicInfo).not.toHaveProperty("about");
  });

  it("preserves empty-string updates (clearing a field is a real intent, not an unset)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    await updateProfile(TOKEN, { bio: "" });

    const updateCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { basicInfo: Record<string, unknown> } };
    expect(variables.input.basicInfo).toEqual({ about: "" });
  });

  it("returns the updated bio/headline values from the server's confirmation payload", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    const result = await updateProfile(TOKEN, { bio: "new bio", headline: "new headline" });

    expect(result.profile.id).toBe("p1");
    expect(result.profile.about).toBe("new bio");
    expect(result.profile.quote).toBe("new headline");
  });

  it("normalizes a missing `notice` to null (callers can branch cleanly)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: UPDATE_OK });

    const result = await updateProfile(TOKEN, { bio: "x" });
    expect(result.notice).toBeNull();
  });

  it("propagates Cf403Error from the write-side mutation call (talent-profile is Cloudflare-protected)", async () => {
    replyStock({ body: PROFILE_OK });
    mockedImpersonated.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(Cf403Error);
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

    await expect(updateProfile(TOKEN, { bio: "x".repeat(10000) })).rejects.toMatchObject({
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

    await expect(updateProfile(TOKEN, { headline: "" })).rejects.toMatchObject({
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

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Something went wrong"),
    });
  });

  it("throws ProfileError UNAUTHENTICATED on errors[0].extensions.code='UNAUTHENTICATED' from the mutation", async () => {
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

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: expect.stringContaining("ttctl auth signin"),
    });
  });

  it("throws ProfileError GRAPHQL_ERROR on top-level errors (non-UNAUTHENTICATED)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        errors: [{ message: "Field UpdateBasicInfoInput.basicInfo not defined", extensions: { code: "VALIDATION" } }],
      },
    });

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("not defined"),
    });
  });

  it("throws ProfileError UNAUTHENTICATED on HTTP 401 response", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx (e.g., 500)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ status: 502, body: "<html>bad gateway</html>" });

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("502"),
    });
  });

  it("wraps generic transport throws (e.g., ECONNRESET) as ProfileError NETWORK_ERROR", async () => {
    replyStock({ body: PROFILE_OK });
    mockedImpersonated.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringContaining("ECONNRESET"),
    });
  });

  it("throws ProfileError UNKNOWN when the mutation response has no data.updateBasicInfo", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: { data: {} } });

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringMatching(/no `data\.updateBasicInfo`/),
    });
  });
});
