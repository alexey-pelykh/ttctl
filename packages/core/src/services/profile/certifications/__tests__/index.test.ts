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

// `CERT_*` are RAW WIRE nodes (what the mock transport returns). `list()`
// / `add()` / `update()` now run them through `mapCertificationNode`
// (#558), so assertions compare against the `CERT_*_MAPPED` typed
// projections, never the raw fixtures.

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
  status: "valid",
  // #558 wire shape: `skills { nodes [{ id, name }] }`. Mapper flattens.
  skills: { nodes: [] as { id: string; name: string }[] },
};

const CERT_1_MAPPED = {
  ...CERT_1,
  skills: [] as { id: string; name: string }[],
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
  status: "expired",
  skills: { nodes: [{ id: "V1-Skill-7", name: "GCP" }] },
};

const CERT_2_MAPPED = {
  ...CERT_2,
  skills: [{ id: "V1-Skill-7", name: "GCP" }],
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

    expect(rows).toEqual([CERT_1_MAPPED, CERT_2_MAPPED]);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("GET_CERTIFICATION");
  });

  it("selects status in the CERTIFICATION_FRAGMENT (#557)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [] } } } } });
    await list(TOKEN);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.query).toContain("status");
  });

  it("selects skills { nodes { id name } } in the CERTIFICATION_FRAGMENT (#558)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [] } } } } });
    await list(TOKEN);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.query).toContain("skills { nodes { id name } }");
  });

  it("surfaces status verbatim on every row (#557)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            certifications: {
              nodes: [
                { ...CERT_1, status: "valid" },
                { ...CERT_2, status: "pending-verification" },
                { ...CERT_1, id: "V1-Certification-3", status: null },
              ],
            },
          },
        },
      },
    });
    const rows = await list(TOKEN);
    expect(rows.map((r) => r.status)).toEqual(["valid", "pending-verification", null]);
  });

  it("flattens skills { nodes } to SkillRef[] on every row (#558)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            certifications: {
              nodes: [
                CERT_1, // wire: { nodes: [] } → mapped: []
                CERT_2, // wire: { nodes: [{ id, name }] } → mapped: [{ id, name }]
              ],
            },
          },
        },
      },
    });
    const rows = await list(TOKEN);
    expect(rows.map((r) => r.skills)).toEqual([[], [{ id: "V1-Skill-7", name: "GCP" }]]);
  });

  it("defaults skills to [] when wire omits the connection (#558)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            certifications: {
              // Wire intentionally omits the `skills` field entirely.
              nodes: [{ id: "V1-Certification-9", certificate: "X", institution: "Y", highlight: false }],
            },
          },
        },
      },
    });
    const rows = await list(TOKEN);
    expect(rows[0]?.skills).toEqual([]);
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
    expect(c).toEqual(CERT_2_MAPPED);
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
    // #605: `skills` is defaulted to `[]` because the wire requires
    // non-null on `CreateCertificationInput.certification.skills` (live
    // capture 2026-05-25: `Expected value to not be null`).
    expect(call.body.variables).toEqual({
      input: {
        profileId: "p1",
        certification: { certificate: "GCP Cloud Architect", institution: "Google", skills: [] },
      },
    });
  });

  it("forwards user-supplied skills verbatim instead of defaulting to [] (#605)", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [] } } } } });
    replyImpersonated({
      body: {
        data: {
          createCertification: {
            success: true,
            errors: null,
            profile: { id: "p1", certifications: { nodes: [CERT_2] } },
          },
        },
      },
    });

    await add(TOKEN, {
      certificate: "GCP Cloud Architect",
      institution: "Google",
      skills: [{ id: "V1-Skill-7", name: "GCP" }],
    });

    const call = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(call.body.variables).toEqual({
      input: {
        profileId: "p1",
        certification: {
          certificate: "GCP Cloud Architect",
          institution: "Google",
          skills: [{ id: "V1-Skill-7", name: "GCP" }],
        },
      },
    });
  });
});

describe("update", () => {
  it("rejects empty fields", async () => {
    await expect(update(TOKEN, "id", {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("dispatches UPDATE_CERTIFICATION with merged input (read-current + user overrides) (#605)", async () => {
    // read-current step → update mutation. CERT_1's null link/number/
    // validFromMonth/validFromYear are omitted (write-side non-nullable);
    // validToMonth/validToYear are user-overridden.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [CERT_1] } } } } });
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
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.operationName).toBe("UPDATE_CERTIFICATION");
    expect(updateCall.body.variables).toEqual({
      input: {
        certificationId: CERT_1.id,
        certification: {
          certificate: CERT_1.certificate,
          institution: CERT_1.institution,
          highlight: CERT_1.highlight,
          validFromMonth: CERT_1.validFromMonth,
          validFromYear: CERT_1.validFromYear,
          validToMonth: 12,
          validToYear: 2030,
          skills: [],
        },
      },
    });
  });

  it("preserves every writable field omitted by the caller (#605 regression: full-replace contract)", async () => {
    // CERT_2 has every writable field populated. User updates ONLY
    // highlight=false; pre-#605 the other eight would have nulled.
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [CERT_2] } } } } });
    replyImpersonated({
      body: {
        data: {
          updateCertification: {
            success: true,
            errors: null,
            profile: { id: "p1", certifications: { nodes: [{ ...CERT_2, highlight: false }] } },
          },
        },
      },
    });

    await update(TOKEN, CERT_2.id, { highlight: false });

    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.variables).toEqual({
      input: {
        certificationId: CERT_2.id,
        certification: {
          certificate: CERT_2.certificate,
          institution: CERT_2.institution,
          link: CERT_2.link,
          number: CERT_2.number,
          validFromMonth: CERT_2.validFromMonth,
          validFromYear: CERT_2.validFromYear,
          validToMonth: CERT_2.validToMonth,
          validToYear: CERT_2.validToYear,
          skills: CERT_2_MAPPED.skills,
          highlight: false,
        },
      },
    });
  });

  it("read-current failure (id not found) surfaces as VALIDATION_ERROR without firing the update mutation", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: { id: "p1", certifications: { nodes: [] } } } } });

    await expect(update(TOKEN, "missing", { highlight: true })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
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
