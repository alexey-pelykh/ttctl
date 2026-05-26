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
  skills as employmentSkills,
  update,
  validateExperienceItems,
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
  // #555: the wire omits `employer` entirely, so the hydrated card
  // projects null — mirrors the employerId null-default above.
  employer: null,
  skills: [],
  managementExperience: null,
  // #554: when the wire omits engagement and isEnterpriseExperience, the
  // mapper projects null for both — mirrors the publicationPermit / reportingTo
  // defaults above. Exercises the typeof-guarded null-default branch.
  engagement: null,
  isEnterpriseExperience: null,
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
  // #554: wire-side `engagement { id }` projects to `{ id: string }`;
  // `isEnterpriseExperience` is a primitive Boolean on the wire.
  engagement: { id: "V1-TalentEngagement-7" },
  isEnterpriseExperience: true,
};

// EMP_2 and its mapped form differ in fields that get projected from
// nested wire connections — `industries { nodes }`, `skills { nodes }`,
// `employer { id }` — to scalar / flat read-side shapes. Spread keeps
// the two in lock-step (mirrors EMP_1_MAPPED above).
const EMP_2_MAPPED = {
  ...EMP_2,
  industries: [{ id: "V1-Industry-1", name: "Software" }],
  employerId: null,
  // #555: EMP_2's wire node carries no `employer` selection either, so
  // the hydrated card projects null.
  employer: null,
  skills: [],
  managementExperience: null,
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
      // #484 anchor: companyWebsite satisfies the CREATE-side gate.
      companyWebsite: "https://custom.test",
      noWebsite: false,
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
          companyWebsite: "https://custom.test",
          noWebsite: false,
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
      // #484: the noEmployer:true path requires an anchor — supply
      // noWebsite:true (the alternative to companyWebsite) so the
      // anchor validator does not fire before dry-run is reached.
      { company: "Custom Place", position: "Founder", noEmployer: true, noWebsite: true },
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

  // #484 — CREATE-side anchor contract: noEmployer:true requires either
  // companyWebsite OR noWebsite:true. Without either, refuse client-side
  // before the wire produces the misleading `employerId: You can't leave
  // this empty` error. See `45-profile-employment-add.e2e.test.ts` for
  // the live-settled empirical evidence.
  it("rejects --no-employer without companyWebsite or noWebsite anchor (#484 VALIDATION_ERROR, no network)", async () => {
    await expect(add(TOKEN, { company: "Custom Place", position: "Founder", noEmployer: true })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("--website") as unknown,
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects --no-employer with companyWebsite:'' (empty-string is not an anchor) (#484)", async () => {
    await expect(
      add(TOKEN, { company: "Custom Place", position: "Founder", noEmployer: true, companyWebsite: "" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("--website") as unknown,
    });
  });

  it("rejects --no-employer with companyWebsite:null (explicit null is not an anchor) (#484)", async () => {
    await expect(
      add(TOKEN, { company: "Custom Place", position: "Founder", noEmployer: true, companyWebsite: null }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("--website") as unknown,
    });
  });

  it("rejects --no-employer with noWebsite:false (explicit false is not an anchor) (#484)", async () => {
    await expect(
      add(TOKEN, { company: "Custom Place", position: "Founder", noEmployer: true, noWebsite: false }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("--website") as unknown,
    });
  });

  it("accepts --no-employer with noWebsite:true (no companyWebsite needed) — the #484 happy path", async () => {
    // Apply path: VIEWER_OK → list (empty before) → create. No
    // autocomplete fires on the noEmployer:true path.
    const EMP_484 = {
      id: "V1-Employment-484",
      company: "Custom Place 484",
      position: "Founder",
      companyWebsite: null,
      noWebsite: true,
      startDate: 2024,
      endDate: null,
      experienceItems: [],
      highlight: false,
      showViaToptal: true,
      toptalRelated: false,
      publicationPermit: true,
      reportingTo: null,
      industries: { nodes: [] },
      primaryGeography: null,
    };
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [] } } } } });
    replyImpersonated({
      body: {
        data: {
          createEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [EMP_484] } },
          },
        },
      },
    });

    const outcome = await add(TOKEN, {
      company: "Custom Place 484",
      position: "Founder",
      startDate: 2024,
      noEmployer: true,
      noWebsite: true,
    });
    expect(outcome.kind).toBe("created");
    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const emp = (
      createCall.body.variables as {
        input: { employment: { employerId: string | null; noWebsite: boolean; companyWebsite?: string } };
      }
    ).input.employment;
    expect(emp.employerId).toBeNull();
    expect(emp.noWebsite).toBe(true);
    // The wire payload carries noWebsite:true with companyWebsite NOT
    // populated (caller never supplied a URL; the anchor is the boolean
    // signal alone).
    expect(emp).not.toHaveProperty("companyWebsite");
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
    // variables must include the five required-non-null fields injected
    // from current state + the user-supplied `position` (which overrides
    // the injected `current.position` via `{ ...merged, ...fields }`).
    // Pre-#394, only `position` was sent and the server rejected the
    // four other required fields as null; #407 added `position` itself
    // to the wire-required set.
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.operationName).toBe("UpdateEmployment");
    expect(updateCall.body.variables).toEqual({
      input: {
        employmentId: EMP_1.id,
        employment: {
          experienceItems: EMP_1.experienceItems,
          skills: [],
          showViaToptal: EMP_1.showViaToptal,
          toptalRelated: EMP_1.toptalRelated,
          highlight: EMP_1.highlight,
          startDate: EMP_1.startDate,
          endDate: EMP_1.endDate,
          company: EMP_1.company,
          publicationPermit: true,
          industryIds: [],
          noWebsite: EMP_1.noWebsite,
          companyWebsite: EMP_1.companyWebsite,
          managementExperience: null,
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
    // GraphQL-required-non-null (5; `position` is the user-supplied
    // override asserted below): always injected from current.
    expect(merged.experienceItems).toEqual(EMP_1.experienceItems);
    expect(merged.skills).toEqual([]); // EMP_1_MAPPED.skills is []
    expect(merged.showViaToptal).toBe(EMP_1.showViaToptal);
    expect(merged.startDate).toBe(EMP_1.startDate);
    // #487 — endDate force-echoed because the wire treats omission as
    // null-set (NOT preservation). EMP_1.endDate is 2020.
    expect(merged.endDate).toBe(EMP_1.endDate);
    // Rails `.blank?` gates: company + publicationPermit always injected
    // (publicationPermit null → defaults to true).
    expect(merged.company).toBe(EMP_1.company);
    expect(merged.publicationPermit).toBe(true);
    expect(merged.industryIds).toEqual([]);
    expect(merged).not.toHaveProperty("employerId");
    expect(merged.noWebsite).toBe(EMP_1.noWebsite);
    expect(merged.companyWebsite).toBe(EMP_1.companyWebsite);
    expect(merged).not.toHaveProperty("primaryGeographyId");
    // #587 — EMP_1_MAPPED.engagement is null, so the merge does not echo
    // an engagementId (omitting keeps an unlinked row unlinked).
    expect(merged).not.toHaveProperty("engagementId");
    expect(merged).not.toHaveProperty("reportingTo");
    expect(merged.position).toBe("Lead");
    expect(merged.toptalRelated).toBe(EMP_1.toptalRelated);
    expect(merged.managementExperience).toBeNull();
    expect(merged.highlight).toBe(EMP_1.highlight);
  });

  // -------------------------------------------------------------------
  // #487 — endDate three-state merge (preserve / clear / set).
  //
  // Pre-#487, `buildUpdateEmploymentInput` did NOT include `endDate` in
  // the `merged` object; the spread `{ ...merged, ...fields }` carried
  // endDate to the wire ONLY when the caller supplied it. The live
  // server treats absence of `endDate` from `UpdateEmploymentInput` as
  // `null` — NOT as "preserve current" — so partial updates of closed
  // roles silently wiped the stored end date (data corruption: "Year –
  // Year" rendered as "Year – Present" on the public profile).
  //
  // Fix: force-echo endDate from current state symmetric to startDate,
  // with explicit `=== undefined` check (NOT `??`) because `null` is
  // an intentional value (caller is marking a previously-closed role
  // as current). Three states must round-trip:
  //   - caller `undefined` → preserve current.endDate (the regression)
  //   - caller `null`      → clear (mark as current role)
  //   - caller `number`    → set to the supplied year
  // -------------------------------------------------------------------

  it("#487 preserves current.endDate when caller omits endDate (the regression)", () => {
    // EMP_1.endDate is 2020 (closed role).
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), { position: "Lead" });
    expect(merged.endDate).toBe(EMP_1.endDate);
  });

  it("#487 lets caller-supplied endDate:null clear the end date (mark as current role)", () => {
    // The intentional `null` value converts a finished role to a
    // current one. Cannot be conflated with "omitted" (which means
    // "preserve current"). `EmploymentFields.endDate?: number | null`
    // declares null as a valid input — round-trip it.
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), { endDate: null });
    expect(merged.endDate).toBeNull();
  });

  it("#487 lets caller-supplied endDate:number override current.endDate", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), { endDate: 2023 });
    expect(merged.endDate).toBe(2023);
  });

  it("#487 preserves null when current.endDate is null and caller omits (open-role idempotency)", () => {
    // Edge case: row with no endDate (current role) being updated for
    // an unrelated field. endDate stays null — the merge sends explicit
    // null rather than omitting, so this is round-trip-safe.
    const currentNullEnd = { ...EMP_1_MAPPED, endDate: null } as Employment;
    const merged = buildUpdateEmploymentInput(currentNullEnd, { position: "X" });
    expect(merged.endDate).toBeNull();
  });

  // #607 — highlight force-echo. Sibling to #487 / #604.

  it("#607 preserves current.highlight=true when caller omits highlight", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_2_MAPPED), { position: "Lead" });
    expect(merged.highlight).toBe(true);
  });

  it("#607 preserves current.highlight=false when caller omits highlight", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), { position: "Lead" });
    expect(merged.highlight).toBe(false);
  });

  it("#607 lets caller-supplied highlight override current.highlight", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), { highlight: true });
    expect(merged.highlight).toBe(true);
  });

  it("lets user-supplied required-non-null fields override the current-derived defaults", () => {
    // Each paragraph must be 50-250 chars (#492 server-side gate) — use
    // realistic in-range content so the validator does not trip here.
    const para1 = "Led a team of five engineers on a payment-platform migration project.";
    const para2 = "Owned the wire-shape regression test pipeline across three downstream services.";
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), {
      experienceItems: [para1, para2],
      showViaToptal: false,
      startDate: 2025,
    });
    expect(merged.experienceItems).toEqual([para1, para2]);
    expect(merged.showViaToptal).toBe(false);
    expect(merged.startDate).toBe(2025);
    // skills preserved from current (EMP_1_MAPPED.skills is []).
    expect(merged.skills).toEqual([]);
  });

  it("injects current.position when the partial update omits position (#407 regression)", () => {
    // Pre-#407, the merge enum never threaded `position` through, so
    // any partial update missing `position` (e.g., the #403 AC#4(b)
    // `{industryIds: [X]}`-only replace) crashed at the wire with
    // `Expected value to not be null` on employment.position.
    // EMP_1_MAPPED.position is "Engineer".
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), {
      industryIds: ["V1-Industry-99"],
    });
    expect(merged.position).toBe(EMP_1.position);
    // User-supplied field still wins (replace-on-supply).
    expect(merged.industryIds).toEqual(["V1-Industry-99"]);
  });

  it("lets user-supplied position override the current-derived default (#407)", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), { position: "Lead" });
    expect(merged.position).toBe("Lead");
  });

  it("injects employerId, engagementId, primaryGeographyId, reportingTo when current row has them", () => {
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
    // #587 — EMP_2_MAPPED.engagement is { id: "V1-TalentEngagement-7" };
    // the merge echoes the nested id back as the scalar engagementId so a
    // partial update preserves the linkage.
    expect(merged.engagementId).toBe("V1-TalentEngagement-7");
    expect(merged.reportingTo).toBe("VP Engineering");
    expect(merged.industryIds).toEqual(["V1-Industry-1"]);
    expect(merged.skills).toEqual([{ id: "V1-Skill-1", name: "TypeScript" }]);
  });

  it("#587 caller-supplied engagementId overrides the current-derived echo", () => {
    // Replace-on-supply: when the caller passes engagementId, it wins over
    // the current row's linkage via the `{ ...merged, ...fields }` spread.
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_2_MAPPED), {
      engagementId: "V1-TalentEngagement-99",
    });
    expect(merged.engagementId).toBe("V1-TalentEngagement-99");
  });

  it("#508 echoes the (noWebsite, companyWebsite) anchor pair from current when current.employerId is null", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), { position: "Lead" });
    expect(merged.noWebsite).toBe(true);
    expect(merged.companyWebsite).toBeNull();
    expect(merged).not.toHaveProperty("employerId");
  });

  it("#508 echoes companyWebsite URL when current is noEmployer WITH a website", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_2_MAPPED), { position: "Lead" });
    expect(merged.noWebsite).toBe(false);
    expect(merged.companyWebsite).toBe("https://globex.test");
    expect(merged).not.toHaveProperty("employerId");
  });

  it("#508 does NOT echo the anchor pair when current has a catalog employerId (#487 preservation)", () => {
    const merged = buildUpdateEmploymentInput(
      fromMapped({
        ...EMP_2_MAPPED,
        employerId: "V1-Employer-99",
      } as Employment),
      { position: "Lead" },
    );
    expect(merged.employerId).toBe("V1-Employer-99");
    expect(merged).not.toHaveProperty("noWebsite");
    expect(merged).not.toHaveProperty("companyWebsite");
  });

  it("#508 lets user-supplied noWebsite/companyWebsite override the anchor echo", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), {
      position: "Lead",
      noWebsite: false,
      companyWebsite: "https://example.com",
    });
    expect(merged.noWebsite).toBe(false);
    expect(merged.companyWebsite).toBe("https://example.com");
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

describe("mapEmploymentNode projection (#554 engagement + isEnterpriseExperience)", () => {
  it("projects engagement {id} and a Boolean isEnterpriseExperience verbatim", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_2] } } } } });

    const [e] = await list(TOKEN);
    expect(e?.engagement).toEqual({ id: "V1-TalentEngagement-7" });
    expect(e?.isEnterpriseExperience).toBe(true);
  });

  it("defaults engagement and isEnterpriseExperience to null when the wire omits them", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });

    const [e] = await list(TOKEN);
    expect(e?.engagement).toBeNull();
    expect(e?.isEnterpriseExperience).toBeNull();
  });

  it("collapses an engagement object without a string id to null", async () => {
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
                  // Wire sent an engagement object but the id slot is non-string;
                  // defensive mapper collapses to null rather than fabricating a partial.
                  engagement: { id: 99 },
                },
              ],
            },
          },
        },
      },
    });

    const [e] = await list(TOKEN);
    expect(e?.engagement).toBeNull();
  });

  it("collapses a non-boolean isEnterpriseExperience value to null", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            employments: {
              nodes: [{ ...EMP_1, isEnterpriseExperience: "true" }],
            },
          },
        },
      },
    });

    const [e] = await list(TOKEN);
    expect(e?.isEnterpriseExperience).toBeNull();
  });
});

describe("mapEmploymentNode projection (#555 employer card)", () => {
  // A fully-populated `employer { … }` wire sub-object — the catalog-
  // resolved happy path.
  const EMPLOYER_WIRE = {
    id: "V1-Employer-1",
    name: "Globex Corp",
    city: "Springfield",
    country: "United States",
    logoUrl: "https://globex.test/logo.png",
    employeeCount: 4200,
    industries: {
      nodes: [
        { id: "V1-Industry-1", name: "Software" },
        { id: "V1-Industry-2", name: "Fintech" },
      ],
    },
  };

  it("projects the full employer card and keeps employerId in lock-step", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [{ ...EMP_1, employer: EMPLOYER_WIRE }] } } } },
    });

    const [e] = await list(TOKEN);
    expect(e?.employer).toEqual({
      id: "V1-Employer-1",
      name: "Globex Corp",
      city: "Springfield",
      country: "United States",
      logoUrl: "https://globex.test/logo.png",
      employeeCount: 4200,
      industries: [
        { id: "V1-Industry-1", name: "Software" },
        { id: "V1-Industry-2", name: "Fintech" },
      ],
    });
    // The flat employerId derives from the same `employer { id }`.
    expect(e?.employerId).toBe("V1-Employer-1");
  });

  it("defaults employer to null when the wire omits it (custom workplace)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", employments: { nodes: [EMP_1] } } } } });

    const [e] = await list(TOKEN);
    expect(e?.employer).toBeNull();
    expect(e?.employerId).toBeNull();
  });

  it("collapses the whole card to null when the employer object has no string id", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            // Wire returned an employer object but the id slot is non-string;
            // the gate collapses the card to null rather than fabricating a
            // partial. employerId collapses identically.
            employments: { nodes: [{ ...EMP_1, employer: { ...EMPLOYER_WIRE, id: 99 } }] },
          },
        },
      },
    });

    const [e] = await list(TOKEN);
    expect(e?.employer).toBeNull();
    expect(e?.employerId).toBeNull();
  });

  it("defends each scalar independently — bad name → '', bad employeeCount → null, missing geo → null, non-array industries → []", async () => {
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
                  employer: {
                    id: "V1-Employer-2",
                    name: 123, // non-string → ""
                    // city / country / logoUrl absent → null
                    employeeCount: "4200", // non-number (e.g. a bucket string) → null
                    industries: null, // non-connection → []
                  },
                },
              ],
            },
          },
        },
      },
    });

    const [e] = await list(TOKEN);
    expect(e?.employer).toEqual({
      id: "V1-Employer-2",
      name: "",
      city: null,
      country: null,
      logoUrl: null,
      employeeCount: null,
      industries: [],
    });
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

// -------------------------------------------------------------------
// #492 — server-side 50-250 char/item gate on experienceItems.
//
// Toptal's `talent_profile/graphql` rejects per-item paragraphs that
// are < 50 or >= 250 characters with USER_ERROR:
//   `employment add rejected (experienceItems): Each item must have at
//    least 50 and less than 250 characters`.
//
// Pre-#492 ttctl did NOT validate client-side. The dryRun preview
// accepted any item length, so an agentic / batch caller drafting a
// description got false confidence — the dryRun read `ok: true`, the
// live call rejected. Closing it requires:
//   - core's `add()` and `buildUpdateEmploymentInput()` to validate
//     BEFORE the wire call AND BEFORE the dryRun branch
//   - a 250-char string (the upper-bound boundary) MUST fail
//     ("less than 250" is server wording; the gate is strict-less-than)
// -------------------------------------------------------------------
describe("validateExperienceItems (#492)", () => {
  const longEnough = (n: number, char = "a") => char.repeat(n);

  it("accepts an empty array (the wire allows experienceItems: [])", () => {
    expect(() => {
      validateExperienceItems([]);
    }).not.toThrow();
  });

  it("accepts a single item exactly at the lower bound (50 chars)", () => {
    expect(() => {
      validateExperienceItems([longEnough(50)]);
    }).not.toThrow();
  });

  it("accepts a single item at the upper-bound interior (249 chars)", () => {
    expect(() => {
      validateExperienceItems([longEnough(249)]);
    }).not.toThrow();
  });

  it("rejects a 49-char item (just below the lower bound)", () => {
    expect(() => {
      validateExperienceItems([longEnough(49)]);
    }).toThrow(/49 characters/);
  });

  it("rejects a 250-char item (server's exclusive upper bound)", () => {
    // The server message reads "less than 250 characters" — strict
    // less-than. 250 itself is rejected.
    expect(() => {
      validateExperienceItems([longEnough(250)]);
    }).toThrow(/250 characters/);
  });

  it("rejects an empty-string item (length 0 < 50)", () => {
    expect(() => {
      validateExperienceItems([""]);
    }).toThrow(/0 characters/);
  });

  it("names the offending paragraph's index when it sits mid-array", () => {
    expect(() => {
      validateExperienceItems([longEnough(60), longEnough(70), longEnough(300), longEnough(80)]);
    }).toThrow(/experienceItems\[2\] is 300 characters/);
  });

  it("error message includes a truncated preview of the offender", () => {
    const tooLong = "X".repeat(300);
    expect(() => {
      validateExperienceItems([tooLong]);
    }).toThrow(/Offending paragraph: "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\.\.\."/);
  });

  it("throws ProfileError with VALIDATION_ERROR code", () => {
    expect(() => {
      validateExperienceItems(["too short"]);
    }).toThrow(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
      }) as unknown as Error,
    );
  });
});

describe("add — #492 experienceItems length gate", () => {
  it("rejects a too-long paragraph BEFORE firing any transport (apply path)", async () => {
    const tooLong = "A".repeat(300);
    await expect(
      add(TOKEN, {
        company: "Globex",
        position: "Senior Engineer",
        employerId: "V1-Employer-9",
        experienceItems: [tooLong],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/experienceItems\[0\] is 300 characters/) as unknown,
    });
    // The gate must fire before any wire I/O — no list, no autocomplete,
    // no mutation.
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects a too-short paragraph in dryRun (the false-confidence gap from #492)", async () => {
    const tooShort = "short text";
    // Even on dry-run, the validator must fire — pre-#492 the dryRun
    // would have returned ok:true and the live wire would have
    // rejected. Now both paths reject identically.
    await expect(
      add(
        TOKEN,
        {
          company: "Globex",
          position: "Senior Engineer",
          employerId: "V1-Employer-9",
          experienceItems: [tooShort],
        },
        { dryRun: true },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/experienceItems\[0\] is 10 characters/) as unknown,
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects a 250-char paragraph (strict upper bound — 'less than 250 characters')", async () => {
    await expect(
      add(
        TOKEN,
        {
          company: "Globex",
          position: "Senior Engineer",
          employerId: "V1-Employer-9",
          experienceItems: ["B".repeat(250)],
        },
        { dryRun: true },
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/250 characters/) as unknown,
    });
  });

  it("rejects when ONE item in a multi-paragraph array is out of range (mid-array offender)", async () => {
    await expect(
      add(TOKEN, {
        company: "Globex",
        position: "Senior Engineer",
        employerId: "V1-Employer-9",
        experienceItems: [
          "A".repeat(60),
          "B".repeat(70),
          "C".repeat(40), // below the lower bound
          "D".repeat(80),
        ],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/experienceItems\[2\] is 40 characters/) as unknown,
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("accepts an in-range multi-paragraph array (boundary 50 + interior 249) on dryRun", async () => {
    const outcome = await add(
      TOKEN,
      {
        company: "Globex",
        position: "Senior Engineer",
        employerId: "V1-Employer-9",
        experienceItems: ["A".repeat(50), "B".repeat(120), "C".repeat(249)],
      },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("unreachable");
    const vars = outcome.preview.variables as {
      input: { employment: { experienceItems: string[] } };
    };
    expect(vars.input.employment.experienceItems).toHaveLength(3);
    // No autocomplete fires (explicit employerId bypass + dry-run).
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });
});

describe("buildUpdateEmploymentInput — #492 experienceItems length gate", () => {
  function fromMapped(mapped: typeof EMP_1_MAPPED): Employment {
    return mapped as Employment;
  }

  it("rejects a too-long paragraph supplied by the caller (the false-confidence gap from #492)", () => {
    expect(() =>
      buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), {
        experienceItems: ["X".repeat(300)],
      }),
    ).toThrow(/experienceItems\[0\] is 300 characters/);
  });

  it("rejects a too-short paragraph supplied by the caller", () => {
    expect(() =>
      buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), {
        experienceItems: ["short"],
      }),
    ).toThrow(/experienceItems\[0\] is 5 characters/);
  });

  it("preserves current.experienceItems through the merge when caller omits the field (no validation needed)", () => {
    // Pre-#492 sanity: when the caller does NOT supply experienceItems,
    // the merge injects current.experienceItems verbatim (server-vetted
    // state already; the validator is for caller-supplied input). The
    // length gate must NOT trip on the read-current echo path even if
    // the current row carries items outside the bounds (which can
    // happen for legacy data).
    const legacyShort = { ...EMP_1_MAPPED, experienceItems: ["legacy"] } as Employment;
    const merged = buildUpdateEmploymentInput(legacyShort, { position: "Lead" });
    expect(merged.experienceItems).toEqual(["legacy"]);
  });

  it("accepts caller-supplied in-range items (boundary 50 + interior 249)", () => {
    const merged = buildUpdateEmploymentInput(fromMapped(EMP_1_MAPPED), {
      experienceItems: ["A".repeat(50), "B".repeat(249)],
    });
    expect(merged.experienceItems).toEqual(["A".repeat(50), "B".repeat(249)]);
  });
});

// -------------------------------------------------------------------
// skills.add / skills.remove — additive merge ops (#614)
//
// Both ops wrap `update()` with read-merge-write: read the current
// employment, compute the merged/filtered skills array, write back.
// The tests assert:
//   - id sanitization (empty input rejected; whitespace stripped)
//   - dedupe (add) / filter (remove) semantics
//   - idempotent noop branches (no wire mutation fires)
//   - refusal when remove would leave an empty skill set
//   - dryRun preview shape mirrors the apply-path wire input
// -------------------------------------------------------------------

const EMP_WITH_SKILLS = {
  ...EMP_2_MAPPED,
  skills: [
    { id: "V1-ProfileSkillSet-1", name: "TypeScript" },
    { id: "V1-ProfileSkillSet-2", name: "React" },
  ],
  industries: [{ id: "V1-Industry-1", name: "Software" }],
} as Employment;

const EMP_WITH_SKILLS_WIRE = {
  id: EMP_WITH_SKILLS.id,
  company: EMP_WITH_SKILLS.company,
  position: EMP_WITH_SKILLS.position,
  companyWebsite: EMP_WITH_SKILLS.companyWebsite,
  noWebsite: EMP_WITH_SKILLS.noWebsite,
  startDate: EMP_WITH_SKILLS.startDate,
  endDate: EMP_WITH_SKILLS.endDate,
  experienceItems: EMP_WITH_SKILLS.experienceItems,
  highlight: EMP_WITH_SKILLS.highlight,
  showViaToptal: EMP_WITH_SKILLS.showViaToptal,
  toptalRelated: EMP_WITH_SKILLS.toptalRelated,
  publicationPermit: EMP_WITH_SKILLS.publicationPermit,
  reportingTo: EMP_WITH_SKILLS.reportingTo,
  industries: { nodes: EMP_WITH_SKILLS.industries },
  primaryGeography: EMP_WITH_SKILLS.primaryGeography,
  skills: { nodes: EMP_WITH_SKILLS.skills },
  engagement: EMP_WITH_SKILLS.engagement,
  isEnterpriseExperience: EMP_WITH_SKILLS.isEnterpriseExperience,
};

describe("skills.add (#614)", () => {
  it("rejects an empty skillSetIds array (no wire I/O)", async () => {
    await expect(employmentSkills.add(TOKEN, EMP_WITH_SKILLS.id, { skillSetIds: [] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects an array of empty/whitespace ids", async () => {
    await expect(
      employmentSkills.add(TOKEN, EMP_WITH_SKILLS.id, { skillSetIds: [" ", "\t", ""] }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("returns noop without firing UpdateEmployment when all supplied ids are already linked", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });

    const outcome = await employmentSkills.add(TOKEN, EMP_WITH_SKILLS.id, {
      skillSetIds: ["V1-ProfileSkillSet-1", "V1-ProfileSkillSet-2"],
    });
    expect(outcome.kind).toBe("noop");
    if (outcome.kind !== "noop") throw new Error("unreachable");
    expect(outcome.result.skills).toEqual(EMP_WITH_SKILLS.skills);
    // Two transport calls total: stockTransport for viewer, impersonated for GET_WORK_EXPERIENCE.
    // NO third call (UpdateEmployment) because every id was already linked.
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("merges new ids onto the existing set, preserving current order then appending new", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });
    // After the update, the wire echoes back the row with the merged skills.
    const merged = [
      ...EMP_WITH_SKILLS.skills,
      { id: "V1-ProfileSkillSet-3", name: "" },
      { id: "V1-ProfileSkillSet-4", name: "" },
    ];
    const mergedWire = { ...EMP_WITH_SKILLS_WIRE, skills: { nodes: merged } };
    replyImpersonated({
      body: {
        data: {
          updateEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [mergedWire] } },
          },
        },
      },
    });

    const outcome = await employmentSkills.add(TOKEN, EMP_WITH_SKILLS.id, {
      skillSetIds: ["V1-ProfileSkillSet-3", "V1-ProfileSkillSet-4"],
    });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("unreachable");

    // Verify the wire input carried the merged list (existing 2 + new 2).
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.operationName).toBe("UpdateEmployment");
    const sent = updateCall.body.variables as {
      input: { employment: { skills: { id: string; name: string }[] } };
    };
    expect(sent.input.employment.skills).toEqual([
      { id: "V1-ProfileSkillSet-1", name: "TypeScript" },
      { id: "V1-ProfileSkillSet-2", name: "React" },
      { id: "V1-ProfileSkillSet-3", name: "" },
      { id: "V1-ProfileSkillSet-4", name: "" },
    ]);
  });

  it("dedupes against current set when caller supplies a mix of present + new ids", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });
    const mergedWire = {
      ...EMP_WITH_SKILLS_WIRE,
      skills: { nodes: [...EMP_WITH_SKILLS.skills, { id: "V1-ProfileSkillSet-5", name: "" }] },
    };
    replyImpersonated({
      body: {
        data: {
          updateEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [mergedWire] } },
          },
        },
      },
    });

    await employmentSkills.add(TOKEN, EMP_WITH_SKILLS.id, {
      skillSetIds: ["V1-ProfileSkillSet-1", "V1-ProfileSkillSet-5"],
    });
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const sent = updateCall.body.variables as {
      input: { employment: { skills: { id: string; name: string }[] } };
    };
    // Only the genuinely-new id is appended; the duplicate is skipped.
    expect(sent.input.employment.skills.map((s) => s.id)).toEqual([
      "V1-ProfileSkillSet-1",
      "V1-ProfileSkillSet-2",
      "V1-ProfileSkillSet-5",
    ]);
  });

  it("dedupes caller-supplied duplicates against each other (single appended entry on the wire)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });
    const mergedWire = {
      ...EMP_WITH_SKILLS_WIRE,
      skills: { nodes: [...EMP_WITH_SKILLS.skills, { id: "V1-ProfileSkillSet-7", name: "" }] },
    };
    replyImpersonated({
      body: {
        data: {
          updateEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [mergedWire] } },
          },
        },
      },
    });

    await employmentSkills.add(TOKEN, EMP_WITH_SKILLS.id, {
      skillSetIds: ["V1-ProfileSkillSet-7", "V1-ProfileSkillSet-7", "V1-ProfileSkillSet-1"],
    });
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const sent = updateCall.body.variables as {
      input: { employment: { skills: { id: string; name: string }[] } };
    };
    // V1-ProfileSkillSet-7 appears exactly once; the already-linked
    // V1-ProfileSkillSet-1 is skipped.
    expect(sent.input.employment.skills.map((s) => s.id)).toEqual([
      "V1-ProfileSkillSet-1",
      "V1-ProfileSkillSet-2",
      "V1-ProfileSkillSet-7",
    ]);
  });

  it("emits a dryRun preview matching the merged UpdateEmployment payload", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });

    const outcome = await employmentSkills.add(
      TOKEN,
      EMP_WITH_SKILLS.id,
      { skillSetIds: ["V1-ProfileSkillSet-9"] },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("unreachable");
    expect(outcome.preview.operationName).toBe("UpdateEmployment");
    const vars = outcome.preview.variables as {
      input: { employment: { skills: { id: string; name: string }[] } };
    };
    expect(vars.input.employment.skills.map((s) => s.id)).toEqual([
      "V1-ProfileSkillSet-1",
      "V1-ProfileSkillSet-2",
      "V1-ProfileSkillSet-9",
    ]);
    // Only the read fires; the mutation transport is NOT invoked.
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });
});

describe("skills.remove (#614)", () => {
  it("rejects an empty skillSetIds array (no wire I/O)", async () => {
    await expect(employmentSkills.remove(TOKEN, EMP_WITH_SKILLS.id, { skillSetIds: [] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("returns noop when none of the supplied ids are currently linked", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });

    const outcome = await employmentSkills.remove(TOKEN, EMP_WITH_SKILLS.id, {
      skillSetIds: ["V1-ProfileSkillSet-99"],
    });
    expect(outcome.kind).toBe("noop");
    if (outcome.kind !== "noop") throw new Error("unreachable");
    // Only the read fired; no UpdateEmployment call.
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("filters the supplied ids out of the row's current set", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });
    const filtered = [{ id: "V1-ProfileSkillSet-2", name: "React" }];
    const filteredWire = { ...EMP_WITH_SKILLS_WIRE, skills: { nodes: filtered } };
    replyImpersonated({
      body: {
        data: {
          updateEmployment: {
            success: true,
            errors: null,
            profile: { id: "p1", employments: { nodes: [filteredWire] } },
          },
        },
      },
    });

    const outcome = await employmentSkills.remove(TOKEN, EMP_WITH_SKILLS.id, {
      skillSetIds: ["V1-ProfileSkillSet-1"],
    });
    expect(outcome.kind).toBe("updated");
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.operationName).toBe("UpdateEmployment");
    const sent = updateCall.body.variables as {
      input: { employment: { skills: { id: string; name: string }[] } };
    };
    expect(sent.input.employment.skills).toEqual(filtered);
  });

  it("refuses VALIDATION_ERROR when filtered result would be empty (no wire mutation)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });

    await expect(
      employmentSkills.remove(TOKEN, EMP_WITH_SKILLS.id, {
        skillSetIds: ["V1-ProfileSkillSet-1", "V1-ProfileSkillSet-2"],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/zero skills/) as unknown,
    });
    // Only the read fires; the would-be empty mutation is rejected client-side.
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("dryRun previews the filtered shape without firing the mutation", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", employments: { nodes: [EMP_WITH_SKILLS_WIRE] } } } },
    });

    const outcome = await employmentSkills.remove(
      TOKEN,
      EMP_WITH_SKILLS.id,
      { skillSetIds: ["V1-ProfileSkillSet-1"] },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("unreachable");
    const vars = outcome.preview.variables as {
      input: { employment: { skills: { id: string; name: string }[] } };
    };
    expect(vars.input.employment.skills.map((s) => s.id)).toEqual(["V1-ProfileSkillSet-2"]);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });
});
