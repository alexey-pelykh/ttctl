// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fetch as wreqFetch } from "node-wreq";
import type { BrowserProfile } from "node-wreq";
import { request as undiciRequest } from "undici";

import { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
import type { GraphQLRequest, ToptalSurface } from "./types.js";

/**
 * TLS-impersonation profile. Pinned as a coupled pair with `USER_AGENT` —
 * see the `tls-fingerprinting` skill on identity-catalog freshness: WAFs
 * cross-validate the User-Agent string against the JA4 hash, so the profile
 * and UA must both name the same Chrome version. Bump them together when
 * `node-wreq` publishes a newer profile.
 *
 * Currently `chrome_145` because that is the freshest profile published in
 * `node-wreq@2.2.1`. The Rust upstream `wreq` crate has `chrome_146` in
 * its release-candidate stream but the Node bindings have not yet shipped a
 * matching release. Track upstream and bump.
 */
export const IMPERSONATE_PROFILE: BrowserProfile = "chrome_145";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

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
 * The `browser` option drives node-wreq's TLS ClientHello and HTTP/2
 * SETTINGS frame to match the bundled Chrome profile (see `IMPERSONATE_PROFILE`).
 * Header-tuple ordering is left as a future tightening — currently we pass
 * a plain `Record<string, string>` matching `stockTransport`'s shape so the
 * two transports stay symmetric. JA4H header-name ordering is a secondary
 * detection vector relative to JA4 / Akamai HTTP/2; revisit if empirical
 * blocks indicate it matters.
 */
export async function impersonatedTransport(req: TransportRequest): Promise<TransportResponse> {
  const url = SURFACE_ENDPOINTS[req.surface];
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  if (req.cookieHeader) headers["cookie"] = req.cookieHeader;

  const res = await wreqFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(req.body),
    browser: IMPERSONATE_PROFILE,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    status: res.status,
    headers: res.headers.toObject(),
    body: parsed,
  };
}
