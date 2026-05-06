// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { CookieJar } from "tough-cookie";

import type { ProfileShowQuery } from "./__generated__/graphql.js";
import { impersonatedTransport } from "./transport.js";
import type { TransportResponse } from "./transport.js";
import { SURFACE_ENDPOINTS } from "./types.js";

/**
 * Full-document `ProfileShow` query string.
 *
 * Mirrors `research/graphql/operations/ProfileShow.graphql`. Sent as a
 * full-document GraphQL query (not a persisted query) because the
 * `talent_profile/graphql` surface has no published persisted-query catalog
 * we can pin a sha256 hash against. Keep this in sync with the .graphql file
 * if either is edited; the codegen smoke test in `__tests__/codegen.test.ts`
 * catches structural drift between the operation document and the generated
 * `ProfileShowQuery` type.
 */
const PROFILE_SHOW_QUERY = `query ProfileShow {
  viewer {
    __typename
    id
    viewerRole {
      __typename
      email
      firstName
      fullName
      phoneNumber
      allocatedHours
      hiredHours
      photo { __typename large small }
      profile {
        __typename
        id
        fullName
        city
        photo { __typename large }
        skillSets {
          __typename
          nodes {
            __typename
            id
            experience
            rating
            public
            skill { __typename id name }
          }
        }
      }
    }
  }
}`;

export type ProfileErrorCode = "UNAUTHENTICATED" | "NO_VIEWER" | "GRAPHQL_ERROR" | "NETWORK_ERROR" | "UNKNOWN";

export class ProfileError extends Error {
  override readonly name = "ProfileError";
  constructor(
    public readonly code: ProfileErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface ProfileShowResponse {
  data?: ProfileShowQuery | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Fetch the signed-in user's profile from the Cloudflare-protected
 * `talent_profile/graphql` surface.
 *
 * Loads the session cookies from the supplied jar, issues the typed
 * `ProfileShow` GraphQL query via `impersonatedTransport`, and returns the
 * typed payload. Cookie persistence (file load/save) is the caller's
 * responsibility — pass an already-loaded `CookieJar`.
 *
 * Errors:
 * - `Cf403Error` propagates from the transport when Cloudflare returns 403
 *   (the `cf_clearance` cookie has expired or the JA3/IP binding drifted).
 *   Caller should surface its message verbatim — it walks the user through
 *   the manual refresh procedure.
 * - `ProfileError` with code `UNAUTHENTICATED` when the surface returns 401
 *   (session expired or no session cookie was supplied). Caller should
 *   suggest `ttctl auth signin` to recover.
 * - `ProfileError` with code `NO_VIEWER` when the response is 200 but
 *   `data.viewer` is `null` (the API contract says this means the session
 *   does not bind to a viewer).
 * - `ProfileError` with code `GRAPHQL_ERROR` when the response carries a
 *   non-empty `errors` array.
 * - `ProfileError` with code `NETWORK_ERROR` when the transport itself
 *   throws (DNS, connection reset, etc).
 */
export async function getProfile(jar: CookieJar): Promise<ProfileShowQuery> {
  const cookieHeader = await jar.getCookieString(SURFACE_ENDPOINTS["talent-profile"]);

  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      ...(cookieHeader ? { cookieHeader } : {}),
      body: {
        operationName: "ProfileShow",
        query: PROFILE_SHOW_QUERY,
      },
    });
  } catch (err) {
    // Cf403Error is raised by impersonatedTransport on 403 — re-throw it as-is
    // so the CLI layer can surface its actionable refresh instructions to the
    // user. Any other thrown error is a network-level failure (DNS, ECONNRESET,
    // TLS handshake, etc.) and gets wrapped in ProfileError.
    if (err instanceof Error && err.name === "Cf403Error") throw err;
    throw new ProfileError("NETWORK_ERROR", `Profile request failed: ${(err as Error).message}`, { cause: err });
  }

  if (res.status === 401) {
    throw new ProfileError("UNAUTHENTICATED", "Session is invalid or expired. Run `ttctl auth signin` to refresh it.");
  }

  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `Profile request returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as ProfileShowResponse | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    const message = first?.message ?? "GraphQL error";
    // Toptal returns HTTP 200 with `errors[0].extensions.code = "UNAUTHENTICATED"`
    // for missing/expired sessions — surface it as UNAUTHENTICATED so the CLI
    // suggests `ttctl auth signin` instead of a generic GraphQL-error message.
    if (first?.extensions?.code === "UNAUTHENTICATED") {
      throw new ProfileError(
        "UNAUTHENTICATED",
        "Session is invalid or expired. Run `ttctl auth signin` to refresh it.",
      );
    }
    throw new ProfileError("GRAPHQL_ERROR", `Profile query failed: ${message}`);
  }

  if (!body?.data) {
    throw new ProfileError("UNKNOWN", "Profile response had no `data` field");
  }

  if (body.data.viewer === null) {
    throw new ProfileError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }

  return body.data;
}
