// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Redirect-handling tests for the transport surface (issue #268).
 *
 * Defense-in-depth posture: every transport entry point has a no-follow
 * redirect policy — `redirect: "manual"` pinned explicitly on node-wreq,
 * and structural on undici (its `request()` on the default dispatcher
 * never follows redirects) — and `executeWithResilience` rejects any 3xx
 * response carrying a `Location` header as a typed `RedirectError`.
 *
 * Why this matters: a followed redirect would carry the request body
 * (operation name + variables) to the redirect target. node-wreq strips
 * the `authorization` header on cross-origin hops, but pinning the policy
 * keeps the no-leak guarantee from depending on a transitive library
 * default. GraphQL endpoints are not expected to redirect, so a 3xx is an
 * anomaly worth surfacing for operator triage.
 *
 * Mocked transport is sufficient here — the wire shape under test is the
 * standard HTTP `Location` header, not an inferred Toptal GraphQL
 * contract, so the schema/contract E2E rule does not apply.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-wreq", () => ({
  fetch: vi.fn(),
}));

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { fetch as wreqFetch } from "node-wreq";
import { request as undiciRequest } from "undici";

import {
  RedirectError,
  impersonatedMultipartTransport,
  impersonatedTransport,
  stockTransport,
} from "../transport/index.js";
import { resetTransportConfigCache } from "../transport-resilience.js";

interface FakeWreqResponse {
  status: number;
  headers: { toObject(): Record<string, string> };
  text(): Promise<string>;
}

function wreqResponse(opts: { status: number; headers?: Record<string, string>; body?: string }): FakeWreqResponse {
  return {
    status: opts.status,
    headers: { toObject: () => opts.headers ?? {} },
    text: () => Promise.resolve(opts.body ?? ""),
  };
}

interface FakeUndiciResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { text(): Promise<string> };
}

function undiciResponse(opts: {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: string;
}): FakeUndiciResponse {
  return {
    statusCode: opts.status,
    headers: opts.headers ?? {},
    body: { text: () => Promise.resolve(opts.body ?? "") },
  };
}

const mockedFetch = vi.mocked(wreqFetch);
const mockedUndici = vi.mocked(undiciRequest);

beforeEach(() => {
  mockedFetch.mockReset();
  mockedUndici.mockReset();
  // A non-zero retry budget proves redirects are NOT retried — they throw
  // immediately rather than walking the retry loop.
  process.env["TTCTL_TRANSPORT_MAX_RETRIES"] = "3";
  resetTransportConfigCache();
});

afterEach(() => {
  delete process.env["TTCTL_TRANSPORT_MAX_RETRIES"];
  resetTransportConfigCache();
});

describe("explicit no-follow redirect policy is pinned per transport", () => {
  // stockTransport has no guard test for an explicit option: undici 8.x's
  // `request()` on the default dispatcher does not follow redirects at all
  // (redirect following is an opt-in interceptor TTCtl never installs), so
  // there is no `redirect` / `maxRedirections` request-level option to
  // assert on. The structural guarantee is covered behaviourally by the
  // "stockTransport rejects HTTP <code>" cases below.

  it("impersonatedTransport passes redirect: 'manual' to node-wreq", async () => {
    mockedFetch.mockResolvedValueOnce(wreqResponse({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } });

    const init = mockedFetch.mock.calls[0]?.[1] as { redirect?: string };
    expect(init.redirect).toBe("manual");
  });

  it("impersonatedMultipartTransport passes redirect: 'manual' to node-wreq", async () => {
    mockedFetch.mockResolvedValueOnce(wreqResponse({ status: 200, body: "{}" }) as never);

    await impersonatedMultipartTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
      files: { "0": { filename: "a", content: Buffer.from("x") } },
      map: { "0": ["variables.x"] },
    });

    const init = mockedFetch.mock.calls[0]?.[1] as { redirect?: string };
    expect(init.redirect).toBe("manual");
  });
});

describe("3xx-with-Location is rejected as RedirectError", () => {
  // 300, 301, 302, 303, 307, 308 — the node-wreq REDIRECT_STATUS_CODES set.
  const redirectCodes = [300, 301, 302, 303, 307, 308];

  for (const status of redirectCodes) {
    it(`stockTransport rejects HTTP ${status.toString()} with a Location header`, async () => {
      mockedUndici.mockResolvedValueOnce(
        undiciResponse({ status, headers: { location: "https://evil.example.com/steal" }, body: "" }) as never,
      );

      await expect(stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } })).rejects.toBeInstanceOf(
        RedirectError,
      );
      // Rejected on the first attempt — no retry loop walked.
      expect(mockedUndici).toHaveBeenCalledTimes(1);
    });

    it(`impersonatedTransport rejects HTTP ${status.toString()} with a Location header`, async () => {
      mockedFetch.mockResolvedValueOnce(
        wreqResponse({ status, headers: { location: "https://evil.example.com/steal" }, body: "" }) as never,
      );

      await expect(
        impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } }),
      ).rejects.toBeInstanceOf(RedirectError);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
  }

  it("impersonatedMultipartTransport rejects HTTP 302 with a Location header", async () => {
    mockedFetch.mockResolvedValueOnce(
      wreqResponse({ status: 302, headers: { location: "https://evil.example.com/steal" }, body: "" }) as never,
    );

    await expect(
      impersonatedMultipartTransport({
        surface: "talent-profile",
        body: { operationName: "X" },
        files: { "0": { filename: "a", content: Buffer.from("x") } },
        map: { "0": ["variables.x"] },
      }),
    ).rejects.toBeInstanceOf(RedirectError);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("RedirectError carries triage-relevant context", () => {
  it("exposes surface, endpoint, status, and the Location value", async () => {
    mockedFetch.mockResolvedValueOnce(
      wreqResponse({ status: 302, headers: { location: "https://evil.example.com/steal" }, body: "" }) as never,
    );

    const err = await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectError);
    const redirect = err as RedirectError;
    expect(redirect.code).toBe("REDIRECT_REFUSED");
    expect(redirect.surface).toBe("talent-profile");
    expect(redirect.endpoint).toBe("https://www.toptal.com/api/talent_profile/graphql");
    expect(redirect.status).toBe(302);
    expect(redirect.location).toBe("https://evil.example.com/steal");
    // The Location value is a URL, not a credential — safe to surface in
    // the operator-facing message.
    expect(redirect.message).toContain("https://evil.example.com/steal");
    expect(redirect.recovery).toContain("github.com/alexey-pelykh/ttctl/issues");
  });

  it("finds the Location header case-insensitively (node-wreq preserves server casing)", async () => {
    mockedFetch.mockResolvedValueOnce(
      wreqResponse({ status: 301, headers: { Location: "https://evil.example.com/steal" }, body: "" }) as never,
    );

    const err = await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectError);
    expect((err as RedirectError).location).toBe("https://evil.example.com/steal");
  });
});

describe("non-redirect 3xx responses fall through to the normal return path", () => {
  it("304 Not Modified is not treated as a redirect", async () => {
    mockedUndici.mockResolvedValueOnce(undiciResponse({ status: 304, body: "" }) as never);

    const res = await stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } });

    // 304 is a cache-validation response, not a redirect — returned verbatim.
    expect(res.status).toBe(304);
  });

  it("a 3xx WITHOUT a Location header is returned verbatim, not rejected", async () => {
    mockedFetch.mockResolvedValueOnce(wreqResponse({ status: 302, body: '{"data":null}' }) as never);

    const res = await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
    });

    // No Location header means there is nothing to follow — the caller's
    // GraphQL response handler sees the 302 verbatim.
    expect(res.status).toBe(302);
    expect(res.body).toEqual({ data: null });
  });
});
