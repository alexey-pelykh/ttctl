// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Shared GraphQL transport wrapper for service modules (issue #329).
 *
 * Replaces 8 near-identical `callGateway` / `callTalentProfile`
 * helpers that previously lived inside individual service files
 * (`services/{applications,availability,contracts,engagements,jobs,
 * payments,profile/skills,timesheet}`). The Zod-validation hook
 * (`buildWireShapeError`, Z-3 / #286) used to be duplicated across 9
 * sites; here it lives once.
 *
 * The per-service helpers all shared a common envelope but differed in
 * three bounded ways:
 *
 *   1. **Surface**: mobile-gateway (via `stockTransport`) or
 *      talent-profile (via `impersonatedTransport`). Resolved here by
 *      delegating to `callSurface`, which dispatches based on
 *      `SURFACES_REQUIRING_IMPERSONATION`.
 *   2. **Domain error class**: each service threw its own typed error
 *      (`ApplicationsError`, `JobsError`, …) so callers can pattern-
 *      match `instanceof ServiceError && err.code === "GRAPHQL_ERROR"`
 *      without importing a cross-domain enum. We accept the class
 *      itself via the `errorFactory` parameter and instantiate it
 *      with the code strings every existing helper already used.
 *   3. **Viewer-binding check**: `applications` requires that the
 *      response include a non-null `viewer` (the gateway treats a
 *      missing viewer as "session valid but no viewer bound", which
 *      should surface as `NO_VIEWER` rather than a generic error). All
 *      other services omit this check. Toggled via
 *      `opts.requireViewer`.
 *
 * `profile/shared.ts#callTalentProfile` remains a separate helper for
 * the moment because its signature differs (it returns the raw
 * `TransportResponse`, takes a `verb` parameter for error tagging, and
 * defers top-level error handling to `ensureNoTopLevelErrors`). The 4
 * profile sub-domains (`industries`, `education`, `employment`,
 * `certifications`) consume it, so a separate migration will handle
 * that consolidation — see #329 follow-up.
 *
 * @see {@link callGatewayShared}
 */

import type { z } from "zod";

import { AuthRevokedError, TtctlError } from "../../auth/errors.js";
import { buildWireShapeError } from "../../lib/wire-shape.js";
import { impersonatedTransport, stockTransport } from "../../transport.js";
import type { TransportResponse } from "../../transport.js";
import { SURFACES_REQUIRING_IMPERSONATION } from "../../types.js";
import type { ToptalSurface } from "../../types.js";
import { isAuthRevokedExtensionCode } from "../profile/shared.js";
import type { GraphQLErrorEntry } from "../profile/shared.js";

/**
 * Codes that {@link callGatewayShared} may throw via its
 * {@link DomainErrorFactory}. Every consuming service's per-domain
 * error code union (e.g. `ApplicationsErrorCode`, `JobsErrorCode`)
 * must be a superset of this set (plus its own domain-specific
 * extensions like `NOT_FOUND`).
 *
 * `NO_VIEWER` is included unconditionally even though only callers
 * passing `opts.requireViewer: true` will see it — services that
 * don't opt into the viewer check still need their factory's code
 * union to permit it for the parameter type to satisfy the factory
 * signature. The runtime never throws `NO_VIEWER` for these services.
 */
export type SharedTransportErrorCode = "NETWORK_ERROR" | "GRAPHQL_ERROR" | "WIRE_SHAPE_ERROR" | "NO_VIEWER" | "UNKNOWN";

/**
 * Constructor signature for any domain-error class consumed by
 * {@link callGatewayShared}.
 *
 * The `code` parameter is typed as {@link SharedTransportErrorCode}.
 * Each consuming service's domain error code union
 * (e.g. `ApplicationsErrorCode`, `JobsErrorCode`) must be a
 * **superset** of {@link SharedTransportErrorCode} — i.e., every
 * shared code is one of the domain's accepted code strings. Under
 * TypeScript's constructor-parameter contravariance, a class whose
 * constructor accepts a wider code union (e.g.
 * `ApplicationsErrorCode = "NO_VIEWER" | "NOT_FOUND" | …shared codes`)
 * satisfies `new (code: SharedTransportErrorCode, …) => ApplicationsError`.
 *
 * This is verified at compile time at every `callGatewayShared` call
 * site: passing a domain error class whose code union is missing a
 * shared code (e.g. lacks `NO_VIEWER`) raises an assignment error.
 */
export interface DomainErrorFactory<E extends Error> {
  new (code: SharedTransportErrorCode, message: string, options?: { cause?: unknown }): E;
}

/**
 * Optional knobs for {@link callGatewayShared}.
 */
export interface CallGatewaySharedOptions<T> {
  /**
   * Zod schema applied to `body.data` before returning. On parse
   * failure the helper throws `errorFactory("WIRE_SHAPE_ERROR", …)`
   * with the original {@link z.ZodError} chained via `cause` and a
   * field-level diff in the message per
   * `docs/wire-validation-error-format.md` (Z-3 / #286). When
   * omitted, the existing pass-through behavior is preserved.
   *
   * `| undefined` accommodates `exactOptionalPropertyTypes` — per-
   * service wrappers thread their own `schema?: z.ZodType<T>`
   * parameter through unchanged (which may be `undefined`).
   */
  schema?: z.ZodType<T> | undefined;
  /**
   * When `true`, the helper additionally narrows `data` to
   * `{ viewer: { id: string } | null }` and throws
   * `errorFactory("NO_VIEWER", …)` if `data.viewer === null`. Used
   * by `applications` (the gateway returns `viewer === null` when
   * the session is technically valid but no viewer is bound — e.g.
   * the bearer maps to a non-talent account). Other services either
   * use schemas that already constrain `viewer` or don't carry a
   * `viewer` field in their wire shape.
   */
  requireViewer?: boolean | undefined;
}

/**
 * Fire a GraphQL request against a Toptal surface and turn
 * transport-level outcomes into a typed domain error.
 *
 * Surface routing: {@link impersonatedTransport} for surfaces in
 * {@link SURFACES_REQUIRING_IMPERSONATION} (talent-profile,
 * scheduler), {@link stockTransport} otherwise (mobile-gateway).
 * Routing is inlined here rather than delegating to `callSurface`
 * because existing service-level tests mock these transport
 * functions directly via `vi.mock("../../transport.js", …)`;
 * routing through `callSurface` would bypass those mocks
 * (the function captures a closure reference at module-load time).
 *
 * Error mapping:
 * - {@link TtctlError} subclasses ({@link AuthRevokedError},
 *   `Cf403Error`, etc.) propagate as-is so the CLI / MCP surfaces
 *   apply uniform `recovery` rendering.
 * - Other transport throws → `errorFactory("NETWORK_ERROR", …)`.
 * - HTTP 401 → {@link AuthRevokedError}.
 * - Non-2xx → `errorFactory("UNKNOWN", …)`.
 * - Top-level `errors[]` with an auth-revoked extension code (per
 *   {@link isAuthRevokedExtensionCode}) → {@link AuthRevokedError}.
 * - Top-level `errors[]` otherwise → `errorFactory("GRAPHQL_ERROR", …)`
 *   with the offending {@link GraphQLErrorEntry} chained via `cause`
 *   (callers that remap to a domain-specific code — e.g. contracts
 *   translating `Record not found` to `NOT_FOUND` — can lift the wire
 *   message off `err.cause.message` without parsing `err.message`).
 * - Missing `data` field → `errorFactory("UNKNOWN", …)`.
 * - Zod parse failure (when `schema` provided) →
 *   `errorFactory("WIRE_SHAPE_ERROR", …)` carrying the diff payload.
 * - `data.viewer === null` (when `requireViewer` true) →
 *   `errorFactory("NO_VIEWER", …)`.
 *
 * Returns the validated `body.data` narrowed to `T`. When `schema` is
 * omitted, the cast is unverified — callers should provide a schema
 * for any operation whose wire shape is gappy in the synthesized SDL
 * (CLAUDE.md § Track 1 vs Track 2 disposition).
 */
export async function callGatewayShared<T, E extends Error>(
  surface: ToptalSurface,
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  errorFactory: DomainErrorFactory<E>,
  opts?: CallGatewaySharedOptions<T>,
): Promise<T> {
  const transport = SURFACES_REQUIRING_IMPERSONATION.has(surface) ? impersonatedTransport : stockTransport;
  let res: TransportResponse;
  try {
    res = await transport({
      surface,
      authToken: token,
      body: { operationName, query, variables },
    });
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    throw new errorFactory("NETWORK_ERROR", `${operationName} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    // #610: surface body.errors[0].message on non-2xx so wire breakages self-diagnose
    // (HTTP 400s usually carry GRAPHQL_VALIDATION_FAILED details; discarding them
    // forces operators to re-curl manually to identify the rejection).
    const errBody = res.body as { errors?: GraphQLErrorEntry[] | null } | null;
    const detail = errBody?.errors?.[0]?.message;
    throw new errorFactory(
      "UNKNOWN",
      `${operationName} returned HTTP ${res.status.toString()}${detail !== undefined ? `: ${detail}` : ""}`,
    );
  }

  const body = res.body as { data?: T | null; errors?: GraphQLErrorEntry[] | null } | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new errorFactory("GRAPHQL_ERROR", `${operationName} failed: ${first?.message ?? "GraphQL error"}`, {
      cause: first,
    });
  }
  if (!body?.data) {
    throw new errorFactory("UNKNOWN", `${operationName} response had no \`data\` field`);
  }

  let data: T;
  if (opts?.schema !== undefined) {
    const parsed = opts.schema.safeParse(body.data);
    if (!parsed.success) {
      const payload = buildWireShapeError(operationName, parsed.error, body.data);
      throw new errorFactory("WIRE_SHAPE_ERROR", payload.message, { cause: parsed.error });
    }
    data = parsed.data;
  } else {
    data = body.data;
  }

  if (opts?.requireViewer === true) {
    const withViewer = data as unknown as { viewer: { id: string } | null };
    if (withViewer.viewer === null) {
      throw new errorFactory("NO_VIEWER", "Session is valid but no viewer is bound to it.");
    }
  }

  return data;
}
