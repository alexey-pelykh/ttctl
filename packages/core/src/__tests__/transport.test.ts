// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-wreq", () => ({
  fetch: vi.fn(),
}));

import { fetch as wreqFetch } from "node-wreq";

import { IMPERSONATE_PROFILE, impersonatedTransport } from "../transport.js";

interface FakeResponse {
  status: number;
  headers: { toObject(): Record<string, string> };
  text(): Promise<string>;
}

function fakeResponse(opts: { status: number; headers?: Record<string, string>; body: string }): FakeResponse {
  return {
    status: opts.status,
    headers: { toObject: () => opts.headers ?? {} },
    text: () => Promise.resolve(opts.body),
  };
}

const mockedFetch = vi.mocked(wreqFetch);

function getCallInit(callIndex = 0): { headers: Record<string, string> } {
  const call = mockedFetch.mock.calls[callIndex];
  if (!call) throw new Error(`Expected wreqFetch to have been called at least ${(callIndex + 1).toString()} time(s)`);
  return call[1] as { headers: Record<string, string> };
}

describe("impersonatedTransport", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("POSTs to the talent-profile endpoint with the chrome_145 browser profile", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: '{"data":{"viewer":null}}' }) as never);

    const result = await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "Viewer", variables: { x: 1 } },
    });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://www.toptal.com/api/talent_profile/graphql",
      expect.objectContaining({
        method: "POST",
        browser: IMPERSONATE_PROFILE,
        body: JSON.stringify({ operationName: "Viewer", variables: { x: 1 } }),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ data: { viewer: null } });
  });

  it("uses chrome_145 as the IMPERSONATE_PROFILE constant", () => {
    expect(IMPERSONATE_PROFILE).toBe("chrome_145");
  });

  it("pairs the Chrome/145 user-agent string with the chrome_145 profile (coupled identity)", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    const init = getCallInit();
    expect(init.headers["user-agent"]).toContain("Chrome/145.0.0.0");
  });

  it("forwards the supplied cookieHeader as the cookie request header", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
      cookieHeader: "session=abc; cf_clearance=xyz",
    });

    const init = getCallInit();
    expect(init.headers["cookie"]).toBe("session=abc; cf_clearance=xyz");
  });

  it("omits the cookie header when no cookieHeader is supplied", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    const init = getCallInit();
    expect(init.headers).not.toHaveProperty("cookie");
  });

  it("propagates the response status and parses a JSON body", async () => {
    mockedFetch.mockResolvedValueOnce(
      fakeResponse({
        status: 403,
        headers: { "content-type": "application/json" },
        body: '{"errors":[{"message":"unauthorized"}]}',
      }) as never,
    );

    const result = await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    expect(result.status).toBe(403);
    expect(result.headers).toEqual({ "content-type": "application/json" });
    expect(result.body).toEqual({ errors: [{ message: "unauthorized" }] });
  });

  it("falls back to the raw text body when the response is not JSON", async () => {
    mockedFetch.mockResolvedValueOnce(
      fakeResponse({
        status: 503,
        headers: { "content-type": "text/html" },
        body: "<html>maintenance</html>",
      }) as never,
    );

    const result = await impersonatedTransport({
      surface: "scheduler",
      body: { operationName: "X" },
    });

    expect(result.status).toBe(503);
    expect(result.body).toBe("<html>maintenance</html>");
  });

  it("targets the scheduler endpoint when surface=scheduler", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({
      surface: "scheduler",
      body: { operationName: "X" },
    });

    expect(mockedFetch).toHaveBeenCalledWith("https://scheduler.toptal.com/api/graphql", expect.anything());
  });

  it("includes content-type and origin/referer headers expected by the talent-profile WAF", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    const init = getCallInit();
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["origin"]).toBe("https://talent.toptal.com");
    expect(init.headers["referer"]).toBe("https://talent.toptal.com/");
  });
});
