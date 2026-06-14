// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `contracts.list / show` run against the portal surface via
// `impersonatedTransport` (Cloudflare-protected). The `list()` call
// first resolves the user's `profileId` via `extractProfileId(token)`,
// which fans out one mobile-gateway round-trip through
// `stockTransport`. Mock both transports.
vi.mock("../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport/index.js")>("../../../transport/index.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
  };
});

import { ContractsError, list, show } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { impersonatedTransport, stockTransport } from "../../../transport/index.js";
import type { TransportResponse } from "../../../transport/index.js";
import { VIEWER_OK } from "../../profile/__tests__/fixtures.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-abc-123";
// `VIEWER_OK.data.viewer.viewerRole.profileId` — kept in sync with the
// shared fixture; if the fixture changes its profileId, update here.
const PROFILE_ID = "p1";

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

const CONTRACT_FIXTURE = {
  __typename: "Contract",
  id: "ct-1",
  kind: "TOPTAL_DIRECT",
  provider: "TOPTAL",
  status: "SIGNED",
  billingType: "HOURLY",
  signedAt: "2025-12-01T10:00:00Z",
  sentAt: "2025-11-20T09:00:00Z",
  isActive: true,
  verificationDeadline: null,
  title: "Toptal Direct Contract",
};

const CONTRACT_FIXTURE_2 = {
  __typename: "Contract",
  id: "ct-2",
  kind: "MASTER_SERVICE_AGREEMENT",
  provider: "Acme Inc.",
  status: "PENDING",
  billingType: null,
  signedAt: null,
  sentAt: "2026-04-15T08:00:00Z",
  isActive: false,
  verificationDeadline: "2026-06-15T00:00:00Z",
  title: "MSA — Acme Inc.",
};

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
});

describe("contracts.list", () => {
  it("returns the projected contracts on a successful response", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            __typename: "Profile",
            id: PROFILE_ID,
            talent: {
              __typename: "Talent",
              id: "t1",
              contracts: [CONTRACT_FIXTURE, CONTRACT_FIXTURE_2],
            },
          },
        },
      },
    });
    const items = await list(TOKEN);
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("ct-1");
    expect(items[0]?.kind).toBe("TOPTAL_DIRECT");
    expect(items[0]?.status).toBe("SIGNED");
    expect(items[0]?.isActive).toBe(true);
    expect(items[1]?.id).toBe("ct-2");
    expect(items[1]?.title).toBe("MSA — Acme Inc.");
  });

  it("returns [] when profile.talent.contracts is null", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: { profile: { id: PROFILE_ID, talent: { id: "t1", contracts: null } } },
      },
    });
    const items = await list(TOKEN);
    expect(items).toEqual([]);
  });

  it("returns [] when profile.talent.contracts is missing", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, talent: { id: "t1" } } } },
    });
    const items = await list(TOKEN);
    expect(items).toEqual([]);
  });

  it("issues the request against talent-profile surface with operationName GetContracts and the resolved profileId", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, talent: { id: "t1", contracts: [] } } } },
    });
    await list(TOKEN);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    const call = mockedImpersonated.mock.calls[0]?.[0];
    expect(call?.surface).toBe("talent-profile");
    expect(call?.authToken).toBe(TOKEN);
    expect(call?.body).toMatchObject({
      operationName: "GetContracts",
      variables: { profileId: PROFILE_ID },
    });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError when GraphQL errors carry an UNAUTHENTICATED extension code", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        errors: [{ message: "Unauthenticated", extensions: { code: "UNAUTHENTICATED" } }],
      },
    });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ContractsError(GRAPHQL_ERROR) for non-auth top-level errors", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { errors: [{ message: "Boom" }] } });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ContractsError",
      code: "GRAPHQL_ERROR",
    });
  });

  it("throws ContractsError(NO_TALENT) when profile is null", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: null } } });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ContractsError",
      code: "NO_TALENT",
    });
  });

  it("throws ContractsError(NO_TALENT) when profile.talent is null", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: PROFILE_ID, talent: null } } } });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ContractsError",
      code: "NO_TALENT",
    });
  });

  it("throws ContractsError(UNKNOWN) when data is missing", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: {} });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ContractsError",
      code: "UNKNOWN",
    });
  });

  it("throws ContractsError(UNKNOWN) on non-2xx HTTP status (not 401)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ status: 500, body: { error: "internal" } });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ContractsError",
      code: "UNKNOWN",
    });
  });

  it("throws ContractsError(NETWORK_ERROR) when transport throws a non-typed error", async () => {
    replyStock({ body: VIEWER_OK });
    mockedImpersonated.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ContractsError",
      code: "NETWORK_ERROR",
    });
  });

  it("propagates TtctlError subclasses verbatim (e.g., Cf403Error)", async () => {
    // Simulate a transport-level Cloudflare 403 (subclass of TtctlError).
    // The service must NOT wrap it as NETWORK_ERROR — the CLI/MCP surface
    // depends on the typed error reaching `presentTtctlError`.
    replyStock({ body: VIEWER_OK });
    const { Cf403Error } = await import("../../../transport/index.js");
    mockedImpersonated.mockRejectedValueOnce(new Cf403Error("talent-profile", "challenge"));
    await expect(list(TOKEN)).rejects.toBeInstanceOf(Cf403Error);
  });
});

describe("contracts.show", () => {
  it("returns the contract whose id matches", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            __typename: "Profile",
            id: PROFILE_ID,
            talent: {
              __typename: "Talent",
              id: "t1",
              contracts: [CONTRACT_FIXTURE, CONTRACT_FIXTURE_2],
            },
          },
        },
      },
    });
    const item = await show(TOKEN, "ct-2");
    expect(item.id).toBe("ct-2");
    expect(item.kind).toBe("MASTER_SERVICE_AGREEMENT");
    expect(item.status).toBe("PENDING");
  });

  it("throws ContractsError(NOT_FOUND) when no contract matches the id", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: { id: PROFILE_ID, talent: { id: "t1", contracts: [CONTRACT_FIXTURE] } },
        },
      },
    });
    await expect(show(TOKEN, "missing-id")).rejects.toMatchObject({
      name: "ContractsError",
      code: "NOT_FOUND",
    });
  });

  it("throws ContractsError(NOT_FOUND) when contracts is empty", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, talent: { id: "t1", contracts: [] } } } },
    });
    await expect(show(TOKEN, "any-id")).rejects.toMatchObject({
      name: "ContractsError",
      code: "NOT_FOUND",
    });
  });

  it('translates a top-level "Record not found" GraphQL error into NOT_FOUND', async () => {
    // Defensive: if the portal surface ever surfaces unknown-id failures
    // through a top-level GraphQL error (the gateway convention for
    // Relay `node(id:)` lookups), the service must fold it to NOT_FOUND
    // rather than GRAPHQL_ERROR.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: { errors: [{ message: "Record not found" }] },
    });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ContractsError",
      code: "NOT_FOUND",
    });
  });
});

describe("ContractsError", () => {
  it("carries a code and a message", () => {
    const err = new ContractsError("NOT_FOUND", "test message");
    expect(err.name).toBe("ContractsError");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("test message");
  });
});
