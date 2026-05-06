// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { ProfileShowQuery } from "./__generated__/graphql.js";
import { impersonatedTransport } from "./transport.js";
import type { TransportResponse } from "./transport.js";

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

export type ProfileErrorCode =
  | "UNAUTHENTICATED"
  | "NO_VIEWER"
  | "GRAPHQL_ERROR"
  | "NETWORK_ERROR"
  | "USER_ERROR"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

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
 * Authenticates via `Authorization: Token token=<token>` (the canonical
 * Toptal auth mechanism — see `research/docs/decisions/ADR-005-token-auth.md`).
 * Cookies are NOT load-bearing on this surface; Chrome TLS impersonation
 * alone clears Cloudflare in the happy path.
 *
 * Errors:
 * - `Cf403Error` propagates from the transport when Cloudflare returns 403.
 *   This is no longer expected in normal operation; if it surfaces, file an
 *   issue (the error message provides the link).
 * - `ProfileError` with code `UNAUTHENTICATED` when the surface returns 401
 *   (token expired or invalid). Caller should suggest `ttctl auth signin`
 *   to recover.
 * - `ProfileError` with code `NO_VIEWER` when the response is 200 but
 *   `data.viewer` is `null` (the API contract says this means the token
 *   does not bind to a viewer).
 * - `ProfileError` with code `GRAPHQL_ERROR` when the response carries a
 *   non-empty `errors` array.
 * - `ProfileError` with code `NETWORK_ERROR` when the transport itself
 *   throws (DNS, connection reset, etc).
 */
export async function getProfile(token: string): Promise<ProfileShowQuery> {
  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "ProfileShow",
        query: PROFILE_SHOW_QUERY,
      },
    });
  } catch (err) {
    // Cf403Error is raised by impersonatedTransport on 403 — re-throw it as-is
    // so the CLI layer can surface its actionable message. Any other thrown
    // error is a network-level failure (DNS, ECONNRESET, TLS handshake, etc.)
    // and gets wrapped in ProfileError.
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

/**
 * Full-document `UPDATE_BASIC_INFO` mutation string.
 *
 * The Toptal `talent_profile/graphql` surface does not publish a persisted-query
 * catalog — every operation is sent as a full document. This is a SIMPLIFIED
 * version of the bundle-extracted `UPDATE_BASIC_INFO` mutation
 * (`research/graphql/web/operations/UPDATE_BASIC_INFO.graphql`): we ask only
 * for the response fields we actually use (id, about, quote, success, notice,
 * errors), avoiding the bundle version's dependency on five fragments
 * (`RealTimeFields`, `ProfileCompletion`, `SkillsReadiness`,
 * `ProfileRecommendations`, `UserErrorFragment`) that haven't been wired into
 * codegen.
 *
 * Operation name is `UPDATE_BASIC_INFO` (SCREAMING_CASE), matching the
 * bundle-extracted document. Per `research/notes/05-talent-profile-api.md`,
 * the server matches `operationName` against the request body literally and
 * the React app sends the SCREAMING_CASE form — keeping the same shape avoids
 * any chance of server-side allowlist drift.
 */
const UPDATE_BASIC_INFO_MUTATION = `mutation UPDATE_BASIC_INFO($input: UpdateBasicInfoInput!) {
  updateBasicInfo(input: $input) {
    success
    notice
    errors {
      message
      field
    }
    profile {
      id
      about
      quote
    }
  }
}`;

/**
 * Subset of profile fields editable via the wave-0 MVP write-path. `bio` and
 * `headline` are the user-facing flag names exposed by the CLI; they map to
 * the GraphQL fields `about` and `quote` respectively (the field names used
 * by the talent_profile surface — see the response selection in
 * `research/graphql/web/operations/UPDATE_BASIC_INFO.graphql`).
 *
 * Both fields are optional. The caller is responsible for ensuring at least
 * one is supplied — `updateProfile` rejects an empty object with a
 * `VALIDATION_ERROR`.
 */
export interface ProfileUpdate {
  bio?: string;
  headline?: string;
}

/**
 * `UpdateBasicInfoInput` is undocumented in the published web schema (the
 * unified SDL ships only a `_placeholder: String` stub) and was NOT captured
 * via the safe-mode interceptor (see
 * `research/notes/06-safe-mutation-capture.md`). The shape here is INFERRED
 * from the patterns in `research/notes/10-mutation-input-patterns.md` (Pattern
 * 1) which match nine sibling mutations:
 *
 *   { profileId: ID!, basicInfo: BasicInfoInput! }
 *
 * `BasicInfoInput` mirrors writable fields of the `Profile` type as observed
 * in the response selection set of `UPDATE_BASIC_INFO.graphql`. Only the two
 * MVP-relevant fields (`about`, `quote`) are typed here. Field names assumed
 * to be optional `String` — sibling captures don't flag any nullability
 * surprises.
 *
 * If a future capture reveals a different shape, this is the only place to
 * update.
 */
interface UpdateBasicInfoInput {
  profileId: string;
  basicInfo: {
    about?: string;
    quote?: string;
  };
}

interface UpdateBasicInfoUserError {
  message?: string | null;
  field?: string | null;
}

interface UpdateBasicInfoPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UpdateBasicInfoUserError[] | null;
  profile?: {
    id: string;
    about?: string | null;
    quote?: string | null;
  } | null;
}

interface UpdateBasicInfoResponse {
  data?: { updateBasicInfo?: UpdateBasicInfoPayload | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Result of a successful `updateProfile` call. Mirrors the GraphQL field
 * names so callers see `about`/`quote` rather than the CLI flag names — the
 * mapping back to user-facing `bio`/`headline` is a presentation concern
 * handled at the CLI layer.
 */
export interface UpdateProfileResult {
  profile: {
    id: string;
    about: string | null;
    quote: string | null;
  };
  notice: string | null;
}

/**
 * Update a subset of the signed-in user's basic-info fields (currently
 * `bio` → `about` and `headline` → `quote`) via the Cloudflare-protected
 * `talent_profile/graphql` surface.
 *
 * Authenticates via `Authorization: Token token=<token>` (the canonical
 * Toptal auth mechanism). Cookies are NOT load-bearing — Chrome TLS
 * impersonation alone passes Cloudflare. Internally calls `getProfile` first
 * to obtain the `profileId` required by the mutation input, then issues the
 * typed `UpdateBasicInfo` mutation via `impersonatedTransport`. Returns the
 * server-confirmed updated values.
 *
 * Errors:
 * - `ProfileError` with code `VALIDATION_ERROR` when neither `bio` nor
 *   `headline` is supplied — the contract requires at least one.
 * - `Cf403Error` propagates from the transport when Cloudflare returns 403.
 * - `ProfileError` with code `UNAUTHENTICATED` on token expiry.
 * - `ProfileError` with code `NO_VIEWER` when no viewer is bound.
 * - `ProfileError` with code `USER_ERROR` when the mutation returns a
 *   non-empty `errors` array (validation failures from the server, e.g., a
 *   bio that exceeds the platform's length limit). The message includes the
 *   first reported error.
 * - `ProfileError` with code `GRAPHQL_ERROR` on top-level GraphQL errors.
 * - `ProfileError` with code `NETWORK_ERROR` on transport-level throws.
 */
export async function updateProfile(token: string, changes: ProfileUpdate): Promise<UpdateProfileResult> {
  if (changes.bio === undefined && changes.headline === undefined) {
    throw new ProfileError("VALIDATION_ERROR", "updateProfile requires at least one of `bio` or `headline`.");
  }

  // Need profileId for the mutation input — fetch the current profile first.
  // Errors from getProfile (Cf403Error, ProfileError) propagate verbatim:
  // a write attempt that can't read its own profile is unrecoverable, and
  // surfacing the read-side error gives the user the same actionable message
  // they'd get from `ttctl profile show`.
  const profile = await getProfile(token);
  const profileId = profile.viewer?.viewerRole.profile.id;
  if (profileId === undefined) {
    throw new ProfileError(
      "NO_VIEWER",
      "Cannot update profile: viewer or profile id missing from the session response.",
    );
  }

  const basicInfo: UpdateBasicInfoInput["basicInfo"] = {};
  if (changes.bio !== undefined) basicInfo.about = changes.bio;
  if (changes.headline !== undefined) basicInfo.quote = changes.headline;

  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "UPDATE_BASIC_INFO",
        query: UPDATE_BASIC_INFO_MUTATION,
        variables: { input: { profileId, basicInfo } satisfies UpdateBasicInfoInput },
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "Cf403Error") throw err;
    throw new ProfileError("NETWORK_ERROR", `Profile update request failed: ${(err as Error).message}`, { cause: err });
  }

  if (res.status === 401) {
    throw new ProfileError("UNAUTHENTICATED", "Session is invalid or expired. Run `ttctl auth signin` to refresh it.");
  }

  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `Profile update returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as UpdateBasicInfoResponse | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    const message = first?.message ?? "GraphQL error";
    if (first?.extensions?.code === "UNAUTHENTICATED") {
      throw new ProfileError(
        "UNAUTHENTICATED",
        "Session is invalid or expired. Run `ttctl auth signin` to refresh it.",
      );
    }
    throw new ProfileError("GRAPHQL_ERROR", `Profile update failed: ${message}`);
  }

  const payload = body?.data?.updateBasicInfo;
  if (!payload) {
    throw new ProfileError("UNKNOWN", "Profile update response had no `data.updateBasicInfo` field");
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const fieldHint = first?.field ? ` (${first.field})` : "";
    throw new ProfileError("USER_ERROR", `Profile update rejected${fieldHint}: ${first?.message ?? "unknown error"}`);
  }

  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `Profile update reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }

  if (!payload.profile) {
    throw new ProfileError("UNKNOWN", "Profile update succeeded but response had no profile payload");
  }

  return {
    profile: {
      id: payload.profile.id,
      about: payload.profile.about ?? null,
      quote: payload.profile.quote ?? null,
    },
    notice: payload.notice ?? null,
  };
}
