// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { AuthCredentials } from "./config.js";
import { resolveOnePasswordReference } from "./onepassword.js";
import { isAuthRevokedExtensionCode } from "./services/profile/shared.js";
import { impersonatedTransport, stockTransport } from "./transport/index.js";
import type { TransportResponse } from "./transport/index.js";
import type { Credentials } from "./types.js";

/**
 * Persisted-query SHA-256 hash for the `EmailPasswordSignIn` mutation. Sourced
 * from `research/graphql/derived/operations/gateway-mobile.json` (operation extracted from the mobile
 * APK at `jadx/sources/fn/t3.java`). Hardcoded because the synthesized SDL has
 * no client-side queries to feed Apollo APQ codegen — operations live in the
 * research workspace, not in this repo. Re-extract and bump if the gateway
 * starts rejecting this hash; track via the operation extraction strategy
 * (see `research/notes` ADR-004).
 */
const EMAIL_PASSWORD_SIGNIN_HASH = "bd8e859a9f0a5c462ceb2ac736648068fa5bcdd874a8a49a460824dd0c5aef51";

/**
 * Minimal full-doc Viewer query used to verify a session is live and bound to
 * the expected user. The cataloged persisted `Viewer` query does not return
 * `viewerRole.email`, so we cannot use APQ here. The mobile gateway accepts
 * full-doc queries for non-mutation traffic, which is why this works without
 * a published persisted hash.
 */
const VIEWER_VERIFY_QUERY = "query ViewerVerify { viewer { id viewerRole { email } } }";

/**
 * Full-document `LogOut` mutation string. Mirrors
 * `research/graphql/talent_profile/operations/LogOut.graphql` exactly — the
 * talent_profile surface does not publish a persisted-query catalog, so
 * every operation is sent as a full document (same pattern as
 * `UPDATE_BASIC_INFO_MUTATION` in `services/profile/basic/index.ts`).
 *
 * Wire format: `{ operationName: "LogOut", query, variables: { input: {} } }`
 * — `LogOutInput` is Pattern 7 (trivial empty input, per
 * `research/notes/10-mutation-input-patterns.md`).
 *
 * Schema/contract status: INFERRED. `LogOutPayload` fields are typed as
 * `Unknown` in the synthesized SDL — the actual wire shape is observed only
 * via the live integration test in `packages/e2e/src/97-auth-signout-
 * server-side.e2e.test.ts`. The selection set here is what the bundle-
 * extracted document selects; if a future capture reveals additional
 * fields the live API returns, expand the inline `LogOutPayload` interface
 * (no codegen wiring needed — `Unknown` would map to `unknown` and provide
 * no narrowing).
 */
const LOG_OUT_MUTATION = `mutation LogOut($input: LogOutInput!) {
  logOut(input: $input) {
    returnTo
    errors {
      key
      message
    }
    notice
    success
  }
}`;

export type SignInErrorCode = "INVALID_CREDENTIALS" | "MFA_REQUIRED" | "NETWORK_ERROR" | "UNKNOWN";

export class SignInError extends Error {
  override readonly name = "SignInError";
  constructor(
    public readonly code: SignInErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface SignInGraphQLError {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface SignInPayload {
  success?: boolean;
  token?: string | null;
  errors?: SignInGraphQLError[] | null;
}

interface SignInResponse {
  data?: {
    auth?: {
      signIn?: SignInPayload | null;
    } | null;
  } | null;
}

interface ViewerResponse {
  data?: {
    viewer?: {
      id?: string;
      viewerRole?: { email?: string | null } | null;
    } | null;
  } | null;
}

/**
 * Collapse the polymorphic credentials value into resolved credentials.
 *
 * Form A (string) → `op://[account/]vault/item` → resolved via `op` CLI
 * Form B (object) → literal `{ username, password }` (username is an email
 *                   per Toptal's `EmailPasswordSignIn` mutation contract;
 *                   the YAML field is named `username` to match 1Password's
 *                   USERNAME purpose semantics)
 *
 * Returns the internal `Credentials` shape `{ email, password }` — that's
 * the GraphQL parameter name for the mutation. The username/email
 * synonymy is documented and load-bearing.
 */
export function resolveCredentials(auth: AuthCredentials): Credentials {
  if (typeof auth === "string") {
    return resolveOnePasswordReference(auth);
  }
  return { email: auth.username, password: auth.password };
}

/**
 * Sign in to Toptal Talent via `EmailPasswordSignIn` GraphQL mutation in
 * persisted-query mode against the mobile gateway and capture the session
 * token from the response.
 *
 * Returns the captured token. The CLI persists it back to the same YAML
 * config file (under `auth.token`) via `persistAuthToken` so subsequent
 * invocations can authenticate via `Authorization: Token token=<X>`
 * without re-signing-in.
 *
 * The next authenticated call (e.g. `auth status`) is the de-facto session
 * verifier — we do NOT issue a redundant Viewer probe inside `signIn` itself.
 *
 * See ADR-005 in the private `ttctl/research` repo for the cross-surface
 * auth model and `research/notes/02-auth-and-clients.md` for the empirical
 * evidence behind it.
 *
 * Throws `SignInError("UNKNOWN", ...)` if the gateway reports `success: true`
 * but does not return a token — that response shape is malformed and the
 * caller has nothing useful to persist.
 */
export async function signIn(credentials: Credentials): Promise<{ token: string }> {
  const signInResponse = await postSignIn(credentials);

  const payload = extractPayload(signInResponse.body);
  if (!payload?.success) {
    throw mapSignInError(payload);
  }

  const token = payload.token;
  if (typeof token !== "string" || token === "") {
    throw new SignInError("UNKNOWN", "Sign-in succeeded but no token was returned");
  }

  return { token };
}

async function postSignIn(credentials: Credentials): Promise<TransportResponse> {
  try {
    return await stockTransport({
      surface: "mobile-gateway",
      body: {
        operationName: "EmailPasswordSignIn",
        variables: { email: credentials.email, password: credentials.password },
        extensions: {
          persistedQuery: { version: 1, sha256Hash: EMAIL_PASSWORD_SIGNIN_HASH },
        },
      },
    });
  } catch (err) {
    throw new SignInError("NETWORK_ERROR", `Sign-in request failed: ${(err as Error).message}`, { cause: err });
  }
}

function extractPayload(body: unknown): SignInPayload | null {
  if (!body || typeof body !== "object") return null;
  const response = body as SignInResponse;
  return response.data?.auth?.signIn ?? null;
}

function mapSignInError(payload: SignInPayload | null): SignInError {
  if (!payload) {
    return new SignInError("UNKNOWN", "Sign-in failed: empty or malformed response body");
  }
  const errors = payload.errors ?? [];
  for (const err of errors) {
    const code = (err.code ?? "").toUpperCase();
    if (code === "INVALID_CREDENTIALS" || code === "INVALID_EMAIL_OR_PASSWORD") {
      return new SignInError("INVALID_CREDENTIALS", err.message ?? "Invalid email or password");
    }
    if (code === "MFA_REQUIRED" || code === "OTP_REQUIRED" || code === "TWO_FACTOR_REQUIRED") {
      return new SignInError("MFA_REQUIRED", err.message ?? "Multi-factor authentication required");
    }
  }
  const first = errors[0];
  const message = first?.message ?? "Sign-in failed for an unknown reason";
  return new SignInError("UNKNOWN", message);
}

/**
 * Result of a session-validity probe. Three terminal shapes:
 *
 *   - `valid` — `Viewer` query returned 2xx with an email; the session is
 *     active and bound to that account.
 *   - `invalid` — no token persisted, OR the gateway responded with a
 *     non-2xx status, OR the response payload lacks `viewer.viewerRole.email`.
 *     `reason` carries a stable machine-readable code so the CLI can pick the
 *     right user-facing message without re-classifying the failure.
 *   - `unreachable` — the transport itself rejected (DNS failure, connect
 *     refused, TLS handshake timeout, etc.); the gateway was never reached.
 *     This is distinguished from `invalid` so the CLI can exit 2 (transient,
 *     retryable) rather than 1 (auth problem, action required).
 */
export type AuthStatusResult =
  | { status: "valid"; email: string }
  | { status: "invalid"; reason: AuthInvalidReason }
  | { status: "unreachable"; reason: string };

export type AuthInvalidReason =
  | "no-session" // no token persisted (first run, or post-signout)
  | "session-expired" // gateway returned 401/403
  | "no-email-in-response" // gateway returned 2xx but viewer.viewerRole.email was absent/null
  | "unexpected-status"; // gateway returned some other non-2xx code (e.g. 5xx)

/**
 * Probe whether the persisted session token is currently valid.
 *
 * Issues a minimal full-doc `Viewer` query against the mobile gateway,
 * authenticated with `Authorization: Token token=<X>`. The cataloged
 * persisted `Viewer` query in `research/graphql/gateway/operations/mobile/Viewer.graphql`
 * does not return `viewerRole.email`, so we can't use APQ here — see
 * `VIEWER_VERIFY_QUERY` doc.
 *
 * Pass `null` (or an empty string) when no token has been persisted yet;
 * the function short-circuits to `invalid/no-session` without touching the
 * network. CLI consumers pass `config.auth.token ?? null` from the
 * already-loaded `TtctlConfig` (no separate token file to read).
 *
 * Never throws on auth or network failure; classifies into the three
 * `AuthStatusResult` shapes so CLI consumers can map cleanly to exit codes
 * and output messages without re-parsing exceptions.
 */
export async function getAuthStatus(token: string | null): Promise<AuthStatusResult> {
  if (token === null || token === "") {
    return { status: "invalid", reason: "no-session" };
  }

  let res: TransportResponse;
  try {
    res = await stockTransport({
      surface: "mobile-gateway",
      authToken: token,
      body: {
        operationName: "ViewerVerify",
        query: VIEWER_VERIFY_QUERY,
      },
    });
  } catch (err) {
    return { status: "unreachable", reason: (err as Error).message };
  }

  if (res.status === 401 || res.status === 403) {
    return { status: "invalid", reason: "session-expired" };
  }
  if (res.status < 200 || res.status >= 300) {
    return { status: "invalid", reason: "unexpected-status" };
  }

  const body = res.body as ViewerResponse | null;
  const email = body?.data?.viewer?.viewerRole?.email;
  if (!email) {
    return { status: "invalid", reason: "no-email-in-response" };
  }
  return { status: "valid", email };
}

/**
 * Stable machine-readable reason codes returned alongside `SignOutResult`'s
 * `invalid` and `unreachable` branches. The CLI / E2E teardown render
 * user-facing messages from these — keep the code stable, fold UX shifts
 * into the renderer.
 */
export type SignOutInvalidReason =
  | "no-session" // empty / null token passed; nothing to log out
  | "session-expired" // gateway responded 401/403 OR top-level errors[].extensions.code matched isAuthRevokedExtensionCode (the bearer was already invalid; the caller's intent (kill the bearer) is satisfied transitively)
  | "graphql-auth-error"; // top-level errors[] surfaced an auth-revoke code we treat as already-invalid

export type SignOutUnreachableReason =
  | { kind: "transport"; reason: string } // network/DNS/TLS handshake failure; talent-profile never responded
  | { kind: "http-status"; status: number } // non-2xx response other than 401/403 (e.g. 5xx)
  | { kind: "graphql-error"; message: string } // top-level errors[] without an auth-revoke code; LogOut not acknowledged
  | { kind: "payload-missing" } // 2xx but logOut payload absent — wire shape divergence
  | { kind: "success-false" }; // 2xx with data.logOut.success === false — LogOut flow not acknowledged by talent_profile

/**
 * Result of a `signOut(token)` call. Three terminal shapes mirror
 * `AuthStatusResult`'s discriminator so call-sites can pattern-match
 * uniformly:
 *
 *   - `logged-out` — talent-profile responded 2xx and
 *     `data.logOut.success === true`. The `LogOut` mutation flow on the
 *     `talent_profile/graphql` surface completed; the server acknowledged
 *     the signal. **This status name is deliberate** — see the
 *     "Bearer-invalidation scope" note below. The status does NOT claim
 *     the captured bearer was revoked for downstream mobile-gateway
 *     traffic; empirical evidence (issue #180 live discovery, 2026-05-12)
 *     shows it is NOT. The status only claims the LogOut mutation itself
 *     was processed.
 *   - `invalid` — the bearer was ALREADY invalid (401/403 or a GraphQL
 *     auth-revoke code). Functionally equivalent to "already revoked" from
 *     the security standpoint — the caller's intent (kill the bearer) is
 *     satisfied. CLI / teardown should still proceed to clear the local copy.
 *   - `unreachable` — could not reach the server or could not confirm
 *     mutation processing. The LogOut signal was not delivered. Caller
 *     MUST fall through to local clear (per CLI UX recommendation) and
 *     rely on the 24-72h aging-out as the load-bearing revocation defense.
 *
 * **Bearer-invalidation scope** (empirical, 2026-05-12; investigation
 * captured in `.tmp/180-delayed-probe-report.json`): The `LogOut` mutation
 * on `talent_profile/graphql` succeeds (`data.logOut.success === true`)
 * but does NOT propagate to bearer invalidation for subsequent
 * `mobile-gateway` calls. Probed across t=0/30/60/180/300s; the bearer
 * remained `{ status: "valid" }` against `getAuthStatus` for the entire
 * 5-minute window. The 24-72h natural aging-out (documented in CLAUDE.md
 * § Auth Model) is the load-bearing revocation defense. `signOut()` is
 * defense-in-depth: audit log + web-session/cookie cleanup on the
 * talent_profile side + forward-compatible call site if Toptal ever wires
 * up server-side bearer revocation.
 *
 * Never throws — every failure is classified into one of the three shapes.
 * This matches `getAuthStatus`'s contract so the call-sites that branch on
 * `result.status` look the same on both paths.
 */
export type SignOutResult =
  | { status: "logged-out" }
  | { status: "invalid"; reason: SignOutInvalidReason }
  | { status: "unreachable"; reason: SignOutUnreachableReason };

interface LogOutUserError {
  key?: string | null;
  message?: string | null;
}

interface LogOutPayload {
  success?: boolean | null;
  notice?: unknown;
  returnTo?: unknown;
  errors?: LogOutUserError[] | null;
}

interface LogOutGraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface LogOutResponse {
  data?: { logOut?: LogOutPayload | null } | null;
  errors?: LogOutGraphQLErrorEntry[] | null;
}

/**
 * Issue the `LogOut` mutation server-side against the Cloudflare-protected
 * `talent_profile/graphql` surface (defense-in-depth audit-log signal +
 * web-session/cookie cleanup; does NOT revoke the captured bearer for
 * downstream mobile-gateway calls per empirical scope — see CLAUDE.md §
 * Auth Model and the `SignOutResult` type docblock above). Authenticates
 * with `Authorization: Token token=<X>` (same bearer that `signIn`
 * captured — see ADR-005).
 *
 * Pass `null` or an empty string when there's no token to log out; the
 * function short-circuits to `invalid/no-session` without touching the
 * network. CLI / teardown call sites that already check for token absence
 * before invoking this are still safe — the defensive short-circuit just
 * removes one decision from the call site.
 *
 * **Never throws.** Every transport, HTTP, GraphQL-level, or wire-shape
 * failure is classified into one of the three `SignOutResult` shapes so
 * call sites can branch on `result.status` without try/catch. The CLI
 * `runAuthSignOut` and `runGlobalTeardown` rely on this contract to keep
 * the local-clear path unconditional (the bearer aging out in 24-72h is
 * the second-line defense if server-side revocation cannot be confirmed).
 *
 * Schema/contract status: the operation document and `LogOutPayload` field
 * shapes are INFERRED — `Unknown` in the SDL. The live wire format is
 * verified by `packages/e2e/src/97-auth-signout-server-side.e2e.test.ts`
 * (TTCTL_E2E=1 gate). If the live response surfaces fields not yet
 * declared here, expand the inline `LogOutPayload` interface — codegen
 * wiring would produce `unknown`-typed fields and is not currently useful.
 */
export async function signOut(token: string | null): Promise<SignOutResult> {
  if (token === null || token === "") {
    return { status: "invalid", reason: "no-session" };
  }

  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "LogOut",
        query: LOG_OUT_MUTATION,
        variables: { input: {} },
      },
    });
  } catch (err) {
    return {
      status: "unreachable",
      reason: { kind: "transport", reason: (err as Error).message },
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { status: "invalid", reason: "session-expired" };
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      status: "unreachable",
      reason: { kind: "http-status", status: res.status },
    };
  }

  const body = res.body as LogOutResponse | null;

  // Top-level GraphQL errors[] — talent_profile surface conventionally
  // surfaces auth-revoke states here (UNAUTHENTICATED / UNAUTHORIZED /
  // AUTHENTICATION_REQUIRED). Treat those as "bearer already invalid"
  // (the user's intent is satisfied); any other top-level error is
  // unreachable (we cannot confirm revocation).
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      return { status: "invalid", reason: "graphql-auth-error" };
    }
    return {
      status: "unreachable",
      reason: { kind: "graphql-error", message: first?.message ?? "GraphQL error" },
    };
  }

  const payload = body?.data?.logOut;
  if (!payload) {
    return { status: "unreachable", reason: { kind: "payload-missing" } };
  }

  if (payload.success === true) {
    return { status: "logged-out" };
  }

  // success: false / null / undefined — server received the mutation but
  // did not acknowledge the LogOut flow as processed. We don't know whether
  // the LogOut signal was actually delivered to the audit log / session
  // store; classify as unreachable so callers fall through to local clear.
  return { status: "unreachable", reason: { kind: "success-false" } };
}
