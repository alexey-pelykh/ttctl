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

  it("forwards the supplied authToken as Authorization: Token token=...", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
      authToken: "tok-xyz",
    });

    const init = getCallInit();
    expect(init.headers["authorization"]).toBe("Token token=tok-xyz");
  });

  it("omits the authorization header when no authToken is supplied", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    const init = getCallInit();
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("includes the x-toptal-analytics-origin: mobile fingerprint header by default", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    const init = getCallInit();
    expect(init.headers["x-toptal-analytics-origin"]).toBe("mobile");
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
    // Use 400 (non-retryable) so the response surfaces immediately rather
    // than triggering the issue-#229 5xx retry loop.
    mockedFetch.mockResolvedValueOnce(
      fakeResponse({
        status: 400,
        headers: { "content-type": "text/html" },
        body: "<html>maintenance</html>",
      }) as never,
    );

    const result = await impersonatedTransport({
      surface: "scheduler",
      body: { operationName: "X" },
    });

    expect(result.status).toBe(400);
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

  it("Cf403Error message asks the user to file an issue (no manual cookie-refresh walkthrough)", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 403, body: "<html>Cloudflare</html>" }) as never);

    let captured: Cf403Error | undefined;
    try {
      await impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } });
    } catch (err) {
      captured = err as Cf403Error;
    }

    expect(captured?.message).toContain('Cloudflare returned HTTP 403 from surface "talent-profile"');
    expect(captured?.message).toContain("https://www.toptal.com/api/talent_profile/graphql");
    expect(captured?.message).toContain("Chrome TLS impersonation alone passes Cloudflare");
    expect(captured?.message).toContain("https://github.com/alexey-pelykh/ttctl/issues");
    // Belt-and-suspenders — the old cookie-refresh walkthrough must NOT be present
    expect(captured?.message).not.toContain("cf_clearance");
    expect(captured?.message).not.toContain("DevTools");
    expect(captured?.message).not.toContain("session.cookies");
  });

  it("does not throw Cf403Error for non-403 status codes from impersonated surfaces", async () => {
    // 401 is non-retryable by the issue-#229 policy and therefore surfaces
    // immediately — exercising the "not a 403, not transient" path.
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 401, body: '{"errors":[{"message":"x"}]}' }) as never);

    const result = await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    expect(result.status).toBe(401);
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

  it("POSTs to the mobile-gateway endpoint with the configured headers", async () => {
    mockedUndici.mockResolvedValueOnce(
      fakeUndici({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"data":null}',
      }) as never,
    );

    const result = await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
    });

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(mockedUndici).toHaveBeenCalledWith(
      "https://www.toptal.com/gateway/graphql/talent/graphql",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ operationName: "X" }),
      }),
    );
  });

  it("forwards the supplied authToken as Authorization: Token token=...", async () => {
    mockedUndici.mockResolvedValueOnce(fakeUndici({ status: 200, headers: {}, body: "{}" }) as never);

    await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
      authToken: "tok-xyz",
    });

    const init = mockedUndici.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers["authorization"]).toBe("Token token=tok-xyz");
  });

  it("omits the authorization header when no authToken is supplied", async () => {
    mockedUndici.mockResolvedValueOnce(fakeUndici({ status: 200, headers: {}, body: "{}" }) as never);

    await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
    });

    const init = mockedUndici.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("includes the x-toptal-analytics-origin: mobile fingerprint header by default", async () => {
    mockedUndici.mockResolvedValueOnce(fakeUndici({ status: 200, headers: {}, body: "{}" }) as never);

    await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
    });

    const init = mockedUndici.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers["x-toptal-analytics-origin"]).toBe("mobile");
  });

  it("flattens multi-valued response headers into a comma-joined string", async () => {
    mockedUndici.mockResolvedValueOnce(
      fakeUndici({
        status: 200,
        headers: {
          "x-multi": ["a", "b"],
          "content-type": "application/json",
        },
        body: "{}",
      }) as never,
    );

    const result = await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
    });

    expect(result.headers["x-multi"]).toBe("a, b");
    expect(result.headers["content-type"]).toBe("application/json");
  });

  it("falls back to raw text when the body is not JSON", async () => {
    // Use a non-retryable status so the new resilience loop (issue #229)
    // surfaces the response on the first attempt instead of looping.
    mockedUndici.mockResolvedValueOnce(
      fakeUndici({
        status: 400,
        headers: { "content-type": "text/html" },
        body: "<html>bad request</html>",
      }) as never,
    );

    const result = await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
    });

    expect(result.status).toBe(400);
    expect(result.body).toBe("<html>bad request</html>");
  });
});
