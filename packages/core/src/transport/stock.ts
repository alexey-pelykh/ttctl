// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { request as undiciRequest } from "undici";

import { logTransportRequest } from "../lib/diagnostic-log.js";
import { readTransportConfig } from "../transport-resilience.js";
import { SURFACE_ENDPOINTS } from "../types.js";
import { COMMON_HEADERS, executeWithResilience } from "./_shared.js";
import type { TransportRequest, TransportResponse } from "./_shared.js";

/**
 * Stock HTTP via undici. Used for the mobile gateway endpoint, which doesn't
 * gate on TLS fingerprint.
 *
 * Resilience (#229): wraps the network call in a retry loop that handles
 * HTTP 429 (with `Retry-After` honoring) and 5xx with bounded exponential
 * backoff, applies a per-attempt timeout, and propagates the caller's
 * `AbortSignal` so an MCP client cancel actually tears down the in-flight
 * request. Final failures surface as a typed {@link TransportError}.
 */
export async function stockTransport(req: TransportRequest): Promise<TransportResponse> {
  const url = SURFACE_ENDPOINTS[req.surface];
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  if (req.authToken) headers["authorization"] = `Token token=${req.authToken}`;

  // Diagnostic log hook (issue #139). No-op when --verbose/--debug
  // are absent; otherwise emits a redacted request line/record to
  // stderr. Records start time outside the disabled-fast-path so
  // performance.now() is paid only when a logger is active.
  logTransportRequest({
    surface: req.surface,
    endpoint: url,
    transport: "stock",
    method: "POST",
    operationName: req.body.operationName,
    headers,
    body: req.body,
  });
  const body = JSON.stringify(req.body);

  // No-follow redirect policy (issue #268). `undici.request()` with the
  // default global dispatcher does NOT follow redirects — redirect
  // following is an opt-in interceptor (`undici.interceptors.redirect`)
  // that TTCtl never installs. The guarantee is structural, not a
  // default-value that a future major could flip, so there is no explicit
  // `redirect` / `maxRedirections` option to pin here (the request-level
  // options type has none). A 3xx response is surfaced verbatim and
  // rejected by `executeWithResilience` as a typed `RedirectError`.
  return executeWithResilience(req, url, async (signal) => {
    const res = await undiciRequest(url, {
      method: "POST",
      headers,
      body,
      signal,
      headersTimeout: readTransportConfig().timeoutMs,
      bodyTimeout: readTransportConfig().timeoutMs,
    });
    const text = await res.body.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) {
        responseHeaders[k] = v.join(", ");
      } else if (typeof v === "string") {
        responseHeaders[k] = v;
      }
    }
    return { status: res.statusCode, headers: responseHeaders, body: parsed };
  });
}
