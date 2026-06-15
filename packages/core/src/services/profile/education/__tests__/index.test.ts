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
  add,
  buildUpdateEducationInput,
  DRY_RUN_EDUCATION_FIELD_PLACEHOLDER,
  highlight,
  list,
  remove,
  show,
  toEducationWireInput,
  update,
} from "../index.js";
import type { Education } from "../index.js";
import { ProfileError } from "../../basic/index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { impersonatedTransport, stockTransport } from "../../../../transport/index.js";
import type { TransportRequest, TransportResponse } from "../../../../transport/index.js";
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
  it("requires institution, degree, fieldOfStudy, location, yearFrom, yearTo (#803 CREATE non-null contract)", async () => {
    await expect(add(TOKEN, {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The pre-#803 minimal {institution, degree} is now rejected client-side.
    await expect(add(TOKEN, { institution: "x", degree: "y" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Each remaining required field omitted in turn → still rejected, no wire call.
    await expect(
      add(TOKEN, { degree: "y", fieldOfStudy: "f", location: "l", yearFrom: 2018, yearTo: 2022 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // no institution
    await expect(
      add(TOKEN, { institution: "x", fieldOfStudy: "f", location: "l", yearFrom: 2018, yearTo: 2022 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // no degree
    await expect(
      add(TOKEN, { institution: "x", degree: "y", location: "l", yearFrom: 2018, yearTo: 2022 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // no fieldOfStudy
    await expect(
      add(TOKEN, { institution: "x", degree: "y", fieldOfStudy: "f", yearFrom: 2018, yearTo: 2022 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // no location
    await expect(
      add(TOKEN, { institution: "x", degree: "y", fieldOfStudy: "f", location: "l", yearTo: 2022 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // no yearFrom
    await expect(
      add(TOKEN, { institution: "x", degree: "y", fieldOfStudy: "f", location: "l", yearFrom: 2018 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // no yearTo
  });

  it("dispatches CREATE_EDUCATION with wire shape (institution → title, skills default []) (#612)", async () => {
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

    const created = await add(TOKEN, {
      institution: "Stanford",
      degree: "MSc",
      fieldOfStudy: "CS",
      location: "Palo Alto",
      yearFrom: 2018,
      yearTo: 2020,
    });

    expect(created).toEqual(EDU_2_MAPPED);
    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(createCall.body.operationName).toBe("CREATE_EDUCATION");
    expect(createCall.body.variables).toEqual({
      input: {
        profileId: "p1",
        education: {
          title: "Stanford",
          degree: "MSc",
          fieldOfStudy: "CS",
          location: "Palo Alto",
          yearFrom: 2018,
          yearTo: 2020,
          skills: [],
        },
      },
    });
  });

  it("forwards user-supplied skills verbatim instead of defaulting to []", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [] } } } } });
    replyImpersonated({
      body: {
        data: {
          createEducation: {
            success: true,
            errors: null,
            profile: { id: "p1", educations: { nodes: [EDU_2] } },
          },
        },
      },
    });

    await add(TOKEN, {
      institution: "Stanford",
      degree: "MSc",
      fieldOfStudy: "CS",
      location: "Palo Alto",
      yearFrom: 2018,
      yearTo: 2020,
      skills: [{ id: "V1-Skill-7", name: "Computer Engineering" }],
    });

    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(createCall.body.variables).toEqual({
      input: {
        profileId: "p1",
        education: {
          title: "Stanford",
          degree: "MSc",
          fieldOfStudy: "CS",
          location: "Palo Alto",
          yearFrom: 2018,
          yearTo: 2020,
          skills: [{ id: "V1-Skill-7", name: "Computer Engineering" }],
        },
      },
    });
  });

  it("surfaces user errors as ProfileError(USER_ERROR)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [] } } } } });
    replyImpersonated({
      body: { data: { createEducation: { success: false, errors: [{ message: "bad", key: "institution" }] } } },
    });

    await expect(
      add(TOKEN, { institution: "x", degree: "y", fieldOfStudy: "f", location: "l", yearFrom: 2018, yearTo: 2022 }),
    ).rejects.toMatchObject({
      code: "USER_ERROR",
    });
  });
});

describe("update", () => {
  it("rejects empty fields", async () => {
    await expect(update(TOKEN, "id", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches UPDATE_EDUCATION with merged wire input (read-current + user overrides) (#612)", async () => {
    // read-current step → update mutation. EDU_1 has null `title` on read;
    // the wire `title` slot is populated from `current.institution` (= "MIT").
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [EDU_1] } } } } });
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
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.operationName).toBe("UPDATE_EDUCATION");
    expect(updateCall.body.variables).toEqual({
      input: {
        educationId: EDU_1.id,
        education: {
          title: EDU_1.institution,
          degree: EDU_1.degree,
          highlight: EDU_1.highlight,
          skills: [],
          fieldOfStudy: EDU_1.fieldOfStudy,
          location: EDU_1.location,
          yearFrom: EDU_1.yearFrom,
          yearTo: 2015,
        },
      },
    });
  });

  it("preserves every writable field omitted by the caller (#612 regression: full-replace contract)", async () => {
    // EDU_2 has every writable field populated AND non-empty skills. User
    // updates ONLY highlight=false; pre-#612 the other seven would have nulled.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [EDU_2] } } } } });
    replyImpersonated({
      body: {
        data: {
          updateEducation: {
            success: true,
            errors: null,
            profile: { id: "p1", educations: { nodes: [{ ...EDU_2, highlight: false }] } },
          },
        },
      },
    });

    await update(TOKEN, EDU_2.id, { highlight: false });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.variables).toEqual({
      input: {
        educationId: EDU_2.id,
        education: {
          title: EDU_2.institution,
          degree: EDU_2.degree,
          fieldOfStudy: EDU_2.fieldOfStudy,
          yearFrom: EDU_2.yearFrom,
          yearTo: EDU_2.yearTo,
          skills: EDU_2_MAPPED.skills,
          highlight: false,
        },
      },
    });
  });

  it("read-current failure (id not found) surfaces as VALIDATION_ERROR without firing the update mutation", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [] } } } } });

    await expect(update(TOKEN, "missing", { highlight: true })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("throws ProfileError(UNKNOWN) when row not in update response", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", educations: { nodes: [EDU_1] } } } } });
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

describe("buildUpdateEducationInput", () => {
  const CURRENT_FULL: Education = {
    id: "V1-Education-99",
    institution: "MIT",
    degree: "BSc",
    fieldOfStudy: "Mathematics",
    location: "Cambridge",
    title: "Some thesis title",
    yearFrom: 2010,
    yearTo: 2014,
    highlight: false,
    skills: [{ id: "V1-Skill-1", name: "Math" }],
  };

  it("echoes every writable field from current when caller supplies one override", () => {
    const merged = buildUpdateEducationInput(CURRENT_FULL, { highlight: true });
    expect(merged).toEqual({
      title: "MIT",
      degree: "BSc",
      fieldOfStudy: "Mathematics",
      location: "Cambridge",
      yearFrom: 2010,
      yearTo: 2014,
      skills: [{ id: "V1-Skill-1", name: "Math" }],
      highlight: true,
    });
  });

  it("translates surface institution → wire title (no `institution` slot on EducationInput)", () => {
    const merged = buildUpdateEducationInput(CURRENT_FULL, { institution: "Stanford" });
    expect(merged.title).toBe("Stanford");
    expect(merged).not.toHaveProperty("institution");
  });

  it("omits null-current nullable fields (wire input is non-nullable per capture)", () => {
    const current: Education = {
      ...CURRENT_FULL,
      fieldOfStudy: null,
      location: null,
      yearFrom: null,
      yearTo: null,
    };
    const merged = buildUpdateEducationInput(current, { degree: "MSc" });
    expect(merged).not.toHaveProperty("fieldOfStudy");
    expect(merged).not.toHaveProperty("location");
    expect(merged).not.toHaveProperty("yearFrom");
    expect(merged).not.toHaveProperty("yearTo");
    expect(merged.title).toBe("MIT");
    expect(merged.degree).toBe("MSc");
    expect(merged.skills).toEqual([{ id: "V1-Skill-1", name: "Math" }]);
  });

  it("rejects empty fields", () => {
    expect(() => buildUpdateEducationInput(CURRENT_FULL, {})).toThrowError(/at least one field flag/);
  });
});

describe("toEducationWireInput", () => {
  it("renames institution → title and passes others through", () => {
    expect(toEducationWireInput({ institution: "MIT", degree: "BSc", highlight: true })).toEqual({
      title: "MIT",
      degree: "BSc",
      highlight: true,
    });
  });

  it("omits undefined fields", () => {
    expect(toEducationWireInput({})).toEqual({});
  });
});

describe("DRY_RUN_EDUCATION_FIELD_PLACEHOLDER", () => {
  it("is the canonical placeholder sentinel string", () => {
    expect(DRY_RUN_EDUCATION_FIELD_PLACEHOLDER).toBe("<preserved from current education state>");
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
