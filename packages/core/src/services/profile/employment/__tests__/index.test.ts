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

import {
  add,
  buildUpdateEmploymentInput,
  employerAutocomplete,
  highlight,
  list,
  remove,
  show,
  update,
} from "../index.js";
import type { Employment } from "../index.js";
import { impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";
import { VIEWER_OK } from "../../__tests__/fixtures.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-emp-123";

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

// `EMP_*` are RAW WIRE nodes (what the mock transport returns). `list()`
// / `add()` / `update()` now run them through `mapEmploymentNode`
// (#344), so assertions compare against the `EMP_*_MAPPED` typed
// projections, never the raw fixtures.

// EMP_1: the four #344 fields ABSENT on the wire — exercises the
// mapper's null/empty defaults.
const EMP_1 = {
  id: "V1-Employment-1",
  company: "Acme",
  position: "Engineer",
  companyWebsite: null,
  noWebsite: true,
  startDate: 2018,
  endDate: 2020,
  experienceItems: ["Built things"],
  highlight: false,
  showViaToptal: false,
  toptalRelated: false,
};

const EMP_1_MAPPED = {
  ...EMP_1,
  publicationPermit: null,
  reportingTo: null,
  industries: [],
  primaryGeography: null,
  employerId: null,
  skills: [],
};

// EMP_2: the four #344 fields PRESENT in their nested wire shape —
// `industries { nodes }` connection + `primaryGeography { id code name }`
// object (NOT the scalar `industryIds` / `primaryGeographyId` of the
// write input).
const EMP_2 = {
  id: "V1-Employment-2",
  company: "Globex",
  position: "Senior Engineer",
  companyWebsite: "https://globex.test",
  noWebsite: false,
  startDate: 2020,
  endDate: null,
  experienceItems: ["Led team", "Shipped X"],
  highlight: true,
  showViaToptal: true,
  toptalRelated: false,
  publicationPermit: true,
  reportingTo: "VP Engineering",
  industries: { nodes: [{ id: "V1-Industry-1", name: "Software" }] },
  primaryGeography: { id: "V1-Geo-1", code: "US", name: "United States" },
};

// EMP_2 and its mapped form differ in fields that get projected from
// nested wire connections — `industries { nodes }`, `skills { nodes }`,
// `employer { id }` — to scalar / flat read-side shapes. Spread keeps
// the two in lock-step (mirrors EMP_1_MAPPED above).
const EMP_2_MAPPED = {
  ...EMP_2,
  industries: [{ id: "V1-Industry-1", name: "Software" }],
  employerId: null,
  skills: [],
};

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
});

describe("list", () => {
  it("dispatches GET_WORK_EXPERIENCE keyed by profileId", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1, EMP_2] } } } } });

    const rows = await list(TOKEN);
    expect(rows).toEqual([EMP_1_MAPPED, EMP_2_MAPPED]);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("GET_WORK_EXPERIENCE");
  });
});

describe("show", () => {
  it("returns matching row", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });

    const e = await show(TOKEN, EMP_1.id);
    expect(e.id).toBe(EMP_1.id);
  });

  it("surfaces the #344 read/write-parity fields (publicationPermit, reportingTo, industries, primaryGeography)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_2] } } } } });

    const e = await show(TOKEN, EMP_2.id);
    expect(e).toEqual(EMP_2_MAPPED);
    expect(e.publicationPermit).toBe(true);
    expect(e.reportingTo).toBe("VP Engineering");
    expect(e.industries).toEqual([{ id: "V1-Industry-1", name: "Software" }]);
    expect(e.primaryGeography).toEqual({ id: "V1-Geo-1", code: "US", name: "United States" });
  });

  it("defaults the #344 fields to null/[] when the wire omits them", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });

    const e = await show(TOKEN, EMP_1.id);
    expect(e).toEqual(EMP_1_MAPPED);
    expect(e.publicationPermit).toBeNull();
    expect(e.reportingTo).toBeNull();
    expect(e.industries).toEqual([]);
    expect(e.primaryGeography).toBeNull();
  });
});

describe("add", () => {
  it("requires --company and --role", async () => {
    await expect(add(TOKEN, {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(add(TOKEN, { company: "Acme" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches CreateEmployment with profileId + resolved employerId after autocomplete (1 exact match)", async () => {
    // Autocomplete returns several matches but only one has name
    // exactly equal to the user's query → use its id transparently.
    replyImpersonated({
      body: {
        data: {
          employersAutocomplete: [
            { id: "V1-Employer-9", name: "Globex", city: null, country: null, logoUrl: null, website: null },
            {
              id: "V1-Employer-10",
              name: "Globex Industries",
              city: "LA",
              country: "US",
              logoUrl: null,
              website: null,
            },
            { id: "V1-Employer-11", name: "Globex Records", city: null, country: null, logoUrl: null, website: null },
          ],
        },
      },
    });
    // Apply path: VIEWER_OK (extractProfileId), then list (before), then create.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });
    replyImpersonated({
      body: {
        data: {
          createEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [EMP_1, EMP_2] } },
          },
        },
      },
    });

    const outcome = await add(TOKEN, { company: "Globex", position: "Senior Engineer", startDate: 2020 });
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") throw new Error("unreachable");
    expect(outcome.result.id).toBe(EMP_2.id);
    expect(outcome.result).toEqual(EMP_2_MAPPED);
    // The CreateEmployment call is the LAST impersonated call (calls 0, 2, 3 — call 1 is stock).
    const createCall = mockedImpersonated.mock.calls[2]?.[0] as TransportRequest;
    expect(createCall.body.operationName).toBe("CreateEmployment");
    expect(createCall.body.variables).toEqual({
      input: {
        profileId: "p1",
        employment: {
          experienceItems: [],
          skills: [],
          showViaToptal: true,
          publicationPermit: true,
          company: "Globex",
          position: "Senior Engineer",
          startDate: 2020,
          employerId: "V1-Employer-9",
        },
      },
    });
  });

  it("uses explicit employerId verbatim (bypass — autocomplete NOT fired)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });
    replyImpersonated({
      body: {
        data: {
          createEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [EMP_1, EMP_2] } },
          },
        },
      },
    });

    const outcome = await add(TOKEN, {
      company: "Globex",
      position: "Senior Engineer",
      startDate: 2020,
      employerId: "V1-Employer-42",
    });
    expect(outcome.kind).toBe("created");
    // Verify only TWO impersonated calls: list + create (no autocomplete).
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(createCall.body.operationName).toBe("CreateEmployment");
    const vars = createCall.body.variables as { input: { employment: { employerId: string } } };
    expect(vars.input.employment.employerId).toBe("V1-Employer-42");
  });

  it("rejects with actionable nudge when autocomplete returns 0 matches (empty catalog response)", async () => {
    const emptyMatch = { body: { data: { employersAutocomplete: null } } };
    replyImpersonated(emptyMatch, emptyMatch);
    await expect(add(TOKEN, { company: "Joe's Garage LLC", position: "Lead" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/No employer matched "Joe's Garage LLC"/) as unknown,
    });
    await expect(add(TOKEN, { company: "Joe's Garage LLC", position: "Lead" })).rejects.toMatchObject({
      message: expect.stringContaining("--employer-id") as unknown,
    });
  });

  it("rejects with closest-candidates listing when autocomplete returns fuzzy matches but no exact name match", async () => {
    // Autocomplete returns prefix / fuzzy matches but NONE matches the
    // user's query exactly. Surface the catalog's actual names so the
    // user can refine.
    const fuzzyOnly = {
      body: {
        data: {
          employersAutocomplete: [
            { id: "V1-Employer-1", name: "AcmeCorp Inc", city: "NYC", country: "US", logoUrl: null, website: null },
            { id: "V1-Employer-2", name: "Acme Industries", city: "LA", country: "US", logoUrl: null, website: null },
          ],
        },
      },
    };
    replyImpersonated(fuzzyOnly, fuzzyOnly);
    await expect(add(TOKEN, { company: "Acme", position: "Engineer" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining('No exact match for "Acme"') as unknown,
    });
    await expect(add(TOKEN, { company: "Acme", position: "Engineer" })).rejects.toMatchObject({
      message: expect.stringMatching(/V1-Employer-1.*AcmeCorp Inc.*\(NYC, US\)/s) as unknown,
    });
  });

  it("rejects with duplicates listing when autocomplete returns 2+ exact-name matches", async () => {
    // The catalog has multiple records sharing the user-supplied display
    // name (e.g. regional subsidiaries). Surface only the exact matches.
    const exactDups = {
      body: {
        data: {
          employersAutocomplete: [
            { id: "V1-Employer-1", name: "Toptal", city: "San Francisco", country: "US", logoUrl: null, website: null },
            { id: "V1-Employer-2", name: "Toptal", city: "London", country: "UK", logoUrl: null, website: null },
            { id: "V1-Employer-3", name: "Toptal", city: null, country: null, logoUrl: null, website: null },
            { id: "V1-Employer-4", name: "Toptracer", city: "Dallas", country: "US", logoUrl: null, website: null },
          ],
        },
      },
    };
    replyImpersonated(exactDups, exactDups);

    await expect(add(TOKEN, { company: "Toptal", position: "Engineer" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining('Multiple employers matched "Toptal" exactly') as unknown,
    });
    await expect(add(TOKEN, { company: "Toptal", position: "Engineer" })).rejects.toMatchObject({
      // Disambiguation includes the 3 exact-name records but NOT Toptracer
      // (which is fuzzy-match only).
      message: expect.not.stringContaining("Toptracer") as unknown,
    });
  });

  it("exact-name match is case-insensitive (user types 'anthropic' → 'Anthropic' resolves)", async () => {
    replyImpersonated({
      body: {
        data: {
          employersAutocomplete: [
            {
              id: "V1-Employer-A",
              name: "Anthropic",
              city: "San Francisco",
              country: "US",
              logoUrl: null,
              website: null,
            },
            { id: "V1-Employer-B", name: "Anthropic Records", city: null, country: null, logoUrl: null, website: null },
          ],
        },
      },
    });
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });
    replyImpersonated({
      body: {
        data: {
          createEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [EMP_1, EMP_2] } },
          },
        },
      },
    });

    const outcome = await add(TOKEN, { company: "anthropic", position: "Engineer" });
    expect(outcome.kind).toBe("created");
    const createCall = mockedImpersonated.mock.calls[2]?.[0] as TransportRequest;
    const vars = createCall.body.variables as { input: { employment: { employerId: string } } };
    expect(vars.input.employment.employerId).toBe("V1-Employer-A");
  });

  it("dry-run fires autocomplete + builds preview with resolved employerId, NOT the mutation", async () => {
    replyImpersonated({
      body: {
        data: {
          employersAutocomplete: [
            { id: "V1-Employer-9", name: "Globex", city: null, country: null, logoUrl: null, website: null },
          ],
        },
      },
    });

    const outcome = await add(
      TOKEN,
      { company: "Globex", position: "Senior Engineer", startDate: 2020 },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("unreachable");
    expect(outcome.preview.operationName).toBe("CreateEmployment");
    expect(outcome.preview.surface).toBe("talent-profile");
    expect(outcome.preview.transport).toBe("impersonated");
    const vars = outcome.preview.variables as {
      input: { profileId: string; employment: { company: string; employerId: string } };
    };
    expect(vars.input.employment.employerId).toBe("V1-Employer-9");
    expect(vars.input.employment.company).toBe("Globex");
    expect(vars.input.profileId).toBe("<resolved at send-time from session token>");
    // Only ONE impersonated call: autocomplete. No mutation, no list, no VIEWER_OK.
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("dry-run with explicit employerId fires ZERO network calls (bypass + dry-run)", async () => {
    const outcome = await add(
      TOKEN,
      { company: "Anything", position: "Engineer", employerId: "V1-Employer-42" },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("unreachable");
    const vars = outcome.preview.variables as { input: { employment: { employerId: string } } };
    expect(vars.input.employment.employerId).toBe("V1-Employer-42");
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // #401 — custom (non-catalog) workplace via noEmployer → employerId:null
  // -------------------------------------------------------------------

  it("custom workplace (noEmployer): skips autocomplete, sends employerId:null + free-text company verbatim, defaults preserved", async () => {
    // Apply path: VIEWER_OK (extractProfileId, stock) → list before
    // (impersonated[0]) → create (impersonated[1]). NO autocomplete
    // reply is queued — it must not fire on the custom path.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });
    replyImpersonated({
      body: {
        data: {
          createEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [EMP_1, EMP_2] } },
          },
        },
      },
    });

    const outcome = await add(TOKEN, {
      company: "Custom Place",
      position: "Founder",
      startDate: 2021,
      noEmployer: true,
    });
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") throw new Error("unreachable");

    // Exactly two impersonated calls: list + create. A third (or a
    // calls[0] autocomplete) would mean resolveEmployerId fired.
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(createCall.body.operationName).toBe("CreateEmployment");
    expect(createCall.body.variables).toEqual({
      input: {
        profileId: "p1",
        employment: {
          experienceItems: [],
          skills: [],
          showViaToptal: true,
          publicationPermit: true,
          company: "Custom Place",
          position: "Founder",
          startDate: 2021,
          employerId: null,
        },
      },
    });
    // The request-shaping signal must NOT leak onto the wire — the
    // server rejects unknown EmploymentInput fields. (toEqual above
    // already enforces exact shape; this states the intent explicitly.)
    const emp = (createCall.body.variables as { input: { employment: Record<string, unknown> } }).input.employment;
    expect(emp).not.toHaveProperty("noEmployer");
  });

  it("custom workplace WITH a website: employerId:null + companyWebsite + noWebsite:false coexist (axis independence)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });
    replyImpersonated({
      body: {
        data: {
          createEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [EMP_1, EMP_2] } },
          },
        },
      },
    });

    const outcome = await add(TOKEN, {
      company: "Custom Place",
      position: "Founder",
      startDate: 2021,
      noEmployer: true,
      companyWebsite: "https://custom.example",
      noWebsite: false,
    });
    expect(outcome.kind).toBe("created");
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const emp = (
      createCall.body.variables as {
        input: { employment: { employerId: string | null; companyWebsite: string; noWebsite: boolean } };
      }
    ).input.employment;
    // The two axes are independent: a custom workplace (employerId:null)
    // still carries the supplied website (noWebsite:false honoured).
    expect(emp.employerId).toBeNull();
    expect(emp.companyWebsite).toBe("https://custom.example");
    expect(emp.noWebsite).toBe(false);
  });

  it("custom workplace + dry-run fires ZERO network calls and previews employerId:null", async () => {
    const outcome = await add(
      TOKEN,
      { company: "Custom Place", position: "Founder", noEmployer: true },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("unreachable");
    expect(outcome.preview.operationName).toBe("CreateEmployment");
    const vars = outcome.preview.variables as {
      input: { profileId: string; employment: { employerId: string | null; company: string } };
    };
    expect(vars.input.employment.employerId).toBeNull();
    expect(vars.input.employment.company).toBe("Custom Place");
    // Strip-symmetry with the apply-path test: the `noEmployer` signal
    // is never on the wire on the dry-run path either (structurally
    // guaranteed — same stripped `employment` object feeds both branches).
    expect(vars.input.employment).not.toHaveProperty("noEmployer");
    expect(vars.input.profileId).toBe("<resolved at send-time from session token>");
    // The #401 custom path skips resolveEmployerId entirely — unlike
    // the #395 non-custom dry-run, NO autocomplete read fires here.
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects --no-employer combined with an explicit employerId (VALIDATION_ERROR, no network)", async () => {
    await expect(
      add(TOKEN, { company: "X", position: "Y", noEmployer: true, employerId: "V1-Employer-1" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("cannot also pass --employer-id") as unknown,
    });
    // The contradiction guard fires before any transport.
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });
});

describe("update", () => {
  it("reads current then dispatches UpdateEmployment with the merged employment input (#394)", async () => {
    // Pre-read for the merge: extractProfileId (stockTransport ProfileShow)
    // + listByProfileId (impersonatedTransport GET_WORK_EXPERIENCE) +
    // the update mutation itself.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });
    replyImpersonated({
      body: {
        data: {
          updateEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [{ ...EMP_1, position: "Lead Engineer" }] } },
          },
        },
      },
    });

    const updated = await update(TOKEN, EMP_1.id, { position: "Lead Engineer" });
    expect(updated.position).toBe("Lead Engineer");
    expect(updated).toEqual({ ...EMP_1_MAPPED, position: "Lead Engineer" });

    // The third impersonated call is the UpdateEmployment mutation. Its
    // variables must include the four required-non-null fields injected
    // from current state + the user-supplied `position`. Pre-#394, only
    // `position` was sent and the server rejected the four absent fields
    // as null.
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.operationName).toBe("UpdateEmployment");
    // The merge injects GraphQL-required (4) + Rails-blank gates
    // (company, publicationPermit) + catalog refs (industryIds; employerId
    // / primaryGeographyId / reportingTo only when current has them).
    // EMP_1 (the #344-fields-absent fixture) → industries [], no employer.
    // (#401 WORM limitation: null-employerId rows cannot be updated on
    // the live wire; absence and explicit null both fail the same Rails
    // `.blank?` gate. The merge omits employerId honestly when null.)
    expect(updateCall.body.variables).toEqual({
      input: {
        employmentId: EMP_1.id,
        employment: {
          experienceItems: EMP_1.experienceItems,
          skills: [],
          showViaToptal: EMP_1.showViaToptal,
          startDate: EMP_1.startDate,
          company: EMP_1.company,
          publicationPermit: true,
          industryIds: [],
          position: "Lead Engineer",
        },
      },
    });
  });

  it("preserves the #344 fields on round-trip even when user supplies only one parity field", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_2] } } } } });
    replyImpersonated({
      body: {
        data: {
          updateEmployment: {
            success: true,
            errors: null,
            profile: {
              id: "p1",
              employments: { nodes: [{ ...EMP_2, publicationPermit: false }] },
            },
          },
        },
      },
    });

    // Write side accepts the scalar `publicationPermit` (one of the 14
    // EmploymentFields); the read side echoes it on the mapped row.
    const updated = await update(TOKEN, EMP_2.id, { publicationPermit: false });
    expect(updated.publicationPermit).toBe(false);
    expect(updated.industries).toEqual([{ id: "V1-Industry-1", name: "Software" }]);
    expect(updated.primaryGeography).toEqual({ id: "V1-Geo-1", code: "US", name: "United States" });
    expect(updated.reportingTo).toBe("VP Engineering");
  });

  it("rejects an empty fields object with VALIDATION_ERROR (no read attempt)", async () => {
    await expect(update(TOKEN, EMP_1.id, {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // No transport call was made — empty-fields guard fires before the
    // read.
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("throws VALIDATION_ERROR when current.startDate is null and caller did not supply --from", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [{ ...EMP_1, startDate: null }] } } } },
    });
    await expect(update(TOKEN, EMP_1.id, { position: "X" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    // Read was made (one stock + one impersonated for show), but the
    // update mutation was NOT dispatched (the guard fires before the
    // mutation call).
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("accepts user-supplied --from when current.startDate is null", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [{ ...EMP_1, startDate: null }] } } } },
    });
    replyImpersonated({
      body: {
        data: {
          updateEmployment: {
            success: true,
            errors: null,
            profile: {
              id: "p1",
              employments: { nodes: [{ ...EMP_1, startDate: 2021, position: "X" }] },
            },
          },
        },
      },
    });
    const updated = await update(TOKEN, EMP_1.id, { position: "X", startDate: 2021 });
    expect(updated.position).toBe("X");
    expect(updated.startDate).toBe(2021);
  });
});

describe("buildUpdateEmploymentInput (#394 merge helper)", () => {
  // Build a minimal Employment from EMP_*_MAPPED to drive the helper.
  function fromMapped(mapped: typeof EMP_1_MAPPED | typeof EMP_2_MAPPED): Employment {
    return mapped as Employment;
  }

  it("rejects an empty fields object", () => {
    expect(() => buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), {})).toThrow(/at least one field flag/);
  });

  it("injects the wire-required fields from current when user supplies a different field", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), { position: "Lead" });
    // GraphQL-required-non-null (4): always injected from current.
    expect(merged.experienceItems).toEqual(EMP_1.experienceItems);
    expect(merged.skills).toEqual([]); // EMP_1_MAPPED.skills is []
    expect(merged.showViaToptal).toBe(EMP_1.showViaToptal);
    expect(merged.startDate).toBe(EMP_1.startDate);
    // Rails `.blank?` gates: company + publicationPermit always injected
    // (publicationPermit null → defaults to true).
    expect(merged.company).toBe(EMP_1.company);
    expect(merged.publicationPermit).toBe(true);
    // Catalog refs: industryIds always injected from current.industries;
    // employerId only injected when current has one (EMP_1 has none).
    // (#401 WORM limitation: explicit null was also tried — Toptal's
    // Rails apply path rejects both absence AND explicit null the same
    // way. Custom workplaces are write-once-read-many; the helper
    // honestly omits null employerId rather than send an explicit null
    // that the wire also rejects.)
    expect(merged.industryIds).toEqual([]);
    expect(merged).not.toHaveProperty("employerId");
    // primaryGeographyId / reportingTo only injected when current has
    // non-null value (EMP_1 has neither).
    expect(merged).not.toHaveProperty("primaryGeographyId");
    expect(merged).not.toHaveProperty("reportingTo");
    // User-supplied field wins.
    expect(merged.position).toBe("Lead");
    // Truly-optional fields the caller did not supply are NOT injected.
    expect(merged).not.toHaveProperty("highlight");
    expect(merged).not.toHaveProperty("companyWebsite");
  });

  it("lets user-supplied required-non-null fields override the current-derived defaults", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), {
      experienceItems: ["paragraph 1", "paragraph 2"],
      showViaToptal: false,
      startDate: 2025,
    });
    expect(merged.experienceItems).toEqual(["paragraph 1", "paragraph 2"]);
    expect(merged.showViaToptal).toBe(false);
    expect(merged.startDate).toBe(2025);
    // skills preserved from current (EMP_1_MAPPED.skills is []).
    expect(merged.skills).toEqual([]);
  });

  it("injects employerId, primaryGeographyId, reportingTo when current row has them", () => {
    const merged = buildUpdateEmploymentInput(
      fromMapped({
        ...EMP_2_MAPPED,
        employerId: "V1-Employer-99",
        skills: [{ id: "V1-Skill-1", name: "TypeScript" }],
      } as Employment),
      { position: "Lead" },
    );
    expect(merged.employerId).toBe("V1-Employer-99");
    expect(merged.primaryGeographyId).toBe("V1-Geo-1");
    expect(merged.reportingTo).toBe("VP Engineering");
    expect(merged.industryIds).toEqual(["V1-Industry-1"]);
    expect(merged.skills).toEqual([{ id: "V1-Skill-1", name: "TypeScript" }]);
  });

  it("falls back to [] when current.experienceItems is null", () => {
    const currentWithNullItems = { ...EMP_1_MAPPED, experienceItems: null } as Employment;
    const merged = buildUpdateEmploymentInput(currentWithNullItems, { position: "X" });
    expect(merged.experienceItems).toEqual([]);
  });

  it("throws VALIDATION_ERROR when both current.startDate and fields.startDate are null/undefined", () => {
    const currentWithNullStart = { ...EMP_1_MAPPED, startDate: null } as Employment;
    expect(() => buildUpdateEmploymentInput(currentWithNullStart, { position: "X" })).toThrow(
      /startDate is required and current value is null/,
    );
  });

  it("uses fields.startDate when current.startDate is null but caller supplied --from", () => {
    const currentWithNullStart = { ...EMP_1_MAPPED, startDate: null } as Employment;
    const merged = buildUpdateEmploymentInput(currentWithNullStart, { position: "X", startDate: 2022 });
    expect(merged.startDate).toBe(2022);
  });
});

describe("mapEmploymentNode projection (#344)", () => {
  it("filters malformed industry nodes and tolerates a missing connection", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            employments: {
              nodes: [
                {
                  ...EMP_1,
                  industries: { nodes: [{ id: "ok", name: "Fintech" }, { id: 42 }, { name: "noId" }] },
                  primaryGeography: { code: "FR" },
                },
              ],
            },
          },
        },
      },
    });

    const [e] = await list(TOKEN);
    // Only the well-formed { id, name } node survives the flatMap.
    expect(e?.industries).toEqual([{ id: "ok", name: "Fintech" }]);
    // primaryGeography with no string `id` projects to null.
    expect(e?.primaryGeography).toBeNull();
  });
});

describe("remove", () => {
  it("dispatches RemoveEmployment", async () => {
    replyImpersonated({
      body: {
        data: { removeEmployment: { success: true, errors: null, profile: { id: "p1", employments: { nodes: [] } } } },
      },
    });
    const id = await remove(TOKEN, EMP_1.id);
    expect(id).toBe(EMP_1.id);
  });
});

describe("highlight", () => {
  it("dispatches highlightEmployment", async () => {
    replyImpersonated({
      body: {
        data: { highlightEmployment: { success: true, errors: null, employment: { id: EMP_1.id, highlight: true } } },
      },
    });
    const r = await highlight(TOKEN, EMP_1.id);
    expect(r).toEqual({ id: EMP_1.id, highlight: true });
  });
});

describe("employerAutocomplete", () => {
  it("rejects empty query", async () => {
    await expect(employerAutocomplete(TOKEN, "")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches GET_EMPLOYERS_AUTOCOMPLETE with search + limit", async () => {
    replyImpersonated({
      body: {
        data: {
          employersAutocomplete: [
            { id: "emp-1", name: "Google", city: "MTV", country: "US", logoUrl: null, website: "https://google.com" },
          ],
        },
      },
    });

    const results = await employerAutocomplete(TOKEN, "Google", 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("Google");
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("GET_EMPLOYERS_AUTOCOMPLETE");
    expect(call.body.variables).toEqual({ search: "Google", limit: 5 });
  });

  it("normalizes single-object response into a list", async () => {
    replyImpersonated({
      body: {
        data: {
          employersAutocomplete: {
            id: "emp-1",
            name: "Google",
            city: null,
            country: null,
            logoUrl: null,
            website: null,
          },
        },
      },
    });

    const results = await employerAutocomplete(TOKEN, "Google");
    expect(results).toHaveLength(1);
  });

  it("returns empty array when no matches", async () => {
    replyImpersonated({ body: { data: { employersAutocomplete: null } } });
    const results = await employerAutocomplete(TOKEN, "ZZZ");
    expect(results).toEqual([]);
  });
});
