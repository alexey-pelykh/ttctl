// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `show` runs against mobile-gateway via `stockTransport` (no Cloudflare,
// no impersonation needed). `set` runs against talent-profile via
// `impersonatedTransport` (Cloudflare-protected). Mocks need to be split so a
// single `set()` call exercises BOTH (stock → impersonated chain).
vi.mock("../../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport/index.js")>(
    "../../../../transport/index.js",
  );
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
  };
});

import { ProfileError, getBasicInfo, normalizeTwitterHandle, set, show } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { Cf403Error, impersonatedTransport, stockTransport } from "../../../../transport/index.js";
import type { TransportRequest, TransportResponse } from "../../../../transport/index.js";

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
      errors: [] as { code?: string | null; key?: string | null; message: string }[],
      profile: {
        id: "p1",
        about: "new bio",
        quote: "new headline",
        twitter: "current_handle",
      },
    },
  },
};

/**
 * Current-profile read used by `set()`'s read-merge path (#393). The
 * apply-path calls {@link getBasicInfo} BEFORE the mutation so the input
 * carries every server-required non-null field; this fixture is the
 * canonical "current state" returned by the GET_BASIC_INFO call so the
 * merged input has full coverage.
 */
const BASIC_INFO_CURRENT = {
  data: {
    profile: {
      id: "p1",
      about: "current bio",
      quote: "current headline",
      fullName: "Ada Lovelace",
      legalName: "Augusta Ada King-Noel",
      city: "London",
      placeIdentity: "ChIJ-place-london",
      phoneNumber: "+44 20 0000 0000",
      twitter: "current_handle",
      linkedin: "https://www.linkedin.com/in/ada",
      github: "https://github.com/ada",
      website: "https://ada.example",
      behance: "https://www.behance.net/ada",
      dribbble: "https://dribbble.com/ada",
      skype: "ada.lovelace",
      country: { id: "country_uk" },
      citizenship: { id: "country_uk" },
      languages: {
        nodes: [
          { id: "lang_en", name: "English" },
          { id: "lang_fr", name: "French" },
        ],
      },
      softwareSkills: {
        nodes: [{ id: "ss_assembly", name: "Assembly" }],
      },
    },
  },
};

describe("set", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
  });

  it("rejects calls with neither bio, headline, nor twitter (CLI/contract guard)", async () => {
    await expect(set(TOKEN, {})).rejects.toMatchObject({
      name: "ProfileError",
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/at least one of/i),
    });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("read-merge chain: ProfileShow (stock) → GET_BASIC_INFO (impersonated) → UPDATE_BASIC_INFO (impersonated)", async () => {
    // #393 — the apply path now reads current state via getBasicInfo()
    // before submitting the mutation, so the wire chain is one stock
    // call + two impersonated calls. Order matters: ProfileShow first
    // (resolves profileId), THEN GET_BASIC_INFO (full state for merge),
    // THEN UPDATE_BASIC_INFO.
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { bio: "new bio" });

    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
    const showCall = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    const readCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(showCall.surface).toBe("mobile-gateway");
    expect(showCall.body.operationName).toBe("ProfileShow");
    expect(readCall.surface).toBe("talent-profile");
    expect(readCall.body.operationName).toBe("GET_BASIC_INFO");
    expect(updateCall.surface).toBe("talent-profile");
    expect(updateCall.body.operationName).toBe("UPDATE_BASIC_INFO");
    expect(updateCall.body.query).toContain("mutation UPDATE_BASIC_INFO");
    expect(updateCall.body.query).toContain("updateBasicInfo(input: $input)");
  });

  it("forwards the auth token on all three calls (ProfileShow, GET_BASIC_INFO, UPDATE_BASIC_INFO)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { bio: "x" });

    const showCall = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    const readCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(showCall.authToken).toBe(TOKEN);
    expect(readCall.authToken).toBe(TOKEN);
    expect(updateCall.authToken).toBe(TOKEN);
  });

  it("merges user-supplied fields over current state — bio→about, headline→quote take precedence", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { bio: "long-form bio text", headline: "short tagline" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.variables).toEqual({
      input: {
        profileId: "p1",
        profile: {
          // Overridden by user input
          about: "long-form bio text",
          quote: "short tagline",
          // Preserved from the BASIC_INFO_CURRENT read snapshot
          fullName: "Ada Lovelace",
          legalName: "Augusta Ada King-Noel",
          city: "London",
          placeIdentity: "ChIJ-place-london",
          countryId: "country_uk",
          citizenshipId: "country_uk",
          phoneNumber: "+44 20 0000 0000",
          twitter: "current_handle",
          // #604 — social URLs + skype preserved from current state
          linkedin: "https://www.linkedin.com/in/ada",
          github: "https://github.com/ada",
          website: "https://ada.example",
          behance: "https://www.behance.net/ada",
          dribbble: "https://dribbble.com/ada",
          skype: "ada.lovelace",
          languageIds: ["lang_en", "lang_fr"],
          softwareSkills: [{ id: "ss_assembly", name: "Assembly" }],
        },
      },
    });
  });

  it("preserves all server-required fields from current state when user only updates headline (#393 regression)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { headline: "only headline" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    // #393 — the omitted bio MUST come from current state, NOT be null /
    // absent. This was the bug: pre-#393, `set({headline})` sent
    // `profile: {quote: <new>}` only, server rejected on null-on-required-
    // field errors. Post-#393 the full profile shape is preserved.
    expect(variables.input.profile["about"]).toBe("current bio");
    expect(variables.input.profile["quote"]).toBe("only headline");
    expect(variables.input.profile["fullName"]).toBe("Ada Lovelace");
    expect(variables.input.profile["countryId"]).toBe("country_uk");
    expect(variables.input.profile["citizenshipId"]).toBe("country_uk");
    expect(variables.input.profile["phoneNumber"]).toBe("+44 20 0000 0000");
    // Twitter is part of the basic-owned merge (#535) — preserved from current state.
    expect(variables.input.profile["twitter"]).toBe("current_handle");
    expect(variables.input.profile["languageIds"]).toEqual(["lang_en", "lang_fr"]);
    expect(variables.input.profile["softwareSkills"]).toEqual([{ id: "ss_assembly", name: "Assembly" }]);
  });

  it("preserves social URLs + skype from current state on a headline-only edit (#604 regression)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { headline: "only headline" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    // #604 — UPDATE_BASIC_INFO is a full-replacement contract: any field
    // omitted from the input is NULLED server-side. Pre-#604 these six were
    // absent from the merge, so every bio/headline edit silently wiped the
    // user's social links. The merge must echo the current value back.
    expect(variables.input.profile["linkedin"]).toBe("https://www.linkedin.com/in/ada");
    expect(variables.input.profile["github"]).toBe("https://github.com/ada");
    expect(variables.input.profile["website"]).toBe("https://ada.example");
    expect(variables.input.profile["behance"]).toBe("https://www.behance.net/ada");
    expect(variables.input.profile["dribbble"]).toBe("https://dribbble.com/ada");
    expect(variables.input.profile["skype"]).toBe("ada.lovelace");
    // The user cannot SET these via basic.set — write ownership stays with
    // external.update (#526). The merge only preserves; it never overrides.
  });

  it("preserves empty-string updates (clearing a field is a real intent, not an unset)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { bio: "" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    // Empty-string is a real intent → server-side `about` is cleared.
    expect(variables.input.profile["about"]).toBe("");
    // Other fields still preserved from current state.
    expect(variables.input.profile["quote"]).toBe("current headline");
  });

  it("forwards null current-state fields as null in the merge (server accepts null when current is null)", async () => {
    // If a field was never set on the current profile (e.g. phoneNumber
    // is null in current state), the merge passes null through to the
    // server. The wire-error from #393 only fires when REQUIRED fields
    // come through as null — fields that are nullable on the server side
    // get null verbatim from the read-merge contract.
    const sparseCurrent = structuredClone(BASIC_INFO_CURRENT);
    sparseCurrent.data.profile.phoneNumber = null as unknown as string;
    sparseCurrent.data.profile.legalName = null as unknown as string;
    // Twitter is nullable on the server side — when current is null, the
    // merge passes null through verbatim (no twitter override from caller).
    sparseCurrent.data.profile.twitter = null as unknown as string;
    // #604 — social URLs + skype the user never set must stay null, not be
    // fabricated. The merge echoes whatever `getBasicInfo` read (here null).
    sparseCurrent.data.profile.linkedin = null as unknown as string;
    sparseCurrent.data.profile.github = null as unknown as string;
    sparseCurrent.data.profile.website = null as unknown as string;
    sparseCurrent.data.profile.behance = null as unknown as string;
    sparseCurrent.data.profile.dribbble = null as unknown as string;
    sparseCurrent.data.profile.skype = null as unknown as string;

    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: sparseCurrent }, { body: UPDATE_OK });

    await set(TOKEN, { bio: "x" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    expect(variables.input.profile["phoneNumber"]).toBeNull();
    expect(variables.input.profile["legalName"]).toBeNull();
    expect(variables.input.profile["twitter"]).toBeNull();
    expect(variables.input.profile["linkedin"]).toBeNull();
    expect(variables.input.profile["github"]).toBeNull();
    expect(variables.input.profile["website"]).toBeNull();
    expect(variables.input.profile["behance"]).toBeNull();
    expect(variables.input.profile["dribbble"]).toBeNull();
    expect(variables.input.profile["skype"]).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Twitter merge / pass-through coverage (#535)
  // ---------------------------------------------------------------------

  it("accepts a twitter-only update (twitter is a first-class basic-owned field per #535)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    // Neither bio nor headline supplied — twitter alone is sufficient.
    const outcome = await set(TOKEN, { twitter: "new_handle" });

    expect(outcome.kind).toBe("applied");
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    // User intent wins on twitter; bio/headline preserved from current state.
    expect(variables.input.profile["twitter"]).toBe("new_handle");
    expect(variables.input.profile["about"]).toBe("current bio");
    expect(variables.input.profile["quote"]).toBe("current headline");
  });

  it("passes empty-string twitter as the explicit clear intent", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { twitter: "" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    // Empty string is a real intent (per ProfileUpdate contract), distinct
    // from undefined ("leave alone"). Send `""` over the wire.
    expect(variables.input.profile["twitter"]).toBe("");
  });

  it("passes null twitter as the explicit clear intent (alternative to empty string)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { twitter: null });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    // Per ProfileUpdate.twitter's `string | null` typing, null is also a
    // valid "clear it" intent — the wire schema accepts both shapes.
    expect(variables.input.profile["twitter"]).toBeNull();
  });

  it("normalizes a twitter URL to the bare handle before sending (#526 regression)", async () => {
    // #526 ROOT CAUSE: callers naturally pass a URL; pre-#526 set() forwarded
    // it verbatim, so the server stored a URL where a bare handle was
    // expected and the field rendered broken. The merge MUST send the bare
    // handle the live wire shape stores.
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { twitter: "https://x.com/alexey_pelykh" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    expect(variables.input.profile["twitter"]).toBe("alexey_pelykh");
  });

  it("normalizes a leading-@ twitter handle to the bare handle before sending", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    await set(TOKEN, { twitter: "@alexey_pelykh" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { profile: Record<string, unknown> } };
    expect(variables.input.profile["twitter"]).toBe("alexey_pelykh");
  });

  it("returns the updated bio/headline/twitter values from the server's confirmation payload", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    const outcome = await set(TOKEN, { bio: "new bio", headline: "new headline" });

    // Apply-path returns `{ kind: "applied", result }` — the discriminator
    // narrows the union for downstream property access.
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return; // unreachable; kept for type narrowing
    expect(outcome.result.profile.id).toBe("p1");
    expect(outcome.result.profile.about).toBe("new bio");
    expect(outcome.result.profile.quote).toBe("new headline");
    // Twitter is echoed from the response selection set per #535.
    expect(outcome.result.profile.twitter).toBe("current_handle");
  });

  it("normalizes a missing `notice` to null (callers can branch cleanly)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    const outcome = await set(TOKEN, { bio: "x" });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return; // unreachable; kept for type narrowing
    expect(outcome.result.notice).toBeNull();
  });

  it("propagates Cf403Error from the write-side mutation call (talent-profile is Cloudflare-protected)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT });
    mockedImpersonated.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(Cf403Error);
    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
  });

  it("propagates Cf403Error from the read-merge call (early-exit before write)", async () => {
    // #393: the read-merge call can fail too — Cf403 there short-circuits
    // BEFORE the write attempt fires, so the write is never called.
    replyStock({ body: PROFILE_OK });
    mockedImpersonated.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(Cf403Error);
    expect(mockedStock).toHaveBeenCalledTimes(1);
    // Only the read attempt fired — write never started.
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("throws ProfileError USER_ERROR when the mutation payload returns a non-empty errors array", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated(
      { body: BASIC_INFO_CURRENT },
      {
        body: {
          data: {
            updateBasicInfo: {
              success: false,
              notice: null,
              errors: [{ message: "About is too long", key: "about" }],
              profile: null,
            },
          },
        },
      },
    );

    await expect(set(TOKEN, { bio: "x".repeat(10000) })).rejects.toMatchObject({
      name: "ProfileError",
      code: "USER_ERROR",
      message: expect.stringContaining("About is too long"),
    });
  });

  it("includes the field name in USER_ERROR messages when the server reports one", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated(
      { body: BASIC_INFO_CURRENT },
      {
        body: {
          data: {
            updateBasicInfo: {
              success: false,
              errors: [{ message: "is required", key: "quote" }],
              profile: null,
            },
          },
        },
      },
    );

    await expect(set(TOKEN, { headline: "" })).rejects.toMatchObject({
      message: expect.stringContaining("(quote)"),
    });
  });

  it("throws ProfileError USER_ERROR when payload.success === false (no errors array)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated(
      { body: BASIC_INFO_CURRENT },
      {
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
      },
    );

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Something went wrong"),
    });
  });

  it("throws AuthRevokedError on errors[0].extensions.code='UNAUTHENTICATED' from the mutation", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated(
      { body: BASIC_INFO_CURRENT },
      {
        status: 200,
        body: {
          errors: [
            {
              message: "Session expired",
              extensions: { code: "UNAUTHENTICATED" },
            },
          ],
        },
      },
    );

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError on errors[0].extensions.code='AUTHENTICATION_REQUIRED' (gateway form) from the mutation", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated(
      { body: BASIC_INFO_CURRENT },
      {
        status: 200,
        body: {
          errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_REQUIRED" } }],
        },
      },
    );

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  // Regression for issue #89 — see the matching read-side test for the
  // empirical-capture context.
  it("throws AuthRevokedError on errors[0].extensions.code='UNAUTHORIZED' (issue #89) from the mutation", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated(
      { body: BASIC_INFO_CURRENT },
      {
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
      },
    );

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError GRAPHQL_ERROR on top-level errors (non-UNAUTHENTICATED)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated(
      { body: BASIC_INFO_CURRENT },
      {
        body: {
          errors: [{ message: "Field 'updateBasicInfo' not defined", extensions: { code: "VALIDATION" } }],
        },
      },
    );

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("not defined"),
    });
  });

  it("throws AuthRevokedError on HTTP 401 response from the mutation", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(set(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx (e.g., 500)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { status: 502, body: "<html>bad gateway</html>" });

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("502"),
    });
  });

  it("wraps generic transport throws (e.g., ECONNRESET) as ProfileError NETWORK_ERROR", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT });
    mockedImpersonated.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringContaining("ECONNRESET"),
    });
  });

  it("throws ProfileError UNKNOWN when the mutation response has no data.updateBasicInfo", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: { data: {} } });

    await expect(set(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringMatching(/no `data\.updateBasicInfo`/),
    });
  });

  // ====================================================================
  // dry-run path (issue #52)
  // ====================================================================
  //
  // Per the AC for #52, `set(token, changes, { dryRun: true })` must:
  //   - NOT invoke any transport (read or write)
  //   - return `{ kind: "preview", preview: <DryRunPreview> }`
  //   - redact the bearer token in the preview's `headers.authorization`
  //   - substitute a placeholder for `profileId` (would be resolved at
  //     send-time via show()) so the preview reflects the request shape
  //     faithfully without firing the read side.
  // ====================================================================

  it("dry-run path returns preview without invoking either transport (transport never called AC)", async () => {
    const outcome = await set(TOKEN, { bio: "preview bio" }, { dryRun: true });

    // The CRITICAL AC: zero transport calls in dry-run path. show()
    // would fire stockTransport for profileId; the mutation would fire
    // impersonatedTransport. Both must remain unmocked-out and untouched.
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();

    // The outcome shape: discriminated-union `kind: "preview"` so the
    // CLI / MCP can branch on it without inspecting the inner payload.
    expect(outcome.kind).toBe("preview");
  });

  it("dry-run preview carries the talent-profile/impersonated transport classification (mutation surface)", async () => {
    const outcome = await set(TOKEN, { bio: "x" }, { dryRun: true });

    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.preview.surface).toBe("talent-profile");
    expect(outcome.preview.transport).toBe("impersonated");
    expect(outcome.preview.endpoint).toBe("https://www.toptal.com/api/talent_profile/graphql");
    expect(outcome.preview.operationName).toBe("UPDATE_BASIC_INFO");
  });

  it("dry-run preview maps `bio` -> `about` and `headline` -> `quote` (user-supplied verbatim, other required fields placeholdered)", async () => {
    const outcome = await set(TOKEN, { bio: "long bio", headline: "tagline" }, { dryRun: true });

    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    const variables = outcome.preview.variables as { input: { profile: Record<string, unknown> } };
    // User-supplied fields are echoed verbatim (apply-path parity).
    expect(variables.input.profile["about"]).toBe("long bio");
    expect(variables.input.profile["quote"]).toBe("tagline");
    // Other server-required fields appear with the dedicated placeholder
    // (so the user can see the full shape the live mutation will send).
    expect(variables.input.profile["fullName"]).toBe("<preserved from current profile state>");
    expect(variables.input.profile["legalName"]).toBe("<preserved from current profile state>");
    expect(variables.input.profile["city"]).toBe("<preserved from current profile state>");
    expect(variables.input.profile["placeIdentity"]).toBe("<preserved from current profile state>");
    expect(variables.input.profile["countryId"]).toBe("<preserved from current profile state>");
    expect(variables.input.profile["citizenshipId"]).toBe("<preserved from current profile state>");
    expect(variables.input.profile["phoneNumber"]).toBe("<preserved from current profile state>");
    // Twitter is part of the merge per #535; user did NOT supply it →
    // placeholder, same shape as the other current-state-read scalars.
    expect(variables.input.profile["twitter"]).toBe("<preserved from current profile state>");
    // Array fields use empty-array placeholders rather than placeholder strings.
    expect(variables.input.profile["languageIds"]).toEqual([]);
    expect(variables.input.profile["softwareSkills"]).toEqual([]);
  });

  it("dry-run preview echoes a bare-handle twitter (normalisation is a no-op; apply-path parity)", async () => {
    const outcome = await set(TOKEN, { twitter: "alexey_pelykh" }, { dryRun: true });

    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    const variables = outcome.preview.variables as { input: { profile: Record<string, unknown> } };
    expect(variables.input.profile["twitter"]).toBe("alexey_pelykh");
    // bio/headline weren't supplied → placeholder.
    expect(variables.input.profile["about"]).toBe("<preserved from current profile state>");
    expect(variables.input.profile["quote"]).toBe("<preserved from current profile state>");
  });

  it("dry-run preview normalizes a twitter URL to the bare handle (#526; preview = what the live call sends)", async () => {
    // The dry-run preview must reflect the SAME normalisation the apply
    // path applies, so a consumer previewing a URL sees the bare handle
    // that the live UPDATE_BASIC_INFO will actually transmit.
    const outcome = await set(TOKEN, { twitter: "https://twitter.com/alexey_pelykh" }, { dryRun: true });

    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    const variables = outcome.preview.variables as { input: { profile: Record<string, unknown> } };
    expect(variables.input.profile["twitter"]).toBe("alexey_pelykh");
  });

  it("dry-run preview substitutes the profileId placeholder (would be resolved at send-time)", async () => {
    const outcome = await set(TOKEN, { bio: "x" }, { dryRun: true });

    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    const variables = outcome.preview.variables as { input: { profileId: string } };
    expect(variables.input.profileId).toMatch(/<resolved at send-time/);
    // Adversarial: the placeholder must NOT look like a real id (e.g.
    // never the "p1" used elsewhere in the suite).
    expect(variables.input.profileId).not.toBe("p1");
  });

  it("dry-run preview redacts the bearer token in the headers projection (no leakage)", async () => {
    const outcome = await set(TOKEN, { bio: "x" }, { dryRun: true });

    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.preview.headers.authorization).toBe("Token token=<redacted>");
    // Adversarial: scan ALL header values to ensure the literal token
    // string never appears anywhere — closes accidental-prefix leaks.
    for (const value of Object.values(outcome.preview.headers)) {
      expect(value).not.toContain(TOKEN);
    }
  });

  it("dry-run path STILL rejects empty changes (validation guard fires before short-circuit)", async () => {
    await expect(set(TOKEN, {}, { dryRun: true })).rejects.toMatchObject({
      name: "ProfileError",
      code: "VALIDATION_ERROR",
    });
    // Even on the validation throw, neither transport was touched.
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("dry-run preview placeholders user-unsupplied bio/headline (#393: full shape, not partial)", async () => {
    // Pre-#393 the preview omitted the user-unsupplied field. Post-#393
    // the preview shows the FULL shape the live mutation will transmit —
    // user-unsupplied scalars get the placeholder so the consumer sees
    // exactly which fields the wire request carries.
    const outcome = await set(TOKEN, { headline: "only headline" }, { dryRun: true });

    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    const variables = outcome.preview.variables as { input: { profile: Record<string, unknown> } };
    // User supplied → echoed verbatim.
    expect(variables.input.profile["quote"]).toBe("only headline");
    // User did NOT supply bio → placeholder.
    expect(variables.input.profile["about"]).toBe("<preserved from current profile state>");
    // The full shape contains all required keys (including `twitter`
    // added in #535 — basic-owned write-side field — and the six
    // social/skype fields read-preserved for #604).
    expect(Object.keys(variables.input.profile).sort()).toEqual(
      [
        "about",
        "behance",
        "citizenshipId",
        "city",
        "countryId",
        "dribbble",
        "fullName",
        "github",
        "languageIds",
        "legalName",
        "linkedin",
        "phoneNumber",
        "placeIdentity",
        "quote",
        "skype",
        "softwareSkills",
        "twitter",
        "website",
      ].sort(),
    );
  });

  it("explicit `dryRun: false` is the apply path (default behavior; ensures option does not invert)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    const outcome = await set(TOKEN, { bio: "x" }, { dryRun: false });

    expect(outcome.kind).toBe("applied");
    expect(mockedStock).toHaveBeenCalledTimes(1);
    // Read-merge chain: GET_BASIC_INFO + UPDATE_BASIC_INFO = 2 impersonated calls.
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
  });

  it("omitted options is the apply path (backward-compat: third arg is optional)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_CURRENT }, { body: UPDATE_OK });

    const outcome = await set(TOKEN, { bio: "x" });

    expect(outcome.kind).toBe("applied");
    // Read-merge chain: 2 impersonated calls (read + write).
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
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
      fullName: "Ada Lovelace",
      legalName: "Augusta Ada King-Noel",
      city: "London",
      placeIdentity: "ChIJ-place-london",
      phoneNumber: "+44 20 0000 0000",
      twitter: "ada_lovelace",
      country: { id: "country_uk" },
      citizenship: { id: "country_uk" },
      languages: {
        nodes: [
          { id: "lang-en", name: "English" },
          { id: "lang-fr", name: "French" },
        ],
      },
      softwareSkills: {
        nodes: [
          { id: "ss-typescript", name: "TypeScript" },
          { id: "ss-postgres", name: "PostgreSQL" },
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
    // #393 — extended projection: identity + location + skills.
    expect(result.fullName).toBe("Ada Lovelace");
    expect(result.legalName).toBe("Augusta Ada King-Noel");
    expect(result.city).toBe("London");
    expect(result.placeIdentity).toBe("ChIJ-place-london");
    expect(result.countryId).toBe("country_uk");
    expect(result.citizenshipId).toBe("country_uk");
    expect(result.phoneNumber).toBe("+44 20 0000 0000");
    // #535 — twitter joins the read projection (basic-owned write surface).
    expect(result.twitter).toBe("ada_lovelace");
    expect(result.softwareSkills).toEqual([
      { id: "ss-typescript", name: "TypeScript" },
      { id: "ss-postgres", name: "PostgreSQL" },
    ]);
  });

  it("normalizes missing scalar fields to null (user hasn't set them) and empty collections to []", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            about: null,
            quote: null,
            fullName: null,
            legalName: null,
            city: null,
            placeIdentity: null,
            phoneNumber: null,
            country: null,
            citizenship: null,
            languages: { nodes: [] },
            softwareSkills: { nodes: [] },
          },
        },
      },
    });

    const result = await getBasicInfo(TOKEN);
    expect(result.bio).toBeNull();
    expect(result.headline).toBeNull();
    expect(result.fullName).toBeNull();
    expect(result.legalName).toBeNull();
    expect(result.city).toBeNull();
    expect(result.placeIdentity).toBeNull();
    expect(result.phoneNumber).toBeNull();
    expect(result.countryId).toBeNull();
    expect(result.citizenshipId).toBeNull();
    // Twitter normalises to null when omitted/null on the wire (#535).
    expect(result.twitter).toBeNull();
    expect(result.languages).toEqual([]);
    expect(result.softwareSkills).toEqual([]);
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

  it("returns an empty softwareSkills array when the server omits the softwareSkills.nodes field entirely", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            about: "bio",
            quote: "headline",
            // softwareSkills omitted — server may not include the key at all.
          },
        },
      },
    });

    const result = await getBasicInfo(TOKEN);
    expect(result.softwareSkills).toEqual([]);
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

  it("filters out malformed softwareSkills nodes (null entries, missing id, missing name)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            about: "bio",
            quote: "headline",
            softwareSkills: {
              nodes: [
                null,
                { id: "ss-typescript", name: "TypeScript" },
                { id: "", name: "Empty id" },
                { id: "ss-postgres" }, // missing name
                { id: "ss-rust", name: "Rust" },
              ],
            },
          },
        },
      },
    });

    const result = await getBasicInfo(TOKEN);
    expect(result.softwareSkills).toEqual([
      { id: "ss-typescript", name: "TypeScript" },
      { id: "ss-rust", name: "Rust" },
    ]);
  });

  it("normalizes country/citizenship with empty-string id to null (empty id is not a valid relation)", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            about: "bio",
            quote: "headline",
            country: { id: "" },
            citizenship: { id: "" },
            languages: { nodes: [] },
            softwareSkills: { nodes: [] },
          },
        },
      },
    });

    const result = await getBasicInfo(TOKEN);
    expect(result.countryId).toBeNull();
    expect(result.citizenshipId).toBeNull();
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

  it("requests the extended selection set (#393 / #535 / #604): identity + location + softwareSkills + twitter + social URLs", async () => {
    replyStock({ body: PROFILE_OK });
    replyImpersonated({ body: BASIC_INFO_OK });

    await getBasicInfo(TOKEN);

    const infoCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    // Selection-set assertions — these guarantee the wire query carries
    // every field that the read-merge path in `set()` depends on. A
    // future regression that drops one of these from GET_BASIC_INFO_QUERY
    // fails this test before it fails the live UPDATE_BASIC_INFO call.
    expect(infoCall.body.query).toContain("fullName");
    expect(infoCall.body.query).toContain("legalName");
    expect(infoCall.body.query).toContain("city");
    expect(infoCall.body.query).toContain("placeIdentity");
    expect(infoCall.body.query).toContain("phoneNumber");
    expect(infoCall.body.query).toContain("twitter");
    expect(infoCall.body.query).toContain("country");
    expect(infoCall.body.query).toContain("citizenship");
    expect(infoCall.body.query).toContain("softwareSkills");
    // #604 — the six social fields the full-replacement merge must preserve.
    // Dropping any from the query means the live read returns it as absent →
    // the merge sends null → the full-replacement contract wipes it.
    expect(infoCall.body.query).toContain("linkedin");
    expect(infoCall.body.query).toContain("github");
    expect(infoCall.body.query).toContain("website");
    expect(infoCall.body.query).toContain("behance");
    expect(infoCall.body.query).toContain("dribbble");
    expect(infoCall.body.query).toContain("skype");
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

// =======================================================================
// normalizeTwitterHandle (#526) — URL / @ / bare → bare handle
// =======================================================================
//
// Pure function; no transport. The live UPDATE_BASIC_INFO wire shape
// stores a BARE HANDLE, but callers naturally pass a URL — pre-#526 the
// URL was forwarded verbatim and the field rendered broken. This suite
// pins the normalisation contract directly (set()'s merge + dry-run paths
// both call it; see the `set` block above for the integration coverage).

describe("normalizeTwitterHandle", () => {
  it("passes a bare handle through unchanged", () => {
    expect(normalizeTwitterHandle("alexey_pelykh")).toBe("alexey_pelykh");
  });

  it("strips a single leading @ from a bare handle", () => {
    expect(normalizeTwitterHandle("@alexey_pelykh")).toBe("alexey_pelykh");
  });

  it("extracts the handle from an https://x.com URL", () => {
    expect(normalizeTwitterHandle("https://x.com/alexey_pelykh")).toBe("alexey_pelykh");
  });

  it("extracts the handle from an https://twitter.com URL", () => {
    expect(normalizeTwitterHandle("https://twitter.com/alexey_pelykh")).toBe("alexey_pelykh");
  });

  it("handles http scheme, www. subdomain, and a trailing slash", () => {
    expect(normalizeTwitterHandle("http://www.twitter.com/alexey_pelykh/")).toBe("alexey_pelykh");
  });

  it("handles a mobile. subdomain", () => {
    expect(normalizeTwitterHandle("https://mobile.twitter.com/alexey_pelykh")).toBe("alexey_pelykh");
  });

  it("drops a query string after the handle", () => {
    expect(normalizeTwitterHandle("https://x.com/alexey_pelykh?s=20")).toBe("alexey_pelykh");
  });

  it("drops a fragment after the handle", () => {
    expect(normalizeTwitterHandle("https://x.com/alexey_pelykh#bio")).toBe("alexey_pelykh");
  });

  it("extracts from a scheme-less x.com URL", () => {
    expect(normalizeTwitterHandle("x.com/alexey_pelykh")).toBe("alexey_pelykh");
  });

  it("extracts from a legacy #!/ hashbang URL", () => {
    expect(normalizeTwitterHandle("https://twitter.com/#!/alexey_pelykh")).toBe("alexey_pelykh");
  });

  it("strips a leading @ inside a URL path (twitter.com/@handle)", () => {
    expect(normalizeTwitterHandle("https://x.com/@alexey_pelykh")).toBe("alexey_pelykh");
  });

  it("is case-insensitive on the host but preserves the handle's case", () => {
    expect(normalizeTwitterHandle("HTTPS://X.COM/Alexey_Pelykh")).toBe("Alexey_Pelykh");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTwitterHandle("  alexey_pelykh  ")).toBe("alexey_pelykh");
    expect(normalizeTwitterHandle("  https://x.com/alexey_pelykh  ")).toBe("alexey_pelykh");
  });

  it("preserves the empty string as the clear-intent (does NOT treat as a URL)", () => {
    expect(normalizeTwitterHandle("")).toBe("");
    expect(normalizeTwitterHandle("   ")).toBe("");
  });

  it("preserves null as the clear-intent", () => {
    expect(normalizeTwitterHandle(null)).toBeNull();
  });

  it("passes an unrecognised shape through verbatim (Toptal is the handle-validity authority)", () => {
    // A value that is neither a recognised x.com/twitter.com URL nor an
    // @-handle is treated as an already-bare handle. We do NOT reject
    // unknown shapes — over-eager client validation would block legitimate
    // handles. A non-twitter URL is intentionally left intact (we only
    // strip the handle out of KNOWN twitter/X hosts).
    expect(normalizeTwitterHandle("some_unusual.handle")).toBe("some_unusual.handle");
    expect(normalizeTwitterHandle("https://example.com/alexey_pelykh")).toBe("https://example.com/alexey_pelykh");
  });
});
