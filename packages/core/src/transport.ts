// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fetch as wreqFetch } from "node-wreq";
import type { BrowserProfile } from "node-wreq";
import { request as undiciRequest } from "undici";

import { TtctlError } from "./auth/errors.js";
import { logTransportRequest, logTransportResponse } from "./lib/diagnostic-log.js";
import { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
import type { GraphQLRequest, ToptalSurface } from "./types.js";

/**
 * Thrown when an impersonated surface returns HTTP 403.
 *
 * Empirically, Chrome TLS impersonation alone passes Cloudflare on the
 * surfaces TTCtl currently uses (`talent-profile`, `scheduler`) — see
 * `hq/engineering/adr/ADR-005-auth-model.md`. A 403 here therefore
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
   * `hq/engineering/adr/ADR-005-auth-model.md`).
   */
  authToken?: string;
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
  const startMs = performance.now();

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
  logTransportResponse({
    surface: req.surface,
    endpoint: url,
    operationName: req.body.operationName,
    status: res.statusCode,
    headers: responseHeaders,
    body: parsed,
    elapsedMs: performance.now() - startMs,
  });
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

  // Diagnostic log hook (issue #139); see stockTransport for the
  // disabled-fast-path rationale.
  logTransportRequest({
    surface: req.surface,
    endpoint: url,
    transport: "impersonated",
    method: "POST",
    operationName: req.body.operationName,
    headers,
    body: req.body,
  });
  const startMs = performance.now();

  const res = await wreqFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(req.body),
    browser: IMPERSONATE_PROFILE,
  });

  // Capture response headers/status BEFORE the Cf403 throw so the
  // diagnostic trace still records the 403 response when --debug is
  // active — the caller's exception handler does not see those wire
  // details, so dropping them on the floor here would leak the
  // failure mode the operator is trying to diagnose.
  const responseHeaders = res.headers.toObject();

  if (res.status === 403) {
    logTransportResponse({
      surface: req.surface,
      endpoint: url,
      operationName: req.body.operationName,
      status: 403,
      headers: responseHeaders,
      body: null,
      elapsedMs: performance.now() - startMs,
    });
    throw new Cf403Error(req.surface, url);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  logTransportResponse({
    surface: req.surface,
    endpoint: url,
    operationName: req.body.operationName,
    status: res.status,
    headers: responseHeaders,
    body: parsed,
    elapsedMs: performance.now() - startMs,
  });
  return {
    status: res.status,
    headers: responseHeaders,
    body: parsed,
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
}

/**
 * Build a `globalThis.FormData` payload conforming to the GraphQL multipart
 * request spec (https://github.com/jaydenseric/graphql-multipart-request-spec).
 * The wire layout is:
 *
 * ```
 * --boundary
 * Content-Disposition: form-data; name="operations"
 * <JSON-encoded { operationName, query, variables }>
 *
 * --boundary
 * Content-Disposition: form-data; name="map"
 * <JSON-encoded { "0": ["variables.input.file"], ... }>
 *
 * --boundary
 * Content-Disposition: form-data; name="0"; filename="<filename>"
 * Content-Type: <contentType>
 * <binary>
 *
 * --boundary--
 * ```
 *
 * `node-wreq`'s `BodyInit` accepts `FormData` directly (verified against
 * `node-wreq@2.2.1`'s `dist/types/shared.d.ts` — `BodyInit` includes
 * `FormData`). When the body is a `FormData`, the runtime sets the
 * `Content-Type: multipart/form-data; boundary=...` header automatically;
 * the caller should NOT pre-set a JSON content-type or it will be
 * overwritten with the boundary-aware multipart one.
 *
 * Pure function — no I/O. Tests construct expected `FormData` instances
 * and inspect the entries via `for-of` iteration.
 */
export function buildGraphQLMultipart(
  body: GraphQLRequest,
  files: Record<string, MultipartFile>,
  map: Record<string, string[]>,
): FormData {
  const form = new FormData();
  form.append("operations", JSON.stringify(body));
  form.append("map", JSON.stringify(map));
  for (const [slot, file] of Object.entries(files)) {
    const blob = new Blob([new Uint8Array(file.content)], {
      type: file.contentType ?? "application/octet-stream",
    });
    form.append(slot, blob, file.filename);
  }
  return form;
}

/**
 * Multipart variant of {@link impersonatedTransport}. Sends a
 * GraphQL-multipart-spec request through the impersonated transport so
 * file-upload mutations (`uploadResume`, `uploadPortfolioCover`,
 * `uploadPortfolioFile`) clear Cloudflare on the `talent-profile` surface.
 *
 * Why a separate function rather than overloading `impersonatedTransport`:
 * the JSON path sets `content-type: application/json` and stringifies the
 * body; the multipart path lets the runtime supply the multipart
 * content-type with its own boundary and passes the `FormData` through
 * unchanged. The two paths have different body wire formats and different
 * header expectations, so they are kept as separate functions for clarity.
 *
 * Errors:
 * - `Cf403Error` on HTTP 403 (Cloudflare bot-management has tightened — see
 *   the `Cf403Error` doc-comment for the recovery hint).
 * - All other transport-level failures propagate as the underlying
 *   `node-wreq` error; service callers wrap them in their domain-specific
 *   `*Error` with `code: 'NETWORK_ERROR'`.
 */
export async function impersonatedMultipartTransport(req: MultipartTransportRequest): Promise<TransportResponse> {
  const url = SURFACE_ENDPOINTS[req.surface];
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  // Strip the JSON content-type — when the body is a `FormData`, node-wreq
  // (like the platform `fetch`) sets the multipart/form-data content-type
  // with its own boundary parameter. Leaving the JSON one would either
  // get overwritten silently or, worse, lock the runtime onto a header
  // that doesn't match the wire body and Cloudflare flags as malformed.
  delete headers["content-type"];
  if (req.authToken) headers["authorization"] = `Token token=${req.authToken}`;

  const formData = buildGraphQLMultipart(req.body, req.files, req.map);

  // Diagnostic log hook (issue #139). Multipart binary payloads are
  // intentionally NOT logged — only the file slot labels + map are
  // surfaced, which is enough to understand what was uploaded without
  // dumping arbitrary bytes into a terminal.
  logTransportRequest({
    surface: req.surface,
    endpoint: url,
    transport: "impersonated-multipart",
    method: "POST",
    operationName: req.body.operationName,
    headers,
    body: req.body,
    multipart: { files: Object.keys(req.files), map: req.map },
  });
  const startMs = performance.now();

  const res = await wreqFetch(url, {
    method: "POST",
    headers,
    body: formData,
    browser: IMPERSONATE_PROFILE,
  });

  const responseHeaders = res.headers.toObject();

  if (res.status === 403) {
    logTransportResponse({
      surface: req.surface,
      endpoint: url,
      operationName: req.body.operationName,
      status: 403,
      headers: responseHeaders,
      body: null,
      elapsedMs: performance.now() - startMs,
    });
    throw new Cf403Error(req.surface, url);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  logTransportResponse({
    surface: req.surface,
    endpoint: url,
    operationName: req.body.operationName,
    status: res.status,
    headers: responseHeaders,
    body: parsed,
    elapsedMs: performance.now() - startMs,
  });
  return {
    status: res.status,
    headers: responseHeaders,
    body: parsed,
  };
}
