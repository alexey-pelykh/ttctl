// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { BrowserProfile } from "node-wreq";

import { TtctlError } from "../auth/errors.js";
import { logTransportResponse, logTransportRetry } from "../lib/diagnostic-log.js";
import {
  classifyTransportError,
  combineSignals,
  computeBackoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  readTransportConfig,
  sleepUnlessAborted,
  TransportError,
} from "../transport-resilience.js";
import { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "../types.js";
import type { GraphQLRequest, ToptalSurface } from "../types.js";

/**
 * Thrown when a transport receives an HTTP 3xx redirect carrying a
 * `Location` header.
 *
 * TTCtl talks to fixed GraphQL endpoints; none of them legitimately
 * redirect. A 3xx is therefore an anomaly — most plausibly Cloudflare or
 * Toptal's edge flipping an infrastructure flag (mirror of the
 * {@link Cf403Error} case), or a misconfigured DNS / edge change.
 *
 * Defense-in-depth posture (issue #268): every transport entry point has a
 * no-follow redirect policy — `redirect: "manual"` pinned explicitly on
 * `node-wreq`, and structurally on `undici` (its `request()` on the
 * default dispatcher never follows redirects; redirect following is an
 * opt-in interceptor TTCtl does not install). A 3xx is therefore returned
 * verbatim rather than followed, and {@link executeWithResilience}
 * inspects the status and throws this typed error rather than handing the
 * redirect body back to a caller that would not know how to interpret it.
 *
 * Refusing to follow is the security-relevant property: a followed
 * cross-origin redirect would leak the request body (operation name +
 * variables) to the redirect target even though `node-wreq` strips the
 * `authorization` header on cross-origin hops. Pinning `node-wreq`'s
 * policy keeps that guarantee from depending on a transitive library
 * default (it ships `redirect: "follow"` by default).
 *
 * Carries `surface`, `endpoint`, `status`, and `location` — the
 * `Location` header value is a URL, not a credential, so it is safe to
 * surface in the message and in diagnostic traces for operator triage.
 */
export class RedirectError extends TtctlError {
  override readonly name = "RedirectError";
  readonly code = "REDIRECT_REFUSED";
  readonly recovery =
    "The Toptal API returned an unexpected HTTP redirect. GraphQL endpoints are not expected to redirect; " +
    "this likely indicates a Toptal infrastructure change. File an issue at " +
    "https://github.com/alexey-pelykh/ttctl/issues with the surface name, a timestamp, and the Location value " +
    "from the error message.";

  constructor(
    public readonly surface: ToptalSurface,
    public readonly endpoint: string,
    public readonly status: number,
    public readonly location: string,
  ) {
    super(RedirectError.formatMessage(surface, endpoint, status, location));
  }

  static formatMessage(surface: ToptalSurface, endpoint: string, status: number, location: string): string {
    return [
      `Transport refused to follow an HTTP ${status.toString()} redirect from surface "${surface}" (${endpoint}).`,
      `Location: ${location}`,
      "",
      "TTCtl's GraphQL endpoints are not expected to redirect. Following the redirect is refused as a " +
        "defense-in-depth measure — a followed redirect would carry the request body to the redirect target.",
      "",
      `Please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the surface name ("${surface}"), ` +
        "a timestamp, and the Location value above so we can investigate.",
    ].join("\n");
  }
}

/**
 * HTTP status codes that signal a redirect when paired with a `Location`
 * header. Matches `node-wreq`'s own `REDIRECT_STATUS_CODES` set
 * (300, 301, 302, 303, 307, 308). `304 Not Modified` is intentionally
 * excluded — it is a cache-validation response, not a redirect, and never
 * carries a `Location`.
 */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([300, 301, 302, 303, 307, 308]);

/**
 * Case-insensitive header lookup over a plain header object. HTTP header
 * names are case-insensitive (RFC 9110 § 5.1), and the two transports
 * normalise differently: `undici` lowercases response header keys, while
 * `node-wreq`'s `Headers.toObject()` preserves the server's original
 * casing. The redirect check must find `Location` regardless of which
 * transport produced the response object.
 */
function getHeaderInsensitive(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Return the `Location` value if `status` + `headers` describe an HTTP
 * redirect — a {@link REDIRECT_STATUS_CODES} status carrying a `Location`
 * header — and `undefined` otherwise.
 *
 * Shared by {@link executeWithResilience} and the photo-upload path's
 * hand-rolled `node-wreq` fetch (`multipartImpersonatedFetch` in
 * `services/profile/basic/index.ts`) so every transport path enforces the
 * same no-follow posture (issue #268). A 3xx WITHOUT a `Location` header
 * is not a redirect — there is nothing to follow — so it returns
 * `undefined` and the caller returns the response verbatim.
 *
 * The caller decides what to do with a positive result: throw a
 * {@link RedirectError}. Detection and reaction are split so each call
 * site can emit its own diagnostic-trace record before throwing, matching
 * how each already handles the {@link Cf403Error} case.
 */
export function getRedirectLocation(status: number, headers: Record<string, string>): string | undefined {
  if (!REDIRECT_STATUS_CODES.has(status)) return undefined;
  return getHeaderInsensitive(headers, "location");
}

/**
 * TLS-impersonation profile — the single source of truth for the Chrome
 * identity. {@link USER_AGENT} derives its version from this constant so the
 * UA and the TLS profile can never drift apart (WAFs cross-validate the
 * User-Agent against the JA4 hash — see the `tls-fingerprinting` skill on
 * identity-catalog freshness). Bump this alone when `node-wreq` ships a newer
 * profile; the UA follows. Currently `chrome_147` (node-wreq@2.4.1 ceiling,
 * one behind Chrome stable in the wild).
 */
export const IMPERSONATE_PROFILE: BrowserProfile = "chrome_147";

/**
 * Chrome User-Agent with the version derived from {@link IMPERSONATE_PROFILE}
 * (see above) so the UA can't drift from the TLS profile. `COMMON_HEADERS`
 * sends it explicitly on both the stock and impersonated paths; the photo-upload
 * multipart path (`services/profile/basic`) imports it too rather than keeping a
 * second hardcoded copy.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  `(KHTML, like Gecko) Chrome/${IMPERSONATE_PROFILE.replace(/^chrome_/, "")}.0.0.0 Safari/537.36`;

/**
 * Default header bundle shared by the stock and impersonated transports.
 * Exported within the `transport/` module so {@link buildDryRunPreview} and
 * both transport leaves project the same wire shape from one source; not
 * re-exported on the package facade (internal to `transport/`).
 */
export const COMMON_HEADERS: Record<string, string> = {
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
   * ADR-005 in the private `ttctl/research` repo).
   */
  authToken?: string;
  /**
   * Caller-supplied abort signal. When the signal aborts, an in-flight
   * request is cancelled and any pending retry backoff sleep returns
   * immediately. Wired through to the MCP server's per-tool-call
   * cancellation so a client that revokes a tool invocation actually
   * tears down the upstream socket (issue #229).
   *
   * The transport composes this signal with a per-attempt internal
   * timeout (default 30 s, overridable via `TTCTL_TRANSPORT_TIMEOUT_MS`)
   * via `AbortSignal.any`, so a wedged Cloudflare connection times out
   * even when no caller signal is supplied.
   */
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Token redaction marker used by {@link buildDryRunPreview} when an
 * `authToken` is present on the source request. Exposed as a constant so
 * tests assert on the exact wire shape and so future code never reaches
 * for the bearer literal by mistake.
 */
export const DRY_RUN_REDACTED_AUTHORIZATION = "Token token=<redacted>" as const;

/**
 * Structured "would-have-sent" preview returned by mutation entry points
 * when invoked with `dryRun: true` (issue #52). Mirrors the shape an
 * actual {@link stockTransport} or {@link impersonatedTransport} call
 * would build internally, with the bearer token replaced by
 * {@link DRY_RUN_REDACTED_AUTHORIZATION} so the preview can be safely
 * emitted to stdout / piped to `jq` without leaking session credentials.
 *
 * The variable shape, operation name, and surface match the request that
 * WOULD have been sent had `dryRun` been false — including any
 * placeholder fields (e.g. `profileId`) that would have been resolved via
 * a sibling read call at execution time. Mutation entry points
 * substitute placeholder strings rather than firing the read side, so
 * the dry-run path has zero network I/O — every transport (read or
 * write) stays uncalled. See `set()` in `services/profile/basic/index.ts`
 * for the canonical pattern.
 *
 * Wire shape (`{ operation, variables, transport, surface, headers }`)
 * is locked under the v0.4 envelope contract (#128) — see
 * {@link DryRunEnvelope} on the CLI side.
 */
export interface DryRunPreview {
  /**
   * Logical surface that would have been called. Drives the transport
   * choice (stock vs impersonated) and is surfaced verbatim in the wire
   * payload for downstream tooling.
   */
  surface: ToptalSurface;
  /**
   * Transport classification — `"stock"` for the mobile gateway,
   * `"impersonated"` for Cloudflare-protected surfaces. Derived from
   * {@link SURFACES_REQUIRING_IMPERSONATION} so the preview always
   * reflects the actual transport that would have been used.
   */
  transport: "stock" | "impersonated";
  /**
   * Concrete URL for the surface — read off {@link SURFACE_ENDPOINTS}.
   * Useful for piping into curl-style replay tooling (post-AC future
   * work; tracked in #52 § Out of Scope).
   */
  endpoint: string;
  /** GraphQL operation name (e.g. `"UPDATE_BASIC_INFO"`). */
  operationName: string;
  /**
   * GraphQL variables payload that would have been sent. Mutation entry
   * points substitute placeholder strings for fields that would be
   * resolved via sibling read calls at execution time — callers reading
   * the preview should NOT treat placeholder values as real ids.
   */
  variables: Record<string, unknown>;
  /**
   * Headers as they would be sent on the wire, with the `authorization`
   * value replaced by {@link DRY_RUN_REDACTED_AUTHORIZATION} when an
   * `authToken` was set on the source request. All other headers
   * (accept, accept-language, content-type, origin, referer, etc.)
   * surface verbatim — they carry no session-bound material.
   */
  headers: Record<string, string>;
}

/**
 * Build a {@link DryRunPreview} from a {@link TransportRequest} without
 * invoking any transport. Pure — no I/O, no allocations beyond the
 * returned object.
 *
 * The headers projection mirrors what {@link stockTransport} and
 * {@link impersonatedTransport} would have set (`COMMON_HEADERS` plus
 * `authorization` when `authToken` is present), with the bearer value
 * redacted to {@link DRY_RUN_REDACTED_AUTHORIZATION}. The transport
 * classification is derived from
 * {@link SURFACES_REQUIRING_IMPERSONATION} so changes to that set
 * propagate automatically.
 *
 * Mutation entry points call this AFTER they've populated their
 * `body.variables` with placeholder substitutions for any fields that
 * would have been resolved at execution time (e.g. `profileId`) —
 * keeping the read-side transport call out of the dry-run path entirely.
 * See `set()` in `services/profile/basic/index.ts` for the pattern.
 */
export function buildDryRunPreview(req: TransportRequest): DryRunPreview {
  const surface = req.surface;
  const transport: "stock" | "impersonated" = SURFACES_REQUIRING_IMPERSONATION.has(surface) ? "impersonated" : "stock";
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  if (req.authToken !== undefined) {
    headers["authorization"] = DRY_RUN_REDACTED_AUTHORIZATION;
  }
  return {
    surface,
    transport,
    endpoint: SURFACE_ENDPOINTS[surface],
    operationName: req.body.operationName,
    variables: req.body.variables ?? {},
    headers,
  };
}

/**
 * One file slot in a GraphQL multipart request — the binary content plus the
 * filename and (optional) content-type the server will see in the
 * `Content-Disposition` of the corresponding form part. The variable path
 * the file binds to is supplied separately via the `map` argument of
 * {@link buildGraphQLMultipart}, keeping this struct purely about file
 * material.
 */
export interface MultipartFile {
  filename: string;
  content: Buffer | Uint8Array;
  contentType?: string;
}

/**
 * Multipart variant of {@link TransportRequest} for GraphQL operations that
 * carry one or more `Upload`-typed variables. The caller supplies the file
 * material and a `map` describing where each file slots into the
 * `variables` tree (per the GraphQL multipart request spec —
 * https://github.com/jaydenseric/graphql-multipart-request-spec).
 *
 * The `body` carries the operation envelope as in JSON requests; the
 * variables it sends include `null` placeholders at the file slots, and the
 * `map` form field tells the server how to reconstitute them from the
 * trailing file parts.
 */
export interface MultipartTransportRequest {
  surface: ToptalSurface;
  body: GraphQLRequest;
  authToken?: string;
  /**
   * Files keyed by an arbitrary slot label. The label is what the spec
   * calls the "file part name" — appears as the form-part name (`"0"`,
   * `"1"`, …) and as the key in `map` that points to the variable path(s)
   * the file binds to.
   */
  files: Record<string, MultipartFile>;
  /**
   * GraphQL multipart map: `slotLabel → [variablePath, ...]`. Variable
   * paths are dotted strings (e.g. `"variables.input.file"`). The same file
   * may bind to multiple variable paths (the spec allows it) but TTCtl's
   * services use a 1:1 mapping today.
   */
  map: Record<string, string[]>;
  /**
   * Caller-supplied abort signal. See {@link TransportRequest.signal} for
   * full semantics — wired identically into the multipart upload path so
   * an MCP `cancel` request actually tears down the file upload mid-flight.
   */
  signal?: AbortSignal;
}

/**
 * Shared retry / timeout / abort loop used by all three transport entry
 * points ({@link stockTransport}, {@link impersonatedTransport},
 * {@link impersonatedMultipartTransport}).
 *
 * `attemptFn` performs a single network attempt against the supplied
 * combined signal and returns the parsed {@link TransportResponse}. The
 * loop:
 *
 * 1. Composes the caller's signal with a per-attempt timeout signal.
 * 2. Calls `attemptFn`.
 * 3. On retryable status (429, 5xx), backs off per the issue #229 policy
 *    and re-attempts up to the configured `maxRetries`.
 * 4. On per-attempt timeout, surfaces as a {@link TransportError} with
 *    code `TIMEOUT` (no retry — the wedge is likely persistent).
 * 5. On caller abort, surfaces as a {@link TransportError} with code
 *    `ABORTED`.
 * 6. On non-retryable errors ({@link Cf403Error}, network failure),
 *    re-throws.
 *
 * Every successful attempt invokes the response logger; the final attempt
 * also logs the surfaced status code so an operator inspecting a stderr
 * trace can correlate retry events with the eventual outcome.
 */
export async function executeWithResilience(
  req: TransportRequest | MultipartTransportRequest,
  url: string,
  attemptFn: (signal: AbortSignal, startMs: number) => Promise<TransportResponse>,
): Promise<TransportResponse> {
  const config = readTransportConfig();
  let attempt = 0;
  let lastStatus: number | undefined;
  let lastRetryAfterMs: number | undefined;

  for (;;) {
    const { signal, dispose } = combineSignals(req.signal, config.timeoutMs);
    const startMs = performance.now();
    let res: TransportResponse | undefined;
    try {
      res = await attemptFn(signal, startMs);
    } catch (err) {
      dispose();
      const classification = classifyTransportError(err, req.signal);
      if (classification === "aborted-by-caller") {
        throw new TransportError(
          "ABORTED",
          req.surface,
          url,
          attempt + 1,
          `Request to ${req.surface} cancelled by caller.`,
          lastStatus,
          lastRetryAfterMs,
          { cause: err },
        );
      }
      if (classification === "timeout") {
        throw new TransportError(
          "TIMEOUT",
          req.surface,
          url,
          attempt + 1,
          `Request to ${req.surface} timed out after ${config.timeoutMs.toString()}ms.`,
          lastStatus,
          lastRetryAfterMs,
          { cause: err },
        );
      }
      // Cf403Error, TtctlError subclasses, and arbitrary network errors
      // propagate as-is — they are caller-visible failures, not transient
      // conditions the retry loop should silently swallow.
      throw err;
    }
    dispose();

    logTransportResponse({
      surface: req.surface,
      endpoint: url,
      operationName: req.body.operationName,
      status: res.status,
      headers: res.headers,
      body: res.body,
      elapsedMs: performance.now() - startMs,
    });

    // Redirect anomaly (issue #268). The transports have a no-follow
    // policy (`redirect: "manual"` on node-wreq; structural on undici, see
    // stockTransport), so a genuine 3xx-with-Location lands here verbatim
    // instead of being followed. GraphQL endpoints are not expected to
    // redirect; refuse to hand the redirect body back to a caller that
    // cannot interpret it and surface a typed RedirectError for operator
    // triage. The response is already captured in the diagnostic trace
    // above. A 3xx WITHOUT a `Location` header is not a redirect — it
    // falls through to the normal (non-retryable) return path so the
    // caller's GraphQL response handler sees it verbatim.
    const redirectLocation = getRedirectLocation(res.status, res.headers);
    if (redirectLocation !== undefined) {
      throw new RedirectError(req.surface, url, res.status, redirectLocation);
    }

    if (!isRetryableStatus(res.status)) {
      return res;
    }

    // Retryable status — decide whether to retry or surface.
    lastStatus = res.status;
    if (attempt >= config.maxRetries) {
      const code: "RATE_LIMITED" | "SERVER_ERROR" = res.status === 429 ? "RATE_LIMITED" : "SERVER_ERROR";
      throw new TransportError(
        code,
        req.surface,
        url,
        attempt + 1,
        `Transport ${req.surface} returned HTTP ${res.status.toString()} after ${(attempt + 1).toString()} attempts.`,
        lastStatus,
        lastRetryAfterMs,
      );
    }

    const reason: "rate-limit" | "server-error" = res.status === 429 ? "rate-limit" : "server-error";
    const retryAfterRaw = res.headers["retry-after"];
    const retryAfterMs = parseRetryAfter(retryAfterRaw);
    lastRetryAfterMs = retryAfterMs;
    const delayMs = retryAfterMs ?? computeBackoffDelay(reason, attempt);
    logTransportRetry({
      surface: req.surface,
      endpoint: url,
      operationName: req.body.operationName,
      attempt: attempt + 1,
      reason,
      status: res.status,
      delayMs,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });

    try {
      await sleepUnlessAborted(delayMs, req.signal);
    } catch (err) {
      // Caller aborted during backoff sleep.
      throw new TransportError(
        "ABORTED",
        req.surface,
        url,
        attempt + 1,
        `Request to ${req.surface} cancelled by caller during backoff.`,
        lastStatus,
        lastRetryAfterMs,
        { cause: err },
      );
    }

    attempt += 1;
  }
}
