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

import { AuthRevokedError } from "../../../../auth/errors.js";
import { impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";
import { VisasError, add, list, remove, update } from "../index.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-visas";

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

/**
 * Stub the stock-transport reply consumed by `extractProfileId`'s internal
 * `basic.show()` round-trip. Only `data.viewer.viewerRole.profileId` is
 * inspected; we don't need a complete `ProfileShowQuery` shape on the wire.
 */
function stubProfileId(profileId: string = "p1"): void {
  mockedStock.mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: {
      data: {
        viewer: { viewerRole: { profileId } as never } as never,
      },
    },
  } satisfies TransportResponse);
}

const VISA_NODE = {
  id: "v1",
  country: { id: "DE", name: "Germany" },
  visaType: "Schengen",
  expiryDate: "2027-01-01",
};

describe("visas.list", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
    mockedStock.mockReset();
  });

  it("targets talent-profile with getTravelVisas", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", travelVisas: { nodes: [VISA_NODE] } } } } });

    const visas = await list(TOKEN);

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("talent-profile");
    expect(call.body.operationName).toBe("getTravelVisas");
    expect(call.body.variables).toEqual({ profileId: "p1" });
    expect(visas).toHaveLength(1);
    expect(visas[0]?.countryName).toBe("Germany");
    expect(visas[0]?.countryId).toBe("DE");
    expect(visas[0]?.visaType).toBe("Schengen");
    expect(visas[0]?.expiryDate).toBe("2027-01-01");
  });

  it("returns [] for an empty list", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", travelVisas: { nodes: [] } } } } });

    const visas = await list(TOKEN);

    expect(visas).toEqual([]);
  });

  it("translates 401 to AuthRevokedError", async () => {
    stubProfileId("p1");
    replyImpersonated({ status: 401, body: {} });

    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("visas.add", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
    mockedStock.mockReset();
  });

  it("rejects empty countryId with VALIDATION_ERROR before any network call", async () => {
    await expect(add(TOKEN, { countryId: "", visaType: "X" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects empty visaType with VALIDATION_ERROR", async () => {
    await expect(add(TOKEN, { countryId: "DE", visaType: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("issues createTravelVisa with the inferred wrapper key", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          createTravelVisa: {
            profile: { id: "p1", travelVisas: { nodes: [VISA_NODE] } },
            errors: null,
          },
        },
      },
    });

    await add(TOKEN, { countryId: "DE", visaType: "Schengen", expiryDate: "2027-01-01" });

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("createTravelVisa");
    const variables = call.body.variables as { input: { profileId: string; travelVisa: unknown } };
    expect(variables.input.profileId).toBe("p1");
    expect(variables.input.travelVisa).toEqual({
      countryId: "DE",
      visaType: "Schengen",
      expiryDate: "2027-01-01",
    });
  });

  it("surfaces user errors as USER_ERROR VisasError", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          createTravelVisa: {
            profile: null,
            errors: [{ message: "unknown country", key: "countryId" }],
          },
        },
      },
    });

    await expect(add(TOKEN, { countryId: "XX", visaType: "Schengen" })).rejects.toMatchObject({
      code: "USER_ERROR",
    });
  });
});

describe("visas.update", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
    mockedStock.mockReset();
  });

  it("rejects empty changes with VALIDATION_ERROR", async () => {
    await expect(update(TOKEN, "v1", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("read-modify-write: merges current countryId + visaType + expiryDate with caller's patch", async () => {
    // First call is list() (read), second is updateTravelVisa (write).
    stubProfileId();
    replyImpersonated(
      {
        body: {
          data: {
            profile: {
              id: "p1",
              travelVisas: { nodes: [VISA_NODE] },
            },
          },
        },
      },
      {
        body: {
          data: {
            updateTravelVisa: {
              profile: { id: "p1", travelVisas: { nodes: [{ ...VISA_NODE, expiryDate: "2030-01-01" }] } },
              errors: null,
            },
          },
        },
      },
    );

    await update(TOKEN, "v1", { expiryDate: "2030-01-01" });

    expect(mockedImpersonated).toHaveBeenCalledTimes(2);
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.operationName).toBe("updateTravelVisa");
    const variables = updateCall.body.variables as { input: { travelVisaId: string; travelVisa: unknown } };
    expect(variables.input.travelVisaId).toBe("v1");
    expect(variables.input.travelVisa).toEqual({
      countryId: "DE",
      visaType: "Schengen",
      expiryDate: "2030-01-01",
    });
  });

  it("read-modify-write: omits expiryDate when current record has null expiry and patch doesn't set one", async () => {
    stubProfileId();
    replyImpersonated(
      {
        body: {
          data: {
            profile: {
              id: "p1",
              travelVisas: { nodes: [{ ...VISA_NODE, expiryDate: null }] },
            },
          },
        },
      },
      {
        body: {
          data: {
            updateTravelVisa: {
              profile: { id: "p1", travelVisas: { nodes: [{ ...VISA_NODE, visaType: "Tourist", expiryDate: null }] } },
              errors: null,
            },
          },
        },
      },
    );

    await update(TOKEN, "v1", { visaType: "Tourist" });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = updateCall.body.variables as { input: { travelVisa: Record<string, unknown> } };
    expect(variables.input.travelVisa).toEqual({
      countryId: "DE",
      visaType: "Tourist",
    });
    expect("expiryDate" in variables.input.travelVisa).toBe(false);
  });

  it("rejects unknown visa id with VALIDATION_ERROR before any update call", async () => {
    stubProfileId();
    replyImpersonated({
      body: {
        data: {
          profile: { id: "p1", travelVisas: { nodes: [VISA_NODE] } },
        },
      },
    });

    await expect(update(TOKEN, "v-unknown", { expiryDate: "2030-01-01" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    // Only the list() call should have fired — never the update.
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });
});

describe("visas.remove", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
  });

  it("issues removeTravelVisa with travelVisaId", async () => {
    replyImpersonated({
      body: {
        data: {
          removeTravelVisa: {
            profile: { id: "p1", travelVisas: { nodes: [] } },
            errors: null,
          },
        },
      },
    });

    await remove(TOKEN, "v1");

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("removeTravelVisa");
    expect(call.body.variables).toEqual({ input: { travelVisaId: "v1" } });
  });
});

describe("VisasError", () => {
  it("carries a stable name and code", () => {
    const err = new VisasError("USER_ERROR", "rejected");
    expect(err.name).toBe("VisasError");
    expect(err.code).toBe("USER_ERROR");
  });
});
