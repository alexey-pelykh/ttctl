// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { redactBody, redactHeaders } from "./redact.js";

/**
 * Diagnostic log level controlling transport-side observability emitted
 * to stderr (issue #139). Three states:
 *
 * - `"none"` — default; all log functions are no-ops. The disabled path
 *   is constant-folded against the module-scoped `currentLevel` so
 *   the cost is a single integer comparison per transport call.
 * - `"verbose"` — emit one line per transport request and one line per
 *   response, of shape: `POST <url> operation=<op>` and
 *   `<status> <reasonPhrase> (elapsedMs=<n>)`. Suitable for "what is
 *   the CLI doing" diagnostics without exposing wire content.
 * - `"debug"` — emit a single JSON-encoded record per request and per
 *   response, including redacted headers and redacted body. Suitable
 *   for paste-into-issue debugging. The bearer token (in the
 *   `authorization` header) and any cookie values are redacted before
 *   serialization per the `redact` module.
 *
 * Output channel is `process.stderr` exclusively (AC #5 of issue #139).
 * The data channel (`process.stdout`, the json/yaml/pretty envelopes
 * locked under #126 / #128) is never touched by this module.
 */
export type DiagnosticLevel = "none" | "verbose" | "debug";

/**
 * Module-scoped diagnostic level. Mirrors the `dry-run.ts` /
 * `config-context.ts` pattern: one global holder, set once by the CLI's
 * `preAction` hook, read by transport entry points. Module isolation
 * keeps each call site's signature focused on its domain (no logger
 * parameter threading) while exposing a single place to test the
 * captured value.
 *
 * Tests MUST call {@link resetDiagnosticLogger} in `beforeEach` to
 * avoid state bleeding across cases.
 */
let currentLevel: DiagnosticLevel = "none";

/**
 * Set the diagnostic level. Called by the CLI's `preAction` hook once
 * per invocation when `--verbose` or `--debug` is present. Setting
 * `"none"` (or omitting the call) keeps the disabled path active.
 *
 * Precedence (for the CLI hook, not enforced here): `--debug` wins over
 * `--verbose` if both are passed. The decision lives in `program.ts`;
 * this function takes whatever level the caller computed.
 */
export function setDiagnosticLogger(level: DiagnosticLevel): void {
  currentLevel = level;
}

/**
 * Read the captured diagnostic level. Returns `"none"` when no level
 * has been set (the default).
 */
export function getDiagnosticLogger(): DiagnosticLevel {
  return currentLevel;
}

/**
 * Reset to `"none"`. Tests call this in `beforeEach` to keep the
 * module-scoped state isolated. Production code never needs to call
 * this — the CLI's `preAction` hook sets the level once per invocation.
 */
export function resetDiagnosticLogger(): void {
  currentLevel = "none";
}

/**
 * Information about a transport request, captured by the transport
 * layer before the network call. Shape mirrors `TransportRequest` /
 * `MultipartTransportRequest` but is decoupled from those types so
 * future transport additions can log without circular dependencies.
 *
 * `body` is the parsed request envelope (operation name, variables) —
 * NOT the JSON-stringified wire bytes. Redaction is applied by this
 * module on emission.
 */
export interface RequestLogInfo {
  surface: string;
  endpoint: string;
  transport: "stock" | "impersonated" | "impersonated-multipart";
  method: string;
  operationName: string;
  headers: Record<string, string>;
  body: unknown;
  /**
   * Multipart upload metadata for `impersonated-multipart` requests:
   * the file slot labels and the variable paths they bind to. The
   * binary contents of the files are NOT included (intentionally —
   * binary content is not useful in a diagnostic trace).
   */
  multipart?: { files: string[]; map: Record<string, string[]> };
}

/**
 * Information about a transport response, captured AFTER the network
 * call completes. `body` is the parsed response envelope (when JSON)
 * or the raw text (when the response was not JSON). `elapsedMs` is
 * `performance.now()`-derived monotonic elapsed milliseconds from
 * request start, so it stays accurate across wall-clock adjustments
 * during the call.
 */
export interface ResponseLogInfo {
  surface: string;
  endpoint: string;
  operationName: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  elapsedMs: number;
}

/**
 * Emit a `--verbose` / `--debug` line for a transport REQUEST.
 *
 * - `"none"`: no-op (single comparison, no allocation).
 * - `"verbose"`: emits one line `POST <endpoint> operation=<op>`.
 * - `"debug"`: emits one JSON-encoded line containing the redacted
 *   request envelope: surface, transport, endpoint, method, operation
 *   name, redacted headers, redacted body, optional multipart map.
 *   Bearer token (`authorization` header) and cookie values are
 *   replaced with `***REDACTED***` per the `redact` module BEFORE
 *   JSON.stringify, so the serialized line cannot leak any secret.
 *
 * Writes to `process.stderr` only; never touches `process.stdout`.
 */
export function logTransportRequest(info: RequestLogInfo): void {
  if (currentLevel === "none") return;
  if (currentLevel === "verbose") {
    process.stderr.write(`${info.method} ${info.endpoint} operation=${info.operationName}\n`);
    return;
  }
  // debug path: full request envelope with redaction
  const record = {
    kind: "request" as const,
    surface: info.surface,
    transport: info.transport,
    endpoint: info.endpoint,
    method: info.method,
    operationName: info.operationName,
    headers: redactHeaders(info.headers),
    body: redactBody(info.body),
    ...(info.multipart !== undefined ? { multipart: info.multipart } : {}),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * Emit a `--verbose` / `--debug` line for a transport RESPONSE.
 *
 * - `"none"`: no-op.
 * - `"verbose"`: emits one line `<status> <reasonPhrase> (elapsedMs=<n>)`.
 *   `<reasonPhrase>` is derived from {@link HTTP_REASON_PHRASES}; for
 *   uncatalogued status codes (rare; non-standard 7xx etc.), the
 *   phrase is `"-"`.
 * - `"debug"`: emits one JSON-encoded line containing the redacted
 *   response envelope: surface, endpoint, operation name, status,
 *   redacted headers, redacted body, elapsed milliseconds. The
 *   response body is redacted because Toptal occasionally echoes
 *   session-bearing fields back to the caller (per issue #139 spec).
 *
 * Writes to `process.stderr` only.
 */
export function logTransportResponse(info: ResponseLogInfo): void {
  if (currentLevel === "none") return;
  if (currentLevel === "verbose") {
    const phrase = HTTP_REASON_PHRASES[info.status] ?? "-";
    process.stderr.write(
      `${info.status.toString()} ${phrase} (elapsedMs=${info.elapsedMs.toFixed(0)}, operation=${info.operationName})\n`,
    );
    return;
  }
  // debug path
  const record = {
    kind: "response" as const,
    surface: info.surface,
    endpoint: info.endpoint,
    operationName: info.operationName,
    status: info.status,
    headers: redactHeaders(info.headers),
    body: redactBody(info.body),
    elapsedMs: Math.round(info.elapsedMs),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

/**
 * Minimal table of HTTP reason phrases used by the `"verbose"` log
 * line. Not exhaustive — covers the status codes TTCtl's transport
 * paths plausibly observe in production (mobile gateway, Cloudflare
 * surfaces, multipart upload). Uncatalogued codes render as `"-"`,
 * which is sufficient signal for verbose-mode triage.
 */
const HTTP_REASON_PHRASES: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
