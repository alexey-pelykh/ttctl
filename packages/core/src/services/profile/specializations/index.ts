// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `profile.specializations` service module — read + apply on the
 * talent's specialization tracks (Core, Marketplace, Expert Crowd,
 * etc.). Specializations are public badges on the Toptal profile that
 * mark the talent's enrolment in a particular Toptal program.
 *
 * | Leaf    | Operation                  |
 * |---------|----------------------------|
 * | `show`  | `GetTalentSpecializations` |
 * | `apply` | `ApplyForSpecialization`   |
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
 * **Selection** ({@link show}): verbatim from the captured op document
 * (`../research/graphql/gateway/operations/portal/GetTalentSpecializations.graphql`).
 * The selection is small (9 leaf fields + a 2-field `operations.apply`
 * branch); we keep it as-captured rather than trimming. `viewer.id` is
 * selected so a `requireViewer: true` posture stays consistent with
 * sibling viewer-scoped reads, and `specialization.id` lets callers
 * round-trip a known specialization through {@link apply}
 * (`operations.apply.callable` / `messages` indicate whether the apply
 * mutation will succeed pre-flight).
 *
 * **Apply** ({@link apply}, #467): wraps `ApplyForSpecialization`
 * verbatim from the captured op
 * (`../research/graphql/gateway/operations/portal/ApplyForSpecialization.graphql`).
 * **DESTRUCTIVE** — submits the talent's application to the named
 * specialization track. No withdraw mutation on the wire (per
 * `operations.apply` schema). Gated by per-domain consent
 * (`profileCapabilityConsentIssued: true` per ADR-009 (ttctl)) and the
 * standard `--dry-run` preview path. T1 disposition (snapshot) — the
 * op is also in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`. E2E coverage on
 * the apply path is gated by the operator opt-in
 * `TTCTL_E2E_APPLY_SPECIALIZATION` env var (mirrors the
 * `TTCTL_E2E_APPLY_JOB` precedent from #436).
 */

import { ensureDestructiveConsent } from "../../../consent.js";
import { buildDryRunPreview } from "../../../transport.js";
import type { DryRunPreview } from "../../../transport.js";
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
 *   - `operations.apply.callable` — server-computed enum-string marker
 *                         indicating whether `applyForSpecialization`
 *                         would succeed (per the synthesized schema
 *                         `Operation.callable: String!`; empirical value
 *                         `"ENABLED"` for the affirmative case). Exposed
 *                         verbatim as a forward-compatible `string`
 *                         rather than coupling to an INFERRED enum —
 *                         same posture as `applicationStatus` above.
 *   - `operations.apply.messages` — server-supplied human-readable
 *                         messages explaining why `callable` is not
 *                         `"ENABLED"` (e.g. "Already accepted",
 *                         "Requires … certification"). Always an array;
 *                         may be empty.
 */
export interface SpecializationApplyOperation {
  callable: string;
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
  callable?: string | null;
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
        callable: wire.operations?.apply?.callable ?? "",
        messages,
      },
    },
  };
}

// ---------------------------------------------------------------------
// apply — ApplyForSpecialization mutation (#467)
// ---------------------------------------------------------------------

/**
 * Per-domain consent ceremony for {@link apply}. Per ADR-009 (ttctl)
 * § Decision Part 1, applying to a specialization is in the
 * `profile-capability` domain (commits the talent to a Toptal review
 * track that publishes the badge on the public profile — a
 * recruiter-visible capability change).
 *
 * The field is statically typed to `true` (literal) — TypeScript
 * compile-time gate. The runtime gate at
 * {@link ensureDestructiveConsent} covers `as`-cast bypasses and
 * JSON-sourced inputs (CLI / MCP / agents passing untyped objects).
 */
export interface SpecializationApplyConsent {
  /**
   * MUST be `true` — acknowledges that this commits the maintainer
   * to a Toptal specialization application (no safe round-trip via
   * TTCtl; the platform's specialization-application workflow may
   * include training, compliance, or recruiter gates). See ADR-009
   * (ttctl) § Decision Part 1 for the per-domain consent vocabulary.
   */
  profileCapabilityConsentIssued: true;
}

/**
 * Optional knobs for {@link apply}. Mirrors the `applications.apply`
 * pattern (#426 / #436) — `dryRun: true` short-circuits the wire call
 * and returns a {@link DryRunPreview}-bearing outcome instead.
 */
export interface SpecializationApplyOptions {
  /**
   * When `true`, short-circuit before any transport call and return a
   * {@link DryRunPreview}-bearing outcome instead of executing the
   * mutation. Default: `false` — normal apply path.
   */
  dryRun?: boolean;
}

/**
 * Server-confirmed result of {@link apply} (#467) on the apply-success
 * path. Echoes the `specializationId` the caller passed AND the wire-
 * supplied `notice` so the caller can render a meaningful confirmation
 * of "what was sent to the server" without an extra `show()` round-trip
 * (write-read symmetry is also continuously verifiable: the next
 * `show()` reflects the new `applicationStatus` for the same id).
 *
 * `specializationId` is threaded from input → result by the service
 * because the captured wire selection
 * (`apply(input: {}) { success notice errors { … } }`) does NOT echo
 * the id — Toptal's gateway resolves the specialization by argument
 * (`specialization(id: $specializationId)`) and returns the apply
 * payload directly, without re-serialising the parent's id.
 */
export interface SpecializationApplyResult {
  /** Echo of the input `specializationId` — useful for audit trails and as a key for the post-apply `show()` cross-check. */
  specializationId: string;
  /**
   * Server-supplied free-text notice (e.g. "Application submitted",
   * "We'll be in touch about next steps"). May be `null` if the wire
   * returns no notice.
   */
  notice: string | null;
}

/**
 * Apply-path outcome for {@link apply}. Carries the
 * {@link SpecializationApplyResult} on the success path; the
 * discriminant `kind: "applied"` distinguishes apply from dry-run
 * preview. Mirrors the `applications.apply()` outcome shape (#426).
 */
export interface SpecializationApplyAppliedOutcome {
  kind: "applied";
  result: SpecializationApplyResult;
}

/**
 * Dry-run outcome for {@link apply}. Mirrors the
 * `applications.apply()` `JobApplyDryRunPreviewOutcome` (#426).
 */
export interface SpecializationApplyDryRunPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link apply}.
 */
export type SpecializationApplyOutcome = SpecializationApplyAppliedOutcome | SpecializationApplyDryRunPreviewOutcome;

// Verbatim from
// `../research/graphql/gateway/operations/portal/ApplyForSpecialization.graphql`.
// Untrusted catalog: listed in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`
// (`codegen.config.ts`), so no `ApplyForSpecializationMutation` type is
// generated — T1 (snapshot) disposition.
const APPLY_FOR_SPECIALIZATION_MUTATION = `mutation ApplyForSpecialization($specializationId: ID!) { specialization(id: $specializationId) { apply(input: {}) { success notice errors { code key message } } } }`;

interface WireSpecializationApplyError {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface WireSpecializationApplyPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: (WireSpecializationApplyError | null)[] | null;
}

interface ApplyForSpecializationResponse {
  specialization: {
    apply: WireSpecializationApplyPayload | null;
  } | null;
}

/**
 * Apply for a Toptal specialization track (Marketplace, Expert Crowd,
 * etc.) — wire `ApplyForSpecialization` (#467).
 *
 * Flow:
 *
 *   1. **Consent gate**: refuses the call (`CONSENT_REQUIRED`) BEFORE
 *      any wire call when `consent.profileCapabilityConsentIssued !==
 *      true`. The compile-time literal narrows the static type; the
 *      runtime check covers `as`-cast bypasses and JSON-sourced inputs
 *      from CLI / MCP / agents. The
 *      `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` env-var bypasses the
 *      literal check for non-interactive CI / test contexts. See
 *      ADR-009 (ttctl) § Decision Part 1.
 *   2. **Dry-run short-circuit**: when `options.dryRun === true`,
 *      emits a {@link DryRunPreview} with the prepared variables
 *      (`specializationId`) and returns `{ kind: "preview", preview }`.
 *      Zero wire calls under dry-run — including the consent gate
 *      check still fires first, so a probe with consent absent does
 *      NOT emit a preview for a call that would have been refused.
 *   3. **Input validation**: `specializationId` must be a non-empty
 *      string — `VALIDATION_ERROR` on empty.
 *   4. **Wire call**: issues `ApplyForSpecialization` against the
 *      mobile-gateway surface via `stockTransport` (same routing as
 *      {@link show} — the captured op lives under `portal/` but the
 *      gateway endpoint is the same as for mobile-side ops).
 *   5. **Error mapping**: `payload.success === false` OR
 *      `payload.errors[]` non-empty surfaces as `USER_ERROR` with the
 *      first error's `(key) message` formatted into the exception
 *      message (caller sees server-supplied detail, e.g.
 *      "Already a member of this specialization." for an
 *      already-accepted track).
 *
 * **Write-read symmetry**: the post-apply state surfaces on the next
 * `show()` call — the affected specialization's `applicationStatus`
 * transitions from a prospective state (e.g. unset / `null`) to
 * `PENDING` (or directly `ACCEPTED` when the platform short-circuits)
 * and `operations.apply.callable` transitions away from its enabled
 * marker (per `Operation.callable: String!` in the synthesized schema —
 * exact disabled value is platform-controlled). The caller can
 * cross-check by id (the echoed `specializationId` matches
 * `Specialization.id`).
 *
 * **DESTRUCTIVE — no undo via TTCtl**: there is no withdraw mutation
 * on the wire. Once the application is submitted, the specialization
 * track's compliance / training workflow takes over. Callers should
 * prefer `--dry-run` to preview the wire payload first.
 *
 * @throws `ProfileError("CONSENT_REQUIRED")` is NOT thrown directly —
 *   the cross-cutting `ConsentRequiredError` (`TtctlError` subclass)
 *   flows out of {@link ensureDestructiveConsent}. CLI / MCP error
 *   handlers cover both via the `TtctlError` branch.
 * @throws `ProfileError("VALIDATION_ERROR")` when `specializationId`
 *   is empty.
 * @throws `ProfileError("USER_ERROR")` on a `success: false` or
 *   non-empty `errors[]` payload (e.g. already-accepted track,
 *   platform compliance gate, malformed id).
 * @throws `ProfileError("UNKNOWN")` on a null/missing payload.
 * @throws `ConsentRequiredError("CONSENT_REQUIRED")` when consent is
 *   absent and the env-var bypass is not set.
 * @throws `AuthRevokedError`, `Cf403Error`, other `TtctlError`
 *   subclasses propagate verbatim.
 */
export async function apply(
  token: string,
  specializationId: string,
  consent: SpecializationApplyConsent,
  options: SpecializationApplyOptions = {},
): Promise<SpecializationApplyOutcome> {
  // Consent gate — runtime check covers `as`-cast bypasses and
  // JSON-sourced inputs from CLI/MCP. Fires BEFORE any wire call AND
  // before the dry-run short-circuit so a probe with consent absent
  // does NOT emit a preview for a call that would have been refused.
  // The widening cast is load-bearing — the static type
  // `profileCapabilityConsentIssued: true` narrows to compile-time-true,
  // which would otherwise make this check look like dead code.
  ensureDestructiveConsent(
    "ApplyForSpecialization",
    "profile-capability",
    consent as unknown as { readonly [key: string]: unknown },
  );

  if (specializationId.length === 0) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      "ApplyForSpecialization requires a non-empty specializationId. Use `profile.specializations.show()` to enumerate available tracks.",
    );
  }

  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: {
          operationName: "ApplyForSpecialization",
          query: APPLY_FOR_SPECIALIZATION_MUTATION,
          variables: { specializationId },
        },
      }),
    };
  }

  // DESTRUCTIVE — submits the talent's application to a specialization
  // track. No safe reverse-trip via TTCtl (no withdraw mutation). The
  // wire shape is captured verbatim from
  // `research/graphql/gateway/operations/portal/ApplyForSpecialization.graphql`;
  // T1 disposition (snapshot at
  // `packages/e2e/src/wire-snapshots/ApplyForSpecialization.snapshot.json`).
  // E2E coverage is gated on the destructive-positive path
  // (TTCTL_E2E_APPLY_SPECIALIZATION) per the
  // `packages/e2e/src/56-jobs-apply.e2e.test.ts` precedent.
  const data = await callGatewayShared<ApplyForSpecializationResponse, ProfileError>(
    "mobile-gateway",
    token,
    "ApplyForSpecialization",
    APPLY_FOR_SPECIALIZATION_MUTATION,
    { specializationId },
    ProfileError,
  );

  if (data.specialization === null) {
    throw new ProfileError("USER_ERROR", `ApplyForSpecialization: specialization "${specializationId}" was not found.`);
  }

  const payload = data.specialization.apply;
  if (payload === null) {
    throw new ProfileError("UNKNOWN", "ApplyForSpecialization response had no payload.");
  }

  const errors = (payload.errors ?? []).filter((e): e is WireSpecializationApplyError => e !== null);
  if (errors.length > 0) {
    const first = errors[0];
    const keyHint = first?.key !== undefined && first.key !== null && first.key !== "" ? ` (${first.key})` : "";
    throw new ProfileError(
      "USER_ERROR",
      `ApplyForSpecialization rejected${keyHint}: ${first?.message ?? "unknown error"}`,
    );
  }
  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `ApplyForSpecialization reported success=false${payload.notice !== undefined && payload.notice !== null ? `: ${payload.notice}` : ""}`,
    );
  }

  return {
    kind: "applied",
    result: {
      specializationId,
      notice: payload.notice ?? null,
    },
  };
}
