// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `me.actions.list` runs against the mobile-gateway surface via
// `stockTransport` (plain HTTPS). Mock that transport.
vi.mock("../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport/index.js")>("../../../transport/index.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { actions } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport/index.js";
import type { TransportResponse } from "../../../transport/index.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-abc-123";

function replyStock(body: unknown, status = 200): void {
  mockedStock.mockResolvedValueOnce({ status, headers: {}, body } satisfies TransportResponse);
}

/** Wrap a `performedActions` list in the full `viewer.viewerRole` envelope. */
function viewerWith(performedActions: unknown): unknown {
  return { data: { viewer: { id: "viewer-1", viewerRole: { roleId: 7, performedActions } } } };
}

const ACTION_FIXTURE = {
  id: "act-1",
  category: "APPLICATION",
  description: {
    template: "You applied to {{job}}",
    variables: [{ name: "job", text: "Senior Engineer" }],
  },
  occurredAt: "2026-05-01T12:34:56Z",
};

beforeEach(() => {
  mockedStock.mockReset();
});

describe("me.actions.list", () => {
  it("projects a full action with nested description + variables", async () => {
    replyStock(viewerWith([ACTION_FIXTURE]));
    const result = await actions.list(TOKEN);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "act-1",
      category: "APPLICATION",
      description: {
        template: "You applied to {{job}}",
        variables: [{ name: "job", text: "Senior Engineer" }],
      },
      occurredAt: "2026-05-01T12:34:56Z",
    });
  });

  it("returns an empty array when there are no performed actions", async () => {
    replyStock(viewerWith([]));
    expect(await actions.list(TOKEN)).toEqual([]);
  });

  it("returns an empty array when performedActions is null", async () => {
    replyStock(viewerWith(null));
    expect(await actions.list(TOKEN)).toEqual([]);
  });

  it("returns an empty array when viewerRole is null", async () => {
    replyStock({ data: { viewer: { id: "viewer-1", viewerRole: null } } });
    expect(await actions.list(TOKEN)).toEqual([]);
  });

  it("throws MeError(NO_VIEWER) when viewer is null", async () => {
    replyStock({ data: { viewer: null } });
    await expect(actions.list(TOKEN)).rejects.toMatchObject({
      name: "MeError",
      code: "NO_VIEWER",
    });
  });

  it("coalesces null scalars, null description, and filters null variable entries", async () => {
    replyStock(
      viewerWith([
        { id: "act-min", category: null, description: null, occurredAt: null },
        {
          id: "act-vars",
          category: "STATUS",
          description: { template: null, variables: [null, { name: null, text: null }] },
          occurredAt: "2026-05-02T00:00:00Z",
        },
      ]),
    );
    const result = await actions.list(TOKEN);
    expect(result[0]).toEqual({ id: "act-min", category: null, description: null, occurredAt: null });
    expect(result[1]).toEqual({
      id: "act-vars",
      category: "STATUS",
      description: { template: null, variables: [{ name: null, text: null }] },
      occurredAt: "2026-05-02T00:00:00Z",
    });
  });

  it("passes before/after/limit through as wire variables (row-5 bare cursor)", async () => {
    replyStock(viewerWith([]));
    await actions.list(TOKEN, { before: "cur-b", after: "cur-a", limit: 25 });
    const req = mockedStock.mock.calls[0]?.[0] as { body: { operationName: string; variables: unknown } };
    expect(req.body.operationName).toBe("GetPerformedActions");
    expect(req.body.variables).toEqual({ before: "cur-b", after: "cur-a", limit: 25 });
  });

  it("nulls omitted pagination args (no wrapper, all three keys present)", async () => {
    replyStock(viewerWith([]));
    await actions.list(TOKEN);
    const req = mockedStock.mock.calls[0]?.[0] as { body: { variables: unknown } };
    expect(req.body.variables).toEqual({ before: null, after: null, limit: null });
  });

  it("propagates AuthRevokedError on HTTP 401", async () => {
    replyStock({}, 401);
    await expect(actions.list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});
