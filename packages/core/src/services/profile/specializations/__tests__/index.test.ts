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

import { ProfileError, apply, show } from "../index.js";
import type { SpecializationApplyConsent } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { ConsentRequiredError } from "../../../../consent.js";
import { stockTransport } from "../../../../transport.js";
import type { TransportResponse } from "../../../../transport.js";

const CONSENT: SpecializationApplyConsent = { profileCapabilityConsentIssued: true };

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
      callable: "DISABLED",
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
          callable: "DISABLED",
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
      operations: { apply: { callable: "DISABLED", messages: ["valid msg", null, "another"] } },
    };
    reply({ body: { data: { viewer: { id: "v1", specializations: [rowWithNullMessages] } } } });
    const result = await show(TOKEN);
    expect(result[0]?.operations.apply.messages).toEqual(["valid msg", "another"]);
  });

  it("normalises missing optional fields to typed defaults (null/empty)", async () => {
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
        operations: { apply: { callable: "", messages: [] } },
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

describe("specializations.apply (#467 / T1 ApplyForSpecialization)", () => {
  const SPECIALIZATION_ID = "spec-marketplace-uuid";

  it("dispatches ApplyForSpecialization against the mobile-gateway surface with the supplied id", async () => {
    reply({
      body: { data: { specialization: { apply: { success: true, notice: "Application submitted.", errors: [] } } } },
    });
    await apply(TOKEN, SPECIALIZATION_ID, CONSENT);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.surface).toBe("mobile-gateway");
    expect(call?.authToken).toBe(TOKEN);
    expect(call?.body.operationName).toBe("ApplyForSpecialization");
    expect(call?.body.variables).toEqual({ specializationId: SPECIALIZATION_ID });
  });

  it("returns the applied outcome with the echoed specializationId + wire notice on success", async () => {
    reply({
      body: { data: { specialization: { apply: { success: true, notice: "Application submitted.", errors: [] } } } },
    });
    const outcome = await apply(TOKEN, SPECIALIZATION_ID, CONSENT);
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.result).toEqual({
      specializationId: SPECIALIZATION_ID,
      notice: "Application submitted.",
    });
  });

  it("normalises a null notice to null on the result echo", async () => {
    reply({ body: { data: { specialization: { apply: { success: true, notice: null, errors: [] } } } } });
    const outcome = await apply(TOKEN, SPECIALIZATION_ID, CONSENT);
    if (outcome.kind !== "applied") return;
    expect(outcome.result.notice).toBeNull();
  });

  // -------- Consent gate (ADR-009 profile-capability) --------

  it("refuses with ConsentRequiredError when profileCapabilityConsentIssued is false (runtime cast bypass)", async () => {
    // Cast widens the static `true` literal so we can pass `false` to
    // exercise the runtime gate (the CLI/MCP flow does this when the
    // user omits the consent flag).
    const noConsent = { profileCapabilityConsentIssued: false } as unknown as SpecializationApplyConsent;
    await expect(apply(TOKEN, SPECIALIZATION_ID, noConsent)).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("refuses with ConsentRequiredError when the consent field is missing", async () => {
    const noConsent = {} as unknown as SpecializationApplyConsent;
    await expect(apply(TOKEN, SPECIALIZATION_ID, noConsent)).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
      domain: "profile-capability",
      opName: "ApplyForSpecialization",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("consent gate fires BEFORE the dry-run short-circuit (no preview emitted on refusal)", async () => {
    const noConsent = {} as unknown as SpecializationApplyConsent;
    await expect(apply(TOKEN, SPECIALIZATION_ID, noConsent, { dryRun: true })).rejects.toBeInstanceOf(
      ConsentRequiredError,
    );
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("env-var bypass (TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1) allows the call without the literal", async () => {
    const prev = process.env["TTCTL_ALLOW_INFERRED_DESTRUCTIVE"];
    process.env["TTCTL_ALLOW_INFERRED_DESTRUCTIVE"] = "1";
    try {
      reply({ body: { data: { specialization: { apply: { success: true, notice: "ok", errors: [] } } } } });
      const noConsent = {} as unknown as SpecializationApplyConsent;
      const outcome = await apply(TOKEN, SPECIALIZATION_ID, noConsent);
      expect(outcome.kind).toBe("applied");
    } finally {
      if (prev === undefined) delete process.env["TTCTL_ALLOW_INFERRED_DESTRUCTIVE"];
      else process.env["TTCTL_ALLOW_INFERRED_DESTRUCTIVE"] = prev;
    }
  });

  // -------- Dry-run short-circuit --------

  it("emits a DryRunPreview with the prepared variables and makes no wire call", async () => {
    const outcome = await apply(TOKEN, SPECIALIZATION_ID, CONSENT, { dryRun: true });
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.transport).toBe("stock");
    expect(outcome.preview.operationName).toBe("ApplyForSpecialization");
    expect(outcome.preview.variables).toEqual({ specializationId: SPECIALIZATION_ID });
    // Bearer redacted in the preview headers.
    expect(outcome.preview.headers["authorization"]).toBe("Token token=<redacted>");
    expect(mockedStock).not.toHaveBeenCalled();
  });

  // -------- Input validation --------

  it("refuses with VALIDATION_ERROR on empty specializationId (no wire call)", async () => {
    await expect(apply(TOKEN, "", CONSENT)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("non-empty specializationId"),
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  // -------- Error mapping --------

  it("maps a payload.errors[] entry to USER_ERROR with the server-supplied key + message", async () => {
    reply({
      body: {
        data: {
          specialization: {
            apply: {
              success: false,
              notice: null,
              errors: [{ code: null, key: "already_applied", message: "Already a member of this specialization." }],
            },
          },
        },
      },
    });
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("already_applied"),
    });
  });

  it("maps a payload.errors[] with no key to USER_ERROR without the (key) prefix in the message", async () => {
    reply({
      body: {
        data: {
          specialization: { apply: { success: false, notice: null, errors: [{ message: "Generic failure." }] } },
        },
      },
    });
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Generic failure."),
    });
  });

  it("maps success=false with no errors[] to USER_ERROR carrying the notice", async () => {
    reply({
      body: {
        data: { specialization: { apply: { success: false, notice: "Not eligible right now.", errors: [] } } },
      },
    });
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Not eligible right now."),
    });
  });

  it("maps a null specialization to USER_ERROR (spec id not found)", async () => {
    reply({ body: { data: { specialization: null } } });
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining(SPECIALIZATION_ID),
    });
  });

  it("maps a null apply payload to UNKNOWN", async () => {
    reply({ body: { data: { specialization: { apply: null } } } });
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  // -------- Transport-level errors --------

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { data: null } });
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError(GRAPHQL_ERROR) on non-auth top-level errors", async () => {
    reply({
      body: {
        data: null,
        errors: [{ message: "Specialization service down", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
      },
    });
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toMatchObject({
      code: "GRAPHQL_ERROR",
      message: expect.stringContaining("Specialization service down"),
    });
  });

  it("throws ProfileError(NETWORK_ERROR) when the transport itself throws", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("filters out null entries in payload.errors[] (defensive)", async () => {
    reply({
      body: {
        data: {
          specialization: {
            apply: { success: false, notice: null, errors: [null, { key: "kk", message: "real error" }] },
          },
        },
      },
    });
    await expect(apply(TOKEN, SPECIALIZATION_ID, CONSENT)).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("kk"),
    });
  });
});
