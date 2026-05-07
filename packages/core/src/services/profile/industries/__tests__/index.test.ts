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

import { add, autocomplete, list, remove, show, update } from "../index.js";
import { impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";
import { VIEWER_OK } from "../../__tests__/fixtures.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-ind-123";

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

const IND_1 = {
  id: "V1-IndustryProfile-1",
  title: "Healthcare",
  about: null,
  domainArea: "Backend",
};

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
});

describe("list", () => {
  it("queries industryProfiles by profileId", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", industryProfiles: { nodes: [IND_1] } } } } });

    const rows = await list(TOKEN);
    expect(rows).toEqual([IND_1]);
  });
});

describe("show", () => {
  it("queries node(id) and returns IndustryProfile fragment", async () => {
    replyImpersonated({ body: { data: { node: IND_1 } } });

    const i = await show(TOKEN, IND_1.id);
    expect(i).toEqual(IND_1);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("GetIndustryProfile");
    expect(call.body.variables).toEqual({ id: IND_1.id });
  });

  it("throws VALIDATION_ERROR when node is null", async () => {
    replyImpersonated({ body: { data: { node: null } } });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("add", () => {
  it("requires --name (title)", async () => {
    await expect(add(TOKEN, {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches CreateIndustryProfile with profileId + industryProfile input", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          createIndustryProfile: { success: true, errors: null, industryProfile: IND_1 },
        },
      },
    });

    const created = await add(TOKEN, { title: "Healthcare", domainArea: "Backend" });
    expect(created).toEqual(IND_1);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("CreateIndustryProfile");
    expect(call.body.variables).toEqual({
      input: { profileId: "p1", industryProfile: { title: "Healthcare", domainArea: "Backend" } },
    });
  });
});

describe("update", () => {
  it("rejects empty fields", async () => {
    await expect(update(TOKEN, "id", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches UpdateIndustryProfile", async () => {
    replyImpersonated({
      body: {
        data: {
          updateIndustryProfile: {
            success: true,
            errors: null,
            industryProfile: { ...IND_1, about: "Updated" },
          },
        },
      },
    });
    const updated = await update(TOKEN, IND_1.id, { about: "Updated" });
    expect(updated.about).toBe("Updated");
  });
});

describe("remove", () => {
  it("dispatches RemoveIndustryProfile", async () => {
    replyImpersonated({
      body: { data: { removeIndustryProfile: { success: true, errors: null } } },
    });
    const id = await remove(TOKEN, IND_1.id);
    expect(id).toBe(IND_1.id);
  });
});

describe("autocomplete", () => {
  it("rejects empty query", async () => {
    await expect(autocomplete(TOKEN, "")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches GET_INDUSTRIES_FOR_AUTOCOMPLETE with search + limit", async () => {
    replyImpersonated({
      body: {
        data: {
          industriesAutocomplete: [{ id: "ind-1", name: "Healthcare" }],
        },
      },
    });

    const r = await autocomplete(TOKEN, "Health", { limit: 5 });
    expect(r).toEqual([{ id: "ind-1", name: "Healthcare" }]);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("GET_INDUSTRIES_FOR_AUTOCOMPLETE");
    expect(call.body.variables).toEqual({ search: "Health", limit: 5 });
  });

  it("includes withoutIds when supplied", async () => {
    replyImpersonated({
      body: {
        data: { industriesAutocomplete: [] },
      },
    });
    await autocomplete(TOKEN, "X", { withoutIds: ["ind-1", "ind-2"] });
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect((call.body.variables as { withoutIds?: string[] }).withoutIds).toEqual(["ind-1", "ind-2"]);
  });

  it("normalizes single-object response into list", async () => {
    replyImpersonated({
      body: { data: { industriesAutocomplete: { id: "ind-1", name: "X" } } },
    });
    const r = await autocomplete(TOKEN, "X");
    expect(r).toHaveLength(1);
  });
});
