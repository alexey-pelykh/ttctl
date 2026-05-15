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

const IND_2 = {
  id: "V1-IndustryProfile-2",
  title: "Finance",
  about: null,
  domainArea: "Frontend",
};

/**
 * Helper: produce a `ListIndustryProfiles` response body for a given
 * rows array. Centralizes the post-#321 envelope shape so every test
 * uses the same structural baseline.
 */
function listBody(rows: (typeof IND_1)[]): unknown {
  return { data: { profile: { id: "p1", industryProfiles: { nodes: rows } } } };
}

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
});

describe("list", () => {
  it("queries industryProfiles by profileId and returns the nodes array", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: listBody([IND_1, IND_2]) });

    const rows = await list(TOKEN);
    expect(rows).toEqual([IND_1, IND_2]);
  });

  it("returns [] when nodes is an empty array (legitimate zero-industries account)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: listBody([]) });

    const rows = await list(TOKEN);
    expect(rows).toEqual([]);
  });

  it("throws GRAPHQL_ERROR when data.profile is null (wire-shape mismatch — AC #6)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: null } } });

    await expect(list(TOKEN)).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("no `data.profile`"),
    });
  });

  it("throws GRAPHQL_ERROR when industryProfiles field is missing (wire-shape mismatch — AC #6)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1" } } } });

    await expect(list(TOKEN)).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("`industryProfiles`"),
    });
  });

  it("throws GRAPHQL_ERROR when nodes is non-array (wire-shape mismatch — AC #6)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", industryProfiles: { nodes: null } } } } });

    await expect(list(TOKEN)).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("non-array"),
    });
  });

  it("filters out null entries inside the nodes array", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: "p1", industryProfiles: { nodes: [IND_1, null, IND_2] } } } },
    });
    const rows = await list(TOKEN);
    expect(rows).toEqual([IND_1, IND_2]);
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

  it("creates the row via CreateIndustryProfile, then reads back via pre/post list set-diff", async () => {
    // extractProfileId (single basic-show via the shared profileId path).
    replyStock({ body: VIEWER_OK });
    // pre-list query.
    replyImpersonated({ body: listBody([IND_1]) });
    // mutation — payload is `{ success, errors }` only.
    replyImpersonated({
      body: {
        data: {
          createIndustryProfile: { success: true, errors: null },
        },
      },
    });
    // post-list query — IND_2 is the newly-added row.
    replyImpersonated({ body: listBody([IND_1, IND_2]) });

    const created = await add(TOKEN, { title: "Finance", domainArea: "Frontend" });
    expect(created).toEqual(IND_2);

    // Verify the mutation wire shape — operationName + flat input envelope
    // verified live 2026-05-16 (#321): { profileId, title, about, domainArea,
    // highlights, educations, employments, certifications, portfolioItems }.
    // Call indices: [0] pre-list, [1] mutation, [2] post-list.
    const mutationCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(mutationCall.body.operationName).toBe("CreateIndustryProfile");
    expect(mutationCall.body.variables).toEqual({
      input: {
        profileId: "p1",
        title: "Finance",
        about: "",
        domainArea: "Frontend",
        highlights: [],
        educations: [],
        employments: [],
        certifications: [],
        portfolioItems: [],
      },
    });
  });

  it("throws UNKNOWN when the post-list does not surface the new row", async () => {
    // extractProfileId + pre-list.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: listBody([IND_1]) });
    // mutation success.
    replyImpersonated({
      body: { data: { createIndustryProfile: { success: true, errors: null } } },
    });
    // post-list — same as pre-list (server filtered the row out? wire regression?).
    replyImpersonated({ body: listBody([IND_1]) });

    await expect(add(TOKEN, { title: "Finance", domainArea: "Frontend" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("no new row appeared"),
    });
  });

  it("propagates USER_ERROR from the mutation payload's `errors` array", async () => {
    // extractProfileId + pre-list.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: listBody([]) });
    // mutation reports success: false with structured user errors.
    replyImpersonated({
      body: {
        data: {
          createIndustryProfile: {
            success: false,
            errors: [{ code: "INVALID", key: "title", message: "title is taken" }],
          },
        },
      },
    });

    await expect(add(TOKEN, { title: "Duplicate", domainArea: "D" })).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("title is taken"),
    });
  });
});

describe("update", () => {
  it("rejects empty fields", async () => {
    await expect(update(TOKEN, "id", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("partial-update over server-side full-replace: shows current, merges, dispatches, reads back", async () => {
    // pre-show — fetch current row to merge into.
    replyImpersonated({ body: { data: { node: IND_1 } } });
    // mutation.
    replyImpersonated({
      body: { data: { updateIndustryProfile: { success: true, errors: null } } },
    });
    // post-show — returns the updated entity.
    const UPDATED = { ...IND_1, about: "Updated" };
    replyImpersonated({ body: { data: { node: UPDATED } } });

    const updated = await update(TOKEN, IND_1.id, { about: "Updated" });
    expect(updated.about).toBe("Updated");

    // Verify mutation wire-shape — flat input envelope verified live
    // 2026-05-16 (#321). Title and domainArea preserved from the
    // pre-show fetch (partial-update merge); the user supplied only
    // `about` so the other fields fall back to the current row's
    // values rather than being clobbered to empty strings.
    const mutationCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(mutationCall.body.operationName).toBe("UpdateIndustryProfile");
    expect(mutationCall.body.variables).toEqual({
      input: {
        industryProfileId: IND_1.id,
        title: IND_1.title,
        about: "Updated",
        domainArea: IND_1.domainArea,
        highlights: [],
        educations: [],
        employments: [],
        certifications: [],
        portfolioItems: [],
      },
    });
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
