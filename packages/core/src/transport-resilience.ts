// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError } from "./auth/errors.js";
import type { ToptalSurface } from "./types.js";

/**
 * Final-failure transport error raised after all retries are exhausted or
 * when a fatal signal-driven condition (caller abort, internal timeout)
 * terminates the request loop.
 *
 * Extends {@link TtctlError} so it propagates through service callers'
 * `if (err instanceof TtctlError) throw err;` guard verbatim — surfaces
 * (CLI / MCP) render `error.recovery` directly.
 *
 * **Codes**:
 *
 * - `TIMEOUT`     — internal per-request timeout fired (default 30s,
 *                   overridable via `TTCTL_TRANSPORT_TIMEOUT_MS`). The
 *                   underlying socket/handshake never completed in time.
 * - `ABORTED`     — caller's `AbortSignal` aborted before the request
 *                   completed. Typically driven by the MCP client cancelling
 *                   an in-flight tool call.
 * - `RATE_LIMITED` — HTTP 429 returned by the surface and the retry budget
 *                    was exhausted. `lastRetryAfterMs` (when set) reports
 *                    the server's last `Retry-After` hint.
 * - `SERVER_ERROR` — HTTP 5xx returned by the surface and the retry budget
 *                    was exhausted.
 */
export class TransportError extends TtctlError {
  override readonly name = "TransportError";
  readonly code: "TIMEOUT" | "ABORTED" | "RATE_LIMITED" | "SERVER_ERROR";
  readonly recovery: string;

  constructor(
    code: "TIMEOUT" | "ABORTED" | "RATE_LIMITED" | "SERVER_ERROR",
    public readonly surface: ToptalSurface,
    public readonly endpoint: string,
    public readonly attempts: number,
    message: string,
    public readonly lastStatus?: number,
    public readonly lastRetryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.recovery = RECOVERY[code];
  }
}

const RECOVERY: Readonly<Record<TransportError["code"], string>> = {
  TIMEOUT: "The Toptal API did not respond in time. Try again; if the wedge persists, file an issue.",
  ABORTED: "Request was cancelled by the caller before it completed.",
  RATE_LIMITED:
    "Toptal returned HTTP 429 (rate limited) after the configured retry budget. Wait a few minutes and retry.",
  SERVER_ERROR: "Toptal returned a 5xx response after the configured retry budget. Retry later or file an issue.",
};

/**
 * Transport resilience configuration. All fields are read from environment
 * variables ONCE on first call to {@link readTransportConfig} and cached. The
 * cache is reset by {@link resetTransportConfigCache} (test-only).
 *
 * Env-var resolution:
 *
 * | Field          | Env var                              | Default | Bounds   |
 * |----------------|--------------------------------------|---------|----------|
 * | `timeoutMs`    | `TTCTL_TRANSPORT_TIMEOUT_MS`         | 30000   | ≥ 1      |
 * | `connectMs`    | `TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS` | 10000   | ≥ 1      |
 * | `maxRetries`   | `TTCTL_TRANSPORT_MAX_RETRIES`        | 3       | 0–10     |
 *
 * Invalid values (NaN, negative, out-of-range) silently fall back to the
 * default — the transport must not blow up on a stray operator typo in an
 * MCP client env block.
 */
export interface TransportConfig {
  /** Total request timeout in milliseconds applied to each attempt. */
  timeoutMs: number;
  /** Connection-establishment timeout in milliseconds. */
  connectMs: number;
  /** Maximum number of retry attempts for 429 and 5xx responses. */
  maxRetries: number;
}

const DEFAULT_CONFIG: TransportConfig = Object.freeze({
  timeoutMs: 30_000,
  connectMs: 10_000,
  maxRetries: 3,
});

let cachedConfig: TransportConfig | undefined;

export function readTransportConfig(): TransportConfig {
  if (cachedConfig !== undefined) return cachedConfig;
  cachedConfig = {
    timeoutMs: readPositiveIntEnv("TTCTL_TRANSPORT_TIMEOUT_MS", DEFAULT_CONFIG.timeoutMs),
    connectMs: readPositiveIntEnv("TTCTL_TRANSPORT_CONNECT_TIMEOUT_MS", DEFAULT_CONFIG.connectMs),
    maxRetries: readBoundedIntEnv("TTCTL_TRANSPORT_MAX_RETRIES", DEFAULT_CONFIG.maxRetries, 0, 10),
  };
  return cachedConfig;
}

/**
 * Reset the cached transport config so the next {@link readTransportConfig}
 * call re-reads the environment. Test-only — production callers never reach
 * for this directly.
 */
export function resetTransportConfigCache(): void {
  cachedConfig = undefined;
}

function readPositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function readBoundedIntEnv(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return defaultValue;
  return parsed;
}

/**
 * Parse an HTTP `Retry-After` header value into a delay in milliseconds.
 *
 * The header takes one of two forms (RFC 9110 § 10.2.3):
 *
 * - **delta-seconds** — an integer number of seconds (e.g. `Retry-After: 30`).
 * - **HTTP-date**     — an absolute timestamp (e.g.
 *   `Retry-After: Fri, 31 Dec 2025 23:59:59 GMT`); delay is computed as
 *   `target - now`, clamped to ≥ 0.
 *
 * Returns `undefined` when the header is absent, malformed, or yields a
 * negative delay; callers fall back to computed exponential backoff.
 *
 * `nowMs` is injectable for deterministic tests.
 */
export function parseRetryAfter(headerValue: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (headerValue === undefined) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === "") return undefined;
  // delta-seconds — integer form first; tolerant of leading-zero / surrounding-space variants.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return seconds * 1000;
  }
  // HTTP-date form. RFC 9110 requires `IMF-fixdate` / `obs-date` shapes
  // which always carry alphabetic day-name / month-name tokens; reject
  // pure-numeric leftovers (e.g. `"-1"`, `"12.5"`) that `Date.parse`
  // would otherwise opportunistically interpret as a year.
  if (!/[A-Za-z]/.test(trimmed)) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  const delta = parsed - nowMs;
  return delta > 0 ? delta : 0;
}

/**
 * Compute exponential-backoff delay in milliseconds for a retry attempt.
 *
 * Formula: `baseMs × 2^attempt`, with ±25 % uniform jitter, clamped to
 * `capMs`. `attempt` is zero-indexed (0 = first retry).
 *
 * 429 responses use a longer base (250 ms) than 5xx (100 ms) so a rate-limit
 * recovery walks back further than a transient server hiccup. The jitter
 * (`random` injectable for tests) reduces the thundering-herd risk when many
 * MCP tool calls land on the same 429 window simultaneously.
 */
export function computeBackoffDelay(
  reason: "rate-limit" | "server-error",
  attempt: number,
  random: () => number = Math.random,
): number {
  const baseMs = reason === "rate-limit" ? 250 : 100;
  const capMs = 30_000;
  const raw = baseMs * 2 ** attempt;
  const jitter = 1 + (random() * 2 - 1) * 0.25; // ±25%
  return Math.min(Math.max(0, Math.round(raw * jitter)), capMs);
}

/**
 * Sleep for `ms` milliseconds, rejecting with the signal's abort reason if
 * the caller aborts during the wait. Used for between-retry backoff so a
 * cancellation propagates promptly rather than waiting out the full delay.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      // `signal` is guaranteed defined here — `onAbort` is registered only
      // via the `signal?.addEventListener` branch below — but the listener
      // closure references the outer-scope binding so eslint cannot infer
      // narrowing across the boundary. Read defensively.
      reject(toError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Normalise an arbitrary `AbortSignal.reason` value into an `Error`. The
 * runtime convention is for `reason` to BE an `Error` (DOMException for
 * `AbortSignal.timeout`, custom `Error` for `AbortController.abort(err)`),
 * but the type is `unknown` and operators occasionally pass strings or
 * `undefined`. Wrap non-Error shapes so downstream Promise consumers
 * always see a real Error.
 */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Aborted");
}

/**
 * Combine the caller's `AbortSignal` (if any) with a per-attempt internal
 * timeout into a single signal usable by the underlying transport. Returns
 * the combined signal plus a `dispose()` to release the timeout resource
 * once the attempt completes (preventing dangling timers).
 *
 * When no caller signal is provided, the combined signal IS the timeout
 * signal directly — no `AbortSignal.any` wrapping overhead.
 */
export function combineSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new DOMException("Transport request timed out.", "TimeoutError"));
  }, timeoutMs);
  // Unref so a stray timer doesn't keep Node alive on early caller resolution.
  timer.unref();
  const signal =
    callerSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([callerSignal, timeoutController.signal]);
  return {
    signal,
    dispose: (): void => {
      clearTimeout(timer);
    },
  };
}

/**
 * Classify an error thrown by the underlying transport into a stable
 * category so the retry loop can decide whether to retry, surface, or
 * re-throw.
 *
 * - `aborted-by-caller` — the caller's signal aborted (cancellation).
 * - `timeout`           — the internal per-attempt timeout fired.
 * - `network`           — any other transport-level failure (DNS, socket
 *                          reset, TLS error). NOT retried in v1 (could be a
 *                          follow-up for #229 if empirical wedge data shows
 *                          retries help).
 */
export function classifyTransportError(
  err: unknown,
  callerSignal: AbortSignal | undefined,
): "aborted-by-caller" | "timeout" | "network" {
  if (callerSignal?.aborted) return "aborted-by-caller";
  if (err instanceof DOMException && err.name === "TimeoutError") return "timeout";
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return "timeout";
  }
  return "network";
}

/**
 * Determine whether a response status code is retryable per the issue
 * #229 policy.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}
