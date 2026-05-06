// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../transport.js")>("../transport.js");
  return {
    ...actual,
    impersonatedTransport: vi.fn(),
  };
});

import { getProfile, ProfileError, updateProfile } from "../profile.js";
import { Cf403Error, impersonatedTransport } from "../transport.js";
import type { TransportRequest, TransportResponse } from "../transport.js";

const mockedTransport = vi.mocked(impersonatedTransport);
const TOKEN = "tok-abc-123";

interface MockResponse {
  status?: number;
  body: unknown;
}

function reply(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedTransport.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

const PROFILE_OK = {
  data: {
    viewer: {
      __typename: "Viewer",
      id: "v1",
      viewerRole: {
        __typename: "ViewerRole",
        email: "user@example.com",
        firstName: "Ada",
        fullName: "Ada Lovelace",
        phoneNumber: "+1 555 0001",
        allocatedHours: 40,
        hiredHours: 30,
        photo: { __typename: "Photo", large: "https://cdn/large.jpg", small: "https://cdn/small.jpg" },
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
    mockedTransport.mockReset();
  });

  it("targets the talent-profile surface with the ProfileShow operation", async () => {
    reply({ body: PROFILE_OK });

    await getProfile(TOKEN);

    expect(mockedTransport).toHaveBeenCalledTimes(1);
    const call = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("talent-profile");
    expect(call.body.operationName).toBe("ProfileShow");
    expect(call.body.query).toContain("query ProfileShow");
    expect(call.body.query).toContain("viewerRole");
    expect(call.body.query).toContain("profile");
  });

  it("forwards the auth token via Authorization: Token token=... (authToken field)", async () => {
    reply({ body: PROFILE_OK });

    await getProfile(TOKEN);

    const call = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    expect(call.authToken).toBe(TOKEN);
  });

  it("returns the typed `data` payload on a 200 response with viewer present", async () => {
    reply({ body: PROFILE_OK });

    const result = await getProfile(TOKEN);

    expect(result.viewer?.id).toBe("v1");
    expect(result.viewer?.viewerRole.email).toBe("user@example.com");
    expect(result.viewer?.viewerRole.fullName).toBe("Ada Lovelace");
    expect(result.viewer?.viewerRole.allocatedHours).toBe(40);
    expect(result.viewer?.viewerRole.profile.city).toBe("London");
    expect(result.viewer?.viewerRole.profile.skillSets.nodes).toHaveLength(1);
    expect(result.viewer?.viewerRole.profile.skillSets.nodes[0]?.skill.name).toBe("Analytical Engine");
  });

  it("throws ProfileError UNAUTHENTICATED on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNAUTHENTICATED",
      message: expect.stringContaining("ttctl auth signin"),
    });
  });

  it("propagates Cf403Error verbatim (does NOT wrap it in ProfileError)", async () => {
    mockedTransport.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(getProfile(TOKEN)).rejects.toBeInstanceOf(Cf403Error);
  });

  it("wraps generic transport throws as ProfileError NETWORK_ERROR", async () => {
    mockedTransport.mockRejectedValueOnce(new Error("ECONNRESET"));

    const promise = getProfile(TOKEN);
    await expect(promise).rejects.toBeInstanceOf(ProfileError);
    await expect(promise).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("throws ProfileError GRAPHQL_ERROR when the response body has a non-empty `errors` array", async () => {
    reply({
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
    reply({
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
    reply({ body: { data: { viewer: null } } });

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NO_VIEWER",
    });
  });

  it("throws ProfileError UNKNOWN when the response has no data field", async () => {
    reply({ body: { data: null } });

    await expect(getProfile(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNKNOWN",
    });
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx status codes (e.g., 500)", async () => {
    reply({ status: 500, body: "<html>internal server error</html>" });

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
    mockedTransport.mockReset();
  });

  it("rejects calls with neither bio nor headline (CLI/contract guard)", async () => {
    await expect(updateProfile(TOKEN, {})).rejects.toMatchObject({
      name: "ProfileError",
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/at least one of/i),
    });
    expect(mockedTransport).not.toHaveBeenCalled();
  });

  it("fetches the profile first to obtain profileId, then issues UpdateBasicInfo", async () => {
    reply({ body: PROFILE_OK }, { body: UPDATE_OK });

    await updateProfile(TOKEN, { bio: "new bio" });

    expect(mockedTransport).toHaveBeenCalledTimes(2);
    const showCall = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    const updateCall = mockedTransport.mock.calls[1]?.[0] as TransportRequest;
    expect(showCall.body.operationName).toBe("ProfileShow");
    expect(updateCall.body.operationName).toBe("UPDATE_BASIC_INFO");
    expect(updateCall.surface).toBe("talent-profile");
    expect(updateCall.body.query).toContain("mutation UPDATE_BASIC_INFO");
    expect(updateCall.body.query).toContain("updateBasicInfo(input: $input)");
  });

  it("forwards the auth token on both the read and write call", async () => {
    reply({ body: PROFILE_OK }, { body: UPDATE_OK });

    await updateProfile(TOKEN, { bio: "x" });

    const showCall = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    const updateCall = mockedTransport.mock.calls[1]?.[0] as TransportRequest;
    expect(showCall.authToken).toBe(TOKEN);
    expect(updateCall.authToken).toBe(TOKEN);
  });

  it("maps `bio` -> `about` and `headline` -> `quote` in the mutation input", async () => {
    reply({ body: PROFILE_OK }, { body: UPDATE_OK });

    await updateProfile(TOKEN, { bio: "long-form bio text", headline: "short tagline" });

    const updateCall = mockedTransport.mock.calls[1]?.[0] as TransportRequest;
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
    reply({ body: PROFILE_OK }, { body: UPDATE_OK });

    await updateProfile(TOKEN, { headline: "only headline" });

    const updateCall = mockedTransport.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { basicInfo: Record<string, unknown> } };
    expect(variables.input.basicInfo).toEqual({ quote: "only headline" });
    expect(variables.input.basicInfo).not.toHaveProperty("about");
  });

  it("preserves empty-string updates (clearing a field is a real intent, not an unset)", async () => {
    reply({ body: PROFILE_OK }, { body: UPDATE_OK });

    await updateProfile(TOKEN, { bio: "" });

    const updateCall = mockedTransport.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { basicInfo: Record<string, unknown> } };
    expect(variables.input.basicInfo).toEqual({ about: "" });
  });

  it("returns the updated bio/headline values from the server's confirmation payload", async () => {
    reply({ body: PROFILE_OK }, { body: UPDATE_OK });

    const result = await updateProfile(TOKEN, { bio: "new bio", headline: "new headline" });

    expect(result.profile.id).toBe("p1");
    expect(result.profile.about).toBe("new bio");
    expect(result.profile.quote).toBe("new headline");
  });

  it("normalizes a missing `notice` to null (callers can branch cleanly)", async () => {
    reply({ body: PROFILE_OK }, { body: UPDATE_OK });

    const result = await updateProfile(TOKEN, { bio: "x" });
    expect(result.notice).toBeNull();
  });

  it("propagates Cf403Error from the read-side getProfile call (write fails before issuing)", async () => {
    mockedTransport.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(Cf403Error);
    expect(mockedTransport).toHaveBeenCalledTimes(1); // never reached the mutation
  });

  it("propagates Cf403Error from the write-side mutation call", async () => {
    mockedTransport.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: PROFILE_OK,
    } satisfies TransportResponse);
    mockedTransport.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toBeInstanceOf(Cf403Error);
    expect(mockedTransport).toHaveBeenCalledTimes(2);
  });

  it("throws ProfileError USER_ERROR when the mutation payload returns a non-empty errors array", async () => {
    reply(
      { body: PROFILE_OK },
      {
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
      },
    );

    await expect(updateProfile(TOKEN, { bio: "x".repeat(10000) })).rejects.toMatchObject({
      name: "ProfileError",
      code: "USER_ERROR",
      message: expect.stringContaining("About is too long"),
    });
  });

  it("includes the field name in USER_ERROR messages when the server reports one", async () => {
    reply(
      { body: PROFILE_OK },
      {
        body: {
          data: {
            updateBasicInfo: {
              success: false,
              errors: [{ message: "is required", field: "quote" }],
              profile: null,
            },
          },
        },
      },
    );

    await expect(updateProfile(TOKEN, { headline: "" })).rejects.toMatchObject({
      message: expect.stringContaining("(quote)"),
    });
  });

  it("throws ProfileError USER_ERROR when payload.success === false (no errors array)", async () => {
    reply(
      { body: PROFILE_OK },
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

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Something went wrong"),
    });
  });

  it("throws ProfileError UNAUTHENTICATED on errors[0].extensions.code='UNAUTHENTICATED' from the mutation", async () => {
    reply(
      { body: PROFILE_OK },
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

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: expect.stringContaining("ttctl auth signin"),
    });
  });

  it("throws ProfileError GRAPHQL_ERROR on top-level errors (non-UNAUTHENTICATED)", async () => {
    reply(
      { body: PROFILE_OK },
      {
        body: {
          errors: [{ message: "Field UpdateBasicInfoInput.basicInfo not defined", extensions: { code: "VALIDATION" } }],
        },
      },
    );

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("not defined"),
    });
  });

  it("throws ProfileError UNAUTHENTICATED on HTTP 401 response", async () => {
    reply({ body: PROFILE_OK }, { status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx (e.g., 500)", async () => {
    reply({ body: PROFILE_OK }, { status: 502, body: "<html>bad gateway</html>" });

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("502"),
    });
  });

  it("wraps generic transport throws (e.g., ECONNRESET) as ProfileError NETWORK_ERROR", async () => {
    mockedTransport.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: PROFILE_OK,
    } satisfies TransportResponse);
    mockedTransport.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringContaining("ECONNRESET"),
    });
  });

  it("throws ProfileError UNKNOWN when the mutation response has no data.updateBasicInfo", async () => {
    reply({ body: PROFILE_OK }, { body: { data: {} } });

    await expect(updateProfile(TOKEN, { bio: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringMatching(/no `data\.updateBasicInfo`/),
    });
  });
});
