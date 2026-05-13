// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyTransportError,
  combineSignals,
  computeBackoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  readTransportConfig,
  resetTransportConfigCache,
  sleepUnlessAborted,
  TransportError,
} from "../transport-resilience.js";

describe("parseRetryAfter", () => {
  it("returns undefined for an absent header", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty / whitespace header", () => {
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
  });

  it("parses delta-seconds form into milliseconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("  42  ")).toBe(42_000);
  });

  it("parses HTTP-date form relative to now", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00:00Z
    const future = new Date(now + 5_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(5_000);
  });

  it("clamps past HTTP-date timestamps to 0", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const past = new Date(now - 5_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it("returns undefined for malformed values", () => {
    expect(parseRetryAfter("nope")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
    expect(parseRetryAfter("12.5")).toBeUndefined();
  });
});

describe("computeBackoffDelay", () => {
  it("returns deterministic delays under a fixed random", () => {
    const fixedRandom = (): number => 0.5; // mid-jitter — no scale change
    expect(computeBackoffDelay("rate-limit", 0, fixedRandom)).toBe(250);
    expect(computeBackoffDelay("rate-limit", 1, fixedRandom)).toBe(500);
    expect(computeBackoffDelay("rate-limit", 2, fixedRandom)).toBe(1_000);
    expect(computeBackoffDelay("server-error", 0, fixedRandom)).toBe(100);
    expect(computeBackoffDelay("server-error", 3, fixedRandom)).toBe(800);
  });

  it("applies ±25% jitter at the boundaries", () => {
    const min = computeBackoffDelay("rate-limit", 1, () => 0);
    const max = computeBackoffDelay("rate-limit", 1, () => 1);
    expect(min).toBe(Math.round(500 * 0.75));
    expect(max).toBe(Math.round(500 * 1.25));
  });

  it("clamps to the 30s cap", () => {
    const huge = computeBackoffDelay("rate-limit", 100, () => 1);
    expect(huge).toBeLessThanOrEqual(30_000);
    expect(huge).toBe(30_000);
  });

  it("rate-limit base is greater than server-error base", () => {
    const rl = computeBackoffDelay("rate-limit", 0, () => 0.5);
    const se = computeBackoffDelay("server-error", 0, () => 0.5);
    expect(rl).toBeGreaterThan(se);
  });
});

describe("isRetryableStatus", () => {
  it("treats 429 as retryable", () => {
    expect(isRetryableStatus(429)).toBe(true);
  });
  it("treats 5xx as retryable", () => {
    for (const s of [500, 502, 503, 504, 599]) expect(isRetryableStatus(s)).toBe(true);
  });
  it("treats non-5xx, non-429 as not retryable", () => {
    for (const s of [200, 301, 400, 401, 403, 404, 422, 600]) expect(isRetryableStatus(s)).toBe(false);
  });
});

describe("sleepUnlessAborted", () => {
  it("resolves after the specified delay when not aborted", async () => {
    const start = Date.now();
    await sleepUnlessAborted(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const ctrl = new AbortController();
    const cause = new Error("already done");
    ctrl.abort(cause);
    await expect(sleepUnlessAborted(1000, ctrl.signal)).rejects.toBe(cause);
  });

  it("rejects when the signal aborts during the wait", async () => {
    const ctrl = new AbortController();
    setTimeout(() => {
      ctrl.abort(new Error("mid-flight"));
    }, 10);
    await expect(sleepUnlessAborted(1000, ctrl.signal)).rejects.toThrow("mid-flight");
  });

  it("resolves when no signal is supplied", async () => {
    await expect(sleepUnlessAborted(5)).resolves.toBeUndefined();
  });
});

describe("combineSignals", () => {
  it("returns the timeout signal directly when no caller signal is provided", () => {
    const { signal, dispose } = combineSignals(undefined, 5_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    dispose();
  });

  it("composes caller + timeout via AbortSignal.any", () => {
    const caller = new AbortController();
    const { signal, dispose } = combineSignals(caller.signal, 5_000);
    expect(signal.aborted).toBe(false);
    caller.abort(new Error("caller-cancel"));
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it("aborts when the internal timeout fires (short timeout)", async () => {
    vi.useFakeTimers();
    const { signal, dispose } = combineSignals(undefined, 50);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(51);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect((signal.reason as DOMException).name).toBe("TimeoutError");
    dispose();
    vi.useRealTimers();
  });

  it("dispose() clears the timer so the signal doesn't fire afterward", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const { signal, dispose } = combineSignals(caller.signal, 50);
    dispose();
    vi.advanceTimersByTime(200);
    // Caller never aborted, timeout was disposed → signal still clean.
    expect(signal.aborted).toBe(false);
    vi.useRealTimers();
  });
});

describe("classifyTransportError", () => {
  it("reports caller abort when the caller signal is aborted", () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("caller"));
    const err = new Error("anything");
    expect(classifyTransportError(err, ctrl.signal)).toBe("aborted-by-caller");
  });

  it("reports timeout for DOMException(TimeoutError)", () => {
    const err = new DOMException("timed out", "TimeoutError");
    expect(classifyTransportError(err, undefined)).toBe("timeout");
  });

  it("reports timeout for an Error named TimeoutError", () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    expect(classifyTransportError(err, undefined)).toBe("timeout");
  });

  it("reports timeout for an Error named AbortError when caller did not abort", () => {
    const err = new Error("aborted internally");
    err.name = "AbortError";
    expect(classifyTransportError(err, undefined)).toBe("timeout");
  });

  it("reports network for any other thrown shape", () => {
    expect(classifyTransportError(new Error("ECONNRESET"), undefined)).toBe("network");
    expect(classifyTransportError("string-not-error", undefined)).toBe("network");
  });
});

describe("readTransportConfig", () => {
  const originals = {
    timeout: process.env["TTCTL_TRANSPORT_TIMEOUT_MS"],
    connect: process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"],
    retries: process.env["TTCTL_TRANSPORT_MAX_RETRIES"],
  };

  beforeEach(() => {
    resetTransportConfigCache();
  });

  afterEach(() => {
    if (originals.timeout === undefined) delete process.env["TTCTL_TRANSPORT_TIMEOUT_MS"];
    else process.env["TTCTL_TRANSPORT_TIMEOUT_MS"] = originals.timeout;
    if (originals.connect === undefined) delete process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"];
    else process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"] = originals.connect;
    if (originals.retries === undefined) delete process.env["TTCTL_TRANSPORT_MAX_RETRIES"];
    else process.env["TTCTL_TRANSPORT_MAX_RETRIES"] = originals.retries;
    resetTransportConfigCache();
  });

  it("uses defaults when no env is set", () => {
    delete process.env["TTCTL_TRANSPORT_TIMEOUT_MS"];
    delete process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"];
    delete process.env["TTCTL_TRANSPORT_MAX_RETRIES"];
    const cfg = readTransportConfig();
    expect(cfg).toEqual({ timeoutMs: 30_000, connectMs: 10_000, maxRetries: 3 });
  });

  it("reads valid env overrides", () => {
    process.env["TTCTL_TRANSPORT_TIMEOUT_MS"] = "15000";
    process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"] = "5000";
    process.env["TTCTL_TRANSPORT_MAX_RETRIES"] = "5";
    const cfg = readTransportConfig();
    expect(cfg).toEqual({ timeoutMs: 15_000, connectMs: 5_000, maxRetries: 5 });
  });

  it("silently falls back to defaults on invalid env values", () => {
    process.env["TTCTL_TRANSPORT_TIMEOUT_MS"] = "notanumber";
    process.env["TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS"] = "-5";
    process.env["TTCTL_TRANSPORT_MAX_RETRIES"] = "99"; // out of bounds
    const cfg = readTransportConfig();
    expect(cfg).toEqual({ timeoutMs: 30_000, connectMs: 10_000, maxRetries: 3 });
  });

  it("caches results across calls until reset", () => {
    process.env["TTCTL_TRANSPORT_TIMEOUT_MS"] = "12345";
    const first = readTransportConfig();
    process.env["TTCTL_TRANSPORT_TIMEOUT_MS"] = "67890";
    const second = readTransportConfig();
    expect(first).toBe(second);
    resetTransportConfigCache();
    const third = readTransportConfig();
    expect(third.timeoutMs).toBe(67_890);
  });
});

describe("TransportError", () => {
  it("carries the discriminating code and recovery hint", () => {
    const err = new TransportError(
      "RATE_LIMITED",
      "mobile-gateway",
      "https://example/graphql",
      4,
      "rate limited",
      429,
      30_000,
    );
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.surface).toBe("mobile-gateway");
    expect(err.attempts).toBe(4);
    expect(err.lastStatus).toBe(429);
    expect(err.lastRetryAfterMs).toBe(30_000);
    expect(err.recovery).toContain("rate limited");
  });

  it("has a unique recovery line per code", () => {
    const codes = ["TIMEOUT", "ABORTED", "RATE_LIMITED", "SERVER_ERROR"] as const;
    const recoveries = codes.map((c) => new TransportError(c, "mobile-gateway", "x", 1, "m").recovery);
    expect(new Set(recoveries).size).toBe(codes.length);
  });

  it("preserves cause for downstream debugging", () => {
    const cause = new Error("dns");
    const err = new TransportError("TIMEOUT", "mobile-gateway", "x", 1, "timed out", undefined, undefined, { cause });
    expect(err.cause).toBe(cause);
  });
});
