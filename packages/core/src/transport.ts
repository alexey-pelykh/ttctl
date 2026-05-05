// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fetch as wreqFetch } from "node-wreq";
import type { BrowserProfile } from "node-wreq";
import { request as undiciRequest } from "undici";

import { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
import type { GraphQLRequest, ToptalSurface } from "./types.js";

/**
 * Per-surface refresh entry-points the user must visit in a real browser to
 * regenerate `cf_clearance`. Only impersonated surfaces are listed: the
 * mobile gateway is not Cloudflare-protected and never throws `Cf403Error`.
 *
 * `talent-profile` and `scheduler` live in distinct Cloudflare zones, so a
 * cookie minted at `talent.toptal.com` does not clear `scheduler.toptal.com`
 * and vice-versa.
 */
const CF_REFRESH_URLS: Record<ToptalSurface, string> = {
  "mobile-gateway": "https://talent.toptal.com/",
  "talent-profile": "https://talent.toptal.com/",
  scheduler: "https://scheduler.toptal.com/",
};

/**
 * Thrown when an impersonated surface returns HTTP 403, which on Cloudflare-
 * protected endpoints almost always means `cf_clearance` is invalid (expired,
 * IP-rebound, or JA3-drifted). The cookie cannot be refreshed programmatically
 * — it is gated by a bot-management challenge that requires a real browser
 * with a real user. The error message walks the user through the manual
 * refresh procedure for the offending surface.
 */
export class Cf403Error extends Error {
  override readonly name = "Cf403Error";

  constructor(
    public readonly surface: ToptalSurface,
    public readonly endpoint: string,
  ) {
    super(Cf403Error.formatMessage(surface, endpoint));
  }

  /**
   * Build the user-facing message. The message text is intentionally verbose
   * and step-numbered so an unhandled throw at the CLI surfaces actionable
   * recovery instructions, not a generic stack trace.
   */
  static formatMessage(surface: ToptalSurface, endpoint: string): string {
    const refreshUrl = CF_REFRESH_URLS[surface];
    return [
      `Cloudflare returned 403 for surface "${surface}" (${endpoint}).`,
      "`cf_clearance` cookie may have expired (Cloudflare 403). To refresh:",
      `  1. Open ${refreshUrl} in Chrome.`,
      "  2. Pass any bot-check (CAPTCHA / Turnstile) if shown.",
      "  3. From DevTools → Application → Cookies, copy the `cf_clearance` value.",
      "  4. Update your cookie jar with the new value (manually edit",
      "     ~/.ttctl/session.cookies, OR rerun `ttctl auth signin`).",
    ].join("\n");
  }
}

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
  /**
   * Raw `Set-Cookie` header values, preserved as an array. Joining cookies on
   * `,` is destructive — `Expires=Sun, 06 Nov 1994 08:49:37 GMT` contains a
   * comma — so the array form is what consumers (cookie jars) need.
   */
  setCookies?: string[];
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
  let setCookies: string[] | undefined;
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === "set-cookie") {
      setCookies = Array.isArray(v) ? [...v] : typeof v === "string" ? [v] : undefined;
      continue;
    }
    if (Array.isArray(v)) {
      responseHeaders[k] = v.join(", ");
    } else if (typeof v === "string") {
      responseHeaders[k] = v;
    }
  }
  return { status: res.statusCode, headers: responseHeaders, body: parsed, ...(setCookies ? { setCookies } : {}) };
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

  if (res.status === 403) {
    throw new Cf403Error(req.surface, url);
  }

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
