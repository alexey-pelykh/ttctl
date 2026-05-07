// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport.js")>("../../../../transport.js");
  return {
    ...actual,
    impersonatedTransport: vi.fn(),
  };
});

import { add, autocomplete, list, readiness, rm, set, show, SkillsError } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { Cf403Error, impersonatedTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";

const mocked = vi.mocked(impersonatedTransport);
const TOKEN = "tok-skills";

interface MockResponse {
  status?: number;
  body: unknown;
}

function reply(...responses: MockResponse[]): void {
  for (const r of responses) {
    mocked.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

beforeEach(() => {
  mocked.mockReset();
});

const SKILL_SET_OK = {
  id: "ss1",
  experience: 60,
  rating: "EXPERT",
  public: true,
  position: 1,
  skill: { id: "sk1", name: "TypeScript" },
  connections: { totalCount: 3 },
};

// -----------------------------------------------------------------------
// add
// -----------------------------------------------------------------------

describe("skills.add", () => {
  it("rejects an empty name without making any network call", async () => {
    await expect(add(TOKEN, "   ")).rejects.toMatchObject({
      name: "SkillsError",
      code: "VALIDATION_ERROR",
    });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("calls ADD_PROFILE_SKILL_SET with a trimmed name and returns the new skill set", async () => {
    reply({
      body: {
        data: {
          addProfileSkillSet: {
            skillSet: SKILL_SET_OK,
            success: true,
            notice: null,
            errors: [],
          },
        },
      },
    });

    const result = await add(TOKEN, "  TypeScript  ");
    expect(result.id).toBe("ss1");
    expect(result.skill.name).toBe("TypeScript");
    expect(result.connectionsCount).toBe(3);

    const call = mocked.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("ADD_PROFILE_SKILL_SET");
    expect(call.body.variables).toEqual({ input: { name: "TypeScript" } });
    expect(call.surface).toBe("talent-profile");
  });

  it("propagates Cf403Error from the talent-profile transport", async () => {
    mocked.mockRejectedValueOnce(new Cf403Error("talent-profile", "https://example.com/api"));
    await expect(add(TOKEN, "TypeScript")).rejects.toBeInstanceOf(Cf403Error);
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "unauthorized" }] } });
    await expect(add(TOKEN, "TypeScript")).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError when extensions.code is UNAUTHENTICATED", async () => {
    reply({ body: { errors: [{ message: "x", extensions: { code: "UNAUTHENTICATED" } }] } });
    await expect(add(TOKEN, "TypeScript")).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws SkillsError USER_ERROR when payload reports user errors", async () => {
    reply({
      body: {
        data: {
          addProfileSkillSet: {
            skillSet: null,
            success: false,
            errors: [{ code: "DUPLICATE", key: "name", message: "Skill already on profile" }],
          },
        },
      },
    });
    await expect(add(TOKEN, "TypeScript")).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Skill already on profile"),
    });
  });

  it("throws SkillsError USER_ERROR when payload.success === false (no errors array)", async () => {
    reply({
      body: {
        data: {
          addProfileSkillSet: { skillSet: null, success: false, notice: "rate-limited", errors: [] },
        },
      },
    });
    await expect(add(TOKEN, "TypeScript")).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("rate-limited"),
    });
  });

  it("throws SkillsError NETWORK_ERROR on transport-level throw", async () => {
    mocked.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(add(TOKEN, "TypeScript")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringContaining("ECONNRESET"),
    });
  });
});

// -----------------------------------------------------------------------
// rm
// -----------------------------------------------------------------------

describe("skills.rm", () => {
  it("rejects an empty id without making a network call", async () => {
    await expect(rm(TOKEN, " ")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("calls REMOVE_PROFILE_SKILL_SET with the supplied id and returns void on success", async () => {
    reply({
      body: { data: { removeProfileSkillSet: { success: true, notice: null, errors: [], profile: { id: "p1" } } } },
    });
    await expect(rm(TOKEN, "ss1")).resolves.toBeUndefined();
    const call = mocked.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.variables).toEqual({ input: { skillSetId: "ss1" } });
  });

  it("throws SkillsError USER_ERROR when the server reports a stale id", async () => {
    reply({
      body: {
        data: {
          removeProfileSkillSet: {
            success: false,
            errors: [{ message: "Skill set not found", key: "skillSetId" }],
          },
        },
      },
    });
    await expect(rm(TOKEN, "ss-stale")).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Skill set not found"),
    });
  });
});

// -----------------------------------------------------------------------
// set (multi-flag atomic)
// -----------------------------------------------------------------------

describe("skills.set", () => {
  it("rejects when no fields are supplied", async () => {
    await expect(set(TOKEN, "ss1", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocked).not.toHaveBeenCalled();
  });

  it("rejects an empty id without making a network call", async () => {
    await expect(set(TOKEN, "", { rating: "EXPERT" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("issues a single mutation when only rating is provided", async () => {
    reply({
      body: {
        data: {
          updateProfileSkillSetRating: {
            skillSet: { id: "ss1", rating: "STRONG" },
            success: true,
            notice: null,
            errors: [],
          },
        },
      },
    });

    const result = await set(TOKEN, "ss1", { rating: "STRONG" });
    expect(result.rating).toBe("STRONG");
    expect(result.experience).toBeNull();
    expect(result.public).toBeNull();
    expect(mocked).toHaveBeenCalledTimes(1);
    const call = mocked.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("UPDATE_PROFILE_SKILL_SET_RATING");
  });

  it("issues three mutations in deterministic order rating → experience → public when all provided", async () => {
    reply(
      {
        body: {
          data: {
            updateProfileSkillSetRating: {
              skillSet: { id: "ss1", rating: "EXPERT" },
              success: true,
              errors: [],
            },
          },
        },
      },
      {
        body: {
          data: {
            updateProfileSkillSetExperience: {
              skillSet: { id: "ss1", experience: 60 },
              success: true,
              errors: [],
            },
          },
        },
      },
      {
        body: {
          data: {
            updateProfileSkillSetPublicity: {
              skillSet: { id: "ss1", public: true },
              success: true,
              errors: [],
            },
          },
        },
      },
    );

    const result = await set(TOKEN, "ss1", { rating: "EXPERT", experience: 60, public: true });
    expect(result.rating).toBe("EXPERT");
    expect(result.experience).toBe(60);
    expect(result.public).toBe(true);

    expect(mocked).toHaveBeenCalledTimes(3);
    const ops = mocked.mock.calls.map((c) => (c[0] as TransportRequest).body.operationName);
    expect(ops).toEqual([
      "UPDATE_PROFILE_SKILL_SET_RATING",
      "UPDATE_PROFILE_SKILL_SET_EXPERIENCE",
      "UPDATE_PROFILE_SKILL_SET_PUBLICITY",
    ]);
  });

  it("propagates the FIRST mutation's USER_ERROR as a regular error (not PARTIAL_FAILURE)", async () => {
    reply({
      body: {
        data: {
          updateProfileSkillSetRating: {
            skillSet: null,
            success: false,
            errors: [{ message: "Invalid rating", key: "rating" }],
          },
        },
      },
    });

    await expect(set(TOKEN, "ss1", { rating: "EXPERT", experience: 60 })).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Invalid rating"),
    });
    // Subsequent mutations not fired after first failure.
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("raises PARTIAL_FAILURE when rating succeeds but experience fails", async () => {
    reply(
      {
        body: {
          data: {
            updateProfileSkillSetRating: {
              skillSet: { id: "ss1", rating: "STRONG" },
              success: true,
              errors: [],
            },
          },
        },
      },
      {
        body: {
          data: {
            updateProfileSkillSetExperience: {
              skillSet: null,
              success: false,
              errors: [{ message: "Experience must be > 0", key: "experience" }],
            },
          },
        },
      },
    );

    await expect(set(TOKEN, "ss1", { rating: "STRONG", experience: 0 })).rejects.toMatchObject({
      code: "PARTIAL_FAILURE",
      message: expect.stringMatching(/rating succeeded.*experience failed/),
    });
  });

  it("collects per-mutation notices into the result.notices array", async () => {
    reply(
      {
        body: {
          data: {
            updateProfileSkillSetRating: {
              skillSet: { id: "ss1", rating: "STRONG" },
              success: true,
              notice: "Profile review may be required",
              errors: [],
            },
          },
        },
      },
      {
        body: {
          data: {
            updateProfileSkillSetPublicity: {
              skillSet: { id: "ss1", public: false },
              success: true,
              notice: null,
              errors: [],
            },
          },
        },
      },
    );

    const result = await set(TOKEN, "ss1", { rating: "STRONG", public: false });
    expect(result.notices).toEqual(["Profile review may be required"]);
  });
});

// -----------------------------------------------------------------------
// show / list / autocomplete / readiness
// -----------------------------------------------------------------------

describe("skills.show", () => {
  it("rejects an empty id", async () => {
    await expect(show(TOKEN, "")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("calls GetSkillSetWithConnections and normalises the wire shape", async () => {
    reply({ body: { data: { node: SKILL_SET_OK } } });
    const result = await show(TOKEN, "ss1");
    expect(result.id).toBe("ss1");
    expect(result.connectionsCount).toBe(3);
    expect(result.skill.name).toBe("TypeScript");
  });

  it("throws USER_ERROR when the id doesn't resolve to a ProfileSkillSet (node === null)", async () => {
    reply({ body: { data: { node: null } } });
    await expect(show(TOKEN, "ss-stale")).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("ss-stale"),
    });
  });
});

describe("skills.list", () => {
  it("rejects an empty profileId", async () => {
    await expect(list(TOKEN, "")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("filters out null nodes and normalises every survivor", async () => {
    reply({
      body: {
        data: {
          profile: {
            id: "p1",
            skillSets: { nodes: [SKILL_SET_OK, null, { ...SKILL_SET_OK, id: "ss2" }] },
          },
        },
      },
    });
    const out = await list(TOKEN, "p1");
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.id)).toEqual(["ss1", "ss2"]);
  });

  it("throws USER_ERROR when the profile id doesn't resolve", async () => {
    reply({ body: { data: { profile: null } } });
    await expect(list(TOKEN, "p-stale")).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("p-stale"),
    });
  });
});

describe("skills.autocomplete", () => {
  it("rejects an empty profileId", async () => {
    await expect(autocomplete(TOKEN, "", "type")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects an empty search string", async () => {
    await expect(autocomplete(TOKEN, "p1", "  ")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("forwards limit and withoutIds defaults (10, [])", async () => {
    reply({
      body: {
        data: {
          profile: {
            id: "p1",
            skillsAutocomplete: [{ id: "sk1", name: "TypeScript" }],
          },
        },
      },
    });
    const out = await autocomplete(TOKEN, "p1", "type");
    expect(out).toEqual([{ id: "sk1", name: "TypeScript" }]);
    const call = mocked.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.variables).toEqual({
      profileId: "p1",
      search: "type",
      limit: 10,
      withoutIds: [],
    });
  });

  it("forwards caller-supplied limit and withoutIds verbatim", async () => {
    reply({ body: { data: { profile: { id: "p1", skillsAutocomplete: [] } } } });
    await autocomplete(TOKEN, "p1", "py", { limit: 25, withoutIds: ["sk-py"] });
    const call = mocked.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.variables).toEqual({
      profileId: "p1",
      search: "py",
      limit: 25,
      withoutIds: ["sk-py"],
    });
  });
});

describe("skills.readiness", () => {
  const READY_OK = {
    isExpertProficiencyCountSatisfied: true,
    isHighlightedItemsCountAndExperienceSatisfied: false,
    isItemsCountSatisfied: true,
    isProficiencyNotSetCountSatisfied: true,
    isProgrammingLanguageSatisfied: true,
  };

  it("rejects an empty profileId", async () => {
    await expect(readiness(TOKEN, "")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns the typed readiness flags verbatim", async () => {
    reply({ body: { data: { profile: { id: "p1", skillsReadiness: READY_OK } } } });
    const out = await readiness(TOKEN, "p1");
    expect(out).toEqual(READY_OK);
  });

  it("throws SkillsError when the profile id doesn't resolve", async () => {
    reply({ body: { data: { profile: null } } });
    await expect(readiness(TOKEN, "p-stale")).rejects.toBeInstanceOf(SkillsError);
  });
});
