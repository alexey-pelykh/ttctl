// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `GetTalentSpecializations` routes through the mobile-gateway surface
// via `stockTransport` (the captured op lives under
// `gateway/operations/portal/` but the gateway endpoint is the same as
// the mobile-side ops — same pattern `payments.summary` (#448) and
// `payments.rate.current` (#447) already follow).
vi.mock("../../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport.js")>("../../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { ProfileError, show } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { stockTransport } from "../../../../transport.js";
import type { TransportResponse } from "../../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-spec-123";

interface MockResponse {
  status?: number;
  body: unknown;
}

function reply(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedStock.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

const SPECIALIZATION_FIXTURE = {
  __typename: "TalentSpecialization",
  id: "spec-core-uuid",
  slug: "core",
  title: "Core",
  description: "The flagship Toptal Core talent network.",
  logoUrl: "https://example.com/badge-core.png",
  applicationStatus: "ACCEPTED",
  eligibleJobsCount: 0,
  applicationCompletedAt: "2024-01-15T12:00:00Z",
  operations: {
    __typename: "TalentSpecializationOperations",
    apply: {
      __typename: "Operation",
      callable: false,
      messages: ["Already a member of this specialization."],
    },
  },
};

beforeEach(() => {
  mockedStock.mockReset();
});

describe("specializations.show (#466 / T1 GetTalentSpecializations)", () => {
  it("dispatches GetTalentSpecializations with empty variables against the mobile-gateway surface", async () => {
    reply({ body: { data: { viewer: { id: "v1", specializations: [SPECIALIZATION_FIXTURE] } } } });
    await show(TOKEN);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.surface).toBe("mobile-gateway");
    expect(call?.authToken).toBe(TOKEN);
    expect(call?.body.operationName).toBe("GetTalentSpecializations");
    // Viewer-scoped — no variables.
    expect(call?.body.variables ?? {}).toEqual({});
  });

  it("projects a single accepted specialization with all fields", async () => {
    reply({ body: { data: { viewer: { id: "v1", specializations: [SPECIALIZATION_FIXTURE] } } } });
    const result = await show(TOKEN);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "spec-core-uuid",
      slug: "core",
      title: "Core",
      description: "The flagship Toptal Core talent network.",
      logoUrl: "https://example.com/badge-core.png",
      applicationStatus: "ACCEPTED",
      eligibleJobsCount: 0,
      applicationCompletedAt: "2024-01-15T12:00:00Z",
      operations: {
        apply: {
          callable: false,
          messages: ["Already a member of this specialization."],
        },
      },
    });
  });

  it("preserves server-supplied row order across multiple specializations", async () => {
    const second = {
      ...SPECIALIZATION_FIXTURE,
      id: "spec-marketplace-uuid",
      slug: "marketplace",
      title: "Marketplace",
    };
    const third = { ...SPECIALIZATION_FIXTURE, id: "spec-expert-uuid", slug: "expert-crowd", title: "Expert Crowd" };
    reply({ body: { data: { viewer: { id: "v1", specializations: [SPECIALIZATION_FIXTURE, second, third] } } } });
    const result = await show(TOKEN);
    expect(result.map((r) => r.slug)).toEqual(["core", "marketplace", "expert-crowd"]);
  });

  it("returns an empty list when viewer.specializations is null (server-side)", async () => {
    reply({ body: { data: { viewer: { id: "v1", specializations: null } } } });
    const result = await show(TOKEN);
    expect(result).toEqual([]);
  });

  it("returns an empty list when viewer.specializations is an empty array", async () => {
    reply({ body: { data: { viewer: { id: "v1", specializations: [] } } } });
    const result = await show(TOKEN);
    expect(result).toEqual([]);
  });

  it("filters out null rows in the wire array (defensive)", async () => {
    reply({ body: { data: { viewer: { id: "v1", specializations: [SPECIALIZATION_FIXTURE, null] } } } });
    const result = await show(TOKEN);
    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("core");
  });

  it("filters out null messages within operations.apply.messages (defensive)", async () => {
    const rowWithNullMessages = {
      ...SPECIALIZATION_FIXTURE,
      operations: { apply: { callable: false, messages: ["valid msg", null, "another"] } },
    };
    reply({ body: { data: { viewer: { id: "v1", specializations: [rowWithNullMessages] } } } });
    const result = await show(TOKEN);
    expect(result[0]?.operations.apply.messages).toEqual(["valid msg", "another"]);
  });

  it("normalises missing optional fields to typed defaults (null/false/empty)", async () => {
    const sparse = {
      id: "spec-sparse",
      slug: null,
      title: null,
      description: null,
      logoUrl: null,
      applicationStatus: null,
      eligibleJobsCount: null,
      applicationCompletedAt: null,
      operations: null,
    };
    reply({ body: { data: { viewer: { id: "v1", specializations: [sparse] } } } });
    const result = await show(TOKEN);
    expect(result).toEqual([
      {
        id: "spec-sparse",
        slug: "",
        title: "",
        description: null,
        logoUrl: null,
        applicationStatus: "",
        eligibleJobsCount: null,
        applicationCompletedAt: null,
        operations: { apply: { callable: false, messages: [] } },
      },
    ]);
  });

  it("throws NO_VIEWER when viewer is null", async () => {
    // Two replies: each `expect().rejects.…` invokes `show(TOKEN)` and
    // consumes one queued mockResolvedValueOnce.
    reply({ body: { data: { viewer: null } } }, { body: { data: { viewer: null } } });
    await expect(show(TOKEN)).rejects.toBeInstanceOf(ProfileError);
    await expect(show(TOKEN)).rejects.toMatchObject({ code: "NO_VIEWER" });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { data: null } });
    await expect(show(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError on top-level extensions.code auth-revoked", async () => {
    reply({
      body: {
        data: null,
        errors: [{ message: "Auth required", extensions: { code: "UNAUTHENTICATED" } }],
      },
    });
    await expect(show(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError(GRAPHQL_ERROR) on non-auth top-level errors", async () => {
    const body = {
      data: null,
      errors: [{ message: "Something broke", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
    };
    reply({ body }, { body });
    await expect(show(TOKEN)).rejects.toMatchObject({ code: "GRAPHQL_ERROR" });
    await expect(show(TOKEN)).rejects.toMatchObject({
      message: expect.stringContaining("Something broke"),
    });
  });

  it("throws ProfileError(NETWORK_ERROR) when the transport itself throws", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNRESET"));
    mockedStock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(show(TOKEN)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(show(TOKEN)).rejects.toMatchObject({ message: expect.stringContaining("ECONNRESET") });
  });
});
