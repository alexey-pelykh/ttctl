// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { CookieJar } from "tough-cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../transport.js", () => ({
  stockTransport: vi.fn(),
}));

import { signIn, SignInError } from "../auth.js";
import { stockTransport } from "../transport.js";
import type { TransportRequest, TransportResponse } from "../transport.js";

const mockedTransport = vi.mocked(stockTransport);

interface MockResponse {
  status?: number;
  body: unknown;
  setCookies?: string[];
}

function reply(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedTransport.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
      ...(r.setCookies ? { setCookies: r.setCookies } : {}),
    } satisfies TransportResponse);
  }
}

const SUCCESS_BODY = { data: { auth: { signIn: { success: true, token: "tok", errors: [] } } } };
const VIEWER_OK = (email: string): unknown => ({ data: { viewer: { id: "v1", viewerRole: { email } } } });

describe("signIn", () => {
  beforeEach(() => {
    mockedTransport.mockReset();
  });

  it("POSTs EmailPasswordSignIn as a persisted query with the cataloged sha256 hash", async () => {
    const jar = new CookieJar();
    reply(
      { body: SUCCESS_BODY, setCookies: ["_toptal_session_id=abc; Path=/; Domain=.toptal.com"] },
      { body: VIEWER_OK("user@example.com") },
    );

    await signIn({ email: "user@example.com", password: "hunter2" }, jar);

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

  it("captures Set-Cookie values into the jar (including _toptal_session_id)", async () => {
    const jar = new CookieJar();
    reply(
      {
        body: SUCCESS_BODY,
        setCookies: [
          "_toptal_session_id=session-xyz; Path=/; Domain=.toptal.com; HttpOnly",
          "csrf=token-abc; Path=/; Domain=.toptal.com",
        ],
      },
      { body: VIEWER_OK("user@example.com") },
    );

    await signIn({ email: "user@example.com", password: "hunter2" }, jar);

    const cookies = await jar.getCookies("https://www.toptal.com/");
    const names = cookies.map((c) => c.key);
    expect(names).toContain("_toptal_session_id");
    expect(names).toContain("csrf");
    const session = cookies.find((c) => c.key === "_toptal_session_id");
    expect(session?.value).toBe("session-xyz");
  });

  it("issues a Viewer verification call with the captured cookies after sign-in succeeds", async () => {
    const jar = new CookieJar();
    reply(
      { body: SUCCESS_BODY, setCookies: ["_toptal_session_id=session-xyz; Path=/; Domain=.toptal.com"] },
      { body: VIEWER_OK("user@example.com") },
    );

    await signIn({ email: "user@example.com", password: "hunter2" }, jar);

    expect(mockedTransport).toHaveBeenCalledTimes(2);
    const verifyCall = mockedTransport.mock.calls[1]?.[0] as TransportRequest;
    expect(verifyCall.surface).toBe("mobile-gateway");
    expect(verifyCall.body.operationName).toBe("ViewerVerify");
    expect(verifyCall.body.query).toContain("viewer");
    expect(verifyCall.body.query).toContain("email");
    expect(verifyCall.cookieHeader).toContain("_toptal_session_id=session-xyz");
  });

  it("compares emails case-insensitively", async () => {
    const jar = new CookieJar();
    reply(
      { body: SUCCESS_BODY, setCookies: ["_toptal_session_id=s; Path=/; Domain=.toptal.com"] },
      { body: VIEWER_OK("USER@example.com") },
    );

    await expect(signIn({ email: "user@EXAMPLE.com", password: "x" }, jar)).resolves.toBeUndefined();
  });

  it("throws INVALID_CREDENTIALS when the gateway returns that error code", async () => {
    const jar = new CookieJar();
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

    await expect(signIn({ email: "user@example.com", password: "wrong" }, jar)).rejects.toMatchObject({
      name: "SignInError",
      code: "INVALID_CREDENTIALS",
    });
  });

  it("throws MFA_REQUIRED when the gateway returns an MFA-style code", async () => {
    const jar = new CookieJar();
    reply({
      body: {
        data: {
          auth: {
            signIn: { success: false, token: null, errors: [{ code: "MFA_REQUIRED", message: "MFA required" }] },
          },
        },
      },
    });

    await expect(signIn({ email: "user@example.com", password: "x" }, jar)).rejects.toMatchObject({
      code: "MFA_REQUIRED",
    });
  });

  it("throws NETWORK_ERROR when the transport itself rejects", async () => {
    const jar = new CookieJar();
    mockedTransport.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const promise = signIn({ email: "user@example.com", password: "x" }, jar);
    await expect(promise).rejects.toBeInstanceOf(SignInError);
    await expect(promise).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("throws UNKNOWN when no signIn payload is present", async () => {
    const jar = new CookieJar();
    reply({ body: { data: null }, setCookies: ["_toptal_session_id=s; Path=/; Domain=.toptal.com"] });

    await expect(signIn({ email: "user@example.com", password: "x" }, jar)).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("throws UNKNOWN when sign-in succeeds but the gateway sets no cookies", async () => {
    const jar = new CookieJar();
    reply({ body: SUCCESS_BODY });

    await expect(signIn({ email: "user@example.com", password: "x" }, jar)).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("no session cookies"),
    });
  });

  it("throws UNKNOWN when Viewer verification returns a different email", async () => {
    const jar = new CookieJar();
    reply(
      { body: SUCCESS_BODY, setCookies: ["_toptal_session_id=s; Path=/; Domain=.toptal.com"] },
      { body: VIEWER_OK("someone-else@example.com") },
    );

    await expect(signIn({ email: "user@example.com", password: "x" }, jar)).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("does not match"),
    });
  });

  it("throws UNKNOWN when Viewer verification returns no email field", async () => {
    const jar = new CookieJar();
    reply(
      { body: SUCCESS_BODY, setCookies: ["_toptal_session_id=s; Path=/; Domain=.toptal.com"] },
      { body: { data: { viewer: { id: "v1", viewerRole: null } } } },
    );

    await expect(signIn({ email: "user@example.com", password: "x" }, jar)).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("wraps Viewer-verification network failures as NETWORK_ERROR", async () => {
    const jar = new CookieJar();
    reply({ body: SUCCESS_BODY, setCookies: ["_toptal_session_id=s; Path=/; Domain=.toptal.com"] });
    mockedTransport.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(signIn({ email: "user@example.com", password: "x" }, jar)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("does not throw on malformed Set-Cookie values (skips them silently)", async () => {
    const jar = new CookieJar();
    reply(
      {
        body: SUCCESS_BODY,
        setCookies: [
          "this is not a valid cookie",
          "_toptal_session_id=ok; Path=/; Domain=.toptal.com",
        ],
      },
      { body: VIEWER_OK("user@example.com") },
    );

    await expect(signIn({ email: "user@example.com", password: "x" }, jar)).resolves.toBeUndefined();
    const cookies = await jar.getCookies("https://www.toptal.com/");
    expect(cookies.some((c) => c.key === "_toptal_session_id")).toBe(true);
  });
});
