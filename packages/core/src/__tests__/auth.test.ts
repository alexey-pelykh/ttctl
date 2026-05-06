// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport.js", () => ({
  stockTransport: vi.fn(),
}));

import { getAuthStatus, signIn, SignInError } from "../auth.js";
import { stockTransport } from "../transport.js";
import type { TransportRequest, TransportResponse } from "../transport.js";

const mockedTransport = vi.mocked(stockTransport);

interface MockResponse {
  status?: number;
  body: unknown;
}

function reply(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedTransport.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

const SUCCESS_BODY = { data: { auth: { signIn: { success: true, token: "tok-abc-123", errors: [] } } } };
const VIEWER_OK = (email: string): unknown => ({ data: { viewer: { id: "v1", viewerRole: { email } } } });

describe("signIn", () => {
  beforeEach(() => {
    mockedTransport.mockReset();
  });

  it("POSTs EmailPasswordSignIn as a persisted query with the cataloged sha256 hash", async () => {
    reply({ body: SUCCESS_BODY });

    await signIn({ email: "user@example.com", password: "hunter2" });

    expect(mockedTransport).toHaveBeenCalledTimes(1);
    const firstCall = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    expect(firstCall.surface).toBe("mobile-gateway");
    expect(firstCall.body.operationName).toBe("EmailPasswordSignIn");
    expect(firstCall.body.variables).toEqual({ email: "user@example.com", password: "hunter2" });
    expect(firstCall.body.extensions?.persistedQuery).toEqual({
      version: 1,
      sha256Hash: "bd8e859a9f0a5c462ceb2ac736648068fa5bcdd874a8a49a460824dd0c5aef51",
    });
    expect(firstCall.body.query).toBeUndefined();
  });

  it("returns the captured token", async () => {
    reply({ body: SUCCESS_BODY });

    const result = await signIn({ email: "user@example.com", password: "hunter2" });

    expect(result).toEqual({ token: "tok-abc-123" });
  });

  it("does not issue a redundant Viewer verification call (one transport call total)", async () => {
    reply({ body: SUCCESS_BODY });

    await signIn({ email: "user@example.com", password: "hunter2" });

    expect(mockedTransport).toHaveBeenCalledTimes(1);
  });

  it("throws INVALID_CREDENTIALS when the gateway returns that error code", async () => {
    reply({
      body: {
        data: {
          auth: {
            signIn: {
              success: false,
              token: null,
              errors: [{ code: "INVALID_CREDENTIALS", message: "Invalid email or password", key: "email" }],
            },
          },
        },
      },
    });

    await expect(signIn({ email: "user@example.com", password: "wrong" })).rejects.toMatchObject({
      name: "SignInError",
      code: "INVALID_CREDENTIALS",
    });
  });

  it("throws MFA_REQUIRED when the gateway returns an MFA-style code", async () => {
    reply({
      body: {
        data: {
          auth: {
            signIn: { success: false, token: null, errors: [{ code: "MFA_REQUIRED", message: "MFA required" }] },
          },
        },
      },
    });

    await expect(signIn({ email: "user@example.com", password: "x" })).rejects.toMatchObject({
      code: "MFA_REQUIRED",
    });
  });

  it("throws NETWORK_ERROR when the transport itself rejects", async () => {
    mockedTransport.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const promise = signIn({ email: "user@example.com", password: "x" });
    await expect(promise).rejects.toBeInstanceOf(SignInError);
    await expect(promise).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("throws UNKNOWN when no signIn payload is present", async () => {
    reply({ body: { data: null } });

    await expect(signIn({ email: "user@example.com", password: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("throws UNKNOWN when sign-in succeeds but the gateway returns no token", async () => {
    reply({ body: { data: { auth: { signIn: { success: true, token: null, errors: [] } } } } });

    await expect(signIn({ email: "user@example.com", password: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("no token was returned"),
    });
  });

  it("throws UNKNOWN when sign-in succeeds but the gateway returns an empty token", async () => {
    reply({ body: { data: { auth: { signIn: { success: true, token: "", errors: [] } } } } });

    await expect(signIn({ email: "user@example.com", password: "x" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("no token was returned"),
    });
  });
});

describe("getAuthStatus", () => {
  beforeEach(() => {
    mockedTransport.mockReset();
  });

  it("returns invalid/no-session when no token is supplied (null)", async () => {
    const result = await getAuthStatus(null);
    expect(result).toEqual({ status: "invalid", reason: "no-session" });
    expect(mockedTransport).not.toHaveBeenCalled();
  });

  it("returns invalid/no-session when an empty-string token is supplied", async () => {
    const result = await getAuthStatus("");
    expect(result).toEqual({ status: "invalid", reason: "no-session" });
    expect(mockedTransport).not.toHaveBeenCalled();
  });

  it("returns valid + email on a 200 Viewer response", async () => {
    reply({ body: VIEWER_OK("user@example.com") });

    const result = await getAuthStatus("tok-abc-123");
    expect(result).toEqual({ status: "valid", email: "user@example.com" });
  });

  it("issues a ViewerVerify call against the mobile gateway with Authorization: Token token=...", async () => {
    reply({ body: VIEWER_OK("user@example.com") });

    await getAuthStatus("tok-abc-123");

    expect(mockedTransport).toHaveBeenCalledTimes(1);
    const call = mockedTransport.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("mobile-gateway");
    expect(call.body.operationName).toBe("ViewerVerify");
    expect(call.body.query).toContain("viewer");
    expect(call.body.query).toContain("email");
    expect(call.authToken).toBe("tok-abc-123");
  });

  it("returns invalid/session-expired on a 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    const result = await getAuthStatus("tok-abc-123");
    expect(result).toEqual({ status: "invalid", reason: "session-expired" });
  });

  it("returns invalid/session-expired on a 403", async () => {
    reply({ status: 403, body: { errors: [{ message: "forbidden" }] } });

    const result = await getAuthStatus("tok-abc-123");
    expect(result).toEqual({ status: "invalid", reason: "session-expired" });
  });

  it("returns invalid/unexpected-status on other non-2xx codes (e.g. 500)", async () => {
    reply({ status: 500, body: { errors: [{ message: "internal error" }] } });

    const result = await getAuthStatus("tok-abc-123");
    expect(result).toEqual({ status: "invalid", reason: "unexpected-status" });
  });

  it("returns invalid/no-email-in-response when 200 lacks viewer.viewerRole.email", async () => {
    reply({ body: { data: { viewer: { id: "v1", viewerRole: null } } } });

    const result = await getAuthStatus("tok-abc-123");
    expect(result).toEqual({ status: "invalid", reason: "no-email-in-response" });
  });

  it("returns invalid/no-email-in-response when viewer is null", async () => {
    reply({ body: { data: { viewer: null } } });

    const result = await getAuthStatus("tok-abc-123");
    expect(result).toEqual({ status: "invalid", reason: "no-email-in-response" });
  });

  it("returns unreachable when the transport itself rejects", async () => {
    mockedTransport.mockRejectedValueOnce(new Error("connect ECONNREFUSED 1.2.3.4:443"));

    const result = await getAuthStatus("tok-abc-123");
    expect(result.status).toBe("unreachable");
    if (result.status === "unreachable") {
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  it("does not throw — every classified failure is returned, not raised", async () => {
    mockedTransport.mockRejectedValueOnce(new Error("DNS lookup failed"));

    await expect(getAuthStatus("tok-abc-123")).resolves.not.toThrow();
  });
});
