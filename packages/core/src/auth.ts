// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { CookieJar } from "tough-cookie";

import type { AuthValue } from "./config.js";
import { resolveOnePasswordReference } from "./onepassword.js";
import { stockTransport } from "./transport.js";
import type { TransportResponse } from "./transport.js";
import { SURFACE_ENDPOINTS } from "./types.js";
import type { Credentials } from "./types.js";

/**
 * Persisted-query SHA-256 hash for the `EmailPasswordSignIn` mutation. Sourced
 * from `research/graphql/operations.json` (operation extracted from the mobile
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
 * persisted-query mode against the mobile gateway, then verify the resulting
 * session by issuing a minimal `Viewer` query and checking `viewerRole.email`
 * matches the supplied credentials.
 *
 * Captured `Set-Cookie` headers (including `_toptal_session_id`) are written
 * to the supplied `jar`. The jar is the only out-band mutation — `signIn`
 * returns `void` on success.
 *
 * Cookie persistence to disk is not handled here (see the cookie-jar
 * persistence work item).
 */
export async function signIn(credentials: Credentials, jar: CookieJar): Promise<void> {
  const signInPayload = await postSignIn(credentials);

  await captureCookies(signInPayload, jar);

  const payload = extractPayload(signInPayload.body);
  if (!payload?.success) {
    throw mapSignInError(payload);
  }

  await verifyViewer(credentials, jar);
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

async function captureCookies(res: TransportResponse, jar: CookieJar): Promise<void> {
  if (!res.setCookies?.length) return;
  const url = SURFACE_ENDPOINTS["mobile-gateway"];
  for (const raw of res.setCookies) {
    try {
      await jar.setCookie(raw, url);
    } catch {
      // Skip malformed cookies; the gateway occasionally emits exotic ones
      // (e.g. invalid Domain attributes) that are not load-bearing.
    }
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

async function verifyViewer(credentials: Credentials, jar: CookieJar): Promise<void> {
  const cookieHeader = await jar.getCookieString(SURFACE_ENDPOINTS["mobile-gateway"]);
  if (!cookieHeader) {
    throw new SignInError("UNKNOWN", "Sign-in succeeded but no session cookies were captured");
  }

  let res: TransportResponse;
  try {
    res = await stockTransport({
      surface: "mobile-gateway",
      cookieHeader,
      body: {
        operationName: "ViewerVerify",
        query: VIEWER_VERIFY_QUERY,
      },
    });
  } catch (err) {
    throw new SignInError("NETWORK_ERROR", `Viewer verification failed: ${(err as Error).message}`, { cause: err });
  }

  const body = res.body as ViewerResponse | null;
  const email = body?.data?.viewer?.viewerRole?.email;
  if (!email) {
    throw new SignInError("UNKNOWN", "Viewer verification returned no email — session may be invalid");
  }
  if (email.toLowerCase() !== credentials.email.toLowerCase()) {
    throw new SignInError("UNKNOWN", `Viewer email '${email}' does not match credentials email '${credentials.email}'`);
  }
}

/**
 * Result of a session-validity probe. Three terminal shapes:
 *
 *   - `valid` — `Viewer` query returned 2xx with an email; the session is
 *     active and bound to that account.
 *   - `invalid` — the cookie jar is missing/empty, OR the gateway responded
 *     with a non-2xx status, OR the response payload lacks `viewer.viewerRole.email`.
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
  | "no-session" // jar empty / no cookies for the gateway domain
  | "session-expired" // gateway returned 401/403
  | "no-email-in-response" // gateway returned 2xx but viewer.viewerRole.email was absent/null
  | "unexpected-status"; // gateway returned some other non-2xx code (e.g. 5xx)

/**
 * Probe whether the persisted session in `jar` is currently valid.
 *
 * Issues a minimal full-doc `Viewer` query against the mobile gateway (the
 * cataloged persisted `Viewer` query in `research/graphql/operations/Viewer.graphql`
 * does not return `viewerRole.email`, so we can't use APQ here — see
 * `VIEWER_VERIFY_QUERY` doc).
 *
 * Never throws on auth or network failure; classifies into the three
 * `AuthStatusResult` shapes so CLI consumers can map cleanly to exit codes
 * and output messages without re-parsing exceptions.
 */
export async function getAuthStatus(jar: CookieJar): Promise<AuthStatusResult> {
  const cookieHeader = await jar.getCookieString(SURFACE_ENDPOINTS["mobile-gateway"]);
  if (!cookieHeader) {
    return { status: "invalid", reason: "no-session" };
  }

  let res: TransportResponse;
  try {
    res = await stockTransport({
      surface: "mobile-gateway",
      cookieHeader,
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
