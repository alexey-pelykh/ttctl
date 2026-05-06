// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { CookieJar } from "tough-cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../transport.js")>("../transport.js");
  return {
    ...actual,
    impersonatedTransport: vi.fn(),
  };
});

import { getProfile, ProfileError } from "../profile.js";
import { Cf403Error, impersonatedTransport } from "../transport.js";
import type { TransportRequest, TransportResponse } from "../transport.js";

const mockedTransport = vi.mocked(impersonatedTransport);

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
    const jar = new CookieJar();
    reply({ body: PROFILE_OK });

    await getProfile(jar);

    expect(mockedTransport).toHaveBeenCalledTimes(1);
    const call = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("talent-profile");
    expect(call.body.operationName).toBe("ProfileShow");
    expect(call.body.query).toContain("query ProfileShow");
    expect(call.body.query).toContain("viewerRole");
    expect(call.body.query).toContain("profile");
  });

  it("forwards the captured cookie header to the impersonated transport", async () => {
    const jar = new CookieJar();
    await jar.setCookie(
      "_toptal_session_id=session-xyz; Path=/; Domain=.toptal.com",
      "https://www.toptal.com/api/talent_profile/graphql",
    );
    await jar.setCookie(
      "cf_clearance=clr-abc; Path=/; Domain=.toptal.com",
      "https://www.toptal.com/api/talent_profile/graphql",
    );
    reply({ body: PROFILE_OK });

    await getProfile(jar);

    const call = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    expect(call.cookieHeader).toContain("_toptal_session_id=session-xyz");
    expect(call.cookieHeader).toContain("cf_clearance=clr-abc");
  });

  it("omits the cookie header when the jar has no cookies for the talent-profile origin", async () => {
    const jar = new CookieJar();
    reply({ body: PROFILE_OK });

    await getProfile(jar);

    const call = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    expect(call.cookieHeader).toBeUndefined();
  });

  it("returns the typed `data` payload on a 200 response with viewer present", async () => {
    const jar = new CookieJar();
    reply({ body: PROFILE_OK });

    const result = await getProfile(jar);

    expect(result.viewer?.id).toBe("v1");
    expect(result.viewer?.viewerRole.email).toBe("user@example.com");
    expect(result.viewer?.viewerRole.fullName).toBe("Ada Lovelace");
    expect(result.viewer?.viewerRole.allocatedHours).toBe(40);
    expect(result.viewer?.viewerRole.profile.city).toBe("London");
    expect(result.viewer?.viewerRole.profile.skillSets.nodes).toHaveLength(1);
    expect(result.viewer?.viewerRole.profile.skillSets.nodes[0]?.skill.name).toBe("Analytical Engine");
  });

  it("throws ProfileError UNAUTHENTICATED on HTTP 401", async () => {
    const jar = new CookieJar();
    reply({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(getProfile(jar)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNAUTHENTICATED",
      message: expect.stringContaining("ttctl auth signin"),
    });
  });

  it("propagates Cf403Error verbatim (does NOT wrap it in ProfileError)", async () => {
    const jar = new CookieJar();
    mockedTransport.mockRejectedValueOnce(
      new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql"),
    );

    await expect(getProfile(jar)).rejects.toBeInstanceOf(Cf403Error);
  });

  it("wraps generic transport throws as ProfileError NETWORK_ERROR", async () => {
    const jar = new CookieJar();
    mockedTransport.mockRejectedValueOnce(new Error("ECONNRESET"));

    const promise = getProfile(jar);
    await expect(promise).rejects.toBeInstanceOf(ProfileError);
    await expect(promise).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("throws ProfileError GRAPHQL_ERROR when the response body has a non-empty `errors` array", async () => {
    const jar = new CookieJar();
    reply({
      body: {
        errors: [{ message: "Schema field not found", extensions: { code: "VALIDATION" } }],
      },
    });

    await expect(getProfile(jar)).rejects.toMatchObject({
      name: "ProfileError",
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("Schema field not found"),
    });
  });

  it("routes errors[0].extensions.code='UNAUTHENTICATED' to ProfileError UNAUTHENTICATED (Toptal returns HTTP 200 + this code, not 401)", async () => {
    const jar = new CookieJar();
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

    await expect(getProfile(jar)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNAUTHENTICATED",
      message: expect.stringContaining("ttctl auth signin"),
    });
  });

  it("throws ProfileError NO_VIEWER when data.viewer is null on a 200 response", async () => {
    const jar = new CookieJar();
    reply({ body: { data: { viewer: null } } });

    await expect(getProfile(jar)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NO_VIEWER",
    });
  });

  it("throws ProfileError UNKNOWN when the response has no data field", async () => {
    const jar = new CookieJar();
    reply({ body: { data: null } });

    await expect(getProfile(jar)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNKNOWN",
    });
  });

  it("throws ProfileError UNKNOWN on unexpected non-2xx status codes (e.g., 500)", async () => {
    const jar = new CookieJar();
    reply({ status: 500, body: "<html>internal server error</html>" });

    await expect(getProfile(jar)).rejects.toMatchObject({
      name: "ProfileError",
      code: "UNKNOWN",
      message: expect.stringContaining("500"),
    });
  });
});
