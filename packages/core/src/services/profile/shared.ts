// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { z } from "zod";

import { AuthRevokedError, TtctlError } from "../../auth/errors.js";
import { buildWireShapeError } from "../../lib/wire-shape.js";
import { impersonatedTransport } from "../../transport/index.js";
import type { TransportResponse } from "../../transport/index.js";
import { show as basicShow, ProfileError } from "./basic/index.js";

/**
 * Shape of an entry in the GraphQL `errors` array (top-level, not the
 * mutation-payload `errors` field). Mirrors the inline definition in
 * `services/profile/basic/index.ts`; declared here so the four sub-domains
 * landing in #74 share a single source of truth.
 */
export interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

/**
 * Mutation-payload `UserError` shape (`{ code, key, message }`). Same name
 * on the wire across `updateBasicInfo`, `createEducation`, `updateEducation`,
 * etc. — keeping the interface here lets every sub-domain surface the
 * same error fields uniformly.
 *
 * The canonical schema (`packages/core/src/__generated__/talent-profile.ts`)
 * is the authority: `UserError { code, key, message }`. Selecting `field`
 * (a stale name from earlier inferred drafts) returns a top-level GraphQL
 * error from the server. See #248 for the wire-shape regression.
 */
export interface UserError {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

/**
 * Returns `true` when `extensions.code` on a GraphQL error indicates the
 * session token has been revoked or expired and the user must re-run
 * `ttctl auth signin`.
 *
 * Recognized stable codes (accumulated across surfaces and history):
 *
 *   - `'UNAUTHENTICATED'`         — talent-profile (Cloudflare-protected, web-portal API)
 *   - `'AUTHENTICATION_REQUIRED'` — defensive carryover from #77 (provenance unverified;
 *                                    see "Empirical history" below)
 *   - `'UNAUTHORIZED'`            — mobile-gateway (federated `talent_schema` subgraph,
 *                                    empirically observed 2026-05-07 for invalid bearer
 *                                    tokens; see `research/notes/14-auth-error-extensions-code.md`)
 *
 * All three collapse to `AuthRevokedError` so the CLI / MCP surfaces apply a
 * uniform "Run `ttctl auth signin`" recovery hint regardless of which surface
 * raised the failure.
 *
 * **Empirical history** (issue #89): the original predicate (#77) recognized
 * only the first two codes. Live mobile-gateway capture for an invalid bearer
 * token returned HTTP 200 with `errors[0].extensions.code = 'UNAUTHORIZED'`
 * (NOT `'AUTHENTICATION_REQUIRED'` as documentation suggested). All token-
 * shape variants (corrupted, malformed, no-auth, plausible-but-invalid) flow
 * through the same code path with identical responses, so this single code
 * covers every "gateway can't resolve the token to an account" case.
 *
 * Future drift: a server-side rename adds another `||` clause here. New codes
 * MUST be empirically captured before being added — see the research note for
 * the capture procedure.
 */
export function isAuthRevokedExtensionCode(code: string | null | undefined): boolean {
  return code === "UNAUTHENTICATED" || code === "AUTHENTICATION_REQUIRED" || code === "UNAUTHORIZED";
}

/**
 * Resolve the signed-in user's `profileId` for use in mutation inputs that
 * follow Pattern 2 (`{ profileId, <entity>: <Entity>Input }`) — see
 * `research/notes/10-mutation-input-patterns.md`. Lazily fetches the
 * profile via `profile.basic.show()` against the mobile-gateway surface,
 * then extracts `viewerRole.profileId`.
 *
 * Errors propagate verbatim — a write attempt that can't read its own
 * profile is unrecoverable, and surfacing the read-side error gives the
 * user the same actionable message as `ttctl profile show`.
 */
export async function extractProfileId(token: string): Promise<string> {
  const profile = await basicShow(token);
  const profileId = profile.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    throw new ProfileError(
      "NO_VIEWER",
      "Cannot resolve profileId: viewer or profile id missing from the session response.",
    );
  }
  return profileId;
}

/**
 * Fire a GraphQL request against the talent-profile surface and turn
 * transport-level outcomes into typed errors consistent across the four
 * sub-domains landing in #74.
 *
 * Error mapping:
 * - Underlying typed errors (`TtctlError` subclasses — `Cf403Error`,
 *   `AuthRevokedError`, …) propagate as-is so the CLI / MCP surfaces can
 *   render their `recovery` hints.
 * - Other transport throws become `ProfileError("NETWORK_ERROR")` with
 *   the underlying message tagged by `verb` (e.g. "education list").
 * - HTTP 401 becomes `AuthRevokedError`.
 * - Non-2xx becomes `ProfileError("UNKNOWN")`.
 *
 * Top-level GraphQL `errors` are NOT inspected here — callers handle
 * those via {@link ensureNoTopLevelErrors} once they've narrowed the body
 * to their expected shape.
 *
 * Optional `schema` parameter (Z-3 / #286): when provided, the
 * response `body.data` is validated against the schema as a SIDE
 * EFFECT before the helper returns; on `ZodError` the call throws
 * `ProfileError("WIRE_SHAPE_ERROR")` with the original ZodError
 * chained via `cause` and a field-level diff in the message per
 * `docs/wire-validation-error-format.md`. The return shape is
 * unchanged (`TransportResponse`) — callers still narrow `res.body`
 * to their per-operation type. Schema validation is a guard rail; it
 * does NOT mutate the response. When omitted, the existing pass-
 * through behavior is preserved. No production op wires `schema` in
 * Wave 3; Z-4 (#288) ships the first beachhead.
 */
export async function callTalentProfile(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  verb: string,
  schema?: z.ZodType,
): Promise<TransportResponse> {
  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: { operationName, query, variables },
    });
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    throw new ProfileError("NETWORK_ERROR", `${verb} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (res.status === 401) throw new AuthRevokedError("Session is invalid or expired.");
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `${verb} returned HTTP ${res.status.toString()}`);
  }
  if (schema !== undefined) {
    const body = res.body as { data?: unknown } | null;
    if (body?.data !== undefined && body.data !== null) {
      const parsed = schema.safeParse(body.data);
      if (!parsed.success) {
        const payload = buildWireShapeError(operationName, parsed.error, body.data);
        throw new ProfileError("WIRE_SHAPE_ERROR", payload.message, { cause: parsed.error });
      }
    }
  }
  return res;
}

/**
 * Throw a typed error when the GraphQL response carries a non-empty
 * top-level `errors` array. Auth-revoked codes (per
 * {@link isAuthRevokedExtensionCode}) become `AuthRevokedError`; anything
 * else becomes `ProfileError("GRAPHQL_ERROR")` tagged by `verb`.
 */
export function ensureNoTopLevelErrors(body: { errors?: GraphQLErrorEntry[] | null } | null, verb: string): void {
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `${verb} failed: ${first?.message ?? "GraphQL error"}`);
  }
}

/**
 * Inspect a mutation payload for `success === false` or a non-empty
 * `errors` array and convert either into `ProfileError("USER_ERROR")`. The
 * common shape across the four sub-domains' mutation payloads is
 * `{ success?, notice?, errors?: UserError[] }`; this helper handles
 * exactly that subset and lets each sub-domain narrow the rest of the
 * payload itself.
 */
export function applyUserErrorsAndSuccess(
  payload: { success?: boolean | null; notice?: string | null; errors?: UserError[] | null },
  verb: string,
): void {
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const fieldHint = first?.key ? ` (${first.key})` : "";
    throw new ProfileError("USER_ERROR", `${verb} rejected${fieldHint}: ${first?.message ?? "unknown error"}`);
  }
  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `${verb} reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
}
