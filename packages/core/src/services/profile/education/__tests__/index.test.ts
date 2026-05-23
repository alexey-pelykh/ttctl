// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport.js")>("../../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
  };
});

import { add, highlight, list, remove, show, update } from "../index.js";
import { ProfileError } from "../../basic/index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";
import { VIEWER_OK } from "../../__tests__/fixtures.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-edu-123";

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

function replyStock(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedStock.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

// `EDU_*` are RAW WIRE nodes (what the mock transport returns). `list()`
// / `add()` / `update()` run them through `mapEducationNode` (#556), so
// assertions compare against the `EDU_*_MAPPED` typed projections, never
// the raw fixtures.

const EDU_1 = {
  id: "V1-Education-1",
  institution: "MIT",
  degree: "BSc",
  fieldOfStudy: "Mathematics",
  location: "Cambridge",
  title: null,
  yearFrom: 2010,
  yearTo: 2014,
  highlight: false,
  // #556 wire shape: `skills { nodes [{ id, name }] }`. Mapper flattens.
  skills: { nodes: [] as { id: string; name: string }[] },
};

const EDU_1_MAPPED = {
  ...EDU_1,
  skills: [] as { id: string; name: string }[],
};

const EDU_2 = {
  id: "V1-Education-2",
  institution: "Stanford",
  degree: "MSc",
  fieldOfStudy: "CS",
  location: null,
  title: null,
  yearFrom: 2014,
  yearTo: 2016,
  highlight: true,
  skills: { nodes: [{ id: "V1-Skill-7", name: "Computer Engineering" }] },
};

const EDU_2_MAPPED = {
  ...EDU_2,
  skills: [{ id: "V1-Skill-7", name: "Computer Engineering" }],
};

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
});

describe("list", () => {
  it("dispatches GET_EDUCATION against talent-profile keyed by profileId", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [EDU_1] } } } } });

    const rows = await list(TOKEN);

    expect(rows).toEqual([EDU_1_MAPPED]);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("talent-profile");
    expect(call.body.operationName).toBe("GET_EDUCATION");
    expect(call.body.variables).toEqual({ profileId: "p1" });
  });

  it("selects skills { nodes { id name } } in the EDUCATION_FRAGMENT (#556)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [] } } } } });
    await list(TOKEN);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.query).toContain("skills { nodes { id name } }");
  });

  it("flattens skills { nodes } to SkillRef[] on every row (#556)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            educations: {
              nodes: [
                EDU_1, // wire: { nodes: [] } → mapped: []
                EDU_2, // wire: { nodes: [{ id, name }] } → mapped: [{ id, name }]
              ],
            },
          },
        },
      },
    });
    const rows = await list(TOKEN);
    expect(rows.map((r) => r.skills)).toEqual([[], [{ id: "V1-Skill-7", name: "Computer Engineering" }]]);
  });

  it("defaults skills to [] when wire omits the connection (#556)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            educations: {
              // Wire intentionally omits the `skills` field entirely.
              nodes: [{ id: "V1-Education-9", institution: "X", degree: "Y", highlight: false }],
            },
          },
        },
      },
    });
    const rows = await list(TOKEN);
    expect(rows[0]?.skills).toEqual([]);
  });

  it("filters out null nodes (defensive)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [EDU_1, null, EDU_2] } } } } });

    const rows = await list(TOKEN);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([EDU_1.id, EDU_2.id]);
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ status: 401, body: {} });

    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError on extensions.code = UNAUTHENTICATED", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { errors: [{ message: "auth", extensions: { code: "UNAUTHENTICATED" } }] },
    });

    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("wraps top-level GraphQL errors as ProfileError(GRAPHQL_ERROR)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { errors: [{ message: "syntax error" }] } });

    await expect(list(TOKEN)).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
    });
  });
});

describe("show", () => {
  it("returns the matching row by id", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [EDU_1, EDU_2] } } } } });

    const row = await show(TOKEN, EDU_2.id);

    expect(row.id).toBe(EDU_2.id);
  });

  it("throws ProfileError(VALIDATION_ERROR) when id not found", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [EDU_1] } } } } });

    await expect(show(TOKEN, "missing")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("add", () => {
  it("requires --institution and --degree", async () => {
    await expect(add(TOKEN, {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(add(TOKEN, { institution: "x" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(add(TOKEN, { degree: "x" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches CREATE_EDUCATION with profileId and education input", async () => {
    replyStock({ body: VIEWER_OK }); // for extractProfileId
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [EDU_1] } } } } }); // before list
    replyImpersonated({
      body: {
        data: {
          createEducation: {
            success: true,
            errors: null,
            profile: { id: "p1", educations: { nodes: [EDU_1, EDU_2] } },
          },
        },
      },
    });

    const created = await add(TOKEN, { institution: "Stanford", degree: "MSc" });

    expect(created).toEqual(EDU_2_MAPPED);
    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(createCall.body.operationName).toBe("CREATE_EDUCATION");
    expect(createCall.body.variables).toEqual({
      input: { profileId: "p1", education: { institution: "Stanford", degree: "MSc" } },
    });
  });

  it("surfaces user errors as ProfileError(USER_ERROR)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [] } } } } });
    replyImpersonated({
      body: { data: { createEducation: { success: false, errors: [{ message: "bad", key: "institution" }] } } },
    });

    await expect(add(TOKEN, { institution: "x", degree: "y" })).rejects.toMatchObject({
      code: "USER_ERROR",
    });
  });
});

describe("update", () => {
  it("rejects empty fields", async () => {
    await expect(update(TOKEN, "id", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches UPDATE_EDUCATION with educationId and education input", async () => {
    replyImpersonated({
      body: {
        data: {
          updateEducation: {
            success: true,
            errors: null,
            profile: { id: "p1", educations: { nodes: [{ ...EDU_1, yearTo: 2015 }] } },
          },
        },
      },
    });

    const updated = await update(TOKEN, EDU_1.id, { yearTo: 2015 });

    expect(updated.yearTo).toBe(2015);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("UPDATE_EDUCATION");
    expect(call.body.variables).toEqual({ input: { educationId: EDU_1.id, education: { yearTo: 2015 } } });
  });

  it("throws ProfileError(UNKNOWN) when row not in response", async () => {
    replyImpersonated({
      body: {
        data: {
          updateEducation: {
            success: true,
            errors: null,
            profile: { id: "p1", educations: { nodes: [] } },
          },
        },
      },
    });

    await expect(update(TOKEN, EDU_1.id, { yearTo: 2015 })).rejects.toBeInstanceOf(ProfileError);
  });
});

describe("remove", () => {
  it("dispatches REMOVE_EDUCATION with educationId and returns the id", async () => {
    replyImpersonated({
      body: {
        data: {
          removeEducation: { success: true, errors: null, profile: { id: "p1", educations: { nodes: [] } } },
        },
      },
    });

    const id = await remove(TOKEN, EDU_1.id);

    expect(id).toBe(EDU_1.id);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("REMOVE_EDUCATION");
    expect(call.body.variables).toEqual({ input: { educationId: EDU_1.id } });
  });
});

describe("highlight", () => {
  it("dispatches highlightEducation with id and highlight value (default true)", async () => {
    replyImpersonated({
      body: {
        data: { highlightEducation: { success: true, errors: null, education: { id: EDU_1.id, highlight: true } } },
      },
    });

    const result = await highlight(TOKEN, EDU_1.id);

    expect(result).toEqual({ id: EDU_1.id, highlight: true });
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("highlightEducation");
    expect(call.body.variables).toEqual({ id: EDU_1.id, highlight: true });
  });

  it("supports value=false (un-highlight)", async () => {
    replyImpersonated({
      body: {
        data: { highlightEducation: { success: true, errors: null, education: { id: EDU_1.id, highlight: false } } },
      },
    });

    const result = await highlight(TOKEN, EDU_1.id, false);

    expect(result.highlight).toBe(false);
  });
});
