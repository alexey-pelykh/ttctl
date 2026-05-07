// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fetch as wreqFetch } from "node-wreq";
import type { BrowserProfile } from "node-wreq";
import { request as undiciRequest } from "undici";

import { TtctlError } from "./auth/errors.js";
import { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
import type { GraphQLRequest, ToptalSurface } from "./types.js";

/**
 * Thrown when an impersonated surface returns HTTP 403.
 *
 * Empirically, Chrome TLS impersonation alone passes Cloudflare on the
 * surfaces TTCtl currently uses (`talent-profile`, `scheduler`) — see
 * `research/docs/decisions/ADR-005-token-auth.md`. A 403 here therefore
 * means Cloudflare has flipped a feature flag (e.g. activated a Turnstile
 * challenge or a new bot-management heuristic) that we don't currently
 * handle. There is no documented manual workaround; the user is asked to
 * file an issue so we can investigate.
 *
 * Refined under issue #77 to extend `TtctlError`. Carries the stable
 * `code = 'CF_403_CLEARANCE'` and a short `recovery` hint that the CLI /
 * MCP surfaces render alongside the existing multi-line `message`.
 *
 * See also `Cf403PersistentError` (defined for future use when an explicit
 * retry-with-fresh-clearance heuristic is added — currently TTCtl cannot
 * distinguish "clearance expired" from "persistent block" at runtime, so
 * `Cf403Error` is the only class actually thrown by the transport).
 */
export class Cf403Error extends TtctlError {
  override readonly name = "Cf403Error";
  readonly code = "CF_403_CLEARANCE";
  readonly recovery =
    "Cloudflare returned 403. Try the request again; if the block persists, file an issue at " +
    "https://github.com/alexey-pelykh/ttctl/issues with the surface name and a timestamp.";

  constructor(
    public readonly surface: ToptalSurface,
    public readonly endpoint: string,
  ) {
    super(Cf403Error.formatMessage(surface, endpoint));
  }

  static formatMessage(surface: ToptalSurface, endpoint: string): string {
    return [
      `Cloudflare returned HTTP 403 from surface "${surface}" (${endpoint}).`,
      "",
      "Empirically, Chrome TLS impersonation alone passes Cloudflare in the happy path on this surface. " +
        "A 403 here means Cloudflare's bot-management has flipped a feature flag we don't currently handle.",
      "",
      `Please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the surface name ("${surface}") ` +
        "and a timestamp so we can investigate.",
    ].join("\n");
  }
}

/**
 * Thrown when Cloudflare is *persistently* blocking an impersonated surface
 * — i.e. clearance refresh and re-attempts have failed and the only
 * remaining recovery is the cookie-jar break-glass path documented in
 * `SECURITY.md`.
 *
 * **Currently defined for future use.** TTCtl's transport has no automated
 * retry-with-fresh-clearance heuristic, so a single 403 cannot be
 * distinguished from a persistent block at runtime. The transport throws
 * the more general `Cf403Error`. When a future iteration adds retry +
 * clearance refresh, that layer will re-classify a confirmed-persistent
 * block to `Cf403PersistentError`. See issue #77 § Out of Scope.
 */
export class Cf403PersistentError extends TtctlError {
  override readonly name = "Cf403PersistentError";
  readonly code = "CF_403_PERSISTENT";
  readonly recovery =
    "Cloudflare is persistently blocking this surface. The cookie-jar auxiliary auth path is the only " +
    "remaining recovery — see SECURITY.md for break-glass details, and file an issue at " +
    "https://github.com/alexey-pelykh/ttctl/issues so we can investigate.";

  constructor(
    public readonly surface: ToptalSurface,
    public readonly endpoint: string,
    message: string = `Cloudflare persistently blocked surface "${surface}" (${endpoint}).`,
  ) {
    super(message);
  }
}

/**
 * Thrown when the scheduler bearer token has expired.
 *
 * **Scaffolded for post-v1 scheduler-surface coverage.** TTCtl currently
 * has no scheduler operations wired in; transport routes scheduler →
 * impersonated, but no service module issues scheduler GraphQL calls. When
 * scheduler coverage lands (post-v1), this class will be thrown by the
 * scheduler service module on bearer-expiry detection.
 *
 * `autoRecover = true` signals to the transport layer that an automated
 * re-mint via `GetTopSchedulerToken` should be attempted once before
 * surfacing this error. The auto-recovery contract is intentionally
 * defined here so callers can plan against it; the actual re-mint
 * orchestration ships with the scheduler surface implementation.
 */
export class SchedulerBearerExpired extends TtctlError {
  override readonly name = "SchedulerBearerExpired";
  readonly code = "SCHEDULER_BEARER_EXPIRED";
  readonly recovery = "Scheduler bearer token expired; will be re-minted automatically on next call.";
  override readonly autoRecover = true;

  constructor(message: string = "Scheduler bearer token expired.") {
    super(message);
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
  // Mobile-app fingerprint alignment: the official Toptal mobile client sets
  // this on every gateway call. Not load-bearing for auth (empirically the
  // Token header alone is sufficient — see issue #59), but copying it into
  // outgoing requests reduces fingerprint divergence over time and limits the
  // surface area for header-shape heuristics to flag this client.
  "x-toptal-analytics-origin": "mobile",
};

export interface TransportRequest {
  surface: ToptalSurface;
  body: GraphQLRequest;
  /**
   * Bearer-style session token captured from `EmailPasswordSignIn`'s
   * `SignInPayload.token`. When present, sent as
   * `Authorization: Token token=<X>` — the canonical Rails
   * `ActionController::HttpAuthentication::Token` format that Toptal's
   * GraphQL services use to authenticate. Empirically validated as the
   * sole auth mechanism on both the mobile gateway and the
   * Cloudflare-protected `talent-profile` surface (see issue #59 and
   * `research/docs/decisions/ADR-005-token-auth.md`).
   */
  authToken?: string;
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
  if (req.authToken) headers["authorization"] = `Token token=${req.authToken}`;

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
 * Empirically this fingerprint alone clears Cloudflare on the surfaces TTCtl
 * uses; no `cf_clearance` cookie is required in the happy path.
 *
 * Header-tuple ordering is left as a future tightening — currently we pass
 * a plain `Record<string, string>` matching `stockTransport`'s shape so the
 * two transports stay symmetric. JA4H header-name ordering is a secondary
 * detection vector relative to JA4 / Akamai HTTP/2; revisit if empirical
 * blocks indicate it matters.
 */
export async function impersonatedTransport(req: TransportRequest): Promise<TransportResponse> {
  const url = SURFACE_ENDPOINTS[req.surface];
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  if (req.authToken) headers["authorization"] = `Token token=${req.authToken}`;

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
