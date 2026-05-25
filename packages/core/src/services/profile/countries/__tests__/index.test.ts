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

import { list } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { impersonatedTransport } from "../../../../transport.js";
import type { TransportResponse } from "../../../../transport.js";

const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-countries-123";

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("profile.countries.list", () => {
  it("issues getCountries on the talent-profile surface and projects the catalog", async () => {
    replyImpersonated({
      body: {
        data: {
          countries: [
            { id: "VjEtQ291bnRyeS0yMzQ", code: "US", name: "United States" },
            { id: "VjEtQ291bnRyeS0z", code: "CA", name: "Canada" },
          ],
        },
      },
    });

    const result = await list(TOKEN);

    expect(result).toEqual([
      { id: "VjEtQ291bnRyeS0yMzQ", code: "US", name: "United States" },
      { id: "VjEtQ291bnRyeS0z", code: "CA", name: "Canada" },
    ]);

    const call = mockedImpersonated.mock.calls[0]?.[0];
    expect(call?.surface).toBe("talent-profile");
    expect(call?.authToken).toBe(TOKEN);
    expect(call?.body.operationName).toBe("getCountries");
  });

  it("defaults missing code / name to null and skips rows without a usable id", async () => {
    replyImpersonated({
      body: {
        data: {
          countries: [
            { id: "VjEtQ291bnRyeS0x" }, // no code / name
            { id: "", code: "ZZ", name: "Dropped (empty id)" }, // skipped
            { code: "ZZ", name: "Dropped (no id)" }, // skipped
            null, // skipped
            { id: "VjEtQ291bnRyeS0y", code: 123, name: 456 }, // non-string code/name → null
          ],
        },
      },
    });

    const result = await list(TOKEN);

    expect(result).toEqual([
      { id: "VjEtQ291bnRyeS0x", code: null, name: null },
      { id: "VjEtQ291bnRyeS0y", code: null, name: null },
    ]);
  });

  it("propagates an empty catalog as []", async () => {
    replyImpersonated({ body: { data: { countries: [] } } });
    await expect(list(TOKEN)).resolves.toEqual([]);
  });

  it("throws GRAPHQL_ERROR when `data.countries` is not an array (wire-shape mismatch)", async () => {
    replyImpersonated({ body: { data: { countries: null } } });
    await expect(list(TOKEN)).rejects.toThrow(/wire shape mismatch/);
  });

  it("throws GRAPHQL_ERROR on a top-level GraphQL error", async () => {
    replyImpersonated({
      body: {
        errors: [{ message: "Field 'countries' doesn't exist", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
      },
    });
    await expect(list(TOKEN)).rejects.toThrow(/countries list failed/);
  });

  it("maps an auth-revoked extension code to AuthRevokedError", async () => {
    replyImpersonated({
      body: { errors: [{ message: "unauthorized", extensions: { code: "UNAUTHENTICATED" } }] },
    });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});
