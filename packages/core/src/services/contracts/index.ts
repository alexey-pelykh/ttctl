// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `contracts` service module — read-only access to the talent's
 * top-level legal documents at `profile(id:).talent.contracts`
 * (Toptal Direct, Master Service Agreement, etc.).
 *
 * | Leaf   | Operation        |
 * |--------|------------------|
 * | `list` | `GetContracts`   |
 * | `show` | `GetContracts` + client-side id filter |
 *
 * **Routing**: Both leaves talk to the **portal** surface
 * (`https://www.toptal.com/api/talent_profile/graphql`, Cloudflare-
 * protected) via `impersonatedTransport` with the `surface:
 * "talent-profile"` knob. Same surface as `auth.signOut` and every
 * `profile/*` mutation; cannot reuse `profile/shared.ts#callTalentProfile`
 * because that helper couples to `ProfileError`.
 *
 * **Domain distinction** (carried from the #157/#188 council, issue #195):
 *
 *   - **`Contract`** — talent-level legal document at
 *     `profile(id:).talent.contracts` (this module). Addressable by `id`,
 *     has `signedAt / verificationDeadline / isActive` lifecycle fields.
 *     Real records on the portal surface.
 *   - **`EngagementAgreement`** — engagement-attached commercial
 *     agreement at `TalentEngagement.currentAgreement` (the
 *     `engagements` module). No `id`, no history, no listability. Stays
 *     projected inline by `ttctl engagements show <id>`.
 *
 * The two domains do not join (no operation surfaces per-engagement
 * contract history). The CLI preserves the boundary: `ttctl contracts`
 * is talent-scoped, `ttctl engagements show` carries the
 * engagement-scoped agreement.
 *
 * **Schema/contract validation rule**: Every field on `Contract` is
 * `Unknown`-typed in the synthesized SDL
 * (`../research/graphql/talent_profile/schema.graphql` lines 163-174).
 * The entire projection is INFERRED; live wire validation via
 * `packages/e2e/src/35-contracts.e2e.test.ts` is mandatory pre-merge
 * per CLAUDE.md § Schema/contract validation rule.
 *
 * **Operation is hand-authored**. The captured document at
 * `../research/graphql/gateway/operations/portal/GetContracts.graphql`
 * is a minimal 4-field projection (id, kind, provider, status) AND uses
 * the wrong wire path (`viewer.contracts`, which the live
 * talent_profile/graphql endpoint rejects). Our hand-authored query
 * below uses the wire path captured in
 * `research/graphql/talent_profile/operations/getLegalSettingsData.graphql`
 * (`profile(id: $profileId).talent.contracts`) and extends the
 * projection to the 10 fields the `talent_profile/fragments/Contract.graphql`
 * fragment defines. `GetContracts` is in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`
 * in `codegen.config.ts` so no typed bindings exist.
 *
 * **Out of scope for v1** (deliberate; see issue #195):
 *
 *   - Contract negotiation / mutation (read-only command group).
 *   - Document download (PDF URLs are not on the projection — the API
 *     surface does not yet expose one).
 *   - Engagement-scoped agreement (lives in `engagements` service).
 */

import type { z } from "zod";

import { AuthRevokedError, TtctlError } from "../../auth/errors.js";
import { buildWireShapeError } from "../../lib/wire-shape.js";
import { impersonatedTransport } from "../../transport.js";
import type { TransportResponse } from "../../transport.js";
import { extractProfileId, isAuthRevokedExtensionCode } from "../profile/shared.js";

// ---------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------

/**
 * Contracts-domain error codes. Mirrors the `EngagementsError` /
 * `PaymentsError` shape.
 *
 * - `NO_TALENT`: HTTP 200 + `data.profile === null` or
 *   `data.profile.talent === null`. Defensive — the portal usually
 *   signals an auth-revoked failure differently. A null `talent` would
 *   indicate a non-talent profile (e.g. a client account) reached this
 *   surface, which TTCtl's auth model precludes.
 * - `NOT_FOUND`: `show(id)` was passed a contract-id that doesn't
 *   appear in `profile.talent.contracts`. Two wire shapes fold here:
 *   an explicit list that doesn't contain the id, AND a top-level
 *   GraphQL `Record not found` error (defensive — the portal sometimes
 *   surfaces unknown-id failures this way for Relay `node(id:)`
 *   lookups, though `contracts` is a list rather than `node(id:)` so
 *   the data-shape sentinel is the primary path).
 * - `GRAPHQL_ERROR`: top-level `errors[]` from the gateway, not an
 *   auth-revoked extension and not a `Record not found`.
 * - `NETWORK_ERROR`, `UNKNOWN`: standard transport failure modes.
 *
 * Auth-revoked failures throw `AuthRevokedError` (cross-cutting
 * `TtctlError` subclass per #77), not a code on this enum. `ProfileError`
 * from `extractProfileId(token)` (the profileId-resolution round-trip)
 * also propagates verbatim — a profile-read failure surfaces with the
 * same actionable message as `ttctl profile show`.
 */
export type ContractsErrorCode =
  | "NO_TALENT"
  | "NOT_FOUND"
  | "GRAPHQL_ERROR"
  | "NETWORK_ERROR"
  | "WIRE_SHAPE_ERROR"
  | "UNKNOWN";

export class ContractsError extends Error {
  override readonly name = "ContractsError";
  constructor(
    public readonly code: ContractsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/**
 * A talent-level legal document — Toptal Direct, Master Service
 * Agreement, etc. Projected from the `Contract` type at
 * `../research/graphql/talent_profile/schema.graphql:163`. Every field
 * is `Unknown`-typed in the synthesized SDL, so the runtime types here
 * are best-effort INFERRED until the gated E2E test pins them.
 *
 * Semantics (best-effort, pending E2E confirmation):
 *
 *   - `id`: Relay-style addressable id (string).
 *   - `kind`: contract kind enum value (e.g. `"TOPTAL_DIRECT"`,
 *     `"MASTER_SERVICE_AGREEMENT"`). Surfaced as `string` to remain
 *     forward-compatible with new enum values.
 *   - `provider`: contract provider/source (e.g. `"TOPTAL"`, a client
 *     name). String for forward-compat.
 *   - `status`: contract lifecycle status (e.g. `"SIGNED"`, `"PENDING"`,
 *     `"DRAFT"`). String for forward-compat.
 *   - `billingType`: billing arrangement (e.g. `"HOURLY"`, `"FIXED"`).
 *     Nullable in case some contract kinds (MSAs) carry no billing-type
 *     binding.
 *   - `signedAt`: ISO-8601 timestamp when the talent signed. Null when
 *     not yet signed.
 *   - `sentAt`: ISO-8601 timestamp when Toptal sent the document. Null
 *     when not yet sent.
 *   - `isActive`: boolean indicating active/binding state. Null shape
 *     allowed defensively.
 *   - `verificationDeadline`: ISO-8601 timestamp by which the talent
 *     must complete verification steps. Null when no deadline applies.
 *   - `title`: human-readable contract title. Null shape allowed
 *     defensively.
 *
 * Nullability is conservative — the SDL has `Unknown` placeholders
 * which carry no nullability signal. The CLI / MCP rendering layer
 * handles `null` defensively. Once the E2E run pins real types, tighten
 * the nullability here if observation supports it.
 */
export interface Contract {
  id: string;
  kind: string | null;
  provider: string | null;
  status: string | null;
  billingType: string | null;
  signedAt: string | null;
  sentAt: string | null;
  isActive: boolean | null;
  verificationDeadline: string | null;
  title: string | null;
}

// ---------------------------------------------------------------------
// GraphQL operation (hand-authored)
// ---------------------------------------------------------------------

// Hand-authored — modeled on the captured
// `research/graphql/talent_profile/operations/getLegalSettingsData.graphql`,
// which is the canonical wire path the portal SPA uses to read the
// talent's contracts (`profile(id:).talent.contracts`). Two other
// candidates were rejected by the live API in pre-merge E2E validation:
//
//   - `viewer.contracts` (the capture at
//     `research/graphql/gateway/operations/portal/GetContracts.graphql`):
//     `Field 'contracts' doesn't exist on type 'Viewer'`. The `Viewer`
//     SDL declaration of `contracts: Contract` (line 671 of
//     `talent_profile/schema.graphql`) is the schema synthesizer's
//     hypothesis that was never verified by a capture.
//   - `activation.talent.contracts` (from the captured
//     `GetActivationLegalData` op): `Field 'activation' doesn't exist
//     on type 'Query'`. The SDL declares `Query.activation: Unknown`
//     but the live talent_profile endpoint rejects it — likely a
//     non-activated-talent path that only works in specific account
//     states.
//
// `profile(id: $profileId)` is the universally-accessible path. The
// `profileId` is resolved via `extractProfileId(token)` which does
// one mobile-gateway round-trip to `profile.basic.show()` to read
// `viewerRole.profileId`. The two-round-trip cost matches `payments`
// service patterns.
//
// Operation name kept as `GetContracts` so any future server-side
// allow-listing keyed on operation name continues to recognize it.
//
// Projection is the 10-field full shape from
// `talent_profile/fragments/Contract.graphql`. Every field is
// `Unknown`-typed in the synthesized SDL → INFERRED.
const GET_CONTRACTS_QUERY = `query GetContracts($profileId: ID!) {
  profile(id: $profileId) {
    __typename
    id
    talent {
      __typename
      id
      contracts {
        __typename
        id
        kind
        provider
        status
        billingType
        signedAt
        sentAt
        isActive
        verificationDeadline
        title
      }
    }
  }
}`;

// ---------------------------------------------------------------------
// Wire shape (best-effort, INFERRED)
// ---------------------------------------------------------------------

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface WireContract {
  id: string;
  kind: string | null;
  provider: string | null;
  status: string | null;
  billingType: string | null;
  signedAt: string | null;
  sentAt: string | null;
  isActive: boolean | null;
  verificationDeadline: string | null;
  title: string | null;
}

interface GetContractsResponse {
  data?: {
    profile: {
      id: string;
      talent: {
        id: string;
        // The synthesized SDL declares `Profile.talent: Talent` (line
        // 437 of `talent_profile/schema.graphql`) and `Talent.contracts`
        // is `Unknown`-typed. The captured `getLegalSettingsData`
        // operation projects `profile(id:).talent.contracts` as a list
        // of `Contract`, and the `Contract` fragment defines the
        // 10-field shape. Conservative typing: list-or-null.
        contracts: WireContract[] | null;
      } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

// Defensive remap: if the portal surface ever returns a `Record not
// found`-style top-level GraphQL error for an unknown contract id (the
// gateway convention for Relay `node(id:)` lookups), fold it into the
// typed `NOT_FOUND` code. The primary `show()` path filters
// client-side; this is belt-and-braces for any future server-side
// `viewer.contract(id:)` lookup.
const NOT_FOUND_MESSAGE_PATTERN = /Record not found/i;

// ---------------------------------------------------------------------
// Transport helper
// ---------------------------------------------------------------------

async function callTalentProfile<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
): Promise<T> {
  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: { operationName, query, variables },
    });
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    throw new ContractsError("NETWORK_ERROR", `${operationName} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ContractsError("UNKNOWN", `${operationName} returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as { data?: T | null; errors?: GraphQLErrorEntry[] | null } | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    const message = first?.message ?? "GraphQL error";
    if (NOT_FOUND_MESSAGE_PATTERN.test(message)) {
      throw new ContractsError("NOT_FOUND", `Contract not found: ${message}`);
    }
    throw new ContractsError("GRAPHQL_ERROR", `${operationName} failed: ${message}`);
  }
  if (!body?.data) {
    throw new ContractsError("UNKNOWN", `${operationName} response had no \`data\` field`);
  }
  if (schema !== undefined) {
    const parsed = schema.safeParse(body.data);
    if (!parsed.success) {
      const payload = buildWireShapeError(operationName, parsed.error, body.data);
      throw new ContractsError("WIRE_SHAPE_ERROR", payload.message, { cause: parsed.error });
    }
    return parsed.data;
  }
  return body.data;
}

// ---------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------

function projectContract(wire: WireContract): Contract {
  return {
    id: wire.id,
    kind: wire.kind,
    provider: wire.provider,
    status: wire.status,
    billingType: wire.billingType,
    signedAt: wire.signedAt,
    sentAt: wire.sentAt,
    isActive: wire.isActive,
    verificationDeadline: wire.verificationDeadline,
    title: wire.title,
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * List the talent's top-level legal contracts via
 * `profile(id:).talent.contracts` on the portal surface.
 *
 * Two round-trips: first a mobile-gateway `profile.basic.show()` call
 * via `extractProfileId(token)` to resolve the user's `profileId`, then
 * the `GetContracts` query against `talent-profile/graphql` with the
 * resolved id.
 *
 * Returns the contracts in server order (no client-side sort). An
 * empty list is a legitimate return value (a talent who hasn't signed
 * any contract yet); callers MUST handle the empty case explicitly.
 *
 * Throws (typed):
 *
 *   - `AuthRevokedError` — session bearer is invalid or expired.
 *   - `Cf403Error` (from the transport) — Cloudflare blocked the
 *     request despite Chrome TLS impersonation; the CLI/MCP surfaces
 *     render the verbatim guidance to file an issue.
 *   - `ProfileError` — the `extractProfileId(token)` round-trip
 *     failed (e.g. the viewer payload had no `viewerRole.profileId`).
 *     Propagates verbatim so the user sees the same actionable message
 *     as `ttctl profile show`.
 *   - `ContractsError(NO_TALENT)` — `data.profile` or
 *     `data.profile.talent` is null (defensive; auth failures usually
 *     surface through `AuthRevokedError`).
 *   - `ContractsError(GRAPHQL_ERROR)` — top-level GraphQL error, not
 *     auth-revoked, not a `Record not found`.
 *   - `ContractsError(NETWORK_ERROR)` — transport failure (DNS, TLS,
 *     connection reset).
 *   - `ContractsError(UNKNOWN)` — non-2xx HTTP status or missing
 *     `data` field.
 */
export async function list(token: string): Promise<Contract[]> {
  const profileId = await extractProfileId(token);
  const data = await callTalentProfile<GetContractsResponse["data"]>(token, "GetContracts", GET_CONTRACTS_QUERY, {
    profileId,
  });
  if (data === null || data === undefined) {
    throw new ContractsError("UNKNOWN", "GetContracts returned no `data` payload.");
  }
  if (data.profile === null) {
    throw new ContractsError("NO_TALENT", "GetContracts response had `profile: null`.");
  }
  if (data.profile.talent === null) {
    throw new ContractsError("NO_TALENT", "GetContracts response had `profile.talent: null`.");
  }
  const wire = data.profile.talent.contracts ?? [];
  return wire.map(projectContract);
}

/**
 * Show a single contract by id. The portal surface does not expose a
 * `contract(id:)` lookup — `show()` fetches the full
 * `profile(id:).talent.contracts` list and filters client-side. The
 * round-trip cost is the same as `list()`; latency-conscious callers
 * may prefer `list()` + their own filter when retrieving multiple
 * contracts.
 *
 * Throws:
 *
 *   - everything `list()` throws, plus
 *   - `ContractsError(NOT_FOUND)` — no contract with the supplied id
 *     was found in `profile.talent.contracts`.
 */
export async function show(token: string, id: string): Promise<Contract> {
  const items = await list(token);
  const match = items.find((c) => c.id === id);
  if (match === undefined) {
    throw new ContractsError("NOT_FOUND", `No contract found with id "${id}" (or you don't have access to it).`);
  }
  return match;
}
