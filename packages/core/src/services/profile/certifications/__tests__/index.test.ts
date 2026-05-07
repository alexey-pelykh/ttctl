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

import { add, highlight, list, remove, show, update } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";
import { VIEWER_OK } from "../../__tests__/fixtures.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-cert-123";

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

const CERT_1 = {
  id: "V1-Certification-1",
  certificate: "AWS Certified",
  institution: "AWS",
  link: null,
  number: null,
  validFromMonth: 1,
  validFromYear: 2020,
  validToMonth: null,
  validToYear: null,
  highlight: false,
};

const CERT_2 = {
  id: "V1-Certification-2",
  certificate: "GCP Cloud Architect",
  institution: "Google",
  link: "https://cred",
  number: "ABC123",
  validFromMonth: 6,
  validFromYear: 2022,
  validToMonth: 6,
  validToYear: 2025,
  highlight: true,
};

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
});

describe("list", () => {
  it("dispatches GET_CERTIFICATION keyed by profileId", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [CERT_1, CERT_2] } } } } });

    const rows = await list(TOKEN);

    expect(rows).toEqual([CERT_1, CERT_2]);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("GET_CERTIFICATION");
  });

  it("throws AuthRevokedError on 401", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ status: 401, body: {} });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("show", () => {
  it("returns matching row by id", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [CERT_1, CERT_2] } } } } });

    const c = await show(TOKEN, CERT_2.id);
    expect(c).toEqual(CERT_2);
  });

  it("throws VALIDATION_ERROR when id not found", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [] } } } } });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("add", () => {
  it("requires both --name (certificate) and --issuer (institution)", async () => {
    await expect(add(TOKEN, {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(add(TOKEN, { certificate: "x" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(add(TOKEN, { institution: "y" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches CREATE_CERTIFICATION with profileId + certification input", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [CERT_1] } } } } });
    replyImpersonated({
      body: {
        data: {
          createCertification: {
            success: true,
            errors: null,
            profile: { id: "p1", certifications: { nodes: [CERT_1, CERT_2] } },
          },
        },
      },
    });

    const c = await add(TOKEN, { certificate: "GCP Cloud Architect", institution: "Google" });
    expect(c.id).toBe(CERT_2.id);
    const call = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("CREATE_CERTIFICATION");
    expect(call.body.variables).toEqual({
      input: { profileId: "p1", certification: { certificate: "GCP Cloud Architect", institution: "Google" } },
    });
  });
});

describe("update", () => {
  it("rejects empty fields", async () => {
    await expect(update(TOKEN, "id", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches UPDATE_CERTIFICATION with certificationId + certification input", async () => {
    replyImpersonated({
      body: {
        data: {
          updateCertification: {
            success: true,
            errors: null,
            profile: { id: "p1", certifications: { nodes: [{ ...CERT_1, validToYear: 2030, validToMonth: 12 }] } },
          },
        },
      },
    });

    const updated = await update(TOKEN, CERT_1.id, { validToYear: 2030, validToMonth: 12 });
    expect(updated.validToYear).toBe(2030);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.variables).toEqual({
      input: { certificationId: CERT_1.id, certification: { validToYear: 2030, validToMonth: 12 } },
    });
  });
});

describe("remove", () => {
  it("dispatches REMOVE_CERTIFICATION", async () => {
    replyImpersonated({
      body: {
        data: {
          removeCertification: { success: true, errors: null, profile: { id: "p1", certifications: { nodes: [] } } },
        },
      },
    });
    const id = await remove(TOKEN, CERT_1.id);
    expect(id).toBe(CERT_1.id);
  });
});

describe("highlight", () => {
  it("dispatches highlightCertification with id and value", async () => {
    replyImpersonated({
      body: {
        data: {
          highlightCertification: { success: true, errors: null, certification: { id: CERT_1.id, highlight: true } },
        },
      },
    });
    const r = await highlight(TOKEN, CERT_1.id, true);
    expect(r).toEqual({ id: CERT_1.id, highlight: true });
  });
});
