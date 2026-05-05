// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-wreq", () => ({
  fetch: vi.fn(),
}));

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { fetch as wreqFetch } from "node-wreq";
import { request as undiciRequest } from "undici";

import { Cf403Error, IMPERSONATE_PROFILE, impersonatedTransport, stockTransport } from "../transport.js";

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
        status: 401,
        headers: { "content-type": "application/json" },
        body: '{"errors":[{"message":"unauthorized"}]}',
      }) as never,
    );

    const result = await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    expect(result.status).toBe(401);
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

  it("throws Cf403Error when talent-profile returns 403", async () => {
    mockedFetch.mockResolvedValueOnce(
      fakeResponse({
        status: 403,
        headers: { "content-type": "text/html" },
        body: "<html>Cloudflare</html>",
      }) as never,
    );

    await expect(
      impersonatedTransport({
        surface: "talent-profile",
        body: { operationName: "X" },
      }),
    ).rejects.toBeInstanceOf(Cf403Error);
  });

  it("throws Cf403Error when scheduler returns 403", async () => {
    mockedFetch.mockResolvedValueOnce(
      fakeResponse({
        status: 403,
        body: "<html>Cloudflare</html>",
      }) as never,
    );

    await expect(
      impersonatedTransport({
        surface: "scheduler",
        body: { operationName: "X" },
      }),
    ).rejects.toBeInstanceOf(Cf403Error);
  });

  it("Cf403Error carries the surface and endpoint that failed", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 403, body: "<html>Cloudflare</html>" }) as never);

    let captured: Cf403Error | undefined;
    try {
      await impersonatedTransport({ surface: "scheduler", body: { operationName: "X" } });
    } catch (err) {
      captured = err as Cf403Error;
    }

    expect(captured).toBeInstanceOf(Cf403Error);
    expect(captured?.surface).toBe("scheduler");
    expect(captured?.endpoint).toBe("https://scheduler.toptal.com/api/graphql");
  });

  it("Cf403Error message includes the verbatim cf_clearance refresh instructions", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 403, body: "<html>Cloudflare</html>" }) as never);

    let captured: Cf403Error | undefined;
    try {
      await impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } });
    } catch (err) {
      captured = err as Cf403Error;
    }

    expect(captured?.message).toContain("`cf_clearance` cookie may have expired (Cloudflare 403). To refresh:");
    expect(captured?.message).toContain("1. Open https://talent.toptal.com/ in Chrome.");
    expect(captured?.message).toContain("2. Pass any bot-check (CAPTCHA / Turnstile) if shown.");
    expect(captured?.message).toContain("3. From DevTools → Application → Cookies, copy the `cf_clearance` value.");
    expect(captured?.message).toContain(
      "4. Update your cookie jar with the new value (manually edit\n     ~/.ttctl/session.cookies, OR rerun `ttctl auth signin`).",
    );
  });

  it("Cf403Error message swaps the refresh URL to scheduler.toptal.com for the scheduler surface", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 403, body: "<html>Cloudflare</html>" }) as never);

    let captured: Cf403Error | undefined;
    try {
      await impersonatedTransport({ surface: "scheduler", body: { operationName: "X" } });
    } catch (err) {
      captured = err as Cf403Error;
    }

    expect(captured?.message).toContain("1. Open https://scheduler.toptal.com/ in Chrome.");
    expect(captured?.message).not.toContain("Open https://talent.toptal.com/ in Chrome.");
  });

  it("Cf403Error names the offending surface and endpoint in the message", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 403, body: "<html>Cloudflare</html>" }) as never);

    let captured: Cf403Error | undefined;
    try {
      await impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } });
    } catch (err) {
      captured = err as Cf403Error;
    }

    expect(captured?.message).toContain('Cloudflare returned 403 for surface "talent-profile"');
    expect(captured?.message).toContain("https://www.toptal.com/api/talent_profile/graphql");
  });

  it("does not throw Cf403Error for non-403 status codes from impersonated surfaces", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 502, body: "<html>bad gateway</html>" }) as never);

    const result = await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    expect(result.status).toBe(502);
  });
});

interface FakeUndiciResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { text(): Promise<string> };
}

function fakeUndici(opts: {
  status: number;
  headers?: Record<string, string | string[]>;
  body: string;
}): FakeUndiciResponse {
  return {
    statusCode: opts.status,
    headers: opts.headers ?? {},
    body: { text: () => Promise.resolve(opts.body) },
  };
}

const mockedUndici = vi.mocked(undiciRequest);

describe("stockTransport", () => {
  beforeEach(() => {
    mockedUndici.mockReset();
  });

  it("preserves multi-valued Set-Cookie headers as an array (not joined on comma)", async () => {
    mockedUndici.mockResolvedValueOnce(
      fakeUndici({
        status: 200,
        headers: {
          "set-cookie": ["_toptal_session_id=abc; Expires=Sun, 06 Nov 2099 08:49:37 GMT; Path=/", "csrf=xyz; Path=/"],
          "content-type": "application/json",
        },
        body: '{"data":null}',
      }) as never,
    );

    const result = await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
    });

    expect(result.setCookies).toEqual([
      "_toptal_session_id=abc; Expires=Sun, 06 Nov 2099 08:49:37 GMT; Path=/",
      "csrf=xyz; Path=/",
    ]);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers["content-type"]).toBe("application/json");
  });

  it("normalizes a single-string Set-Cookie header into a one-element array", async () => {
    mockedUndici.mockResolvedValueOnce(
      fakeUndici({
        status: 200,
        headers: { "set-cookie": "_toptal_session_id=abc; Path=/" },
        body: "{}",
      }) as never,
    );

    const result = await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
    });

    expect(result.setCookies).toEqual(["_toptal_session_id=abc; Path=/"]);
  });

  it("omits setCookies when no Set-Cookie header is present (exactOptionalPropertyTypes)", async () => {
    mockedUndici.mockResolvedValueOnce(
      fakeUndici({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }) as never,
    );

    const result = await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
    });

    expect("setCookies" in result).toBe(false);
  });
});
