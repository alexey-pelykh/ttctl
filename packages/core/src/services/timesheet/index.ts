// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `timesheet` service module — list billing-cycle timesheets, inspect a
 * single timesheet detail, and submit one for billing.
 *
 * In Toptal vocabulary the "timesheet" is a per-billing-cycle bucket of
 * `TimesheetRecord` entries (date, duration, note). A billing cycle is
 * scoped to an engagement (= an active assignment between the talent
 * and a client). The wire entities here are:
 *
 *   - `BillingCycle.id`         — the public "timesheet id" — what
 *                                  `timesheet list` returns and what
 *                                  `timesheet show` / `submit` consume.
 *   - `JobActivityItem.id`      — the user-facing "engagement id"
 *                                  exposed by `engagements list` /
 *                                  `engagements show`. Used to scope
 *                                  `timesheet list` to one engagement.
 *
 * | Leaf                     | Operation(s)                                       |
 * |--------------------------|----------------------------------------------------|
 * | `list` (default)         | `PendingTimesheets` (viewer-wide pending)          |
 * | `list({engagement})`     | `Timesheets($jobActivityItemId)`                   |
 * | `show(id)`               | `TimesheetDetails($id)` — id is BillingCycle.id    |
 * | `submit(id)`             | `SubmitTimesheet($id)` — id is BillingCycle.id     |
 * | `resolveCurrentCycle()`  | `PendingTimesheets` + client-side window filter    |
 *
 * **Routing**: All ops talk to the **mobile-gateway** surface
 * (`https://www.toptal.com/gateway/graphql/talent/graphql`) via
 * `stockTransport`. Same surface as `engagements`, `applications`, and
 * `profile.basic.show()`. The gateway is plain HTTPS — no Cloudflare,
 * no TLS impersonation needed.
 *
 * **Operations are inlined as strings** (not codegen-driven) — same
 * pattern as `engagements` and `applications`. The captured operations
 * live in `../research/graphql/gateway/operations/mobile/`:
 *   - `PendingTimesheets.graphql`   — used verbatim
 *   - `Timesheets.graphql`          — used verbatim
 *   - `TimesheetDetails.graphql`    — used verbatim
 *   - `SubmitTimesheet.graphql`     — used verbatim
 *
 * **CLAUDE.md schema/contract validation rule**: the operations here
 * are **[INFERRED — UNVERIFIED]** until the gated `*.e2e.test.ts` files
 * pass against a live session. Although the operations were captured
 * from the APK (not pattern-inferred), the rule applies because they
 * are not in `codegen.config.ts` and the wire response shapes are
 * hand-written rather than codegen-generated. The `SubmitTimesheet`
 * mutation specifically triggers the rule's mutation clause: live E2E
 * is the only authoritative verification.
 *
 * **Submit is destructive**: the CLI surface gates submission behind a
 * `--confirm` flag and a TTY confirmation prompt; the core service
 * is callable directly and does not enforce these — callers are
 * responsible for end-user confirmation.
 *
 * **Out of scope for v1** (per #13 spec):
 *   - Editing timesheet records (`UpdateTimesheet` mutation exists but
 *     isn't surfaced; web UI handles record entry).
 *   - Uploading timesheet attachments (`UploadTimesheet` mutation).
 *   - Reminder settings (`UpdateTimesheetReminderSettings` mutation).
 *   - Per-day hour adjustments and rejection/approval workflow.
 */

import type { z } from "zod";

import { buildDryRunPreview } from "../../transport.js";
import type { DryRunPreview } from "../../transport.js";
import { callGatewayShared } from "../_shared/transport.js";

/**
 * Timesheet-domain error codes. Mirrors the `EngagementsError` /
 * `ApplicationsError` shape per project convention.
 *
 * - `NO_VIEWER`: HTTP 200 + `data.viewer === null` (defensive — should
 *   never happen with a valid token).
 * - `NOT_FOUND`: the supplied id (billing cycle or engagement) does
 *   not resolve. The wire shape can surface this either as a top-level
 *   `Record not found` GraphQL error OR as `data.node === null` /
 *   `data.viewer.jobActivityItem === null`.
 * - `NO_ENGAGEMENT`: the activity row exists but has no engagement
 *   (e.g., an interview-only row that never became an engagement). The
 *   timesheet domain can't operate on such rows.
 * - `NO_CURRENT_CYCLE`: {@link resolveCurrentCycle} returned zero
 *   matches — used by the CLI's submit auto-resolve path so callers
 *   can distinguish "nothing to submit" from "id was invalid".
 * - `MULTIPLE_CURRENT_CYCLES`: {@link resolveCurrentCycle} returned
 *   more than one match — used by the CLI's submit auto-resolve path
 *   so callers can prompt the user to disambiguate. The error carries
 *   the candidate list on `EngagementsError.cause` (not exposed via
 *   typing; callers use `resolveCurrentCycle` directly when they need
 *   structured access).
 * - `GRAPHQL_ERROR`: top-level `errors[]` from the gateway, not an
 *   auth-revoked extension and not a `Record not found`.
 * - `MUTATION_ERROR`: the `MutationResult.errors[]` payload from
 *   `SubmitTimesheet` (the wire operation succeeded at GraphQL level,
 *   but the submission itself reports per-field errors — overdue,
 *   missing required hours, etc.).
 * - `NETWORK_ERROR`, `UNKNOWN`: standard transport failure modes.
 *
 * Auth-revoked failures throw `AuthRevokedError` (cross-cutting
 * `TtctlError` subclass per #77), not a code on this enum.
 */
export type TimesheetErrorCode =
  | "NO_VIEWER"
  | "NOT_FOUND"
  | "NO_ENGAGEMENT"
  | "NO_CURRENT_CYCLE"
  | "MULTIPLE_CURRENT_CYCLES"
  | "GRAPHQL_ERROR"
  | "MUTATION_ERROR"
  | "NETWORK_ERROR"
  | "WIRE_SHAPE_ERROR"
  | "UNKNOWN";

export class TimesheetError extends Error {
  override readonly name = "TimesheetError";
  constructor(
    public readonly code: TimesheetErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Minimum-commitment payload mirrored from the captured
 * `minimumCommitmentData` fragment. When `applicable === false`, the
 * server explains via `reasonNotApplicable`.
 */
export interface TimesheetMinimumCommitment {
  applicable: boolean;
  minimumHours: number | null;
  reasonNotApplicable: string | null;
}

/**
 * Reference to the engagement+job a billing cycle belongs to. The id
 * carried here is the underlying `TalentEngagement.id`, NOT the
 * `JobActivityItem.id` exposed by `engagements list`. Callers that
 * need to cross-reference back to the engagements row should use
 * `engagements list` and match on `engagementId`.
 */
export interface TimesheetEngagementRef {
  id: string;
  job: {
    id: string;
    title: string | null;
    client: { id: string; fullName: string | null } | null;
  };
}

/**
 * One row in the timesheet list — surfaced by `timesheet list`. Wire
 * type for `hours` is a string (e.g., `"8.0"`) — preserved as-is so
 * the CLI can render it verbatim without decimal-precision surprises.
 *
 * `timesheetSubmissionOpenDatetime` / `timesheetSubmissionDeadlineDatetime`
 * carry the wire ISO-8601 datetime strings. The CLI may render only
 * the date portion in pretty output.
 */
export interface TimesheetListItem {
  /** BillingCycle.id — the public timesheet id. */
  id: string;
  startDate: string;
  endDate: string;
  hours: string;
  minimumCommitment: TimesheetMinimumCommitment | null;
  timesheetOverdue: boolean;
  timesheetSubmissionOpenDatetime: string | null;
  timesheetSubmissionDeadlineDatetime: string | null;
  timesheetSubmitted: boolean;
  engagement: TimesheetEngagementRef;
}

/**
 * One time-entry within a timesheet (per-day duration). `duration` is
 * the canonical wire field — a **string-encoded decimal** in **minutes**
 * (e.g., `"480.0"` for an 8-hour day, `"0.0"` for a zero-hour day).
 * `note` may be empty/null; `isDayOff === true` rows represent a marked
 * day off and typically carry `duration === "0.0"`.
 *
 * **Wire-shape history**: this field was declared as `duration: number`
 * (presumed seconds) until 2026-05-14. The live mobile-gateway returns
 * a string-encoded minutes value, empirically captured during the first
 * end-to-end `SubmitTimesheet` mutation run. The previous declaration
 * caused `ttctl timesheet show` to render an 8-hour day as `0.13h`
 * (because `"480.0" / 3600 ≈ 0.133`). See
 * `.tmp/timesheet-submit-e2e-20260514/{01-before-show,03-submit}.json`
 * for the originating capture.
 */
export interface TimesheetRecord {
  date: string;
  duration: string;
  note: string | null;
  isDayOff: boolean;
}

/**
 * Detail-view shape for `timesheet show <id>`. Extends
 * {@link TimesheetListItem} with the timesheet records, the comment,
 * the rate-card snapshot, and the points-of-contact projection from
 * the engagement.
 *
 * Field selection mirrors the captured `timesheetDetailsFields`
 * fragment.
 */
export interface TimesheetDetail extends TimesheetListItem {
  timesheetUrl: string | null;
  timesheetComment: string | null;
  timesheetRecords: TimesheetRecord[];
  actualAgreement: {
    applicationRate: string | null;
    talentHourlyRate: string | null;
    marketplaceMargin: string | null;
  } | null;
  engagement: TimesheetEngagementRef & {
    expectedHours: number | null;
  };
}

/**
 * Optional list filter.
 */
export interface ListOptions {
  /**
   * When set, scope the listing to the given engagement (the
   * `JobActivityItem.id` from `engagements list`, NOT the underlying
   * `TalentEngagement.id`). Switches the wire query from
   * `PendingTimesheets` (viewer-wide pending-only) to
   * `Timesheets(jobActivityItemId)` (all cycles for that engagement,
   * regardless of submission state).
   */
  engagement?: string;
}

/**
 * Result of {@link resolveCurrentCycle}.
 *
 * - `kind: "found"` — exactly one cycle's submission window contains
 *   "today" AND it's not yet submitted. Submit by `cycle.id`.
 * - `kind: "none"` — zero cycles match. Either the user is too early
 *   (before the next cycle's `submissionOpenDatetime`) or too late
 *   (after the deadline of every pending cycle).
 * - `kind: "multiple"` — more than one cycle matches. The CLI prompts
 *   the user to disambiguate by explicit id.
 */
export type CurrentCycleResolution =
  | { kind: "found"; cycle: TimesheetListItem }
  | { kind: "none" }
  | { kind: "multiple"; candidates: TimesheetListItem[] };

/**
 * Per-mutation option object for the dry-run short-circuit. Mirrors
 * `engagements.DryRunOptions` (issue #163) and the CLI-global
 * `--dry-run` flag (#52). When `dryRun === true`, {@link submit}
 * builds a {@link DryRunPreview} and returns `{ kind: "preview",
 * preview }` WITHOUT invoking the gateway transport. Default `false`
 * — the apply path runs and a `{ kind: "applied", result }` outcome
 * is returned.
 *
 * **`submit` specifics**: the apply path takes `id: string`
 * (BillingCycle.id) and submits unconditionally. The dry-run path
 * builds the preview directly off the supplied id. When the CLI
 * runner is in auto-resolve mode (no positional id, dry-run engaged),
 * it stamps a literal placeholder string (e.g.
 * `<auto-resolved-at-apply-time>`) into `id` so the preview's
 * `variables.id` is well-named and clearly NOT a real cycle id; the
 * apply path resolves the real id via
 * {@link resolveCurrentCycle} before submitting.
 */
export interface DryRunOptions {
  dryRun?: boolean;
}

/**
 * Apply-path outcome for {@link submit}. Wraps the
 * post-submission {@link TimesheetDetail} in a discriminated union so
 * callers can branch deterministically between the apply path
 * (`kind: "applied"`) and the dry-run path
 * (`kind: "preview"`, see {@link TimesheetDryRunPreviewOutcome}).
 */
export interface TimesheetSubmitAppliedOutcome {
  kind: "applied";
  result: TimesheetDetail;
}

/**
 * Dry-run outcome for {@link submit}. Carries the
 * {@link DryRunPreview} (operation name, surface, transport,
 * endpoint, variables payload, redacted bearer header) — emitted
 * verbatim by the CLI's dry-run envelope (`emitDryRunSuccess`).
 */
export interface TimesheetDryRunPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link submit}.
 */
export type SubmitOutcome = TimesheetSubmitAppliedOutcome | TimesheetDryRunPreviewOutcome;

/**
 * Optional inputs for {@link resolveCurrentCycle}.
 */
export interface ResolveCurrentCycleOptions {
  /**
   * Same semantic as {@link ListOptions.engagement}: scope the
   * resolve to one engagement. When set, the helper switches its
   * underlying query from `PendingTimesheets` to
   * `Timesheets(jobActivityItemId)` and filters to
   * `timesheetSubmitted === false` client-side.
   */
  engagement?: string;
  /**
   * Override "now" for deterministic tests. Defaults to
   * `new Date()` at call time.
   */
  now?: Date;
}

// ---------------------------------------------------------------------

// Verbatim from `../research/graphql/gateway/operations/mobile/PendingTimesheets.graphql`.
const PENDING_TIMESHEETS_QUERY = `query PendingTimesheets { viewer { __typename id ...pendingTimesheets } }  fragment minimumCommitmentData on MinimumCommitment { __typename applicable minimumHours reasonNotApplicable }  fragment timesheetListFields on BillingCycle { __typename id startDate endDate hours minimumCommitment { __typename ...minimumCommitmentData } timesheetOverdue timesheetSubmissionOpenDatetime timesheetSubmissionDeadlineDatetime timesheetSubmitted engagement { __typename id job { __typename id client { __typename id fullName } title } } }  fragment pendingTimesheets on Viewer { __typename billingCycles(filters: { pendingTimesheetOnly: true } , pagination: { limit: 50 } ) { __typename nodes { __typename ...timesheetListFields } } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/Timesheets.graphql`.
const TIMESHEETS_QUERY = `query Timesheets($jobActivityItemId: ID!) { viewer { __typename id jobActivityItem(id: $jobActivityItemId) { __typename id engagement { __typename id billingCycles(filters: { onlyTimesheets: true } ) { __typename ids nodes { __typename ...timesheetListFields } } } } } }  fragment minimumCommitmentData on MinimumCommitment { __typename applicable minimumHours reasonNotApplicable }  fragment timesheetListFields on BillingCycle { __typename id startDate endDate hours minimumCommitment { __typename ...minimumCommitmentData } timesheetOverdue timesheetSubmissionOpenDatetime timesheetSubmissionDeadlineDatetime timesheetSubmitted engagement { __typename id job { __typename id client { __typename id fullName } title } } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/TimesheetDetails.graphql`.
const TIMESHEET_DETAILS_QUERY = `query TimesheetDetails($id: ID!) { node(id: $id) { __typename ...timesheetDetailsFields } }  fragment minimumCommitmentData on MinimumCommitment { __typename applicable minimumHours reasonNotApplicable }  fragment timesheetListFields on BillingCycle { __typename id startDate endDate hours minimumCommitment { __typename ...minimumCommitmentData } timesheetOverdue timesheetSubmissionOpenDatetime timesheetSubmissionDeadlineDatetime timesheetSubmitted engagement { __typename id job { __typename id client { __typename id fullName } title } } }  fragment contactFieldsData on ContactFields { __typename communitySlackId email phoneNumber skype }  fragment timeZoneFields on TimeZone { __typename location value }  fragment recruiterData on Recruiter { __typename id fullName contactFields { __typename ...contactFieldsData } photo { __typename small } vacation { __typename id startDate endDate } timeZone { __typename ...timeZoneFields } }  fragment pointOfContactData on PointsOfContact { __typename current { __typename ...recruiterData } handoff { __typename ...recruiterData } kind }  fragment deliveryModelData on TalentEngagementDeliveryModel { __typename id identifier }  fragment timesheetDetailsFields on BillingCycle { __typename ...timesheetListFields timesheetUrl actualAgreement { __typename applicationRate talentHourlyRate marketplaceMargin } engagement { __typename id expectedHours job { __typename id pointsOfContact { __typename ...pointOfContactData } engagementDeliveryModel { __typename ...deliveryModelData } } } timesheetComment timesheetRecords { __typename date duration isDayOff note } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/SubmitTimesheet.graphql`.
const SUBMIT_TIMESHEET_MUTATION = `mutation SubmitTimesheet($id: ID!) { submitTimesheet(billingCycleId: $id) { __typename billingCycle { __typename ...timesheetDetailsFields } ...mutationResultFields } }  fragment minimumCommitmentData on MinimumCommitment { __typename applicable minimumHours reasonNotApplicable }  fragment timesheetListFields on BillingCycle { __typename id startDate endDate hours minimumCommitment { __typename ...minimumCommitmentData } timesheetOverdue timesheetSubmissionOpenDatetime timesheetSubmissionDeadlineDatetime timesheetSubmitted engagement { __typename id job { __typename id client { __typename id fullName } title } } }  fragment contactFieldsData on ContactFields { __typename communitySlackId email phoneNumber skype }  fragment timeZoneFields on TimeZone { __typename location value }  fragment recruiterData on Recruiter { __typename id fullName contactFields { __typename ...contactFieldsData } photo { __typename small } vacation { __typename id startDate endDate } timeZone { __typename ...timeZoneFields } }  fragment pointOfContactData on PointsOfContact { __typename current { __typename ...recruiterData } handoff { __typename ...recruiterData } kind }  fragment deliveryModelData on TalentEngagementDeliveryModel { __typename id identifier }  fragment timesheetDetailsFields on BillingCycle { __typename ...timesheetListFields timesheetUrl actualAgreement { __typename applicationRate talentHourlyRate marketplaceMargin } engagement { __typename id expectedHours job { __typename id pointsOfContact { __typename ...pointOfContactData } engagementDeliveryModel { __typename ...deliveryModelData } } } timesheetComment timesheetRecords { __typename date duration isDayOff note } }  fragment mutationResultFields on MutationResult { __typename errors { __typename key message code } success }`;

// ---------------------------------------------------------------------

interface MutationResultErrors {
  key?: string | null;
  message?: string | null;
  code?: string | null;
}

interface MutationResult {
  success: boolean;
  errors?: MutationResultErrors[] | null;
}

interface PendingTimesheetsResponse {
  viewer: {
    id: string;
    billingCycles: {
      nodes: TimesheetListWireItem[] | null;
    } | null;
  } | null;
}

interface TimesheetsResponse {
  viewer: {
    id: string;
    jobActivityItem: {
      id: string;
      engagement: {
        id: string;
        billingCycles: {
          ids: string[] | null;
          nodes: TimesheetListWireItem[] | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

interface TimesheetDetailsResponse {
  node: TimesheetDetailWireItem | null;
}

interface SubmitTimesheetResponse {
  submitTimesheet:
    | (MutationResult & {
        billingCycle: TimesheetDetailWireItem | null;
      })
    | null;
}

/**
 * Wire shape from the `timesheetListFields` fragment.
 */
interface TimesheetListWireItem {
  id: string;
  startDate: string;
  endDate: string;
  hours: string;
  minimumCommitment: TimesheetMinimumCommitment | null;
  timesheetOverdue: boolean;
  timesheetSubmissionOpenDatetime: string | null;
  timesheetSubmissionDeadlineDatetime: string | null;
  timesheetSubmitted: boolean;
  engagement: {
    id: string;
    job: {
      id: string;
      title: string | null;
      client: { id: string; fullName: string | null } | null;
    };
  };
}

/**
 * Wire shape from the `timesheetDetailsFields` fragment — list fields
 * plus the detail extension (records, comment, agreement, expanded
 * engagement.job).
 */
interface TimesheetDetailWireItem extends TimesheetListWireItem {
  timesheetUrl: string | null;
  timesheetComment: string | null;
  timesheetRecords: TimesheetRecord[] | null;
  actualAgreement: {
    applicationRate: string | null;
    talentHourlyRate: string | null;
    marketplaceMargin: string | null;
  } | null;
  engagement: TimesheetListWireItem["engagement"] & {
    expectedHours: number | null;
  };
}

/**
 * Server-side GraphQL error messages that signal "the supplied id does
 * not resolve to a known node" — remapped from `GRAPHQL_ERROR` to the
 * domain-typed `NOT_FOUND` for UX clarity.
 *
 * Empirically observed (E2E 2026-05-12, `TimesheetDetails`, mobile-gateway):
 *
 *   "Node id 'VjEtTm9uZXhpc3RlbnQtMA' resolves to an unknown type
 *    Nonexistent. Please check if there is no typo and schemas are up
 *    to date."
 *
 * This is the Relay-style global-id decode error — Toptal's gateway
 * decodes `<Type>-<localId>` and rejects when the type prefix isn't a
 * known schema node. Match the stable phrase `Node id ... resolves to
 * an unknown type` (typo-tolerant via `.*?`); the historical
 * `Record not found` literal is kept for defense-in-depth against an
 * older message variant.
 */
const NOT_FOUND_MESSAGE_PATTERN = /Record not found|Node id .*? resolves to an unknown type/i;

/**
 * Thin per-service wrapper around {@link callGatewayShared} (issue
 * #329). Pins the mobile-gateway surface and the {@link TimesheetError}
 * domain class.
 */
async function callGateway<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return callGatewayShared<T, TimesheetError>(
    "mobile-gateway",
    token,
    operationName,
    query,
    variables,
    TimesheetError,
    { schema },
  );
}

/**
 * Project a `TimesheetListWireItem` into the public list shape. Pure
 * shape mirror — present so the list and resolve paths share a single
 * mapper.
 */
function projectListItem(wire: TimesheetListWireItem): TimesheetListItem {
  return {
    id: wire.id,
    startDate: wire.startDate,
    endDate: wire.endDate,
    hours: wire.hours,
    minimumCommitment: wire.minimumCommitment,
    timesheetOverdue: wire.timesheetOverdue,
    timesheetSubmissionOpenDatetime: wire.timesheetSubmissionOpenDatetime,
    timesheetSubmissionDeadlineDatetime: wire.timesheetSubmissionDeadlineDatetime,
    timesheetSubmitted: wire.timesheetSubmitted,
    engagement: wire.engagement,
  };
}

function projectDetailItem(wire: TimesheetDetailWireItem): TimesheetDetail {
  return {
    ...projectListItem(wire),
    timesheetUrl: wire.timesheetUrl,
    timesheetComment: wire.timesheetComment,
    timesheetRecords: wire.timesheetRecords ?? [],
    actualAgreement: wire.actualAgreement,
    engagement: {
      ...wire.engagement,
      expectedHours: wire.engagement.expectedHours,
    },
  };
}

/**
 * List the signed-in user's timesheet billing cycles.
 *
 * Default (no `engagement` option): uses `PendingTimesheets` to fetch
 * viewer-wide cycles that still need submission. This is the
 * "what needs my attention" view.
 *
 * With `engagement` option: uses `Timesheets($jobActivityItemId)` to
 * fetch ALL cycles for that engagement (regardless of submission
 * state). The argument is the public `JobActivityItem.id` exposed by
 * `engagements list`.
 *
 * The returned array preserves server order; the CLI / MCP do not
 * re-sort.
 */
export async function list(token: string, opts: ListOptions = {}): Promise<TimesheetListItem[]> {
  if (opts.engagement === undefined) {
    const data = await callGateway<PendingTimesheetsResponse>(token, "PendingTimesheets", PENDING_TIMESHEETS_QUERY, {});
    if (data.viewer === null) {
      throw new TimesheetError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
    }
    return (data.viewer.billingCycles?.nodes ?? []).map(projectListItem);
  }

  let data: TimesheetsResponse;
  try {
    data = await callGateway<TimesheetsResponse>(token, "Timesheets", TIMESHEETS_QUERY, {
      jobActivityItemId: opts.engagement,
    });
  } catch (err) {
    if (err instanceof TimesheetError && err.code === "GRAPHQL_ERROR" && NOT_FOUND_MESSAGE_PATTERN.test(err.message)) {
      throw new TimesheetError(
        "NOT_FOUND",
        `No engagement found with id "${opts.engagement}" (or you don't have access to it).`,
        { cause: err },
      );
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new TimesheetError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.jobActivityItem === null) {
    throw new TimesheetError(
      "NOT_FOUND",
      `No engagement found with id "${opts.engagement}" (or you don't have access to it).`,
    );
  }
  if (data.viewer.jobActivityItem.engagement === null) {
    throw new TimesheetError(
      "NO_ENGAGEMENT",
      `Activity item "${opts.engagement}" exists but has no engagement (likely an application or interview).`,
    );
  }
  return (data.viewer.jobActivityItem.engagement.billingCycles?.nodes ?? []).map(projectListItem);
}

/**
 * Fetch a single timesheet's detail by `BillingCycle.id`.
 *
 * Uses the gateway's `node(id)` polymorphic root with the captured
 * `timesheetDetailsFields` fragment. Throws
 * `TimesheetError("NOT_FOUND")` when the id doesn't resolve (matches
 * both the `Record not found` GraphQL error path AND the data-shape
 * sentinel `data.node === null`).
 *
 * Throws `TimesheetError("UNKNOWN")` if the node resolves but isn't a
 * `BillingCycle` — that would be a wire surprise (a different `node`
 * type carrying our fragment) and warrants surfacing rather than
 * silent type-coercion.
 */
export async function show(token: string, id: string): Promise<TimesheetDetail> {
  let data: TimesheetDetailsResponse;
  try {
    data = await callGateway<TimesheetDetailsResponse>(token, "TimesheetDetails", TIMESHEET_DETAILS_QUERY, { id });
  } catch (err) {
    if (err instanceof TimesheetError && err.code === "GRAPHQL_ERROR" && NOT_FOUND_MESSAGE_PATTERN.test(err.message)) {
      throw new TimesheetError("NOT_FOUND", `No timesheet found with id "${id}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.node === null) {
    throw new TimesheetError("NOT_FOUND", `No timesheet found with id "${id}" (or you don't have access to it).`);
  }
  return projectDetailItem(data.node);
}

/**
 * Resolve the "current" pending timesheet — the billing cycle whose
 * submission window contains `now` AND which is not yet submitted.
 *
 * - `kind: "found"`: exactly one cycle matches.
 * - `kind: "none"`: zero cycles match (too early before next window,
 *   too late after every cycle's deadline, or no engagements have
 *   timesheets enabled).
 * - `kind: "multiple"`: more than one cycle matches (parallel
 *   engagements with overlapping current windows).
 *
 * When `opts.engagement` is provided, the resolution scopes to that
 * engagement (uses `Timesheets($jobActivityItemId)` + client-side
 * filter to `timesheetSubmitted === false`). Otherwise uses
 * `PendingTimesheets` (server-side filtered).
 *
 * The `now` option exists for deterministic testing; production code
 * paths pass nothing and the helper uses `new Date()`.
 */
export async function resolveCurrentCycle(
  token: string,
  opts: ResolveCurrentCycleOptions = {},
): Promise<CurrentCycleResolution> {
  const now = opts.now ?? new Date();
  const candidates = await listPending(token, opts.engagement);

  const inWindow = candidates.filter((c) => isInSubmissionWindow(c, now));
  if (inWindow.length === 0) return { kind: "none" };
  if (inWindow.length === 1) {
    const cycle = inWindow[0];
    if (cycle === undefined) return { kind: "none" };
    return { kind: "found", cycle };
  }
  return { kind: "multiple", candidates: inWindow };
}

/**
 * Internal: return the pending (`timesheetSubmitted === false`) cycles
 * — viewer-wide if no engagement scope, scoped + client-filtered if
 * scoped. Shared between {@link resolveCurrentCycle} and any future
 * callers wanting the same pre-filtered list.
 */
async function listPending(token: string, engagement: string | undefined): Promise<TimesheetListItem[]> {
  if (engagement === undefined) {
    return list(token);
  }
  const all = await list(token, { engagement });
  return all.filter((c) => !c.timesheetSubmitted);
}

/**
 * Returns `true` when `now` falls within the cycle's submission window
 * AND the cycle is not yet submitted.
 *
 * Submission window is `[timesheetSubmissionOpenDatetime,
 * timesheetSubmissionDeadlineDatetime]` (inclusive). Cycles missing
 * either bound are excluded — defensive: if the server hasn't decided
 * when the window opens/closes, "now" is unambiguously not inside.
 */
function isInSubmissionWindow(cycle: TimesheetListItem, now: Date): boolean {
  if (cycle.timesheetSubmitted) return false;
  if (cycle.timesheetSubmissionOpenDatetime === null) return false;
  if (cycle.timesheetSubmissionDeadlineDatetime === null) return false;
  const open = Date.parse(cycle.timesheetSubmissionOpenDatetime);
  const deadline = Date.parse(cycle.timesheetSubmissionDeadlineDatetime);
  if (Number.isNaN(open) || Number.isNaN(deadline)) return false;
  const t = now.getTime();
  return t >= open && t <= deadline;
}

/**
 * Submit a timesheet for billing.
 *
 * **Destructive**: the submission is one-way at the wire level — once
 * submitted, the timesheet enters Toptal's billing pipeline. Callers
 * (CLI / MCP) are responsible for end-user confirmation.
 *
 * `id` is the BillingCycle.id from `list()` / `show()`. Returns the
 * post-submission detail payload (with `timesheetSubmitted: true`)
 * wrapped in `{ kind: "applied", result }` on the apply path.
 *
 * Dry-run path (`options.dryRun === true`): builds a
 * {@link DryRunPreview} of the mutation WITHOUT invoking the
 * gateway transport. Returns `{ kind: "preview", preview }`. The
 * CLI's `--dry-run` flag flows through here so the destructive
 * mutation is never sent in preview mode. See {@link DryRunOptions}
 * for the placeholder-id semantics when the CLI is in auto-resolve
 * mode.
 *
 * Throws (apply path only — dry-run never throws domain errors):
 * - `TimesheetError("NOT_FOUND")` when the id doesn't resolve to a
 *   billing cycle the viewer can submit AND the server is willing to
 *   communicate that as a structured error (Relay-style global-id
 *   decode failure, matched via {@link NOT_FOUND_MESSAGE_PATTERN}).
 * - `TimesheetError("GRAPHQL_ERROR")` when the server returns a
 *   top-level GraphQL error other than the Relay decode pattern.
 *   Empirically (E2E 2026-05-12), Toptal's `SubmitTimesheet` returns
 *   `"500: Internal Server Error"` for syntactically valid but
 *   non-existent BillingCycle ids — the wire does not pre-validate the
 *   id, so the 500 surfaces verbatim. The CLI presents it as
 *   `GRAPHQL_ERROR` (not `NOT_FOUND`) to avoid misleading the caller
 *   into thinking the id was definitively absent vs. the server
 *   genuinely failed.
 * - `TimesheetError("MUTATION_ERROR")` when the server reports
 *   `success: false` on `MutationResult` (commonly: missing required
 *   hours, already submitted, deadline passed). The message carries
 *   the server-side error code+key+message tuples.
 */
export async function submit(token: string, id: string, options: DryRunOptions = {}): Promise<SubmitOutcome> {
  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: {
          operationName: "SubmitTimesheet",
          query: SUBMIT_TIMESHEET_MUTATION,
          variables: { id },
        },
      }),
    };
  }
  let data: SubmitTimesheetResponse;
  try {
    data = await callGateway<SubmitTimesheetResponse>(token, "SubmitTimesheet", SUBMIT_TIMESHEET_MUTATION, { id });
  } catch (err) {
    // Remap Relay-style id-decode failures from GRAPHQL_ERROR to NOT_FOUND
    // for consistent UX with `show()` and the engagement-scoped `list()`.
    // The 500-on-bad-id case (no decode error, just a server crash) flows
    // through verbatim as GRAPHQL_ERROR — see function docstring.
    if (err instanceof TimesheetError && err.code === "GRAPHQL_ERROR" && NOT_FOUND_MESSAGE_PATTERN.test(err.message)) {
      throw new TimesheetError(
        "NOT_FOUND",
        `No timesheet found with id "${id}" (or you don't have access to submit it).`,
        {
          cause: err,
        },
      );
    }
    throw err;
  }
  const payload = data.submitTimesheet;
  if (payload === null) {
    throw new TimesheetError(
      "NOT_FOUND",
      `No timesheet found with id "${id}" (or you don't have access to submit it).`,
    );
  }
  if (!payload.success) {
    throw new TimesheetError("MUTATION_ERROR", formatMutationErrors("SubmitTimesheet rejected", payload.errors));
  }
  if (payload.billingCycle === null) {
    throw new TimesheetError(
      "UNKNOWN",
      "SubmitTimesheet succeeded but the server returned no updated billingCycle payload.",
    );
  }
  return { kind: "applied", result: projectDetailItem(payload.billingCycle) };
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
