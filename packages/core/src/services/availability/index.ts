// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `availability` service module — view and manage the signed-in user's
 * platform-wide availability: time zone, working-hours window, flexible
 * shift range, and viewer-scoped allocated-hours.
 *
 * **Vocabulary note**: in the Toptal Talent portal the per-engagement
 * "time off" feature is implemented as engagement breaks (`scheduleTimeOff`
 * UI buttons fire `engagement.createBreak`). Per-engagement break
 * management is owned by `services/engagements/breaks.{list,add,remove}`
 * — this module deliberately does NOT expose a parallel "time-off"
 * surface (the underlying API would be identical to the engagement-break
 * one, so duplication would only confuse users). The "lead time"
 * concept that exists in the portal is "Minimum scheduling notice" for
 * booking pages / consultations — a different surface, out of scope here.
 *
 * | Leaf                          | Operation                                     |
 * |-------------------------------|-----------------------------------------------|
 * | `show()`                      | `GetAvailability` (read viewerRole snapshot)  |
 * | `workingHours.show()`         | `GetAvailability` (subset projection)         |
 * | `workingHours.set(input)`     | `UpdateWorkingHours`                          |
 * | `allocatedHours.show()`       | `GetAvailability` (subset projection)         |
 * | `allocatedHours.set(hours)`   | `UpdateAllocatedHours`                        |
 *
 * **Routing**: All ops talk to the **mobile-gateway** surface
 * (`https://www.toptal.com/gateway/graphql/talent/graphql`) via
 * `stockTransport`. The gateway is plain HTTPS — no Cloudflare, no TLS
 * impersonation needed. Same surface as `engagements` and
 * `applications`.
 *
 * **Operations are inlined as strings** (not codegen-driven) — same
 * pattern as `engagements` and `applications`. The
 * `UpdateAllocatedHours` mutation is used VERBATIM from
 * `../research/graphql/gateway/operations/mobile/UpdateAllocatedHours.graphql`.
 * `UpdateWorkingHours` is derived from the captured
 * `../research/graphql/gateway/operations/portal/UpdateWorkingHours.graphql`,
 * with the input shape VERIFIED against the live mobile-gateway on
 * 2026-05-11 (the captured schema documents `UpdateWorkingHoursInput
 * { _placeholder: String }` — a schema gap). The verified shape is:
 *
 *     input UpdateWorkingHoursInput {
 *       profileId: ID!                    # viewer.viewerRole.profile.id
 *       profile: WorkingHoursInput!
 *     }
 *     input WorkingHoursInput {
 *       timeZone: String
 *       workingTimeFrom: String
 *       workingTimeTo: String
 *       availableShiftRangeFrom: String
 *       availableShiftRangeTo: String
 *     }
 *
 * The `profile` sub-object's fields are all optional — the mutation
 * supports partial updates (the portal sends only the changed fields).
 * Times are formatted as `"HH:MM:SS"` strings (e.g., `"09:00:00"`);
 * time-zone values match the IANA-zone `value` field on `TimeZone`
 * (e.g., `"Europe/Berlin"`).
 *
 * **CLAUDE.md schema/contract validation rule TRIGGERED**: the
 * `UpdateWorkingHours` mutation here uses a verified-from-live-probe
 * input shape. The gated `*.e2e.test.ts` files must pass against a live
 * session before merge (see `packages/e2e/src/23-availability-write.e2e.test.ts`).
 *
 * **Out of scope for v1** (per #146 amended spec):
 *   - Time-off list/add/remove — already shipped as `engagements breaks`.
 *   - Lead-time setting — different surface (booking pages /
 *     consultations); follow-up issue.
 *   - `meetingTimeFrom` / `meetingTimeTo` — not selected by the
 *     `GetAvailability` query and not writable via the portal bundle's
 *     mutation input.
 *   - Per-engagement availability overrides — does not exist in the
 *     API.
 */

import type { z } from "zod";

import { buildDryRunPreview } from "../../transport.js";
import type { DryRunPreview } from "../../transport.js";
import { callGatewayShared } from "../_shared/transport.js";

/**
 * Availability-domain error codes. Mirrors the `EngagementsError` /
 * `ApplicationsError` shape per project convention.
 *
 * - `NO_VIEWER`: HTTP 200 + `data.viewer === null` (impossible in
 *   practice — auth-revoked is signalled differently — but kept for
 *   defensive coverage).
 * - `NO_VIEWER_ROLE`: viewer is present but `viewerRole === null`
 *   (e.g., user is signed in but has no role assigned on the platform).
 * - `GRAPHQL_ERROR`: top-level `errors[]` from the gateway, not an
 *   auth-revoked extension.
 * - `MUTATION_ERROR`: the `MutationResult.errors[]` payload (operation
 *   succeeded at GraphQL level, but the mutation itself reports
 *   per-field errors — validation failures, etc.).
 * - `NETWORK_ERROR`, `UNKNOWN`: standard transport failure modes.
 *
 * Auth-revoked failures throw `AuthRevokedError` (cross-cutting
 * `TtctlError` subclass per #77), not a code on this enum.
 */
export type AvailabilityErrorCode =
  | "NO_VIEWER"
  | "NO_VIEWER_ROLE"
  | "GRAPHQL_ERROR"
  | "MUTATION_ERROR"
  | "NETWORK_ERROR"
  | "WIRE_SHAPE_ERROR"
  | "UNKNOWN";

export class AvailabilityError extends Error {
  override readonly name = "AvailabilityError";
  constructor(
    public readonly code: AvailabilityErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Time zone projection — matches the wire `TimeZone` type. `value` is the
 * IANA zone identifier (e.g., `"Europe/Berlin"`) and the canonical input
 * for `workingHours.set({ timeZone })`. `location` and the offsets are
 * read-only metadata for human-facing rendering.
 */
export interface AvailabilityTimeZone {
  name: string | null;
  value: string;
  location: string | null;
  utcOffset: number | null;
  stdOffset: number | null;
}

/**
 * Top-level availability snapshot returned by `show()`.
 *
 * Times are `"HH:MM:SS"` strings; null when the field is unset on the
 * server. `allocatedHours` is a non-negative integer in [0, 80] per the
 * platform's UI-enforced range (`SetAvailability` validator caps at 80),
 * or null when unset.
 */
export interface AvailabilitySnapshot {
  /** Viewer id (Viewer.id from the gateway). */
  viewerId: string;
  /** Profile id (viewer.viewerRole.profile.id) — needed as the `profileId` field on `UpdateWorkingHoursInput`. Null when the viewer has a role but no bound profile (unusual but defensively handled). */
  profileId: string | null;
  /** Time zone, IANA identifier in `.value`. */
  timeZone: AvailabilityTimeZone | null;
  /** Daily working hours window start, `"HH:MM:SS"`. */
  workingTimeFrom: string | null;
  /** Daily working hours window end, `"HH:MM:SS"`. */
  workingTimeTo: string | null;
  /** Flexible shift-range start (the "I could shift to these hours if needed" window). */
  availableShiftRangeFrom: string | null;
  /** Flexible shift-range end. */
  availableShiftRangeTo: string | null;
  /** Allocated hours (viewer-scoped, integer in [0, 80]). */
  allocatedHours: number | null;
}

/**
 * Input for `workingHours.set()`. All fields optional — the mutation
 * supports partial updates. The CLI/MCP surfaces require at least one
 * field to be provided.
 */
export interface UpdateWorkingHoursInput {
  /** IANA time-zone identifier (e.g., `"Europe/Berlin"`). */
  timeZone?: string;
  /** Daily working hours window start, `"HH:MM:SS"`. */
  workingTimeFrom?: string;
  /** Daily working hours window end, `"HH:MM:SS"`. */
  workingTimeTo?: string;
  /** Flexible shift-range start, `"HH:MM:SS"`. */
  availableShiftRangeFrom?: string;
  /** Flexible shift-range end, `"HH:MM:SS"`. */
  availableShiftRangeTo?: string;
}

/**
 * Per-mutation option object for the dry-run short-circuit (issue #164,
 * mirroring the #52 / #162 / #163 reference pattern). When `dryRun ===
 * true`, the mutation builds a {@link DryRunPreview} and returns
 * `{ kind: "preview", preview }` WITHOUT invoking the gateway transport
 * — including any pre-fetch the apply path would normally issue (per the
 * AC's "no GraphQL request is sent (mock transport assertion)"
 * requirement). Default `false` — the apply path runs and a
 * `{ kind: "applied", result }` outcome is returned.
 *
 * Stand-alone interface (not a discriminated-union option) so future
 * per-mutation options (e.g. hypothetical idempotency-key parameter)
 * can extend additively. Uniform across the 2 availability mutations.
 */
export interface DryRunOptions {
  /**
   * When `true`, short-circuit before any transport call and return a
   * {@link DryRunPreview}-bearing outcome instead of executing the
   * mutation. Default: `false` — normal apply path.
   */
  dryRun?: boolean;
}

/**
 * Apply-path outcome for {@link workingHours.set}. Wraps the
 * post-mutation working-hours fields in a discriminated union so
 * callers can branch deterministically between apply
 * (`kind: "applied"`) and dry-run (`kind: "preview"`,
 * see {@link AvailabilityDryRunPreviewOutcome}).
 */
export interface WorkingHoursAppliedOutcome {
  kind: "applied";
  result: {
    timeZone: AvailabilityTimeZone | null;
    workingTimeFrom: string | null;
    workingTimeTo: string | null;
    availableShiftRangeFrom: string | null;
    availableShiftRangeTo: string | null;
    notice: string | null;
  };
}

/**
 * Dry-run outcome shared by every availability mutation. Carries a
 * {@link DryRunPreview} (operation name, surface, transport, endpoint,
 * variables payload, redacted headers) — emitted verbatim by the CLI's
 * dry-run envelope (`emitDryRunSuccess` in
 * `packages/cli/src/lib/envelopes.ts`).
 */
export interface AvailabilityDryRunPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link workingHours.set}. Pre-1.0
 * breaking change vs the pre-#164 return type (the raw result object) —
 * callers must branch on `outcome.kind` to access either
 * `outcome.result` or `outcome.preview`.
 */
export type WorkingHoursSetOutcome = WorkingHoursAppliedOutcome | AvailabilityDryRunPreviewOutcome;

/**
 * Apply-path outcome for {@link allocatedHours.set}.
 */
export interface AllocatedHoursAppliedOutcome {
  kind: "applied";
  result: {
    allocatedHours: number;
    hiredHours: number | null;
    notice: string | null;
  };
}

/**
 * Discriminated-union return type for {@link allocatedHours.set}.
 * Pre-1.0 breaking change vs the pre-#164 return type — callers must
 * branch on `outcome.kind`.
 */
export type AllocatedHoursSetOutcome = AllocatedHoursAppliedOutcome | AvailabilityDryRunPreviewOutcome;

// ---------------------------------------------------------------------
// GraphQL operation strings
//
// `GetAvailability` is a derived query selecting only the fields
// `workingHours.show()` / `allocatedHours.show()` / top-level `show()`
// need.
//
// `UpdateWorkingHours` is derived from the captured portal operation;
// the input shape was recovered from the portal bundle call-site (see
// module doc comment).
//
// `UpdateAllocatedHours` is used VERBATIM from
// `../research/graphql/gateway/operations/mobile/UpdateAllocatedHours.graphql`.
// ---------------------------------------------------------------------

const GET_AVAILABILITY_QUERY = `query GetAvailability {
  viewer {
    __typename
    id
    viewerRole {
      __typename
      allocatedHours
      timeZone { __typename name value location utcOffset stdOffset }
      workingTimeFrom
      workingTimeTo
      availableShiftRangeFrom
      availableShiftRangeTo
      profile { __typename id }
    }
  }
}`;

const UPDATE_WORKING_HOURS_MUTATION = `mutation UpdateWorkingHours($input: UpdateWorkingHoursInput!) {
  updateWorkingHours(input: $input) {
    __typename
    success
    notice
    errors { __typename code key message }
    profile {
      __typename
      id
      timeZone { __typename name value location utcOffset stdOffset }
      workingTimeFrom
      workingTimeTo
      availableShiftRangeFrom
      availableShiftRangeTo
    }
  }
}`;

// Verbatim from `../research/graphql/gateway/operations/mobile/UpdateAllocatedHours.graphql`.
const UPDATE_ALLOCATED_HOURS_MUTATION = `mutation UpdateAllocatedHours($hours: Int!) { viewerRole { __typename update(input: { allocatedHours: $hours } ) { __typename notice ...mutationResultFields viewer { __typename id ...availabilityData } } } }  fragment mutationResultFields on MutationResult { __typename errors { __typename key message code } success }  fragment lastAllocatedHoursChangeRequestData on AllocatedHoursChangeRequest { __typename id allocatedHours rejectReason comment statusV2 { __typename value } futureAvailableHours returnInDate useReturnAvailability reviewedManually }  fragment availabilityData on Viewer { __typename id preliminarySearchSetting { __typename enabled disablingReason comment } viewerRole { __typename allocatedHours hiredHours lastAllocatedHoursChangeRequest { __typename ...lastAllocatedHoursChangeRequestData } } }`;

interface MutationResultErrors {
  key?: string | null;
  message?: string | null;
  code?: string | null;
}

interface MutationResult {
  success: boolean;
  errors?: MutationResultErrors[] | null;
}

interface ViewerRoleAvailabilityFields {
  allocatedHours: number;
  timeZone: AvailabilityTimeZone | null;
  workingTimeFrom: string | null;
  workingTimeTo: string | null;
  availableShiftRangeFrom: string | null;
  availableShiftRangeTo: string | null;
  profile: { id: string } | null;
}

interface GetAvailabilityResponse {
  viewer: {
    id: string;
    viewerRole: ViewerRoleAvailabilityFields | null;
  } | null;
}

interface UpdateWorkingHoursResponse {
  updateWorkingHours:
    | (MutationResult & {
        notice?: string | null;
        profile: {
          id: string;
          timeZone: AvailabilityTimeZone | null;
          workingTimeFrom: string | null;
          workingTimeTo: string | null;
          availableShiftRangeFrom: string | null;
          availableShiftRangeTo: string | null;
        } | null;
      })
    | null;
}

interface UpdateAllocatedHoursResponse {
  viewerRole: {
    update:
      | (MutationResult & {
          notice?: string | null;
          viewer: {
            id: string;
            viewerRole: {
              allocatedHours: number;
              hiredHours?: number | null;
            } | null;
          } | null;
        })
      | null;
  } | null;
}

/**
 * Thin per-service wrapper around {@link callGatewayShared} (issue
 * #329). Pins the mobile-gateway surface and the
 * {@link AvailabilityError} domain class.
 */
async function callGateway<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return callGatewayShared<T, AvailabilityError>(
    "mobile-gateway",
    token,
    operationName,
    query,
    variables,
    AvailabilityError,
    { schema },
  );
}

function formatMutationErrors(prefix: string, errors: MutationResultErrors[] | null | undefined): string {
  if (errors == null || errors.length === 0) {
    return `${prefix}: no error detail returned.`;
  }
  const parts = errors.map((e) => {
    const fields: string[] = [];
    if (e.code != null) fields.push(`code=${e.code}`);
    if (e.key != null) fields.push(`key=${e.key}`);
    const head = fields.length > 0 ? `[${fields.join(", ")}] ` : "";
    return `${head}${e.message ?? "(no message)"}`;
  });
  return `${prefix}: ${parts.join("; ")}`;
}

/**
 * Read the signed-in user's full availability snapshot — time zone,
 * working-hours window, flexible shift range, and allocated hours.
 *
 * Throws `AvailabilityError("NO_VIEWER")` when the server returns a
 * null viewer (defensive — auth-revoked surfaces via `AuthRevokedError`
 * instead).
 *
 * Throws `AvailabilityError("NO_VIEWER_ROLE")` when the viewer exists
 * but has no role assigned (no role = no working-hours / allocated-hours
 * shape).
 */
export async function show(token: string): Promise<AvailabilitySnapshot> {
  const data = await callGateway<GetAvailabilityResponse>(token, "GetAvailability", GET_AVAILABILITY_QUERY, {});
  if (data.viewer === null) {
    throw new AvailabilityError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.viewerRole === null) {
    throw new AvailabilityError(
      "NO_VIEWER_ROLE",
      "Viewer has no role assigned — no availability data is available. (Are you signed in as a Toptal Talent?)",
    );
  }
  const role = data.viewer.viewerRole;
  return {
    viewerId: data.viewer.id,
    profileId: role.profile?.id ?? null,
    timeZone: role.timeZone,
    workingTimeFrom: role.workingTimeFrom,
    workingTimeTo: role.workingTimeTo,
    availableShiftRangeFrom: role.availableShiftRangeFrom,
    availableShiftRangeTo: role.availableShiftRangeTo,
    allocatedHours: role.allocatedHours,
  };
}

/**
 * Working-hours sub-namespace under the service. Mirrors
 * `engagements.breaks` so the public surface stays
 * `availability.workingHours.{show, set}` — matches the CLI verb path
 * `availability working-hours {show, set}`.
 */
export const workingHours = {
  /**
   * Read just the working-hours subset of the snapshot. Identical
   * underlying query to `show()`; the projection here drops
   * `allocatedHours` for callers that only care about the time-zone
   * and working-hours fields.
   */
  async show(token: string): Promise<{
    viewerId: string;
    timeZone: AvailabilityTimeZone | null;
    workingTimeFrom: string | null;
    workingTimeTo: string | null;
    availableShiftRangeFrom: string | null;
    availableShiftRangeTo: string | null;
  }> {
    const snap = await show(token);
    return {
      viewerId: snap.viewerId,
      timeZone: snap.timeZone,
      workingTimeFrom: snap.workingTimeFrom,
      workingTimeTo: snap.workingTimeTo,
      availableShiftRangeFrom: snap.availableShiftRangeFrom,
      availableShiftRangeTo: snap.availableShiftRangeTo,
    };
  },

  /**
   * Update working-hours fields. All input fields are optional — only
   * the provided keys are sent in the mutation payload, supporting
   * partial updates (per portal bundle's call-site behavior).
   *
   * Throws `AvailabilityError("MUTATION_ERROR")` when the gateway
   * returns `success: false` (validation failures, malformed time
   * strings, unknown time-zone identifiers).
   *
   * Returns the post-update working-hours shape wrapped in
   * {@link WorkingHoursAppliedOutcome}.
   *
   * Dry-run path (issue #164): when invoked with `options.dryRun ===
   * true`, builds a {@link DryRunPreview} of the mutation WITHOUT
   * invoking the gateway transport — including the `show()` pre-fetch
   * the apply path uses to resolve `profileId` (per the AC's "no
   * GraphQL request is sent" requirement). The preview's
   * `variables.input.profileId` is populated with the placeholder
   * string `"<resolved at apply time>"`; the wire SHAPE (field names,
   * operation, surface, redacted headers) is verbatim. Mirrors the
   * skipped-prefetch pattern from `engagements.breaks.add` (issue #163).
   */
  async set(
    token: string,
    input: UpdateWorkingHoursInput,
    options: DryRunOptions = {},
  ): Promise<WorkingHoursSetOutcome> {
    const profileFields: Record<string, string> = {};
    if (input.timeZone !== undefined) profileFields["timeZone"] = input.timeZone;
    if (input.workingTimeFrom !== undefined) profileFields["workingTimeFrom"] = input.workingTimeFrom;
    if (input.workingTimeTo !== undefined) profileFields["workingTimeTo"] = input.workingTimeTo;
    if (input.availableShiftRangeFrom !== undefined)
      profileFields["availableShiftRangeFrom"] = input.availableShiftRangeFrom;
    if (input.availableShiftRangeTo !== undefined) profileFields["availableShiftRangeTo"] = input.availableShiftRangeTo;

    if (Object.keys(profileFields).length === 0) {
      throw new AvailabilityError(
        "MUTATION_ERROR",
        "UpdateWorkingHours requires at least one field (timeZone, workingTimeFrom, workingTimeTo, availableShiftRangeFrom, availableShiftRangeTo).",
      );
    }

    if (options.dryRun === true) {
      // Skip the `show()` pre-fetch entirely — the AC mandates zero
      // transport calls in dry-run mode. The placeholder string stands
      // in for `profileId` so the preview's `variables.input` matches
      // the wire shape; the actual id resolves at apply time. Same
      // pattern as `engagements.breaks.add` (issue #163).
      return {
        kind: "preview",
        preview: buildDryRunPreview({
          surface: "mobile-gateway",
          authToken: token,
          body: {
            operationName: "UpdateWorkingHours",
            query: UPDATE_WORKING_HOURS_MUTATION,
            variables: { input: { profileId: "<resolved at apply time>", profile: profileFields } },
          },
        }),
      };
    }

    // The mutation's `UpdateWorkingHoursInput` requires `profileId: ID!` and
    // `profile: WorkingHoursInput!` (verified live 2026-05-11 via wire probe
    // against mobile-gateway — see `.tmp/probe-update-working-hours.mjs`).
    // Fetch the profile id from the live snapshot so callers don't have to
    // plumb it through.
    const snap = await show(token);
    if (snap.profileId === null) {
      throw new AvailabilityError(
        "NO_VIEWER_ROLE",
        "Viewer has a role but no bound profile id — cannot construct UpdateWorkingHours payload.",
      );
    }

    // #608 defense-in-depth read-merge; sibling to #604/#605/#607.
    const merged: Record<string, string> = {};
    if (snap.timeZone !== null) merged["timeZone"] = snap.timeZone.value;
    if (snap.workingTimeFrom !== null) merged["workingTimeFrom"] = snap.workingTimeFrom;
    if (snap.workingTimeTo !== null) merged["workingTimeTo"] = snap.workingTimeTo;
    if (snap.availableShiftRangeFrom !== null) merged["availableShiftRangeFrom"] = snap.availableShiftRangeFrom;
    if (snap.availableShiftRangeTo !== null) merged["availableShiftRangeTo"] = snap.availableShiftRangeTo;
    Object.assign(merged, profileFields);

    const data = await callGateway<UpdateWorkingHoursResponse>(
      token,
      "UpdateWorkingHours",
      UPDATE_WORKING_HOURS_MUTATION,
      { input: { profileId: snap.profileId, profile: merged } },
    );
    if (data.updateWorkingHours === null) {
      throw new AvailabilityError("UNKNOWN", "UpdateWorkingHours returned a null payload.");
    }
    const result = data.updateWorkingHours;
    if (!result.success) {
      throw new AvailabilityError("MUTATION_ERROR", formatMutationErrors("UpdateWorkingHours failed", result.errors));
    }
    if (result.profile === null) {
      throw new AvailabilityError("UNKNOWN", "UpdateWorkingHours returned success but the `profile` payload was null.");
    }
    return {
      kind: "applied",
      result: {
        timeZone: result.profile.timeZone,
        workingTimeFrom: result.profile.workingTimeFrom,
        workingTimeTo: result.profile.workingTimeTo,
        availableShiftRangeFrom: result.profile.availableShiftRangeFrom,
        availableShiftRangeTo: result.profile.availableShiftRangeTo,
        notice: result.notice ?? null,
      },
    };
  },
};

/**
 * Allocated-hours sub-namespace. The wire mutation
 * (`UpdateAllocatedHours`) operates on `viewerRole`, NOT on a specific
 * engagement — `allocatedHours` is global across all of the viewer's
 * active engagements. This is why the surface lives under
 * `availability` rather than under `engagements` (per #147 scope
 * amendment that absorbed it into #146).
 */
export const allocatedHours = {
  /**
   * Read just the allocated-hours value. `hiredHours` is NOT
   * surfaced here — it's only returned by `set()` (where the
   * post-update payload includes it for context).
   */
  async show(token: string): Promise<{ allocatedHours: number }> {
    const snap = await show(token);
    if (snap.allocatedHours === null) {
      throw new AvailabilityError("UNKNOWN", "Viewer role payload had no allocatedHours field.");
    }
    return { allocatedHours: snap.allocatedHours };
  },

  /**
   * Set the viewer-scoped allocated-hours value. The platform UI caps
   * this at 80 (`SetAvailability` validator); the server enforces the
   * same range — pass an out-of-range value at your own risk (the
   * mutation will return `success: false` with a validation error).
   *
   * Returns the post-update `{ allocatedHours, hiredHours, notice }`
   * triple wrapped in {@link AllocatedHoursAppliedOutcome}.
   *
   * Dry-run path (issue #164): when invoked with `options.dryRun ===
   * true`, builds a {@link DryRunPreview} of the mutation without
   * invoking the gateway transport and returns it wrapped in
   * {@link AvailabilityDryRunPreviewOutcome}. The integer-range
   * validation runs BEFORE the dry-run short-circuit — invalid input
   * still throws `AvailabilityError("MUTATION_ERROR")` rather than
   * emitting a preview that would be rejected at apply time.
   */
  async set(token: string, hours: number, options: DryRunOptions = {}): Promise<AllocatedHoursSetOutcome> {
    if (!Number.isInteger(hours) || hours < 0) {
      throw new AvailabilityError(
        "MUTATION_ERROR",
        `UpdateAllocatedHours: hours must be a non-negative integer (got ${String(hours)}).`,
      );
    }
    if (options.dryRun === true) {
      return {
        kind: "preview",
        preview: buildDryRunPreview({
          surface: "mobile-gateway",
          authToken: token,
          body: {
            operationName: "UpdateAllocatedHours",
            query: UPDATE_ALLOCATED_HOURS_MUTATION,
            variables: { hours },
          },
        }),
      };
    }
    const data = await callGateway<UpdateAllocatedHoursResponse>(
      token,
      "UpdateAllocatedHours",
      UPDATE_ALLOCATED_HOURS_MUTATION,
      { hours },
    );
    if (data.viewerRole === null) {
      throw new AvailabilityError("NO_VIEWER_ROLE", "Viewer has no role assigned.");
    }
    const result = data.viewerRole.update;
    if (result === null) {
      throw new AvailabilityError("UNKNOWN", "UpdateAllocatedHours returned a null payload.");
    }
    if (!result.success) {
      throw new AvailabilityError("MUTATION_ERROR", formatMutationErrors("UpdateAllocatedHours failed", result.errors));
    }
    if (result.viewer === null || result.viewer.viewerRole === null) {
      throw new AvailabilityError(
        "UNKNOWN",
        "UpdateAllocatedHours returned success but the post-update viewer payload was null.",
      );
    }
    return {
      kind: "applied",
      result: {
        allocatedHours: result.viewer.viewerRole.allocatedHours,
        hiredHours: result.viewer.viewerRole.hiredHours ?? null,
        notice: result.notice ?? null,
      },
    };
  },
};
