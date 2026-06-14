// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fetch as wreqFetch } from "node-wreq";

import { TtctlError } from "../auth/errors.js";
import { logTransportRequest, logTransportResponse } from "../lib/diagnostic-log.js";
import { readTransportConfig } from "../transport-resilience.js";
import { SURFACE_ENDPOINTS } from "../types.js";
import type { GraphQLRequest, ToptalSurface } from "../types.js";
import { COMMON_HEADERS, executeWithResilience, IMPERSONATE_PROFILE } from "./_shared.js";
import type { MultipartFile, MultipartTransportRequest, TransportRequest, TransportResponse } from "./_shared.js";

/**
 * Thrown when an impersonated surface returns HTTP 403.
 *
 * Empirically, Chrome TLS impersonation alone passes Cloudflare on the
 * surfaces TTCtl currently uses (`talent-profile`, `scheduler`) — see
 * ADR-005 in the private `ttctl/research` repo. A 403 here therefore
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
 * Thrown when `node-wreq`'s native TLS-impersonation binding cannot be loaded
 * for the current platform/arch.
 *
 * `node-wreq` ships its Rust binary as optional dependencies for a fixed set of
 * targets. Two real-world targets have no prebuilt binary: Alpine/musl on ARM64
 * (`linux-arm64-musl`) and Windows on ARM (`win32-arm64`). Because the binaries
 * are OPTIONAL deps and TTCtl declares no `os`/`cpu`/`libc`, install SUCCEEDS on
 * those platforms — the failure only surfaces when `node-wreq` lazily loads its
 * binding on the first Cloudflare-protected call and throws a low-level
 * `Error`. Stock mobile-gateway calls (`undici`) keep working, so without this
 * translation the user sees confusing partial breakage (issue #708).
 *
 * {@link impersonatedFetch} catches that low-level Error and throws this typed
 * one so the CLI / MCP surfaces render a single actionable message naming the
 * platform and the supported set (mirroring {@link Cf403Error}). The original
 * `node-wreq` Error is preserved as `cause`. See the README "Supported
 * platforms" section.
 */
export class NativeModuleUnavailableError extends TtctlError {
  override readonly name = "NativeModuleUnavailableError";
  readonly code = "NATIVE_MODULE_UNAVAILABLE";
  readonly recovery =
    "TTCtl's native TLS-impersonation module has no prebuilt binary for this platform/architecture. " +
    'Alpine/musl on ARM64 and Windows on ARM are not yet supported — see the README "Supported platforms" ' +
    "section. If you are on a supported platform, reinstall TTCtl to fetch the native binary; if it persists, " +
    "file an issue at https://github.com/alexey-pelykh/ttctl/issues with your platform and architecture.";

  constructor(
    public readonly platform: string,
    public readonly arch: string,
    options?: { cause?: unknown },
  ) {
    super(NativeModuleUnavailableError.formatMessage(platform, arch), options);
  }

  static formatMessage(platform: string, arch: string): string {
    return [
      `Failed to load TTCtl's native TLS-impersonation module (node-wreq) for ${platform}-${arch}.`,
      "",
      "This operation talks to a Cloudflare-protected Toptal surface, which requires a prebuilt native " +
        "TLS-impersonation binary. None is available for your platform/architecture.",
      "",
      "Supported platforms:",
      "  - macOS:   x64 (Intel), arm64 (Apple Silicon)",
      "  - Linux:   x64 (glibc and musl/Alpine), arm64 (glibc only)",
      "  - Windows: x64",
      "",
      "Not yet supported: Alpine/musl on ARM64 (linux-arm64-musl), Windows on ARM (win32-arm64).",
      "",
      "Mobile-gateway operations still work here; only Cloudflare-protected operations (profile editing) " +
        "need the native module. If you ARE on a supported platform, the binary may have failed to install — " +
        "reinstall TTCtl. If the problem persists, file an issue at https://github.com/alexey-pelykh/ttctl/issues " +
        "with your platform and architecture.",
    ].join("\n");
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
 * Recognise `node-wreq`'s native-binding load failure. `node-wreq` throws a
 * plain `Error` (not a typed class) from its lazy `getBinding()` resolver with
 * one of two messages — `Unsupported platform: …` (target absent from its
 * platform map) or `Failed to load native module …` (target present but the
 * platform package failed to `require`). Matching the message is the only
 * signal available; pinned to `node-wreq@2.4.1`'s wording (`dist/native/binding.js`).
 */
function isNativeModuleLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("Failed to load native module") || err.message.includes("Unsupported platform");
}

/**
 * `node-wreq.fetch` wrapper that translates a native-binding load failure into
 * a typed {@link NativeModuleUnavailableError}. Every impersonated call site
 * routes through this so an unsupported platform (Alpine/musl ARM64, Windows
 * ARM) gets one actionable message instead of a raw "Failed to load native
 * module" stack (issue #708). All other errors propagate unchanged. Exported so
 * the photo-upload multipart path (`services/profile/basic`) shares the same
 * translation rather than re-implementing it.
 */
export const impersonatedFetch: typeof wreqFetch = async (input, init) => {
  try {
    return await wreqFetch(input, init);
  } catch (err) {
    if (isNativeModuleLoadError(err)) {
      throw new NativeModuleUnavailableError(process.platform, process.arch, { cause: err });
    }
    throw err;
  }
};

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
 *
 * Resilience (#229): wraps the network call in the same retry / timeout /
 * abort loop as {@link stockTransport}. `Cf403Error` propagates as a
 * non-retryable typed error — the 403 is signalled to Cloudflare's
 * bot-management WAF, not a transient condition.
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
  const body = JSON.stringify(req.body);

  return executeWithResilience(req, url, async (signal, startMs) => {
    const res = await impersonatedFetch(url, {
      method: "POST",
      headers,
      body,
      browser: IMPERSONATE_PROFILE,
      signal,
      timeout: readTransportConfig().timeoutMs,
      connectTimeout: readTransportConfig().connectMs,
      // No-follow redirect policy (issue #268). `node-wreq` defaults to
      // `redirect: "follow"` (up to 20 hops). It does strip the
      // `authorization` header on cross-origin hops, but a followed
      // redirect would still carry the request body (operation name +
      // variables) to the redirect target. Pinning `"manual"` returns the
      // 3xx verbatim so `executeWithResilience` can reject it as a typed
      // `RedirectError` — and keeps the no-leak guarantee from depending
      // on a transitive library default.
      redirect: "manual",
    });

    const responseHeaders = res.headers.toObject();

    if (res.status === 403) {
      // Capture the 403 response shape in the diagnostic trace BEFORE
      // throwing — the caller's exception handler does not see the wire
      // details and operators investigating a Cloudflare block need the
      // headers (cf-ray, cf-mitigated) to paste into a triage issue.
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
    return {
      status: res.status,
      headers: responseHeaders,
      body: parsed,
    };
  });
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

  return executeWithResilience(req, url, async (signal, startMs) => {
    // FormData is rebuilt per attempt — the underlying `Blob` slices read
    // a fresh stream each time, so a retry of an aborted upload does not
    // attempt to replay an already-consumed body.
    const formData = buildGraphQLMultipart(req.body, req.files, req.map);
    const res = await impersonatedFetch(url, {
      method: "POST",
      headers,
      body: formData,
      browser: IMPERSONATE_PROFILE,
      signal,
      timeout: readTransportConfig().timeoutMs,
      connectTimeout: readTransportConfig().connectMs,
      // No-follow redirect policy (issue #268). File-upload mutations are
      // the highest-impact body-exfiltration vector if redirect handling
      // weakens — see the rationale on the JSON `impersonatedTransport`
      // call site above.
      redirect: "manual",
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
    return {
      status: res.status,
      headers: responseHeaders,
      body: parsed,
    };
  });
}
