// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * End-to-end resilience tests for the transport surface (issue #229).
 *
 * Covers: 429 + Retry-After, 429 without Retry-After, 5xx retry, retry
 * exhaustion, AbortSignal propagation, per-attempt timeout, multipart
 * path retries. Network library mocks are reset per case so each
 * scenario controls the exact wire shape it asserts against.
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
  Cf403Error,
  impersonatedMultipartTransport,
  impersonatedTransport,
  stockTransport,
} from "../transport/index.js";
import { resetTransportConfigCache, TransportError } from "../transport-resilience.js";

interface FakeWreqResponse {
  status: number;
  headers: { toObject(): Record<string, string> };
  text(): Promise<string>;
}

function wreqOk(opts: { status: number; headers?: Record<string, string>; body: string }): FakeWreqResponse {
  return {
    status: opts.status,
    headers: { toObject: () => opts.headers ?? {} },
    text: () => Promise.resolve(opts.body),
  };
}

interface FakeUndiciResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { text(): Promise<string> };
}

function undiciOk(opts: {
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

const mockedFetch = vi.mocked(wreqFetch);
const mockedUndici = vi.mocked(undiciRequest);

beforeEach(() => {
  mockedFetch.mockReset();
  mockedUndici.mockReset();
  // Pin a short, fast retry budget so suites stay quick. Reset cache so
  // each describe block sees the env it expects.
  process.env["TTCTL_TRANSPORT_TIMEOUT_MS"] = "30000";
  process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"] = "10000";
  process.env["TTCTL_TRANSPORT_MAX_RETRIES"] = "3";
  resetTransportConfigCache();
});

afterEach(() => {
  delete process.env["TTCTL_TRANSPORT_TIMEOUT_MS"];
  delete process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"];
  delete process.env["TTCTL_TRANSPORT_MAX_RETRIES"];
  resetTransportConfigCache();
});

describe("stockTransport — 429 / 5xx retry behavior", () => {
  it("retries on HTTP 429 then returns the eventual 200", async () => {
    mockedUndici
      .mockResolvedValueOnce(undiciOk({ status: 429, headers: { "retry-after": "0" }, body: "{}" }) as never)
      .mockResolvedValueOnce(undiciOk({ status: 200, headers: {}, body: '{"ok":true}' }) as never);

    const res = await stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } });
    expect(mockedUndici).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("honors Retry-After delta-seconds header", async () => {
    vi.useFakeTimers();
    mockedUndici
      .mockResolvedValueOnce(undiciOk({ status: 429, headers: { "retry-after": "2" }, body: "{}" }) as never)
      .mockResolvedValueOnce(undiciOk({ status: 200, headers: {}, body: "{}" }) as never);

    const p = stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } });
    // Advance fake timers by 2000ms — the documented Retry-After value.
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await p;
    expect(res.status).toBe(200);
    vi.useRealTimers();
  });

  it("throws TransportError(RATE_LIMITED) after exhausting retries on persistent 429", async () => {
    // Every attempt returns 429 with retry-after=0 so backoff is instant.
    mockedUndici.mockResolvedValue(undiciOk({ status: 429, headers: { "retry-after": "0" }, body: "{}" }) as never);

    await expect(stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      attempts: 4,
    });
    // 1 initial + 3 retries = 4 total calls
    expect(mockedUndici).toHaveBeenCalledTimes(4);
  });

  it("retries on 5xx and surfaces the final response when transient", async () => {
    mockedUndici
      .mockResolvedValueOnce(undiciOk({ status: 503, headers: {}, body: "<html/>" }) as never)
      .mockResolvedValueOnce(undiciOk({ status: 200, headers: {}, body: '{"k":1}' }) as never);

    const res = await stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } });
    expect(mockedUndici).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("throws TransportError(SERVER_ERROR) after exhausting retries on persistent 500", async () => {
    mockedUndici.mockResolvedValue(undiciOk({ status: 500, headers: {}, body: "boom" }) as never);

    await expect(stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } })).rejects.toMatchObject({
      code: "SERVER_ERROR",
      attempts: 4,
    });
  });

  it("respects TTCTL_TRANSPORT_MAX_RETRIES env override", async () => {
    process.env["TTCTL_TRANSPORT_MAX_RETRIES"] = "1";
    resetTransportConfigCache();
    mockedUndici.mockResolvedValue(undiciOk({ status: 429, headers: { "retry-after": "0" }, body: "{}" }) as never);

    await expect(stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      attempts: 2,
    });
    expect(mockedUndici).toHaveBeenCalledTimes(2);
  });

  it("propagates the AbortSignal to undici", async () => {
    mockedUndici.mockResolvedValueOnce(undiciOk({ status: 200, headers: {}, body: "{}" }) as never);

    const ctrl = new AbortController();
    await stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
      signal: ctrl.signal,
    });
    const initArg = mockedUndici.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(initArg.signal).toBeInstanceOf(AbortSignal);
    // The propagated signal is the composed one, so it triggers when the caller aborts.
    ctrl.abort(new Error("caller"));
    expect(initArg.signal?.aborted).toBe(true);
  });

  it("does not retry when the caller aborts during backoff", async () => {
    vi.useFakeTimers();
    mockedUndici.mockResolvedValueOnce(
      undiciOk({ status: 429, headers: { "retry-after": "60" }, body: "{}" }) as never,
    );

    const ctrl = new AbortController();
    const p = stockTransport({
      surface: "mobile-gateway",
      body: { operationName: "X" },
      signal: ctrl.signal,
    });

    // Let the first attempt resolve + the backoff sleep start.
    await vi.advanceTimersByTimeAsync(0);
    ctrl.abort(new Error("user-cancel"));
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
    // No second attempt fired — abort happened during sleep.
    expect(mockedUndici).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("treats an AbortError thrown by the transport as TIMEOUT when no caller abort fired", async () => {
    mockedUndici.mockImplementation(() => {
      const err = new Error("Request aborted by internal timeout");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    let captured: unknown;
    try {
      await stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(TransportError);
    expect((captured as TransportError).code).toBe("TIMEOUT");
    expect((captured as TransportError).surface).toBe("mobile-gateway");
  });
});

describe("impersonatedTransport — resilience behavior", () => {
  it("retries on 429 then returns the success", async () => {
    mockedFetch
      .mockResolvedValueOnce(wreqOk({ status: 429, headers: { "retry-after": "0" }, body: "{}" }) as never)
      .mockResolvedValueOnce(wreqOk({ status: 200, body: '{"ok":true}' }) as never);

    const res = await impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("retries on 502 and surfaces TransportError(SERVER_ERROR) on persistent failure", async () => {
    mockedFetch.mockResolvedValue(wreqOk({ status: 502, body: "<html/>" }) as never);

    await expect(
      impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } }),
    ).rejects.toMatchObject({ code: "SERVER_ERROR", attempts: 4 });
  });

  it("propagates Cf403Error WITHOUT retrying", async () => {
    mockedFetch.mockResolvedValueOnce(wreqOk({ status: 403, body: "<html>Cloudflare</html>" }) as never);

    await expect(
      impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } }),
    ).rejects.toBeInstanceOf(Cf403Error);
    expect(mockedFetch).toHaveBeenCalledTimes(1); // single attempt only
  });

  it("propagates the AbortSignal to node-wreq", async () => {
    mockedFetch.mockResolvedValueOnce(wreqOk({ status: 200, body: "{}" }) as never);

    const ctrl = new AbortController();
    await impersonatedTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
      signal: ctrl.signal,
    });
    const initArg = mockedFetch.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(initArg.signal).toBeInstanceOf(AbortSignal);
    ctrl.abort(new Error("caller"));
    expect(initArg.signal?.aborted).toBe(true);
  });

  it("surfaces a synchronous caller abort as TransportError(ABORTED)", async () => {
    mockedFetch.mockImplementationOnce(async (_url, init) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      // Simulate node-wreq seeing the aborted signal and rejecting accordingly.
      if (signal?.aborted) {
        const err = new Error("Aborted before send");
        err.name = "AbortError";
        throw err;
      }
      return wreqOk({ status: 200, body: "{}" }) as never;
    });

    const ctrl = new AbortController();
    ctrl.abort(new Error("pre-abort"));
    await expect(
      impersonatedTransport({
        surface: "talent-profile",
        body: { operationName: "X" },
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED", surface: "talent-profile" });
  });

  it("passes the configured per-attempt timeout to node-wreq", async () => {
    process.env["TTCTL_TRANSPORT_TIMEOUT_MS"] = "12345";
    process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"] = "678";
    resetTransportConfigCache();
    mockedFetch.mockResolvedValueOnce(wreqOk({ status: 200, body: "{}" }) as never);

    await impersonatedTransport({ surface: "talent-profile", body: { operationName: "X" } });
    const initArg = mockedFetch.mock.calls[0]?.[1] as { timeout?: number; connectTimeout?: number };
    expect(initArg.timeout).toBe(12_345);
    expect(initArg.connectTimeout).toBe(678);
  });
});

describe("impersonatedMultipartTransport — resilience behavior", () => {
  it("retries on 429 and ultimately surfaces the success", async () => {
    mockedFetch
      .mockResolvedValueOnce(wreqOk({ status: 429, headers: { "retry-after": "0" }, body: "{}" }) as never)
      .mockResolvedValueOnce(wreqOk({ status: 200, body: '{"data":{"upload":true}}' }) as never);

    const res = await impersonatedMultipartTransport({
      surface: "talent-profile",
      body: { operationName: "uploadResume" },
      files: { "0": { filename: "cv.pdf", content: Buffer.from("hi") } },
      map: { "0": ["variables.input.file"] },
    });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("rebuilds the FormData on each retry attempt", async () => {
    mockedFetch
      .mockResolvedValueOnce(wreqOk({ status: 429, headers: { "retry-after": "0" }, body: "{}" }) as never)
      .mockResolvedValueOnce(wreqOk({ status: 200, body: "{}" }) as never);

    await impersonatedMultipartTransport({
      surface: "talent-profile",
      body: { operationName: "uploadResume" },
      files: { "0": { filename: "cv.pdf", content: Buffer.from("hi") } },
      map: { "0": ["variables.input.file"] },
    });
    const firstBody = (mockedFetch.mock.calls[0]?.[1] as { body: FormData }).body;
    const secondBody = (mockedFetch.mock.calls[1]?.[1] as { body: FormData }).body;
    expect(firstBody).toBeInstanceOf(FormData);
    expect(secondBody).toBeInstanceOf(FormData);
    expect(firstBody).not.toBe(secondBody); // fresh instance per attempt
  });

  it("Cf403Error from multipart upload does NOT retry", async () => {
    mockedFetch.mockResolvedValueOnce(wreqOk({ status: 403, body: "Forbidden" }) as never);

    await expect(
      impersonatedMultipartTransport({
        surface: "talent-profile",
        body: { operationName: "X" },
        files: { "0": { filename: "a", content: Buffer.from("x") } },
        map: { "0": ["variables.x"] },
      }),
    ).rejects.toBeInstanceOf(Cf403Error);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("TransportError shape on retry-exhaustion", () => {
  it("carries surface, endpoint, attempts, lastStatus, lastRetryAfterMs", async () => {
    mockedUndici.mockResolvedValue(undiciOk({ status: 429, headers: { "retry-after": "0" }, body: "{}" }) as never);

    try {
      await stockTransport({ surface: "mobile-gateway", body: { operationName: "X" } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      const te = err as TransportError;
      expect(te.code).toBe("RATE_LIMITED");
      expect(te.surface).toBe("mobile-gateway");
      expect(te.endpoint).toBe("https://www.toptal.com/gateway/graphql/talent/graphql");
      expect(te.attempts).toBe(4);
      expect(te.lastStatus).toBe(429);
      expect(te.lastRetryAfterMs).toBe(0);
      expect(te.recovery).toMatch(/rate limited/i);
    }
  });
});
