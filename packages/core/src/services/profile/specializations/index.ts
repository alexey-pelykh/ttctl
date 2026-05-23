// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `profile.specializations` service module — read-only access to the
 * talent's accepted specialization tracks (Core, Marketplace, Expert
 * Crowd, etc.). Specializations are public badges on the Toptal profile
 * that mark the talent's enrolment in a particular Toptal program.
 *
 * | Leaf    | Operation                  |
 * |---------|----------------------------|
 * | `show`  | `GetTalentSpecializations` |
 *
 * **Routing**: talks to the **mobile-gateway** surface
 * (`https://www.toptal.com/gateway/graphql/talent/graphql`) via
 * `stockTransport`. The op was captured under
 * `../research/graphql/gateway/operations/portal/` (the portal client
 * authored it) but the gateway endpoint is the same as for mobile-side
 * ops — `gateway/operations/portal/` and `gateway/operations/mobile/`
 * share the `mobile-gateway` surface per the convention `payments.summary()`
 * (#448, `GetTalentPaymentSummary`) and `payments.rate.current()` (#447,
 * `GetTalentRate`) already follow.
 *
 * **T1 disposition** (#466): `GetTalentSpecializations` is in
 * `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`), so no
 * generated operation type exists — the disposition is structurally
 * forced to T1 per ADR-006. Wire shape is pinned by
 * `GetTalentSpecializations.snapshot.json` (committed once captured on a
 * `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run) and asserted on every
 * `TTCTL_E2E=1` run via `assertWireShapeStable`.
 *
 * **Schema/contract rule**: triggered (new hand-authored op site reading
 * a `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` operation; mandatory live E2E
 * coverage at PR time).
 *
 * **Selection**: verbatim from the captured op document
 * (`../research/graphql/gateway/operations/portal/GetTalentSpecializations.graphql`).
 * The selection is small (9 leaf fields + a 2-field `operations.apply`
 * branch); we keep it as-captured rather than trimming. `viewer.id` is
 * selected so a `requireViewer: true` posture stays consistent with
 * sibling viewer-scoped reads, and `specialization.id` lets callers
 * round-trip a known specialization through `applyForSpecialization`
 * (out of scope for this read leaf — `operations.apply.callable` /
 * `messages` are the surface for that follow-up).
 */

import { ProfileError } from "../basic/index.js";
import type { ProfileErrorCode } from "../basic/index.js";
import { callGatewayShared } from "../../_shared/transport.js";

// Re-export `ProfileError` (and its code enum) so consumers can
// `catch (err) { if (err instanceof profile.specializations.ProfileError) ... }`
// without crossing sibling sub-domain boundaries.
export { ProfileError };
export type { ProfileErrorCode };

/**
 * One `TalentSpecialization` row as `show()` projects it. Mirrors the
 * captured `TalentSpecialization` fragment (verbatim selection).
 *
 * Field meanings (per portal UI and the captured op):
 *   - `id`              — opaque catalog id (UUID-shaped); stable across
 *                         sessions, suitable for `applyForSpecialization`
 *                         input.
 *   - `slug`            — short kebab-case label (e.g. `"core"`,
 *                         `"marketplace"`, `"expert-crowd"`); stable; useful
 *                         for human-readable identification.
 *   - `title`           — display title rendered on the public profile
 *                         badge.
 *   - `description`     — long-form explanatory copy shown in the
 *                         specialization picker. May be `null`.
 *   - `logoUrl`         — absolute URL of the badge image rendered on the
 *                         public profile. May be `null` for a
 *                         specialization with no logo art.
 *   - `applicationStatus` — wire enum string (e.g. `"ACCEPTED"`,
 *                         `"PENDING"`, `"REJECTED"`, plus
 *                         pre-application states). The synthesized
 *                         schema types this as `Unknown`, so we expose it
 *                         as a forward-compatible `string` rather than
 *                         coupling to an INFERRED enum.
 *   - `eligibleJobsCount` — server-computed count of jobs the talent
 *                         would become eligible for upon acceptance.
 *                         Typically zero for already-accepted specs,
 *                         positive for prospective ones. May be `null`
 *                         when the wire does not surface a count
 *                         (e.g. pre-application states).
 *   - `applicationCompletedAt` — ISO-8601 timestamp of acceptance (the
 *                         "granted-at date" in issue #466's verbiage).
 *                         `null` for prospective / pending / rejected
 *                         applications.
 *   - `operations.apply.callable` — server-computed flag indicating
 *                         whether `applyForSpecialization` would succeed
 *                         (the apply mutation may be gated by talent
 *                         state or prior history).
 *   - `operations.apply.messages` — server-supplied human-readable
 *                         messages explaining why `callable` is false
 *                         (e.g. "Already accepted", "Requires …
 *                         certification"). Always an array; may be empty.
 */
export interface SpecializationApplyOperation {
  callable: boolean;
  messages: string[];
}

export interface SpecializationOperations {
  apply: SpecializationApplyOperation;
}

export interface Specialization {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  logoUrl: string | null;
  applicationStatus: string;
  eligibleJobsCount: number | null;
  applicationCompletedAt: string | null;
  operations: SpecializationOperations;
}

// ---------------------------------------------------------------------
// GraphQL operation (verbatim from the captured doc)
// ---------------------------------------------------------------------

// Verbatim from
// `../research/graphql/gateway/operations/portal/GetTalentSpecializations.graphql`.
// Untrusted catalog: listed in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`
// (`codegen.config.ts`), so no `GetTalentSpecializationsQuery` type is
// generated — T1 (snapshot) disposition.
const GET_TALENT_SPECIALIZATIONS_QUERY = `query GetTalentSpecializations { viewer { id specializations { id title ...TalentSpecialization } } } fragment TalentSpecialization on TalentSpecialization { id slug title description logoUrl applicationStatus eligibleJobsCount applicationCompletedAt operations { apply { callable messages } } }`;

// ---------------------------------------------------------------------
// Wire-shape interfaces (private)
// ---------------------------------------------------------------------

interface WireSpecializationApplyOperation {
  callable?: boolean | null;
  messages?: (string | null)[] | null;
}

interface WireSpecializationOperations {
  apply?: WireSpecializationApplyOperation | null;
}

interface WireSpecialization {
  id: string;
  slug?: string | null;
  title?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  applicationStatus?: string | null;
  eligibleJobsCount?: number | null;
  applicationCompletedAt?: string | null;
  operations?: WireSpecializationOperations | null;
}

interface SpecializationsResponse {
  viewer: {
    id: string;
    specializations?: (WireSpecialization | null)[] | null;
  } | null;
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Read the talent's specializations (badges shown on the public profile).
 *
 * Viewer-scoped — takes no input. Returns the full list of
 * specializations the talent has interacted with (accepted, pending,
 * rejected, and prospective). Empty list is a legitimate state for a
 * fresh account.
 *
 * @param token  Captured bearer.
 *
 * @throws `ProfileError("NO_VIEWER")` when the session is valid but no
 *   viewer is bound to it.
 * @throws `ProfileError("GRAPHQL_ERROR")` for any non-auth top-level
 *   GraphQL error.
 * @throws `AuthRevokedError` for 401 or `extensions.code` auth-revoked
 *   signals (raised by the shared transport wrapper).
 */
export async function show(token: string): Promise<Specialization[]> {
  const data = await callGatewayShared<SpecializationsResponse, ProfileError>(
    "mobile-gateway",
    token,
    "GetTalentSpecializations",
    GET_TALENT_SPECIALIZATIONS_QUERY,
    {},
    ProfileError,
    { requireViewer: true },
  );
  // `requireViewer: true` already raises `NO_VIEWER` for the null branch,
  // but the type system needs the narrowing.
  if (data.viewer === null) {
    throw new ProfileError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  const rows = (data.viewer.specializations ?? []).filter((r): r is WireSpecialization => r !== null);
  return rows.map(project);
}

function project(wire: WireSpecialization): Specialization {
  const messages = (wire.operations?.apply?.messages ?? []).filter((m): m is string => m !== null);
  return {
    id: wire.id,
    slug: wire.slug ?? "",
    title: wire.title ?? "",
    description: wire.description ?? null,
    logoUrl: wire.logoUrl ?? null,
    applicationStatus: wire.applicationStatus ?? "",
    eligibleJobsCount: wire.eligibleJobsCount ?? null,
    applicationCompletedAt: wire.applicationCompletedAt ?? null,
    operations: {
      apply: {
        callable: wire.operations?.apply?.callable ?? false,
        messages,
      },
    },
  };
}
