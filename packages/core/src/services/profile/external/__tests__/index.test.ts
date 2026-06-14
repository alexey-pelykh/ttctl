// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  ProfileError,
  advancedWizardShow,
  customRequirementsSet,
  customRequirementsShow,
  readiness,
  recommendations,
  show,
  update,
} from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { Cf403Error, impersonatedTransport, stockTransport } from "../../../../transport/index.js";
import type { TransportRequest, TransportResponse } from "../../../../transport/index.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-abc-123";
const PROFILE_ID = "p1";

interface MockResponse {
  status?: number;
  body: unknown;
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
 * `basic.show()` reads `data.viewer.viewerRole.profileId` and the
 * `viewer === null` branch — that's the only structural shape the
 * external/reviews services exercise. The full rich `ProfileShowQuery`
 * fixture (used in the basic-domain tests) is overkill for these tests:
 * after the cast inside `show()`, only the profileId path is dereferenced.
 * `as unknown` lets us bypass the wide ProfileShowQuery type at the
 * boundary without re-creating the full fixture.
 */
function mockProfileIdResolver(profileId: string = PROFILE_ID): void {
  mockedStock.mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: {
      data: {
        viewer: {
          viewerRole: { profileId },
        },
      },
    } as unknown,
  } satisfies TransportResponse);
}

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("update", () => {
  it("rejects calls with no fields supplied (validation guard)", async () => {
    await expect(update(TOKEN, {})).rejects.toThrow(ProfileError);
    await expect(update(TOKEN, {})).rejects.toThrow(/at least one of/);
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // #526 — twitter is NOT settable here; supplying it returns an
  // actionable redirect to basic.set instead of a silent drop.
  // -------------------------------------------------------------------

  it("rejects a twitter value with VALIDATION_ERROR + a redirect to basic.set, no transport fired (#526)", async () => {
    await expect(update(TOKEN, { twitter: "alexey_pelykh" })).rejects.toMatchObject({
      name: "ProfileError",
      code: "VALIDATION_ERROR",
      // The message names where twitter lives (basic.set / basic update).
      message: expect.stringMatching(/basic\.set|basic update/i),
    });
    // Rejected BEFORE any network — neither the profileId resolver (stock)
    // nor the mutation (impersonated) is called.
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("rejects twitter regardless of value — null and empty string also redirect (#526)", async () => {
    await expect(update(TOKEN, { twitter: null })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(update(TOKEN, { twitter: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("rejects the WHOLE call when twitter is co-supplied with valid URLs (no partial write) (#526)", async () => {
    // The server's transactional-failure history means a twitter+linkedin
    // batch would lose everything anyway; ttctl rejects up-front so the
    // user moves twitter to basic.set and re-runs the valid fields here.
    // Crucially: linkedin is NOT written (no transport fires).
    await expect(update(TOKEN, { linkedin: "https://linkedin.com/in/ada", twitter: "@ada" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/basic\.set|basic update/i),
    });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("fetches the profileId via stock then issues UpdateExternalProfiles via impersonated", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          updateExternalProfiles: {
            success: true,
            notice: null,
            errors: null,
            profile: {
              id: PROFILE_ID,
              updatedByTalentAt: "2026-05-07T12:00:00Z",
              linkedin: "https://linkedin.com/in/ada",
              github: null,
              website: null,
              twitter: null,
              behance: null,
              dribbble: null,
            },
          },
        },
      },
    });

    const result = await update(TOKEN, { linkedin: "https://linkedin.com/in/ada" });

    expect(mockedStock).toHaveBeenCalledOnce();
    expect(mockedImpersonated).toHaveBeenCalledOnce();
    expect(mockedImpersonated.mock.calls[0]?.[0]).toMatchObject({
      surface: "talent-profile",
      authToken: TOKEN,
      body: {
        operationName: "UpdateExternalProfiles",
        variables: {
          input: { profileId: PROFILE_ID, profile: { linkedin: "https://linkedin.com/in/ada" } },
        },
      },
    } satisfies Partial<TransportRequest>);
    expect(result.profile.linkedin).toBe("https://linkedin.com/in/ada");
    expect(result.profile.twitter).toBeNull();
    expect(result.notice).toBeNull();
  });

  it("only sends the provided fields in the input (partial updates)", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          updateExternalProfiles: {
            success: true,
            notice: "Saved.",
            errors: [],
            profile: {
              id: PROFILE_ID,
              updatedByTalentAt: "2026-05-07T12:00:00Z",
              linkedin: null,
              github: "https://github.com/ada",
              website: "https://ada.dev",
              twitter: null,
              behance: null,
              dribbble: null,
            },
          },
        },
      },
    });

    await update(TOKEN, { github: "https://github.com/ada", website: "https://ada.dev" });

    const call = mockedImpersonated.mock.calls[0]?.[0];
    expect(call?.body.variables).toMatchObject({
      input: {
        profileId: PROFILE_ID,
        profile: { github: "https://github.com/ada", website: "https://ada.dev" },
      },
    });
    // linkedin / behance / dribbble must NOT be in the input.
    const profileFields = (call?.body.variables as { input: { profile: Record<string, unknown> } }).input.profile;
    expect(Object.keys(profileFields).sort()).toEqual(["github", "website"]);
  });

  it("returns twitter on the result when the server echoes it (#345 — echo retained post-#526)", async () => {
    // Regression test for #345 still applies — even though `twitter` is
    // no longer writable on the input (per #526's transactional-failure
    // evidence), the `UpdateExternalProfiles` response selection set
    // continues to echo it because the server's `Profile` entity still
    // exposes the field. Callers writing OTHER fields will see the
    // pre-existing `twitter` value (set elsewhere — e.g. via the web
    // portal) reflected on the result without a follow-up `show()`
    // round-trip, which preserves the verification benefit #345 added.
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          updateExternalProfiles: {
            success: true,
            notice: null,
            errors: null,
            profile: {
              id: PROFILE_ID,
              updatedByTalentAt: "2026-05-07T12:00:00Z",
              linkedin: "https://linkedin.com/in/ada",
              github: null,
              website: null,
              twitter: "https://twitter.com/ada",
              behance: null,
              dribbble: null,
            },
          },
        },
      },
    });

    const result = await update(TOKEN, { linkedin: "https://linkedin.com/in/ada" });

    // Wire input carries ONLY linkedin under the `profile:` wrapper —
    // twitter is intentionally absent (#526 — server rejects it).
    const call = mockedImpersonated.mock.calls[0]?.[0];
    expect(call?.body.variables).toMatchObject({
      input: { profileId: PROFILE_ID, profile: { linkedin: "https://linkedin.com/in/ada" } },
    });
    const profileFields = (call?.body.variables as { input: { profile: Record<string, unknown> } }).input.profile;
    expect("twitter" in profileFields).toBe(false);
    // But the wire output still echoes twitter through the result
    // (server-side echo retained for backward compatibility).
    expect(result.profile.twitter).toBe("https://twitter.com/ada");
    expect(result.profile.linkedin).toBe("https://linkedin.com/in/ada");
    expect(result.profile.github).toBeNull();
    expect(result.profile.website).toBeNull();
    expect(result.profile.behance).toBeNull();
    expect(result.profile.dribbble).toBeNull();
  });

  it("throws ProfileError USER_ERROR when payload.errors is non-empty", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          updateExternalProfiles: {
            success: false,
            notice: null,
            errors: [{ message: "URL must be https", key: "linkedin" }],
            profile: null,
          },
        },
      },
    });

    await expect(update(TOKEN, { linkedin: "http://insecure" })).rejects.toMatchObject({
      name: "ProfileError",
      code: "USER_ERROR",
      message: expect.stringContaining("URL must be https"),
    });
  });

  it("propagates Cf403Error from the impersonated transport", async () => {
    mockProfileIdResolver();
    mockedImpersonated.mockRejectedValueOnce(new Cf403Error("talent-profile", "https://example/"));

    await expect(update(TOKEN, { linkedin: "https://linkedin.com/in/ada" })).rejects.toThrow(Cf403Error);
  });

  it("throws AuthRevokedError on extensions.code='UNAUTHENTICATED'", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        errors: [{ message: "Session invalid", extensions: { code: "UNAUTHENTICATED" } }],
      },
    });

    await expect(update(TOKEN, { linkedin: "https://linkedin.com/in/ada" })).rejects.toThrow(AuthRevokedError);
  });
});

// ---------------------------------------------------------------------------
// customRequirementsShow
// ---------------------------------------------------------------------------

describe("customRequirementsShow", () => {
  it("returns the three booleans from the customRequirements payload", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            customRequirements: {
              backgroundCheck: true,
              drugTest: false,
              timeTrackingTools: true,
            },
          },
        },
      },
    });

    const result = await customRequirementsShow(TOKEN);
    expect(result).toEqual({
      backgroundCheck: true,
      drugTest: false,
      timeTrackingTools: true,
    });
  });

  it("coerces non-boolean wire values to null defensively", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            customRequirements: {
              backgroundCheck: "not-a-boolean",
              drugTest: null,
              timeTrackingTools: 1,
            },
          },
        },
      },
    });

    const result = await customRequirementsShow(TOKEN);
    expect(result).toEqual({ backgroundCheck: null, drugTest: null, timeTrackingTools: null });
  });

  it("treats a missing customRequirements object as all-null", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, customRequirements: null } } },
    });
    const result = await customRequirementsShow(TOKEN);
    expect(result).toEqual({ backgroundCheck: null, drugTest: null, timeTrackingTools: null });
  });

  it("throws ProfileError NO_VIEWER when data.profile is null", async () => {
    mockProfileIdResolver();
    replyImpersonated({ body: { data: { profile: null } } });

    await expect(customRequirementsShow(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NO_VIEWER",
    });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    mockProfileIdResolver();
    replyImpersonated({ status: 401, body: {} });
    await expect(customRequirementsShow(TOKEN)).rejects.toThrow(AuthRevokedError);
  });
});

// ---------------------------------------------------------------------------
// customRequirementsSet
// ---------------------------------------------------------------------------

describe("customRequirementsSet", () => {
  it("rejects calls with no booleans supplied", async () => {
    await expect(customRequirementsSet(TOKEN, {})).rejects.toThrow(ProfileError);
    await expect(customRequirementsSet(TOKEN, {})).rejects.toThrow(/at least one of/);
  });

  it("merges caller-omitted fields with current server state and resubmits all three", async () => {
    // First impersonated call: customRequirementsShow (the merge-fetch).
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            customRequirements: {
              backgroundCheck: true,
              drugTest: true,
              timeTrackingTools: false,
            },
          },
        },
      },
    });
    // Second profileId resolver call (for the actual mutation).
    mockProfileIdResolver();
    // Third impersonated call: the mutation.
    replyImpersonated({
      body: {
        data: {
          updateCustomRequirements: {
            success: true,
            notice: null,
            errors: [],
            profile: {
              id: PROFILE_ID,
              updatedByTalentAt: "2026-05-07T12:00:00Z",
              customRequirements: { backgroundCheck: false, drugTest: true, timeTrackingTools: false },
            },
          },
        },
      },
    });

    await customRequirementsSet(TOKEN, { backgroundCheck: false });

    const mutationCall = mockedImpersonated.mock.calls[1]?.[0];
    expect(mutationCall?.body.variables).toMatchObject({
      input: {
        profileId: PROFILE_ID,
        customRequirements: {
          backgroundCheck: false, // caller-supplied override
          drugTest: true, // pre-filled from current state
          timeTrackingTools: false, // pre-filled from current state
        },
      },
    });
  });

  it("treats null current state as false when pre-filling missing fields", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, customRequirements: null } } },
    });
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          updateCustomRequirements: {
            success: true,
            notice: null,
            errors: [],
            profile: {
              id: PROFILE_ID,
              updatedByTalentAt: "2026-05-07T12:00:00Z",
              customRequirements: { backgroundCheck: true, drugTest: false, timeTrackingTools: false },
            },
          },
        },
      },
    });

    await customRequirementsSet(TOKEN, { backgroundCheck: true });

    const mutationCall = mockedImpersonated.mock.calls[1]?.[0];
    expect(mutationCall?.body.variables).toMatchObject({
      input: {
        profileId: PROFILE_ID,
        customRequirements: { backgroundCheck: true, drugTest: false, timeTrackingTools: false },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// readiness
// ---------------------------------------------------------------------------

describe("readiness", () => {
  it("returns the per-section flags plus submitAvailable and updatedByTalentAt", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            submitAvailable: false,
            updatedByTalentAt: "2026-05-07T12:00:00Z",
            profileReadiness: {
              isPhotoResolutionSatisfied: true,
              isBasicInfoSatisfied: true,
              isCertificationsSatisfied: false,
              isEmploymentsCountSatisfied: true,
              isEmploymentConnectionsSatisfied: false,
              isSkillValidationsSatisfied: true,
              isPortfolioItemsCountSatisfied: false,
              isPortfolioItemConnectionsSatisfied: false,
              isWorkingHoursSatisfied: true,
            },
          },
        },
      },
    });

    const result = await readiness(TOKEN);
    expect(result.submitAvailable).toBe(false);
    expect(result.isPhotoResolutionSatisfied).toBe(true);
    expect(result.isCertificationsSatisfied).toBe(false);
    expect(result.updatedByTalentAt).toBe("2026-05-07T12:00:00Z");
  });

  it("coerces unexpected wire types to null", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            submitAvailable: "maybe",
            updatedByTalentAt: 12345,
            profileReadiness: { isPhotoResolutionSatisfied: "yes" },
          },
        },
      },
    });

    const result = await readiness(TOKEN);
    expect(result.submitAvailable).toBeNull();
    expect(result.updatedByTalentAt).toBeNull();
    expect(result.isPhotoResolutionSatisfied).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recommendations
// ---------------------------------------------------------------------------

describe("recommendations", () => {
  it("returns each node as a {type, payload} pair with __typename stripped", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            recommendations: {
              nodes: [
                {
                  __typename: "EmploymentsCountRecommendation",
                  type: "EmploymentsCountRecommendation",
                  minimumCount: 3,
                },
                {
                  __typename: "AdvancedProfileRecommendation",
                  type: "AdvancedProfileRecommendation",
                  isCustomRequirementsCompleted: false,
                  isTravelInformationCompleted: true,
                },
              ],
            },
          },
        },
      },
    });

    const result = await recommendations(TOKEN);
    expect(result).toEqual([
      { type: "EmploymentsCountRecommendation", payload: { minimumCount: 3 } },
      {
        type: "AdvancedProfileRecommendation",
        payload: { isCustomRequirementsCompleted: false, isTravelInformationCompleted: true },
      },
    ]);
  });

  it("returns an empty array when the recommendations container is empty", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, recommendations: { nodes: [] } } } },
    });

    const result = await recommendations(TOKEN);
    expect(result).toEqual([]);
  });

  it("falls back type='Unknown' when the discriminator is missing", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            recommendations: { nodes: [{ minimumCount: 5 }] },
          },
        },
      },
    });

    const result = await recommendations(TOKEN);
    expect(result).toEqual([{ type: "Unknown", payload: { minimumCount: 5 } }]);
  });
});

// ---------------------------------------------------------------------------
// advancedWizardShow
// ---------------------------------------------------------------------------

describe("advancedWizardShow", () => {
  it("returns wizardStatus + travel-visa summary", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            advancedProfileWizardStatus: "IN_PROGRESS",
            travelVisas: {
              nodes: [{ id: "v1" }, { id: "v2" }, null, { id: "v3" }],
            },
          },
        },
      },
    });

    const result = await advancedWizardShow(TOKEN);
    expect(result).toEqual({
      wizardStatus: "IN_PROGRESS",
      travelVisaCount: 3,
      travelVisaIds: ["v1", "v2", "v3"],
    });
  });

  it("treats absent travelVisas as zero count", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: { id: PROFILE_ID, advancedProfileWizardStatus: null, travelVisas: null },
        },
      },
    });

    const result = await advancedWizardShow(TOKEN);
    expect(result).toEqual({ wizardStatus: null, travelVisaCount: 0, travelVisaIds: [] });
  });
});

// ---------------------------------------------------------------------------
// show (#343 — read side of external URLs)
// ---------------------------------------------------------------------------

describe("show", () => {
  it("issues getExternalProfiles via impersonated and returns all six URLs (happy path)", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            updatedByTalentAt: "2026-05-07T12:00:00Z",
            linkedin: "https://linkedin.com/in/ada",
            github: "https://github.com/ada",
            website: "https://ada.dev",
            twitter: "https://twitter.com/ada",
            behance: "https://behance.net/ada",
            dribbble: "https://dribbble.com/ada",
          },
        },
      },
    });

    const result = await show(TOKEN);

    expect(mockedStock).toHaveBeenCalledOnce();
    expect(mockedImpersonated).toHaveBeenCalledOnce();
    expect(mockedImpersonated.mock.calls[0]?.[0]).toMatchObject({
      surface: "talent-profile",
      authToken: TOKEN,
      body: {
        operationName: "getExternalProfiles",
        variables: { profileId: PROFILE_ID },
      },
    } satisfies Partial<TransportRequest>);
    expect(result).toEqual({
      id: PROFILE_ID,
      updatedByTalentAt: "2026-05-07T12:00:00Z",
      linkedin: "https://linkedin.com/in/ada",
      github: "https://github.com/ada",
      website: "https://ada.dev",
      twitter: "https://twitter.com/ada",
      behance: "https://behance.net/ada",
      dribbble: "https://dribbble.com/ada",
    });
  });

  it("maps every unset URL to null (no URLs set)", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            updatedByTalentAt: null,
            linkedin: null,
            github: null,
            website: null,
            twitter: null,
            behance: null,
            dribbble: null,
          },
        },
      },
    });

    const result = await show(TOKEN);
    expect(result).toEqual({
      id: PROFILE_ID,
      updatedByTalentAt: null,
      linkedin: null,
      github: null,
      website: null,
      twitter: null,
      behance: null,
      dribbble: null,
    });
  });

  it("coerces non-string wire values to null defensively", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            updatedByTalentAt: 1234567890,
            linkedin: { nested: "object" },
            github: 42,
            website: false,
            twitter: ["array"],
            behance: null,
            dribbble: "https://dribbble.com/ada",
          },
        },
      },
    });

    const result = await show(TOKEN);
    expect(result).toEqual({
      id: PROFILE_ID,
      updatedByTalentAt: null,
      linkedin: null,
      github: null,
      website: null,
      twitter: null,
      behance: null,
      dribbble: "https://dribbble.com/ada",
    });
  });

  it("throws ProfileError NO_VIEWER when data.profile is null", async () => {
    mockProfileIdResolver();
    replyImpersonated({ body: { data: { profile: null } } });

    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NO_VIEWER",
    });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    mockProfileIdResolver();
    replyImpersonated({ status: 401, body: {} });
    await expect(show(TOKEN)).rejects.toThrow(AuthRevokedError);
  });

  it("throws AuthRevokedError on extensions.code='UNAUTHENTICATED'", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: { errors: [{ message: "Session invalid", extensions: { code: "UNAUTHENTICATED" } }] },
    });
    await expect(show(TOKEN)).rejects.toThrow(AuthRevokedError);
  });

  it("propagates Cf403Error from the impersonated transport", async () => {
    mockProfileIdResolver();
    mockedImpersonated.mockRejectedValueOnce(new Cf403Error("talent-profile", "https://example/"));

    await expect(show(TOKEN)).rejects.toThrow(Cf403Error);
  });
});
