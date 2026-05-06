// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { AuthValue } from "./config.js";
import { resolveOnePasswordReference } from "./onepassword.js";
import { stockTransport } from "./transport.js";
import type { TransportResponse } from "./transport.js";
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
 * Collapse the polymorphic auth value into resolved credentials.
 *
 * Form A (string)  → `op://VAULT/ITEM` → resolved via `op` CLI
 * Form B (object)  → literal `{ email, password }`
 */
export function resolveCredentials(auth: AuthValue): Credentials {
  if (typeof auth === "string") {
    return resolveOnePasswordReference(auth);
  }
  return { email: auth.email, password: auth.password };
}

/**
 * Sign in to Toptal Talent via `EmailPasswordSignIn` GraphQL mutation in
 * persisted-query mode against the mobile gateway and capture the session
 * token from the response.
 *
 * Returns the captured token. The CLI persists it to disk via
 * `saveAuthToken` so subsequent invocations can authenticate via
 * `Authorization: Token token=<X>` without re-signing-in.
 *
 * The next authenticated call (e.g. `auth status`) is the de-facto session
 * verifier — we do NOT issue a redundant Viewer probe inside `signIn` itself.
 *
 * See `research/docs/decisions/ADR-005-token-auth.md` for the cross-surface
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
 * network. CLI consumers should pass the result of `loadAuthToken(...)`
 * directly.
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
