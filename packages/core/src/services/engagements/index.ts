// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `engagements` service module — view current and past engagements,
 * inspect engagement detail, and manage engagement breaks.
 *
 * In Toptal vocabulary, an "Engagement" is an active assignment between
 * a talent and a client (= what users colloquially call "current job"
 * or "current contract"). The platform exposes engagements through the
 * `TalentJobActivityItem` join (same surface as `applications` service),
 * but filtered to the engagement-bearing status groups.
 *
 * | Leaf                      | Operation(s)                                          |
 * |---------------------------|-------------------------------------------------------|
 * | `list`                    | `JobActivityItems(statusGroupV2: ENGAGED-set)`        |
 * | `show`                    | `JobActivityItem(id)` with extended engagement projection |
 * | `stats`                   | `JobActivityItems(statusGroup)` × 2 (one per engaged group) |
 * | `breaks.list`             | `EngagementBreaks(jobActivityItemId)`                 |
 * | `breaks.add`              | `CreateEngagementBreak(engagementId, ...)`            |
 * | `breaks.remove`           | `CancelEngagementBreak(engagementBreakId)`            |
 * | `breaks.reschedule`       | `RescheduleEngagementBreak(engagementBreakId, ...)`   |
 *
 * **Routing**: All ops talk to the **mobile-gateway** surface
 * (`https://www.toptal.com/gateway/graphql/talent/graphql`) via
 * `stockTransport`. The gateway is plain HTTPS — no Cloudflare, no TLS
 * impersonation needed. Same surface as `applications` and
 * `profile.basic.show()`.
 *
 * **Operations are inlined as strings** (not codegen-driven) — same
 * pattern as `applications` and `profile.skills` mutations. The
 * captured operations live in
 * `../research/graphql/gateway/operations/mobile/`:
 *   - `EngagementBreaks.graphql` — used verbatim
 *   - `CreateEngagementBreak.graphql` — used verbatim
 *   - `CancelEngagementBreak.graphql` — used verbatim
 *   - `RescheduleEngagementBreak.graphql` — used verbatim (#155)
 *   - `JobActivityItems.graphql` — derived (extended engagement projection)
 *   - `JobActivityItem.graphql` — derived (extended engagement projection)
 *
 * **CLAUDE.md schema/contract validation rule**: the operations here
 * are **[INFERRED — UNVERIFIED]** until the gated `*.e2e.test.ts` files
 * pass against a live session. Engagement break mutations
 * (`CreateEngagementBreak`, `CancelEngagementBreak`,
 * `RescheduleEngagementBreak`) trigger the rule specifically —
 * pre-merge requirement is the live E2E run, not the unit tests.
 *
 * **Engagement-id semantics**: there are TWO IDs in this domain:
 *   - `jobActivityItem.id` — the row id from `engagements list`
 *   - `engagement.id` — the underlying TalentEngagement id (mutation root
 *     for `engagement(id).createBreak`)
 *
 * The CLI/MCP surface uses `jobActivityItem.id` as the public engagement
 * id (consistent with the `engagements list` output). Internal
 * translation to `engagement.id` happens via {@link breaks.add} which
 * does a one-shot `EngagementBreaks` query first to fetch the
 * `engagement.id`, then issues the `CreateEngagementBreak` mutation.
 * Add costs one extra round-trip; remove takes the
 * `engagementBreak.id` directly (no translation needed).
 *
 * **Allocated-hours scope absorbed by `availability` (#146)**: per the
 * #147 scope amendment (2026-05-10), `UpdateAllocatedHours` (a
 * viewer-level mutation operating on `viewerRole.allocatedHours`)
 * belongs in the availability domain, not engagements. This service
 * does NOT expose allocated-hours management.
 *
 * **Out of scope for v1**:
 *   - Engagement creation / acceptance / rejection (lives in
 *     `applications` group as part of the activity-item lifecycle).
 *   - Engagement payments / earnings detail (would require
 *     `GetEngagementPayments` from the portal surface, which is
 *     Cloudflare-protected — separate work).
 *   - Engagement testimonial (`CREATE_ENGAGEMENT_TESTIMONIAL` —
 *     follow-up).
 */

import type { z } from "zod";

import { buildDryRunPreview } from "../../transport.js";
import type { DryRunPreview } from "../../transport.js";
import { callGatewayShared } from "../_shared/transport.js";

/**
 * Engagements-domain error codes. Mirrors the `ApplicationsError` /
 * `ProfileError` shape per project convention.
 *
 * - `NO_VIEWER`: HTTP 200 + `data.viewer === null` (impossible in
 *   practice — auth-revoked is signalled differently — but kept for
 *   defensive coverage).
 * - `NOT_FOUND`: caller's id doesn't resolve to a viewable engagement.
 *   Distinct wire shapes both fold into this code (top-level
 *   `Record not found` GraphQL error AND `data.viewer.jobActivityItem
 *   === null`).
 * - `NO_ENGAGEMENT`: the activity row exists but has no engagement
 *   (e.g., the row is an interview that never became an engagement).
 *   Specific to `breaks.list` / `breaks.add` which require an
 *   engagement-bearing row.
 * - `GRAPHQL_ERROR`: top-level `errors[]` from the gateway, not an
 *   auth-revoked extension and not a `Record not found`.
 * - `MUTATION_ERROR`: the `MutationResult.errors[]` payload (operation
 *   succeeded at GraphQL level, but the mutation itself reports
 *   per-field errors — break date overlaps, validation failures).
 * - `NETWORK_ERROR`, `UNKNOWN`: standard transport failure modes.
 *
 * Auth-revoked failures throw `AuthRevokedError` (cross-cutting
 * `TtctlError` subclass per #77), not a code on this enum.
 */
export type EngagementsErrorCode =
  | "NO_VIEWER"
  | "NOT_FOUND"
  | "NO_ENGAGEMENT"
  | "GRAPHQL_ERROR"
  | "MUTATION_ERROR"
  | "NETWORK_ERROR"
  | "WIRE_SHAPE_ERROR"
  | "UNKNOWN";

export class EngagementsError extends Error {
  override readonly name = "EngagementsError";
  constructor(
    public readonly code: EngagementsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Engagement-bearing status groups in `JobActivityItemStatusGroupEnum`.
 * Used both by `list` (default filter) and `stats` (per-group counts).
 *
 * Note: `ARCHIVED` is intentionally NOT included — that group includes
 * archived non-engagement items too (archived applications, archived
 * interviews). Users wanting an archived engagement view should use
 * `applications list --status-group ARCHIVED` and filter further.
 */
export const ENGAGEMENT_STATUS_GROUPS = ["ACTIVE_ENGAGEMENT", "CLOSED_ENGAGEMENT"] as const;
export type EngagementStatusGroup = (typeof ENGAGEMENT_STATUS_GROUPS)[number];

/**
 * Public `--status` filter values for `list`. Maps to one or both
 * {@link ENGAGEMENT_STATUS_GROUPS} entries.
 */
export const ENGAGEMENT_LIST_STATUSES = ["active", "past", "all"] as const;
export type EngagementListStatus = (typeof ENGAGEMENT_LIST_STATUSES)[number];

function listStatusToGroups(status: EngagementListStatus): EngagementStatusGroup[] {
  switch (status) {
    case "active":
      return ["ACTIVE_ENGAGEMENT"];
    case "past":
      return ["CLOSED_ENGAGEMENT"];
    case "all":
      return ["ACTIVE_ENGAGEMENT", "CLOSED_ENGAGEMENT"];
  }
}

/**
 * Status payload — both `statusV2` (specific) and `statusGroupV2`
 * (coarse, one of {@link ENGAGEMENT_STATUS_GROUPS}) carry the same shape
 * on the wire.
 */
export interface EngagementStatus {
  value: string;
  verbose: string;
}

/**
 * Reference to the job an engagement points at.
 */
export interface EngagementJobRef {
  id: string;
  title: string | null;
  url: string | null;
  client: { id: string; fullName: string | null } | null;
}

/**
 * One row in the engagements list — surfaced by `engagements list`. The
 * `id` is the `jobActivityItem.id` (the public engagement id from a
 * user perspective). `engagementId` is the underlying
 * `TalentEngagement.id`, exposed so consumers can call mutation paths
 * directly when they prefer to bypass the internal lookup in
 * {@link breaks.add}.
 */
export interface EngagementListItem {
  id: string;
  engagementId: string | null;
  statusV2: EngagementStatus;
  statusGroupV2: EngagementStatus;
  statusColor: string | null;
  lastUpdatedAt: string;
  job: EngagementJobRef;
  startDate: string | null;
  endDate: string | null;
  expectedHours: number | null;
  commitment: { slug: string } | null;
}

/**
 * One entry in the engagement-break reasons catalog — the server-side
 * dictionary of valid `--reason-id` values for {@link breaks.add}.
 *
 * Source: `platformConfiguration.engagementBreakReasons` (returns
 * `[FeedbackReason]!` on the wire). Each `FeedbackReason` carries:
 *   - `identifier` — the value to pass to `breaks.add` as
 *     `reasonIdentifier` (e.g., `talent_on_vacation`, `other`).
 *   - `nameForRole` — the human-readable label tailored to the
 *     talent's role.
 *
 * The schema's `FeedbackReason` has no `description` field; AC1's "if
 * available" allowance lets the surface omit it without breaking the
 * contract.
 */
export interface EngagementBreakReason {
  identifier: string;
  nameForRole: string;
}

/**
 * Engagement break wire shape (matches the captured
 * `engagementBreakData` fragment). `operations` mirrors the schema's
 * `EngagementBreakOperations` projection — `callable` is a free-text
 * indicator the server returns to signal whether the operation is
 * available for this break (active vs cancelled vs already-removed).
 */
export interface EngagementBreak {
  id: string;
  startDate: string;
  endDate: string;
  comment: string | null;
  operations: {
    removeEngagementBreak: { callable: string } | null;
    rescheduleEngagementBreak: { callable: string } | null;
  } | null;
}

/**
 * Time-zone identity (subset of the well-typed `TimeZone` SDL type) —
 * `location`, `name`, and `value`. `location`/`value` mirror the
 * live-verified `timeZoneFields` selection from `timesheet.show`; `name`
 * (the human-readable label, e.g. "Pacific Time (US & Canada)") is added
 * per the #545 spec, which calls for `timeZone { name }` on the CLI
 * "Time zone" line. Surfaced on both {@link CompanyRepresentative} and
 * {@link Recruiter}. Leaf fields are `String!` in the SDL; typed nullable
 * defensively per project convention.
 */
export interface ContactTimeZone {
  location: string | null;
  name: string | null;
  value: string | null;
}

/**
 * Recruiter contact channels (`ContactFields` SDL type). Mirrors the
 * live-verified `contactFieldsData` selection from `timesheet.show`.
 */
export interface RecruiterContactFields {
  communitySlackId: string | null;
  email: string | null;
  phoneNumber: string | null;
  skype: string | null;
}

/**
 * Toptal-side recruiter contact identity (`Recruiter` SDL type) — the
 * "who's my recruiter on this engagement" counterparty. The selection
 * mirrors the live-verified `recruiterData` fragment from `timesheet.show`
 * (`TIMESHEET_DETAILS_QUERY`): `id fullName contactFields photo vacation
 * timeZone`.
 *
 * **INFERRED note**: `Recruiter.vacation` is typed `Unknown` in the
 * synthesized SDL; the `{ id startDate endDate }` shape is proven by the
 * shipped, `TTCTL_E2E=1`-gated `timesheet.show` selection. All leaf fields
 * are nullable defensively (applications `RecruiterRef` #539 idiom). The
 * same wire shape is duplicated as `jobs.Recruiter` per the per-service
 * type convention (cf. `FixedRate`).
 */
export interface Recruiter {
  id: string;
  fullName: string | null;
  contactFields: RecruiterContactFields | null;
  photo: { small: string | null } | null;
  vacation: { id: string; startDate: string | null; endDate: string | null } | null;
  timeZone: ContactTimeZone | null;
}

/**
 * Job points-of-contact (`PointsOfContact` SDL type). `current` is the
 * active recruiter; `handoff` is the prior/secondary recruiter (same
 * `Recruiter` shape); `kind` is a free-text discriminator.
 *
 * **INFERRED note**: `PointsOfContact.handoff` is typed `Unknown` in the
 * synthesized SDL; the `Recruiter`-shaped selection is proven by the
 * shipped, `TTCTL_E2E=1`-gated `timesheet.show` `pointOfContactData`
 * fragment.
 */
export interface PointsOfContact {
  current: Recruiter | null;
  handoff: Recruiter | null;
  kind: string | null;
}

/**
 * Client-side hiring-manager contact (`CompanyRepresentative` SDL type) —
 * the "who's the client-side contact on this job" counterparty. All
 * fields are `String!` / `ID!` (non-null) in the synth SDL; typed nullable
 * defensively per project convention. `timeZone` reuses {@link ContactTimeZone}.
 */
export interface CompanyRepresentative {
  id: string;
  email: string | null;
  fullName: string | null;
  phoneNumber: string | null;
  position: string | null;
  timeZone: ContactTimeZone | null;
}

/**
 * Detail-view shape for `engagements show <id>`. Extends
 * {@link EngagementListItem} with additional engagement metadata
 * (current agreement, bill cycle, earning summary) AND inlines the
 * current breaks list (so a single `show` call covers what would
 * otherwise need a follow-up `breaks list`).
 *
 * Field selection is conservative — fields the CLI/MCP renders.
 * `currentAgreement` carries the rate fields the user typically wants
 * to inspect (their hourly rate, the marketplace margin, the
 * commitment level). `billCycle.verbose` is the human-readable bill
 * cycle (`"Monthly"`, `"Bi-weekly"`, etc.). `earning.paid` is
 * cumulative paid earnings on this engagement.
 */
export interface EngagementDetail extends EngagementListItem {
  currentAgreement: {
    applicationRate: string | null;
    talentHourlyRate: string | null;
    talentRate: string | null;
    marketplaceMargin: string | null;
    timePeriod: string | null;
    commitment: { slug: string } | null;
  } | null;
  billCycle: { verbose: string } | null;
  earning: { paid: { decimal: string } | null } | null;
  eligibleForPayment: boolean | null;
  eligibleToViewTimesheets: boolean | null;
  eligibleToViewTimeOffs: boolean | null;
  proposedEnd: { endDate: string | null; status: string | null } | null;
  job: EngagementJobRef & {
    descriptionMd: string | null;
    expectedHours: number | null;
    commitment: { slug: string } | null;
    workType: { slug: string } | null;
    specialization: { title: string } | null;
    startDate: string | null;
    isCoaching: boolean | null;
    isToptalProject: boolean | null;
    /** Client-side hiring-manager contacts (#545). `[]` when the wire elides them. */
    contacts: CompanyRepresentative[];
    /** Toptal-side recruiter points-of-contact (#545). `null` when the wire elides them. */
    pointsOfContact: PointsOfContact | null;
  };
  breaks: EngagementBreak[];
}

/**
 * Aggregate stats payload returned by `stats()`. `total` is the sum
 * across {@link ENGAGEMENT_STATUS_GROUPS}; each entry in `groups` is a
 * server-provided count (`totalCount`).
 */
export interface EngagementsStats {
  total: number;
  groups: { name: EngagementStatusGroup; count: number }[];
}

/**
 * Optional list filter.
 */
export interface ListOptions {
  /**
   * Filter to one of {@link ENGAGEMENT_LIST_STATUSES}. Defaults to
   * `"active"` per the #147 spec.
   */
  status?: EngagementListStatus;
  /**
   * Free-text keyword filter (passes through to the gateway's
   * `keywords` arg, same as `applications list`). Each entry ANDs with
   * the others.
   */
  keywords?: string[];
  /**
   * 1-indexed page number (issue #375). Forwarded verbatim to the
   * wire's `jobActivityList.page` argument. Default `1` when omitted.
   *
   * The `jobActivityList` paginator's page-index base is **INFERRED**
   * from the sibling `eligibleJobs` paginator (`JobsList`, #138), which
   * E2E verification empirically proved is **1-indexed** (verbatim
   * threading, no `-1` subtraction). The synthesized SDL declares
   * `viewer.jobActivityList: JobActivityList!` with NO arguments
   * (the captured operations never declared them), so live-API E2E is
   * the only authority — see `packages/e2e/src/18-engagements-list.e2e.test.ts`.
   */
  page?: number;
  /**
   * Items per page (issue #375). Forwarded to the wire's
   * `jobActivityList.pageSize` argument. Default `20` when omitted.
   * Upper bound is server-enforced.
   */
  perPage?: number;
}

/**
 * Page wrapper returned by {@link list}. Carries the projected items
 * plus the server-reported `totalCount` and the resolved `page` /
 * `perPage` (the effective values used in the query, after defaults).
 *
 * The CLI / MCP layers use `totalCount` to derive offset-style
 * pagination metadata (`totalPages`, `hasNextPage`) for the list
 * envelope (issue #375), mirroring the `jobs.JobListPage` shape
 * shipped in #138 / #183 / #369.
 *
 * Why not return `EngagementListItem[]` directly: pre-#375 the captured
 * `JobActivityItems` operation had no `page` / `pageSize` args, so the
 * caller could not present pagination metadata. With the wiring change,
 * callers MUST have access to `totalCount` to render the "Page X of Y"
 * footer and populate the JSON envelope's `pageInfo`. The envelope ABI
 * (#128) is pre-1.0, so this return-shape change is forward-evolution,
 * not a breaking-change release.
 */
export interface EngagementListPage {
  items: EngagementListItem[];
  totalCount: number;
  /** 1-indexed page number actually requested. */
  page: number;
  /** Items per page actually requested. */
  perPage: number;
}

/**
 * Default values for {@link ListOptions} pagination fields when the
 * caller does not specify them. Mirrors the pre-#375 implicit wire
 * behavior (`jobActivityList` returned the server's default first
 * slice). Exposed so the CLI / MCP dry-run paths can render the exact
 * variables the apply path sends, and so tests assert against the
 * same constants the production code uses. Values match the
 * `jobs.DEFAULT_PAGE` / `jobs.DEFAULT_PER_PAGE` precedent (1 / 20).
 */
export const DEFAULT_PAGE = 1 as const;
export const DEFAULT_PER_PAGE = 20 as const;

/**
 * Input for `breaks.add`. `reasonIdentifier` is the server-side break
 * reason key. The mutation requires a non-empty value at the server
 * (validation rejects empty strings with `code=blank, key=reasonId`);
 * the caller must supply a valid identifier discovered from the
 * `platformConfiguration.engagementBreakReasons` catalog. Known
 * canonical identifiers at time of writing: `talent_on_vacation`,
 * `client_needs_preparation`, `client_on_vacation`, `other`. Use
 * {@link breaks.reasonsList} (CLI: `ttctl engagements breaks reasons
 * list`; MCP: `ttctl_engagements_breaks_reasons_list`) to discover
 * the live catalog.
 */
export interface AddBreakOptions {
  startDate: string;
  endDate: string;
  // write-only: platform-level Class B asymmetry. TalentEngagementBreak has no read-side field that surfaces this value — neither `reason`, `reasonIdentifier`, `breakReason`, `feedbackReason`, `reasonId`, nor `reasonText` are valid selections (all 6 rejected with `Cannot query field` on the live mobile-gateway, 2026-05-18). The canonical Android mobile client's captured `engagementBreakData` fragment (research/graphql/gateway/operations/mobile/EngagementBreaks.graphql) selects only id/startDate/endDate/comment/operations — confirming Toptal's own client does not echo reason either. PR #355 attempted to add a read-side echo and was reverted in #360. See #346.
  reasonIdentifier: string;
  comment?: string;
}

/**
 * Per-mutation option object for the dry-run short-circuit (issue #163,
 * mirroring the #52 reference pattern on `profile.basic.set()` and the
 * #162 replication across `jobs`). When `dryRun === true`, the mutation
 * builds a {@link DryRunPreview} and returns `{ kind: "preview", preview }`
 * WITHOUT invoking the gateway transport. Default `false` — the apply
 * path runs and a `{ kind: "applied", result }` outcome is returned.
 *
 * Kept as a stand-alone interface (not a discriminated-union option) so
 * future per-mutation options can extend the same shape additively. The
 * signature is deliberately uniform across the 2 engagement-breaks
 * mutations.
 */
export interface DryRunOptions {
  /**
   * When `true`, short-circuit before any transport call and return a
   * {@link DryRunPreview}-bearing outcome instead of executing the
   * mutation. Default: `false` — normal apply path.
   *
   * **`breaks.add` specifics**: the apply path issues an
   * `EngagementBreaks` query first to translate `jobActivityItem.id`
   * → `engagement.id` for the mutation root. The dry-run path SKIPS
   * that prefetch (per the AC's "no GraphQL request is sent (mock
   * transport assertion)") and uses the caller-supplied
   * `jobActivityItemId` as the placeholder value for `engagementId`
   * in the preview's variables payload. The preview's wire SHAPE
   * (field names, operation name, surface, redacted headers) is
   * verbatim; the `engagementId` VALUE is a placeholder that resolves
   * at apply time. The dry-run envelope carries a `notice` field
   * surfacing this caveat to the user.
   */
  dryRun?: boolean;
}

/**
 * Apply-path outcome for {@link breaks.add}. Wraps the
 * server-confirmed {@link EngagementBreak} in a discriminated union so
 * callers can branch deterministically between the apply path
 * (`kind: "applied"`) and the dry-run path (`kind: "preview"`, see
 * {@link EngagementBreaksDryRunPreviewOutcome}).
 */
export interface EngagementBreakAddAppliedOutcome {
  kind: "applied";
  result: EngagementBreak;
}

/**
 * Apply-path outcome for {@link breaks.remove}. Carries the
 * `{ id }` confirmation that the wire's `CancelEngagementBreak`
 * mutation returns.
 */
export interface EngagementBreakRemoveAppliedOutcome {
  kind: "applied";
  result: { id: string };
}

/**
 * Input for {@link breaks.reschedule} (#155). The wire mutation
 * (`RescheduleEngagementBreak`) accepts only `startDate` + `endDate` in
 * its input block — there is NO `comment` field, NO `reasonIdentifier`
 * field. The server preserves the existing break's reason and comment
 * across the reschedule; callers wanting to also change those fields
 * must `remove` + `add` instead.
 */
export interface RescheduleBreakOptions {
  startDate: string;
  endDate: string;
}

/**
 * Apply-path outcome for {@link breaks.reschedule}. Wraps the
 * server-confirmed {@link EngagementBreak} (with refreshed dates) in a
 * discriminated union so callers branch deterministically on apply vs
 * dry-run. The "result" is the FULL break record (post-reschedule), not
 * just the diff — matches the apply-path semantics of
 * {@link breaks.add}, NOT {@link breaks.remove}.
 */
export interface EngagementBreakRescheduleAppliedOutcome {
  kind: "applied";
  result: EngagementBreak;
}

/**
 * Dry-run outcome shared by every engagement-breaks mutation. Carries a
 * {@link DryRunPreview} (operation name, surface, transport, endpoint,
 * variables payload, redacted headers) — emitted verbatim by the CLI's
 * dry-run envelope (`emitDryRunSuccess` in
 * `packages/cli/src/lib/envelopes.ts`).
 */
export interface EngagementBreaksDryRunPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link breaks.add}. The apply
 * path returns the post-mutation {@link EngagementBreak} wrapped in
 * `{ kind: "applied", result }`; the dry-run path returns a
 * {@link DryRunPreview} wrapped in `{ kind: "preview", preview }`.
 *
 * Pre-1.0 the pre-#163 return type (`Promise<EngagementBreak>`) no
 * longer exists — callers must branch on `outcome.kind` to access
 * either `outcome.result` or `outcome.preview`. The MCP layer (and any
 * future consumer) updates in lockstep with this rename via the
 * `unwrapEngagementOutcome` generic in
 * `packages/mcp/src/tools/engagements.ts`.
 */
export type AddBreakOutcome = EngagementBreakAddAppliedOutcome | EngagementBreaksDryRunPreviewOutcome;

/**
 * Discriminated-union return type for {@link breaks.remove}.
 */
export type RemoveBreakOutcome = EngagementBreakRemoveAppliedOutcome | EngagementBreaksDryRunPreviewOutcome;

/**
 * Discriminated-union return type for {@link breaks.reschedule}. The
 * apply path returns the post-mutation {@link EngagementBreak} wrapped
 * in `{ kind: "applied", result }`; the dry-run path returns a
 * {@link DryRunPreview} wrapped in `{ kind: "preview", preview }`.
 */
export type RescheduleBreakOutcome = EngagementBreakRescheduleAppliedOutcome | EngagementBreaksDryRunPreviewOutcome;

// ---------------------------------------------------------------------
// GraphQL operation strings
//
// `JobActivityItems` and `JobActivityItem` are reused operation names
// (matching the captured operations) with selection sets specifically
// tailored to the engagement projection.
//
// Break operations are used VERBATIM from the captured documents in
// `../research/graphql/gateway/operations/mobile/`.
//
// Pagination variable types (issue #375):
//
// - `$page: Int` — nullable Int; omitted → server applies its default
//   first slice. Mirrors the `JobsList` precedent (#138), where
//   `BlogPosts`, `GetJobsForDashboard`, and `GetTalentReferralTrackers`
//   in `research/graphql/gateway/operations/` all declare `$page: Int`.
//   The page-index base for `jobActivityList` is INFERRED 1-indexed
//   from the `eligibleJobs` sibling (empirically verified 1-indexed in
//   #138 E2E) — see {@link ListOptions.page}. Live-API E2E is the
//   authority (`packages/e2e/src/18-engagements-list.e2e.test.ts`).
//
// - `$pageSize: PageSize` — CUSTOM SCALAR, NOT `Int`. The `JobsList`
//   precedent (#138) empirically established this: the live API
//   returned HTTP 400 `Variable "$pageSize" of type "Int!" used in
//   position expecting type "PageSize"` when declared as `Int!`. The
//   schema/contract validation rule caught it during E2E pre-merge
//   verification. `PageSize` is declared in the synthesized gateway
//   SDL (`scalar PageSize`).
//
// The synthesized SDL declares `viewer.jobActivityList: JobActivityList!`
// with NO arguments (captured operations never declared `page` /
// `pageSize`); `totalCount` on `JobActivityList` strongly implies
// wire-level pagination exists. Adding these args is a hand-authored
// operation modification → CLAUDE.md § Schema/contract validation rule
// triggered → mandatory `TTCTL_E2E=1` round-trip before merge.
// ---------------------------------------------------------------------

const ENGAGEMENTS_LIST_QUERY = `query JobActivityItems($keywords: [String!], $onlyStatusGroupFilter: [JobActivityItemStatusGroupEnum!], $page: Int, $pageSize: PageSize) {
  viewer {
    __typename
    id
    jobActivityList(keywords: $keywords, statusGroupV2: { only: $onlyStatusGroupFilter }, page: $page, pageSize: $pageSize) {
      __typename
      entities {
        __typename
        id
        statusV2 { __typename value verbose }
        statusGroupV2 { __typename value verbose }
        statusColor
        lastUpdatedAt
        job {
          __typename
          id
          title
          url
          client { __typename id fullName }
        }
        engagement {
          __typename
          id
          startDate
          endDate
          expectedHours
          commitment { __typename slug }
        }
      }
      totalCount
    }
  }
}`;

const ENGAGEMENT_SHOW_QUERY = `query JobActivityItem($id: ID!) {
  viewer {
    __typename
    id
    jobActivityItem(id: $id) {
      __typename
      id
      statusV2 { __typename value verbose }
      statusGroupV2 { __typename value verbose }
      statusColor
      lastUpdatedAt
      job {
        __typename
        id
        title
        url
        descriptionMd
        expectedHours
        startDate
        commitment { __typename slug }
        workType { __typename slug }
        specialization { __typename title }
        isCoaching
        isToptalProject
        client { __typename id fullName }
        contacts { __typename id email fullName phoneNumber position timeZone { __typename ...timeZoneFields } }
        pointsOfContact { __typename ...pointOfContactData }
      }
      engagement {
        __typename
        id
        startDate
        endDate
        expectedHours
        commitment { __typename slug }
        eligibleForPayment
        eligibleToViewTimesheets
        eligibleToViewTimeOffs
        billCycle { __typename verbose }
        currentAgreement {
          __typename
          applicationRate
          talentHourlyRate
          talentRate
          marketplaceMargin
          timePeriod
          commitment { __typename slug }
        }
        earning {
          __typename
          paid { __typename decimal }
        }
        proposedEnd { __typename endDate status }
        engagementBreaks {
          __typename
          ...engagementBreakData
        }
      }
    }
  }
}

fragment engagementBreakData on TalentEngagementBreak {
  __typename
  id
  startDate
  endDate
  comment
  operations {
    __typename
    removeEngagementBreak { __typename callable }
    rescheduleEngagementBreak { __typename callable }
  }
}

fragment timeZoneFields on TimeZone {
  __typename
  location
  name
  value
}

fragment contactFieldsData on ContactFields {
  __typename
  communitySlackId
  email
  phoneNumber
  skype
}

fragment recruiterData on Recruiter {
  __typename
  id
  fullName
  contactFields { __typename ...contactFieldsData }
  photo { __typename small }
  vacation { __typename id startDate endDate }
  timeZone { __typename ...timeZoneFields }
}

fragment pointOfContactData on PointsOfContact {
  __typename
  current { __typename ...recruiterData }
  handoff { __typename ...recruiterData }
  kind
}`;

// Verbatim from `../research/graphql/gateway/operations/mobile/EngagementBreaks.graphql`.
const ENGAGEMENT_BREAKS_QUERY = `query EngagementBreaks($jobActivityItemId: ID!) { viewer { __typename id jobActivityItem(id: $jobActivityItemId) { __typename id engagement { __typename id engagementBreaks { __typename ...engagementBreakData } } } } }  fragment engagementBreakData on TalentEngagementBreak { __typename id startDate endDate comment operations { __typename removeEngagementBreak { __typename callable } rescheduleEngagementBreak { __typename callable } } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/CreateEngagementBreak.graphql`.
const CREATE_ENGAGEMENT_BREAK_MUTATION = `mutation CreateEngagementBreak($engagementId: ID!, $startDate: Date!, $endDate: Date!, $reasonIdentifier: String!, $comment: String) { engagement(id: $engagementId) { __typename createBreak(input: { startDate: $startDate endDate: $endDate reasonIdentifier: $reasonIdentifier comment: $comment } ) { __typename ...mutationResultFields break { __typename ...engagementBreakData engagement { __typename id engagementBreaks { __typename id } } } } } }  fragment mutationResultFields on MutationResult { __typename errors { __typename key message code } success }  fragment engagementBreakData on TalentEngagementBreak { __typename id startDate endDate comment operations { __typename removeEngagementBreak { __typename callable } rescheduleEngagementBreak { __typename callable } } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/CancelEngagementBreak.graphql`.
const CANCEL_ENGAGEMENT_BREAK_MUTATION = `mutation CancelEngagementBreak($engagementBreakId: ID!) { engagementBreak(id: $engagementBreakId) { __typename cancel(input: {  } ) { __typename ...mutationResultFields break { __typename id engagement { __typename id engagementBreaks { __typename id } } } } } }  fragment mutationResultFields on MutationResult { __typename errors { __typename key message code } success }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/RescheduleEngagementBreak.graphql` (#155).
const RESCHEDULE_ENGAGEMENT_BREAK_MUTATION = `mutation RescheduleEngagementBreak($engagementBreakId: ID!, $startDate: Date!, $endDate: Date!) { engagementBreak(id: $engagementBreakId) { __typename reschedule(input: { startDate: $startDate endDate: $endDate } ) { __typename ...mutationResultFields break { __typename ...engagementBreakData } } } }  fragment mutationResultFields on MutationResult { __typename errors { __typename key message code } success }  fragment engagementBreakData on TalentEngagementBreak { __typename id startDate endDate comment operations { __typename removeEngagementBreak { __typename callable } rescheduleEngagementBreak { __typename callable } } }`;

// Minimal projection on `PlatformConfiguration` — we only need the
// `engagementBreakReasons` field for the reasons-catalog discovery
// query, NOT the full platformConfigurationData fragment captured in
// `../research/graphql/gateway/operations/mobile/PlatformConfiguration.graphql`.
// The narrower projection keeps the round-trip cheap and the test
// surface focused; the full fragment is available in the research
// repo if other engagement code later needs more fields.
//
// Per CLAUDE.md § Schema/contract validation rule, this operation is
// hand-authored (NOT in `codegen.config.ts` documents) → mandatory live
// E2E coverage. See `packages/e2e/src/29-engagements-breaks-reasons.e2e.test.ts`.
const ENGAGEMENT_BREAK_REASONS_QUERY = `query PlatformConfiguration { platformConfiguration { __typename id engagementBreakReasons { __typename identifier nameForRole } } }`;

interface MutationResultErrors {
  key?: string | null;
  message?: string | null;
  code?: string | null;
}

interface MutationResult {
  success: boolean;
  errors?: MutationResultErrors[] | null;
}

interface EngagementsListResponse {
  viewer: {
    id: string;
    jobActivityList: {
      entities: EngagementsListEntity[] | null;
      totalCount: number;
    } | null;
  } | null;
}

interface EngagementsListEntity {
  id: string;
  statusV2: EngagementStatus;
  statusGroupV2: EngagementStatus;
  statusColor: string | null;
  lastUpdatedAt: string;
  job: EngagementJobRef;
  engagement: {
    id: string;
    startDate: string | null;
    endDate: string | null;
    expectedHours: number | null;
    commitment: { slug: string } | null;
  } | null;
}

interface EngagementShowResponse {
  viewer: {
    id: string;
    jobActivityItem: EngagementShowItem | null;
  } | null;
}

interface EngagementShowItem {
  id: string;
  statusV2: EngagementStatus;
  statusGroupV2: EngagementStatus;
  statusColor: string | null;
  lastUpdatedAt: string;
  // `contacts` is `[CompanyRepresentative]!` on the wire — a non-null list
  // of NULLABLE items; `projectContacts` filters the nulls. `pointsOfContact`
  // shares the output `PointsOfContact` shape (defensively nullable already).
  job: Omit<EngagementDetail["job"], "contacts"> & {
    contacts: (CompanyRepresentative | null)[];
  };
  engagement: {
    id: string;
    startDate: string | null;
    endDate: string | null;
    expectedHours: number | null;
    commitment: { slug: string } | null;
    eligibleForPayment: boolean | null;
    eligibleToViewTimesheets: boolean | null;
    eligibleToViewTimeOffs: boolean | null;
    billCycle: { verbose: string } | null;
    currentAgreement: EngagementDetail["currentAgreement"];
    earning: EngagementDetail["earning"];
    proposedEnd: EngagementDetail["proposedEnd"];
    engagementBreaks: EngagementBreak[] | null;
  } | null;
}

interface EngagementBreaksResponse {
  viewer: {
    id: string;
    jobActivityItem: {
      id: string;
      engagement: {
        id: string;
        engagementBreaks: EngagementBreak[] | null;
      } | null;
    } | null;
  } | null;
}

interface CreateEngagementBreakResponse {
  engagement: {
    createBreak:
      | (MutationResult & {
          break: EngagementBreak | null;
        })
      | null;
  } | null;
}

interface CancelEngagementBreakResponse {
  engagementBreak: {
    cancel:
      | (MutationResult & {
          break: { id: string } | null;
        })
      | null;
  } | null;
}

interface RescheduleEngagementBreakResponse {
  engagementBreak: {
    reschedule:
      | (MutationResult & {
          break: EngagementBreak | null;
        })
      | null;
  } | null;
}

interface PlatformConfigurationResponse {
  platformConfiguration: {
    id: string;
    engagementBreakReasons: ({ identifier: string; nameForRole: string } | null)[] | null;
  } | null;
}

const NOT_FOUND_MESSAGE_PATTERN = /Record not found/i;

/**
 * Thin per-service wrapper around {@link callGatewayShared} (issue
 * #329). Pins the mobile-gateway surface and the
 * {@link EngagementsError} domain class.
 */
async function callGateway<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return callGatewayShared<T, EngagementsError>(
    "mobile-gateway",
    token,
    operationName,
    query,
    variables,
    EngagementsError,
    { schema },
  );
}

/**
 * Project a wire `EngagementsListEntity` into the public
 * {@link EngagementListItem} shape. Engagement subobject may be null
 * (defensive — though a status filter of ACTIVE_ENGAGEMENT or
 * CLOSED_ENGAGEMENT should always return rows with an engagement).
 */
function projectListItem(entity: EngagementsListEntity): EngagementListItem {
  return {
    id: entity.id,
    engagementId: entity.engagement?.id ?? null,
    statusV2: entity.statusV2,
    statusGroupV2: entity.statusGroupV2,
    statusColor: entity.statusColor,
    lastUpdatedAt: entity.lastUpdatedAt,
    job: entity.job,
    startDate: entity.engagement?.startDate ?? null,
    endDate: entity.engagement?.endDate ?? null,
    expectedHours: entity.engagement?.expectedHours ?? null,
    commitment: entity.engagement?.commitment ?? null,
  };
}

/**
 * Project the wire `Recruiter` sub-shape into the public {@link Recruiter}
 * type (#545), defensively coalescing every nullable hop and dropping the
 * wire `__typename`. Returns `null` when the wire elides the recruiter.
 * Mirrors the applications #539 `RecruiterRef` projection idiom; duplicated
 * verbatim in `jobs.index.ts` per the per-service type convention.
 */
function projectRecruiter(wire: Recruiter | null | undefined): Recruiter | null {
  if (wire == null) return null;
  return {
    id: wire.id,
    fullName: wire.fullName ?? null,
    contactFields:
      wire.contactFields == null
        ? null
        : {
            communitySlackId: wire.contactFields.communitySlackId ?? null,
            email: wire.contactFields.email ?? null,
            phoneNumber: wire.contactFields.phoneNumber ?? null,
            skype: wire.contactFields.skype ?? null,
          },
    photo: wire.photo == null ? null : { small: wire.photo.small ?? null },
    vacation:
      wire.vacation == null
        ? null
        : { id: wire.vacation.id, startDate: wire.vacation.startDate ?? null, endDate: wire.vacation.endDate ?? null },
    timeZone:
      wire.timeZone == null
        ? null
        : {
            location: wire.timeZone.location ?? null,
            name: wire.timeZone.name ?? null,
            value: wire.timeZone.value ?? null,
          },
  };
}

/**
 * Project the wire `PointsOfContact` into the public {@link PointsOfContact}
 * type (#545). Returns `null` when the wire elides the struct entirely.
 */
function projectPointsOfContact(wire: PointsOfContact | null | undefined): PointsOfContact | null {
  if (wire == null) return null;
  return {
    current: projectRecruiter(wire.current),
    handoff: projectRecruiter(wire.handoff),
    kind: wire.kind ?? null,
  };
}

/**
 * Project the wire `contacts` list (`[CompanyRepresentative]!` — non-null
 * list of nullable items) into a clean {@link CompanyRepresentative}`[]`
 * (#545), filtering null entries and dropping `__typename`.
 */
function projectContacts(wire: (CompanyRepresentative | null)[] | null | undefined): CompanyRepresentative[] {
  if (wire == null) return [];
  const out: CompanyRepresentative[] = [];
  for (const c of wire) {
    if (c == null) continue;
    out.push({
      id: c.id,
      email: c.email ?? null,
      fullName: c.fullName ?? null,
      phoneNumber: c.phoneNumber ?? null,
      position: c.position ?? null,
      timeZone:
        c.timeZone == null
          ? null
          : { location: c.timeZone.location ?? null, name: c.timeZone.name ?? null, value: c.timeZone.value ?? null },
    });
  }
  return out;
}

/**
 * List the signed-in user's engagements.
 *
 * Default scope is active engagements only (`status: "active"` →
 * `ACTIVE_ENGAGEMENT`). `status: "past"` returns closed engagements
 * (`CLOSED_ENGAGEMENT`); `status: "all"` returns both.
 *
 * The returned items preserve server order; the CLI / MCP do not
 * re-sort.
 *
 * Pagination (#375): `opts.page` (1-indexed) and `opts.perPage` are
 * forwarded to the wire's `jobActivityList.page` / `pageSize`
 * arguments. Defaults: `page: 1, perPage: 20` ({@link DEFAULT_PAGE} /
 * {@link DEFAULT_PER_PAGE}). The wire's `page` base is INFERRED
 * 1-indexed from the `eligibleJobs` sibling (#138) — see
 * {@link ListOptions.page}. Returns an {@link EngagementListPage}
 * carrying `totalCount` so callers can render offset-style pagination
 * metadata. `totalCount` is the full server-side count for the filter
 * (page-independent), the same field {@link stats} reads.
 */
export async function list(token: string, opts: ListOptions = {}): Promise<EngagementListPage> {
  const status = opts.status ?? "active";
  const groups = listStatusToGroups(status);
  const page = opts.page ?? DEFAULT_PAGE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;

  const variables: Record<string, unknown> = {
    keywords: opts.keywords !== undefined && opts.keywords.length > 0 ? opts.keywords : null,
    onlyStatusGroupFilter: groups,
    page,
    pageSize: perPage,
  };
  const data = await callGateway<EngagementsListResponse>(token, "JobActivityItems", ENGAGEMENTS_LIST_QUERY, variables);
  if (data.viewer === null) {
    throw new EngagementsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.jobActivityList === null) {
    return { items: [], totalCount: 0, page, perPage };
  }
  const items = (data.viewer.jobActivityList.entities ?? []).map(projectListItem);
  return { items, totalCount: data.viewer.jobActivityList.totalCount, page, perPage };
}

/**
 * Fetch a single engagement's detail by `jobActivityItem.id`.
 *
 * Throws `EngagementsError("NOT_FOUND")` when the id doesn't resolve
 * (matches `applications.show` semantics — both the
 * "Record not found" GraphQL error path AND the data-shape sentinel
 * `viewer.jobActivityItem === null`).
 *
 * Throws `EngagementsError("NO_ENGAGEMENT")` when the row exists but
 * has no engagement (e.g., an interview-only row that never reached
 * engagement status).
 */
export async function show(token: string, id: string): Promise<EngagementDetail> {
  let data: EngagementShowResponse;
  try {
    data = await callGateway<EngagementShowResponse>(token, "JobActivityItem", ENGAGEMENT_SHOW_QUERY, { id });
  } catch (err) {
    if (
      err instanceof EngagementsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new EngagementsError("NOT_FOUND", `No engagement found with id "${id}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new EngagementsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.jobActivityItem === null) {
    throw new EngagementsError("NOT_FOUND", `No engagement found with id "${id}" (or you don't have access to it).`);
  }
  const item = data.viewer.jobActivityItem;
  if (item.engagement === null) {
    throw new EngagementsError(
      "NO_ENGAGEMENT",
      `Activity item "${id}" exists but has no engagement (likely an application or interview that never became an engagement).`,
    );
  }
  return {
    id: item.id,
    engagementId: item.engagement.id,
    statusV2: item.statusV2,
    statusGroupV2: item.statusGroupV2,
    statusColor: item.statusColor,
    lastUpdatedAt: item.lastUpdatedAt,
    // Spread keeps the existing wire job fields verbatim; the two #545
    // counterparty fields are projected to clean public shapes (null-filtered
    // contacts, recruiter __typename dropped).
    job: {
      ...item.job,
      contacts: projectContacts(item.job.contacts),
      pointsOfContact: projectPointsOfContact(item.job.pointsOfContact),
    },
    startDate: item.engagement.startDate,
    endDate: item.engagement.endDate,
    expectedHours: item.engagement.expectedHours,
    commitment: item.engagement.commitment,
    currentAgreement: item.engagement.currentAgreement,
    billCycle: item.engagement.billCycle,
    earning: item.engagement.earning,
    eligibleForPayment: item.engagement.eligibleForPayment,
    eligibleToViewTimesheets: item.engagement.eligibleToViewTimesheets,
    eligibleToViewTimeOffs: item.engagement.eligibleToViewTimeOffs,
    proposedEnd: item.engagement.proposedEnd,
    breaks: item.engagement.engagementBreaks ?? [],
  };
}

/**
 * Aggregate per-engagement-status-group counts plus the overall total.
 * Issues 2 calls in parallel (one per {@link ENGAGEMENT_STATUS_GROUPS}
 * value).
 *
 * Each `count` is server-provided (`totalCount`), no client-side
 * synthesis.
 *
 * Pagination-safe (#375): this reuses the shared
 * {@link ENGAGEMENTS_LIST_QUERY}, which post-#375 declares the nullable
 * `$page` / `$pageSize` variables. `stats` intentionally passes
 * NEITHER — they resolve to `null`, so the server applies its default
 * slice. `totalCount` is the full per-filter count regardless of which
 * page is materialized, so the aggregate is unaffected by the
 * pagination wiring.
 */
export async function stats(token: string): Promise<EngagementsStats> {
  const groupResults = await Promise.all(
    ENGAGEMENT_STATUS_GROUPS.map(async (group) => {
      const data = await callGateway<EngagementsListResponse>(token, "JobActivityItems", ENGAGEMENTS_LIST_QUERY, {
        keywords: null,
        onlyStatusGroupFilter: [group],
      });
      const count = data.viewer?.jobActivityList?.totalCount ?? 0;
      return { name: group, count };
    }),
  );
  const total = groupResults.reduce((sum, g) => sum + g.count, 0);
  return { total, groups: groupResults };
}

/**
 * Internal: fetch the underlying `engagement.id` from a
 * `jobActivityItem.id`. Used by `breaks.add` (which needs the
 * engagement id for the mutation root) since the public CLI/MCP
 * surface accepts the activity-item id.
 *
 * Reuses `EngagementBreaks` query (it returns engagement.id alongside
 * the breaks list) so this is a normal query, not an extra round-trip
 * specifically for id translation.
 *
 * Throws `EngagementsError("NOT_FOUND")` / `"NO_ENGAGEMENT"` with
 * matching semantics to `show()`.
 */
async function fetchEngagementBreaksAndId(
  token: string,
  jobActivityItemId: string,
): Promise<{ engagementId: string; breaks: EngagementBreak[] }> {
  let data: EngagementBreaksResponse;
  try {
    data = await callGateway<EngagementBreaksResponse>(token, "EngagementBreaks", ENGAGEMENT_BREAKS_QUERY, {
      jobActivityItemId,
    });
  } catch (err) {
    if (
      err instanceof EngagementsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new EngagementsError(
        "NOT_FOUND",
        `No engagement found with id "${jobActivityItemId}" (or you don't have access to it).`,
        { cause: err },
      );
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new EngagementsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.jobActivityItem === null) {
    throw new EngagementsError(
      "NOT_FOUND",
      `No engagement found with id "${jobActivityItemId}" (or you don't have access to it).`,
    );
  }
  if (data.viewer.jobActivityItem.engagement === null) {
    throw new EngagementsError("NO_ENGAGEMENT", `Activity item "${jobActivityItemId}" exists but has no engagement.`);
  }
  return {
    engagementId: data.viewer.jobActivityItem.engagement.id,
    breaks: data.viewer.jobActivityItem.engagement.engagementBreaks ?? [],
  };
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
 * Engagement breaks management. Sub-namespace under the service so the
 * public surface stays `engagements.breaks.{list, add, remove, reschedule}` —
 * matches the CLI verb path `engagements breaks {list, add, remove, reschedule}`.
 */
export const breaks = {
  /**
   * List breaks for an engagement (by `jobActivityItem.id`).
   *
   * Reuses the captured `EngagementBreaks` operation verbatim. The
   * returned array preserves server order.
   */
  async list(token: string, jobActivityItemId: string): Promise<EngagementBreak[]> {
    const { breaks: breakList } = await fetchEngagementBreaksAndId(token, jobActivityItemId);
    return breakList;
  },

  /**
   * Schedule a new break on an engagement (by `jobActivityItem.id`).
   *
   * Internally fetches the underlying `engagement.id` first
   * ({@link fetchEngagementBreaksAndId}) — adds one round-trip but
   * keeps the CLI/MCP surface consistent (the user always passes the
   * activity-item id, never the underlying engagement id).
   *
   * `reasonIdentifier` is the server-side reason key. The mutation
   * marks it `String!` AND the server rejects empty strings (validated
   * by live API: `code=blank, key=reasonId`), so the caller must
   * supply a valid value — see {@link AddBreakOptions} for the known
   * catalog and the discovery path.
   *
   * Throws `EngagementsError("MUTATION_ERROR")` when the gateway
   * returns `success: false` (overlapping break dates, validation
   * failures, etc.).
   *
   * Dry-run path (issue #163): when invoked with `options.dryRun ===
   * true`, builds a {@link DryRunPreview} of the mutation WITHOUT
   * invoking the gateway transport — including the prefetch
   * `EngagementBreaks` query (per the AC's "no GraphQL request is
   * sent" requirement). The preview's `variables.engagementId` is
   * populated with the caller-supplied `jobActivityItemId` as a
   * placeholder; the wire SHAPE (field names, operation, surface,
   * redacted headers) is verbatim. The actual `engagement.id` resolves
   * at apply time via the skipped prefetch.
   */
  async add(
    token: string,
    jobActivityItemId: string,
    opts: AddBreakOptions,
    options: DryRunOptions = {},
  ): Promise<AddBreakOutcome> {
    if (options.dryRun === true) {
      // Skip the prefetch entirely — the AC mandates zero transport
      // calls in dry-run mode. The literal `jobActivityItemId` stands
      // in for `engagementId` so the preview's variable structure
      // matches the wire shape; the CLI envelope surfaces a `notice`
      // explaining the deferred resolution.
      const previewVariables: Record<string, unknown> = {
        engagementId: jobActivityItemId,
        startDate: opts.startDate,
        endDate: opts.endDate,
        reasonIdentifier: opts.reasonIdentifier,
        comment: opts.comment ?? null,
      };
      return {
        kind: "preview",
        preview: buildDryRunPreview({
          surface: "mobile-gateway",
          authToken: token,
          body: {
            operationName: "CreateEngagementBreak",
            query: CREATE_ENGAGEMENT_BREAK_MUTATION,
            variables: previewVariables,
          },
        }),
      };
    }
    const { engagementId } = await fetchEngagementBreaksAndId(token, jobActivityItemId);
    const variables: Record<string, unknown> = {
      engagementId,
      startDate: opts.startDate,
      endDate: opts.endDate,
      reasonIdentifier: opts.reasonIdentifier,
      comment: opts.comment ?? null,
    };
    const data = await callGateway<CreateEngagementBreakResponse>(
      token,
      "CreateEngagementBreak",
      CREATE_ENGAGEMENT_BREAK_MUTATION,
      variables,
    );
    if (data.engagement === null) {
      throw new EngagementsError("NOT_FOUND", `Engagement "${engagementId}" no longer exists.`);
    }
    const result = data.engagement.createBreak;
    if (result === null) {
      throw new EngagementsError("UNKNOWN", "CreateEngagementBreak returned a null payload.");
    }
    if (!result.success) {
      throw new EngagementsError("MUTATION_ERROR", formatMutationErrors("CreateEngagementBreak failed", result.errors));
    }
    if (result.break === null) {
      throw new EngagementsError("UNKNOWN", "CreateEngagementBreak returned success but the `break` payload was null.");
    }
    return { kind: "applied", result: result.break };
  },

  /**
   * Fetch the engagement-break reasons catalog — the valid
   * `--reason-id` values for {@link breaks.add}.
   *
   * Issues `PlatformConfiguration` against the mobile gateway with a
   * minimal projection (`engagementBreakReasons { identifier
   * nameForRole }`). Returns a defensively-cleaned, sorted-by-identifier
   * list:
   *   - null wire entries (`[FeedbackReason]!` — list non-null but
   *     items nullable per Toptal SDL convention) are filtered out.
   *   - sort is locale-independent, case-insensitive on `identifier`
   *     so consumers get a stable, predictable order across runs.
   *
   * **CLAUDE.md schema/contract**: this operation is hand-authored
   * (NOT in `codegen.config.ts`) → live E2E coverage required pre-merge.
   * See `packages/e2e/src/29-engagements-breaks-reasons.e2e.test.ts`.
   *
   * `EngagementsError("NO_VIEWER")` is not raised here:
   * `platformConfiguration` is a viewer-agnostic root field on the
   * gateway (the catalog is the same regardless of viewer), so the
   * `data.viewer === null` defensive branch from the other operations
   * does not apply. Auth failures still surface via `AuthRevokedError`
   * per the standard `callGateway` semantics.
   */
  async reasonsList(token: string): Promise<EngagementBreakReason[]> {
    const data = await callGateway<PlatformConfigurationResponse>(
      token,
      "PlatformConfiguration",
      ENGAGEMENT_BREAK_REASONS_QUERY,
      {},
    );
    if (data.platformConfiguration === null) {
      // Defensive: the gateway should never return null for this root
      // field in practice, but the schema marks
      // `platformConfiguration: PlatformConfiguration` as nullable, so
      // cover the case rather than letting the wire-shape mismatch
      // surface as a runtime TypeError.
      return [];
    }
    const wireItems = data.platformConfiguration.engagementBreakReasons ?? [];
    const cleaned: EngagementBreakReason[] = wireItems
      .filter((r): r is { identifier: string; nameForRole: string } => r != null)
      .map((r) => ({ identifier: r.identifier, nameForRole: r.nameForRole }));
    cleaned.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { sensitivity: "base" }));
    return cleaned;
  },

  /**
   * Cancel a break by `engagementBreak.id`. The id is what
   * `breaks.list` returns; users can copy it directly.
   *
   * Returns `{ id }` of the cancelled break for envelope wrapping.
   * Throws `EngagementsError("MUTATION_ERROR")` on `success: false`.
   *
   * Dry-run path (issue #163): when invoked with `options.dryRun ===
   * true`, builds a {@link DryRunPreview} of the mutation without
   * invoking the gateway transport and returns it wrapped in
   * {@link EngagementBreaksDryRunPreviewOutcome}. The single
   * `engagementBreakId` variable is preserved verbatim — no
   * translation needed for this mutation.
   */
  async remove(token: string, engagementBreakId: string, options: DryRunOptions = {}): Promise<RemoveBreakOutcome> {
    const variables = { engagementBreakId };
    if (options.dryRun === true) {
      return {
        kind: "preview",
        preview: buildDryRunPreview({
          surface: "mobile-gateway",
          authToken: token,
          body: {
            operationName: "CancelEngagementBreak",
            query: CANCEL_ENGAGEMENT_BREAK_MUTATION,
            variables,
          },
        }),
      };
    }
    const data = await callGateway<CancelEngagementBreakResponse>(
      token,
      "CancelEngagementBreak",
      CANCEL_ENGAGEMENT_BREAK_MUTATION,
      variables,
    );
    if (data.engagementBreak === null) {
      throw new EngagementsError("NOT_FOUND", `Engagement break "${engagementBreakId}" not found.`);
    }
    const result = data.engagementBreak.cancel;
    if (result === null) {
      throw new EngagementsError("UNKNOWN", "CancelEngagementBreak returned a null payload.");
    }
    if (!result.success) {
      throw new EngagementsError("MUTATION_ERROR", formatMutationErrors("CancelEngagementBreak failed", result.errors));
    }
    return { kind: "applied", result: { id: engagementBreakId } };
  },

  /**
   * Reschedule an existing break to a new date window by
   * `engagementBreak.id` (#155). The id is what `breaks.list` returns
   * (and what `breaks.add` returns after creating one); users can pass
   * it directly without any translation. The mutation root is
   * `engagementBreak(id: $engagementBreakId)` — same root as
   * {@link breaks.remove}, NOT
   * `engagement(id: ...).rescheduleBreak(...)` — so no engagement-id
   * prefetch is needed (unlike {@link breaks.add}).
   *
   * The wire input has only `startDate` + `endDate`. There is NO
   * `comment` or `reasonIdentifier` field on the mutation input — the
   * server preserves the existing break's reason and comment across the
   * reschedule. Callers wanting to change those fields must
   * `remove` + `add` instead.
   *
   * Returns the FULL post-mutation {@link EngagementBreak} (with
   * refreshed dates + preserved comment/operations), wrapped in the
   * apply outcome — mirroring {@link breaks.add}, not
   * {@link breaks.remove} (which returns only `{ id }` because cancel
   * has nothing meaningful to surface).
   *
   * Throws `EngagementsError("NOT_FOUND")` when the break id resolves
   * to `null engagementBreak`; throws `EngagementsError("MUTATION_ERROR")`
   * when the gateway returns `success: false` (overlapping windows,
   * validation failures).
   *
   * Dry-run path: when invoked with `options.dryRun === true`, builds a
   * {@link DryRunPreview} of the mutation without invoking the gateway
   * transport. The single trio `{ engagementBreakId, startDate, endDate }`
   * is preserved verbatim — no translation needed.
   */
  async reschedule(
    token: string,
    engagementBreakId: string,
    opts: RescheduleBreakOptions,
    options: DryRunOptions = {},
  ): Promise<RescheduleBreakOutcome> {
    const variables = {
      engagementBreakId,
      startDate: opts.startDate,
      endDate: opts.endDate,
    };
    if (options.dryRun === true) {
      return {
        kind: "preview",
        preview: buildDryRunPreview({
          surface: "mobile-gateway",
          authToken: token,
          body: {
            operationName: "RescheduleEngagementBreak",
            query: RESCHEDULE_ENGAGEMENT_BREAK_MUTATION,
            variables,
          },
        }),
      };
    }
    const data = await callGateway<RescheduleEngagementBreakResponse>(
      token,
      "RescheduleEngagementBreak",
      RESCHEDULE_ENGAGEMENT_BREAK_MUTATION,
      variables,
    );
    if (data.engagementBreak === null) {
      throw new EngagementsError("NOT_FOUND", `Engagement break "${engagementBreakId}" not found.`);
    }
    const result = data.engagementBreak.reschedule;
    if (result === null) {
      throw new EngagementsError("UNKNOWN", "RescheduleEngagementBreak returned a null payload.");
    }
    if (!result.success) {
      throw new EngagementsError(
        "MUTATION_ERROR",
        formatMutationErrors("RescheduleEngagementBreak failed", result.errors),
      );
    }
    if (result.break === null) {
      throw new EngagementsError(
        "UNKNOWN",
        "RescheduleEngagementBreak returned success but the `break` payload was null.",
      );
    }
    return { kind: "applied", result: result.break };
  },
};
