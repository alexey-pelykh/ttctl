// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { request as undiciRequest } from "undici";

import { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
import type { GraphQLRequest, ToptalSurface } from "./types.js";

/**
 * TLS-impersonation profile. Pinned to `chrome_146` to match the
 * `User-Agent: Chrome/146` we send. See the `tls-fingerprinting` skill —
 * identity-catalog freshness requires the impersonate profile and User-Agent
 * to track current Chrome stable as a coupled pair.
 */
export const IMPERSONATE_PROFILE = "chrome_146";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const COMMON_HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json",
  origin: "https://talent.toptal.com",
  referer: "https://talent.toptal.com/",
  "sec-fetch-site": "same-site",
  "user-agent": USER_AGENT,
};

export interface TransportRequest {
  surface: ToptalSurface;
  body: GraphQLRequest;
  cookieHeader?: string;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Choose transport per surface. The mobile gateway accepts stock TLS;
 * `talent-profile` and `scheduler` require Chrome TLS-fingerprint impersonation
 * to clear Cloudflare's bot-management.
 */
export async function callSurface(req: TransportRequest): Promise<TransportResponse> {
  if (SURFACES_REQUIRING_IMPERSONATION.has(req.surface)) {
    return impersonatedTransport(req);
  }
  return stockTransport(req);
}

/**
 * Stock HTTP via undici. Used for the mobile gateway endpoint, which doesn't
 * gate on TLS fingerprint.
 */
export async function stockTransport(req: TransportRequest): Promise<TransportResponse> {
  const url = SURFACE_ENDPOINTS[req.surface];
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  if (req.cookieHeader) headers["cookie"] = req.cookieHeader;

  const res = await undiciRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(req.body),
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
}

/**
 * Impersonated HTTP via `node-wreq` (Rust + BoringSSL). Used for the
 * Cloudflare-protected `talent-profile` and `scheduler` surfaces.
 *
 * Implementation deferred to milestone 1 — see issue tracker. This stub keeps
 * the type surface in place so dependent code compiles.
 */
export function impersonatedTransport(req: TransportRequest): Promise<TransportResponse> {
  // TODO(milestone-1): wire node-wreq with `browser: 'chrome_146'`,
  // header-tuple ordering, and per-surface cookie jar.
  void req;
  return Promise.reject(new Error("impersonatedTransport not yet implemented; see TODO"));
}
