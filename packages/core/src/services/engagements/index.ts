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

import { AuthRevokedError, TtctlError } from "../../auth/errors.js";
import { buildDryRunPreview, stockTransport } from "../../transport.js";
import type { DryRunPreview, TransportResponse } from "../../transport.js";
import { isAuthRevokedExtensionCode } from "../profile/shared.js";

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
}

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
// ---------------------------------------------------------------------

const ENGAGEMENTS_LIST_QUERY = `query JobActivityItems($keywords: [String!], $onlyStatusGroupFilter: [JobActivityItemStatusGroupEnum!]) {
  viewer {
    __typename
    id
    jobActivityList(keywords: $keywords, statusGroupV2: { only: $onlyStatusGroupFilter }) {
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

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

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
  job: EngagementDetail["job"];
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
 * Issue a GraphQL request against the mobile-gateway surface and
 * normalize transport / GraphQL outcomes into typed `EngagementsError`
 * throws. Mirrors the `callGateway` helper in the `applications`
 * service.
 */
async function callGateway<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let res: TransportResponse;
  try {
    res = await stockTransport({
      surface: "mobile-gateway",
      authToken: token,
      body: { operationName, query, variables },
    });
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    throw new EngagementsError("NETWORK_ERROR", `${operationName} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new EngagementsError("UNKNOWN", `${operationName} returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as { data?: T | null; errors?: GraphQLErrorEntry[] | null } | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new EngagementsError("GRAPHQL_ERROR", `${operationName} failed: ${first?.message ?? "GraphQL error"}`);
  }
  if (!body?.data) {
    throw new EngagementsError("UNKNOWN", `${operationName} response had no \`data\` field`);
  }
  return body.data;
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
 * List the signed-in user's engagements.
 *
 * Default scope is active engagements only (`status: "active"` →
 * `ACTIVE_ENGAGEMENT`). `status: "past"` returns closed engagements
 * (`CLOSED_ENGAGEMENT`); `status: "all"` returns both.
 *
 * The returned array preserves server order; the CLI / MCP do not
 * re-sort.
 */
export async function list(token: string, opts: ListOptions = {}): Promise<EngagementListItem[]> {
  const status = opts.status ?? "active";
  const groups = listStatusToGroups(status);

  const variables: Record<string, unknown> = {
    keywords: opts.keywords !== undefined && opts.keywords.length > 0 ? opts.keywords : null,
    onlyStatusGroupFilter: groups,
  };
  const data = await callGateway<EngagementsListResponse>(token, "JobActivityItems", ENGAGEMENTS_LIST_QUERY, variables);
  if (data.viewer === null) {
    throw new EngagementsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.jobActivityList === null) {
    return [];
  }
  return (data.viewer.jobActivityList.entities ?? []).map(projectListItem);
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
    job: item.job,
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
