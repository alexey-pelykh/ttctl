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

import { add, employerAutocomplete, highlight, list, remove, show, update } from "../index.js";
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
    expect(rows).toEqual([EMP_1, EMP_2]);
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
});

describe("add", () => {
  it("requires --company and --role", async () => {
    await expect(add(TOKEN, {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(add(TOKEN, { company: "Acme" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches CreateEmployment with profileId + employment input", async () => {
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

    const e = await add(TOKEN, { company: "Globex", position: "Senior Engineer", startDate: 2020 });
    expect(e.id).toBe(EMP_2.id);
    const call = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("CreateEmployment");
    expect(call.body.variables).toEqual({
      input: { profileId: "p1", employment: { company: "Globex", position: "Senior Engineer", startDate: 2020 } },
    });
  });
});

describe("update", () => {
  it("dispatches UpdateEmployment with employmentId + employment input", async () => {
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
