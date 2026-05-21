// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `applications` service module — read-only access to the user's Toptal
 * Talent **Activity** view (which Toptal colloquially calls
 * "applications" but is actually a join of `AvailabilityRequest`,
 * `JobApplication`, `Interview`, and `TalentEngagement` rows under one
 * `TalentJobActivityItem` resource).
 *
 * | Leaf            | Operation(s)                                          |
 * |-----------------|-------------------------------------------------------|
 * | `list`          | `JobActivityItems(keywords?, statusGroups?)`          |
 * | `show`          | `JobActivityItem(id)`                                 |
 * | `stats`         | `JobActivityItems(statusGroup)` × N (one per group)   |
 *
 * **Routing**: All three leaves talk to the **mobile-gateway** surface
 * (`https://www.toptal.com/gateway/graphql/talent/graphql`) via
 * `stockTransport`. The gateway is plain HTTPS — no Cloudflare, no TLS
 * impersonation needed. Same surface as `profile.basic.show()`.
 *
 * **Operations are inlined as strings** (not codegen-driven) — same
 * pattern as `profile.skills` mutations and `profile.basic.getBasicInfo`.
 * The captured `JobActivityItems.graphql` and `JobActivityItem.graphql`
 * documents in `../research/graphql/gateway/operations/mobile/` carry a
 * large fragment cascade (`jobData`, `jobActivityEngagementData`, …)
 * touching ~25 types. Routing them through codegen would (a) require
 * augmenting the synthesized schema's `viewer.jobActivityList` field with
 * the `keywords` / `statusGroupV2` argument signatures the operation
 * actually passes (the synthesized SDL declares the field with no args),
 * and (b) pull in dozens of types we don't surface. The trimmed
 * inline strings here select only the fields the CLI / MCP renders;
 * shape is verified empirically by the gated E2E tests in
 * `@ttctl/e2e`.
 *
 * **CLAUDE.md schema/contract validation rule**: the operations here
 * are **[INFERRED — UNVERIFIED]** until the gated `*.e2e.test.ts` files
 * pass against a live session. The pre-merge requirement is the live
 * E2E run, not the unit tests (which can only verify our parsing).
 *
 * **Pagination (#377)**: `list` accepts optional `{ page?, perPage? }`
 * in {@link ListOptions} (1-indexed user-facing; forwarded to the
 * wire's `jobActivityList.page` / `.pageSize` args). Defaults are
 * `page: 1, perPage: 20`. The captured `JobActivityItems.graphql`
 * document did NOT declare `$page` / `$pageSize`; #377 adds them to
 * the trimmed inline string here (a hand-authored operation
 * modification — schema/contract rule triggers, gated E2E is the
 * authority on the wire arg types). `list` returns a {@link
 * JobActivityListPage} carrying `{items,totalCount,page,perPage}` so
 * the CLI / MCP layers can render offset-style `pageInfo`. Sibling
 * vertical of #369/#376 (jobs `eligibleJobs` pagination, #138/#183)
 * and #375 (engagements, same `JobActivityItems` op name, separate
 * service module / document).
 *
 * **Out of scope for v1** (deliberate; see `.tmp/workitem-15.md`):
 * - Date range filters (`--from` / `--to`) — captured operation accepts no
 *   date args.
 *
 * **Stats granularity**: the wire has no aggregate stats query.
 * `viewer.jobActivityList.totalCount` returns the count for whatever
 * `statusGroupV2.only` filter the call applied. `stats()` issues 5
 * parallel `JobActivityItems` calls (one per
 * `JobActivityItemStatusGroupEnum` value), reads each call's
 * server-provided `totalCount`, and surfaces the aggregate plus the
 * per-group breakdown. Each count IS server-provided (not synthesized),
 * so the AC's "no client-side synthesis" principle is respected.
 */

import type { z } from "zod";

import { buildDryRunPreview } from "../../transport.js";
import type { DryRunPreview } from "../../transport.js";
import { callGatewayShared } from "../_shared/transport.js";
import type { GraphQLErrorEntry } from "../profile/shared.js";

/**
 * Applications-domain error codes. Mirrors the `ProfileError` /
 * `SkillsError` shape per project convention so each sub-domain carries
 * its own typed error class without callers having to import a shared
 * cross-domain enum. Auth-revoked failures throw `AuthRevokedError`
 * (cross-cutting `TtctlError` subclass per #77), not a code on this
 * enum.
 *
 * `NOT_FOUND` is specific to `show()`: the gateway returns a successful
 * response with `viewer.jobActivityItem === null` when the supplied id
 * doesn't resolve to an item the signed-in user can see (no separate
 * 404 status). The service translates that explicit null to a typed
 * `NOT_FOUND` so the CLI can render a "no such application" line and
 * the MCP tool can return a structured `(NOT_FOUND)` error response.
 */
export type ApplicationsErrorCode =
  | "NO_VIEWER"
  | "NOT_FOUND"
  | "GRAPHQL_ERROR"
  | "MUTATION_ERROR"
  | "NETWORK_ERROR"
  | "WIRE_SHAPE_ERROR"
  | "UNKNOWN";

export class ApplicationsError extends Error {
  override readonly name = "ApplicationsError";
  constructor(
    public readonly code: ApplicationsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The five known values of `JobActivityItemStatusGroupEnum` from the
 * synthesized schema (`../research/graphql/gateway/schema.graphql`
 * line 176). Re-declared here as a literal-typed tuple so consumers
 * (CLI flag validation, MCP `z.enum`, `stats()` iteration) share one
 * source of truth without depending on the codegen output.
 *
 * Order matches the schema declaration. `stats()` iterates this array
 * to issue one count call per group.
 */
export const STATUS_GROUPS = [
  "ACTIVE_ENGAGEMENT",
  "ARCHIVED",
  "CLOSED_ENGAGEMENT",
  "ON_CLIENT_REVIEW",
  "ON_RECRUITER_REVIEW",
] as const;

export type StatusGroup = (typeof STATUS_GROUPS)[number];

/**
 * Optional list filter — both fields fold straight into the captured
 * operation's variables (`keywords`, `onlyStatusGroupFilter`).
 */
export interface ListOptions {
  /**
   * Free-text keyword filter. Each entry is matched server-side against
   * job title, client name, and other indexed fields. Multiple keywords
   * AND together (per observed behavior in the mobile app).
   */
  keywords?: string[];
  /**
   * Restrict the list to one or more status groups. When omitted the
   * server returns rows from every group.
   */
  statusGroups?: StatusGroup[];
  /**
   * 1-indexed page number (issue #377). Forwarded to the wire's
   * `jobActivityList.page` argument. Default `1` when omitted. The
   * wire `page` is INFERRED to be 1-indexed from the sibling
   * `eligibleJobs` precedent (#138) — same gateway; gated E2E is the
   * authority.
   */
  page?: number;
  /**
   * Items per page (issue #377). Forwarded verbatim to the wire's
   * `jobActivityList.pageSize` argument. Default `20` when omitted.
   * Server-capped.
   */
  perPage?: number;
}

/**
 * Page wrapper returned by {@link list} (issue #377). Carries the
 * projected items plus the server-reported `totalCount` and the
 * resolved `page` / `perPage` (the effective values used in the query,
 * after defaults). Mirrors the `jobs.JobListPage` shape from #138 so
 * the CLI / MCP layers render an identical offset-style `pageInfo`.
 *
 * `totalCount` is the grand total across ALL pages (NOT the count of
 * the returned slice) — the same server scalar `stats()` reads — so
 * callers derive `totalPages = ceil(totalCount / perPage)`.
 *
 * Why a structured value instead of a bare `JobActivityItem[]`:
 * pre-#377 the operation declared no `$page` / `$pageSize`, so callers
 * could not surface pagination metadata. With the wiring change,
 * callers MUST have `totalCount` to render the "Page X of Y" footer
 * and populate the JSON envelope's `pageInfo`.
 */
export interface JobActivityListPage {
  items: JobActivityItem[];
  totalCount: number;
  /** 1-indexed page number actually requested. */
  page: number;
  /** Items per page actually requested. */
  perPage: number;
}

/**
 * Default {@link ListOptions} pagination values when the caller does
 * not specify them (issue #377). Exposed so the CLI / MCP dry-run
 * preview and unit tests assert against the same constants the apply
 * path uses — identical convention to `jobs.DEFAULT_PAGE` /
 * `jobs.DEFAULT_PER_PAGE` (#138 / #369).
 */
export const DEFAULT_PAGE = 1 as const;
export const DEFAULT_PER_PAGE = 20 as const;

/**
 * Status payload — both `statusV2` (specific) and `statusGroupV2`
 * (coarse, one of {@link STATUS_GROUPS}) carry the same shape on the
 * wire. `verbose` is the human-readable label the Toptal UI shows
 * (e.g. "Active Engagement", "Archived").
 */
export interface ApplicationStatus {
  value: string;
  verbose: string;
}

/**
 * Reference to a job an activity row points at. The full `TalentJob`
 * type carries 30+ fields; this projection surfaces only what `list` /
 * `show` render. `client.fullName` is the company name as the user
 * sees it.
 */
export interface ApplicationJobRef {
  id: string;
  title: string | null;
  url: string | null;
  client: { id: string; fullName: string | null } | null;
}

/**
 * Recruiter-pinned Fixed rate (#410). The Toptal portal renders this as
 * the "Fixed" rate badge on Interest Requests — distinct from the
 * marketplace `maxRate` ceiling on `TalentJob`. Lives on the
 * `AvailabilityRequest.metadata.offeredHourlyRate` path in the
 * synthesized schema (`AvailabilityRequestFixedMetadata`). Shape is
 * the standard `Money { decimal verbose }`. `null` when the activity
 * row has no AR, or the AR carries no Fixed-rate offer.
 */
export interface FixedRate {
  decimal: string;
  verbose: string;
}

/**
 * `AvailabilityRequestKindEnum` values (#411). **INFERRED — UNVERIFIED**
 * from the synthesized schema, which declares the enum as `_UNKNOWN` (line
 * 2729 of `../research/graphql/gateway/schema.graphql` — "values not
 * statically extractable; observe via API responses"). The three values
 * exposed here mirror the three `AvailabilityRequest.metadata` union
 * variants:
 *
 *   - `FIXED` ← `AvailabilityRequestFixedMetadata` (recruiter pinned a
 *     hard hourly rate; the captured Fixed rate from #410)
 *   - `FLEXIBLE` ← `AvailabilityRequestFlexibleMetadata` (rate negotiable)
 *   - `MARKETPLACE_FLEXIBLE` ← `MarketplaceAvailabilityRequestFlexibleMetadata`
 *
 * Live E2E verification (`packages/e2e/src/44-applications-confirm.e2e.test.ts`)
 * is the authority on which spellings the gateway actually accepts. If
 * the wire rejects a value with an UNKNOWN_ENUM_VALUE GraphQL error, the
 * literal here is the place to fix.
 *
 * The {@link confirm} service auto-detects the kind from the
 * AR's metadata `__typename` when {@link ConfirmInput.kind} is omitted,
 * so callers without explicit knowledge of the enum spelling can still
 * confirm correctly.
 */
export type AvailabilityRequestKind = "FIXED" | "FLEXIBLE" | "MARKETPLACE_FLEXIBLE";

export const AVAILABILITY_REQUEST_KINDS: readonly AvailabilityRequestKind[] = [
  "FIXED",
  "FLEXIBLE",
  "MARKETPLACE_FLEXIBLE",
] as const;

/**
 * One row of `PlatformConfiguration.availabilityRequestRejectReasonsV3.{fixed,flexible}`.
 * The `key` is the wire-side `rejectReason` value the talent must pass
 * when declining an IR. `value` is the human-readable label the portal
 * renders next to the radio button. `customPlaceholder` is the
 * placeholder text the portal shows in the free-text comment box when
 * this reason is selected (server-localised). `isMandatory` indicates
 * whether the comment is required for this reason (`true` → talent
 * must accompany the decline with a free-text note).
 */
export interface AvailabilityRequestRejectReason {
  key: string;
  value: string;
  customPlaceholder: string | null;
  isMandatory: boolean;
}

/**
 * Reject-reason inventory split by AR kind (`PlatformConfiguration
 * .availabilityRequestRejectReasonsV3` shape). The portal renders only
 * the slice matching the AR's `kind`; client code should likewise pick
 * the slice that matches the AR being declined.
 */
export interface AvailabilityRequestRejectReasons {
  /** Reasons valid for Fixed-kind ARs (recruiter pinned a rate). */
  fixed: AvailabilityRequestRejectReason[];
  /** Reasons valid for Flexible-kind ARs (incl. marketplace flexible). */
  flexible: AvailabilityRequestRejectReason[];
}

/**
 * Per-mutation option object for the dry-run short-circuit (issue #164
 * pattern; sibling to `availability.DryRunOptions`). When `dryRun ===
 * true`, the mutation builds a {@link DryRunPreview} and returns
 * `{ kind: "preview", preview }` WITHOUT invoking the gateway transport
 * — including any pre-fetch the apply path would normally issue
 * (`confirm` may resolve `kind` from a `show(id)` pre-fetch when
 * `ConfirmInput.kind` is omitted; under `dryRun`, that pre-fetch is
 * skipped and the variable is filled with a placeholder string).
 * Default `false` — the apply path runs and a `{ kind: "applied",
 * result }` outcome is returned.
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
 * Echo shape returned by {@link confirm} and {@link reject} (#411).
 * Carries the post-mutation AR state with the fields the trimmed mobile
 * selection set extends over the captured operations
 * (`ConfirmAvailabilityRequest`, `RejectAvailabilityRequest`):
 *
 *   - `id`, `answeredAt`, `statusV2` — from the captured selections
 *   - `talentComment`, `requestedHourlyRate`, `rejectReason` — extended
 *     here so callers (CLI / MCP) can render a meaningful confirmation
 *     of "what was sent to the server" without an extra round-trip
 *
 * The wire-side type is `AvailabilityRequest`; this projection picks
 * only the fields we surface. Live E2E
 * (`packages/e2e/src/44-applications-confirm.e2e.test.ts`,
 * `45-applications-reject.e2e.test.ts`) is the authority on the
 * extended selection — the schema declares `talentComment: String!`
 * (line 819) and `requestedHourlyRate: Money!` (line 817), and
 * `rejectReason: Unknown` (line 816, schema gap — treated as `string |
 * null` at the projection layer until the live wire pins the shape).
 */
export interface AvailabilityRequestRespondPayload {
  id: string;
  answeredAt: string | null;
  statusV2: ApplicationStatus;
  talentComment: string | null;
  requestedHourlyRate: { decimal: string; verbose: string } | null;
  rejectReason: string | null;
}

/**
 * Input for {@link confirm}. The wire mutation's input takes
 * `talentComment, matcherQuestionsAnswers, expertiseQuestionsAnswers,
 * pitchData, requestedHourlyRate, kind` (per
 * `../research/graphql/gateway/operations/mobile/ConfirmAvailabilityRequest.graphql`).
 *
 * - `requestedHourlyRate` is **REQUIRED** by the wire (`BigDecimal!`).
 *   When omitted, the service auto-fills from the AR's
 *   `metadata.offeredHourlyRate` (the recruiter-pinned Fixed rate); when
 *   the AR has no Fixed-metadata variant (i.e., the AR kind is
 *   `FLEXIBLE` or `MARKETPLACE_FLEXIBLE`) the caller MUST supply a rate
 *   explicitly — the service throws `MUTATION_ERROR` if neither is
 *   available.
 * - `kind` is **REQUIRED** by the wire
 *   (`AvailabilityRequestKindEnum!`). When omitted, the service
 *   auto-detects from the AR's `metadata.__typename`. INFERRED — see
 *   {@link AvailabilityRequestKind} for the value spellings.
 * - `comment` (optional) — the talent's free-text accompanying message.
 *   Mapped to the wire's `talentComment` field.
 * - `matcherQuestionsAnswers`, `expertiseQuestionsAnswers`, `pitchData`
 *   (optional) — structural inputs for AR confirmations that require
 *   matcher / expertise question answers or a custom pitch. These are
 *   wire pass-throughs; the service does NOT introspect them. v1
 *   exposes them as `unknown` arrays — callers passing them are
 *   responsible for the wire shape (`JobPositionAnswerInput[]`,
 *   `JobExpertiseAnswerInput[]`, `PitchInput`).
 */
export interface ConfirmInput {
  /** Optional talent-side free-text message. Wire field: `talentComment`. */
  comment?: string;
  /** Hourly rate the talent requests for this engagement. Decimal string (matches `BigDecimal!`). Auto-filled from the AR's Fixed metadata when omitted. */
  requestedHourlyRate?: string;
  /** AR kind. Auto-detected from `metadata.__typename` when omitted. INFERRED enum values — see {@link AvailabilityRequestKind}. */
  kind?: AvailabilityRequestKind;
  /** Optional matcher-questions answers (`JobPositionAnswerInput[]`). v1: opaque pass-through. */
  matcherQuestionsAnswers?: unknown[];
  /** Optional expertise-questions answers (`JobExpertiseAnswerInput[]`). v1: opaque pass-through. */
  expertiseQuestionsAnswers?: unknown[];
  /** Optional pitch input (`PitchInput`). v1: opaque pass-through. */
  pitchInput?: Record<string, unknown>;
}

/**
 * Input for {@link reject}. The wire mutation's input takes
 * `talentComment, rejectReason` (per
 * `../research/graphql/gateway/operations/mobile/RejectAvailabilityRequest.graphql`).
 *
 * - `reason` is **REQUIRED** — the wire `rejectReason: String!` field.
 *   Pass a `key` from {@link rejectReasons} (e.g. `"rate_too_low"`).
 *   The service does NOT validate the key against the inventory at
 *   call time; the wire rejects unknown keys with a top-level GraphQL
 *   error.
 * - `comment` (optional) — talent free-text. Wire field: `talentComment`.
 *   When the chosen `reason` has `isMandatory: true`, the wire requires
 *   a non-empty comment.
 */
export interface RejectInput {
  /** Wire `rejectReason` string key (from {@link rejectReasons}). */
  reason: string;
  /** Optional accompanying free-text. Wire field: `talentComment`. */
  comment?: string;
}

/**
 * Apply-path outcome for {@link confirm} / {@link reject}. Carries the
 * post-mutation AR projection in `result`; the discriminant `kind:
 * "applied"` distinguishes apply from dry-run preview.
 */
export interface AvailabilityRequestAppliedOutcome {
  kind: "applied";
  result: AvailabilityRequestRespondPayload;
}

/**
 * Dry-run outcome shared by `confirm` and `reject` (#411). Mirrors the
 * `availability.AvailabilityDryRunPreviewOutcome` pattern.
 */
export interface AvailabilityRequestDryRunPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link confirm}.
 */
export type ConfirmOutcome = AvailabilityRequestAppliedOutcome | AvailabilityRequestDryRunPreviewOutcome;

/**
 * Discriminated-union return type for {@link reject}.
 */
export type RejectOutcome = AvailabilityRequestAppliedOutcome | AvailabilityRequestDryRunPreviewOutcome;

/**
 * One row in the activity list — the CLI's `applications list` and the
 * MCP's `ttctl_applications_list` both surface this shape. `engagement`,
 * `jobApplication`, and `interview` are presence indicators (only `id`
 * is selected) — a non-null value tells the consumer "this row has
 * reached the corresponding lifecycle stage". `availabilityRequest`
 * additionally carries the recruiter Fixed-rate offer (#410). The
 * `mostRelevantApplication` union from the captured operation is
 * intentionally elided here: it duplicates information `jobApplication`
 * / `availabilityRequest` already carry.
 *
 * `fixedRate` (#410) is projected from
 * `availabilityRequest.metadata.offeredHourlyRate` so callers can rate-
 * triage Interest Requests without crawling into the AR sub-shape
 * themselves. `null` when no AR exists for this row.
 */
export interface JobActivityItem {
  id: string;
  statusV2: ApplicationStatus;
  statusGroupV2: ApplicationStatus;
  statusColor: string | null;
  lastUpdatedAt: string;
  job: ApplicationJobRef;
  jobApplication: { id: string } | null;
  engagement: { id: string } | null;
  availabilityRequest: { id: string } | null;
  interview: { id: string } | null;
  fixedRate: FixedRate | null;
}

/**
 * Detail-view shape for `applications show <id>`. Extends
 * {@link JobActivityItem} with extra job metadata (description, work
 * type, dates) and engagement / application detail fields (rate,
 * commitment, current billing cycle).
 *
 * Field selection is deliberately conservative — the captured
 * `JobActivityItem` operation pulls in the full `jobData` +
 * `jobActivityEngagementData` fragments (~50 fields). The shape here
 * picks the fields the CLI's `pretty` formatter actually renders;
 * future expansions can additively widen the projection.
 */
export interface JobActivityItemDetail extends JobActivityItem {
  job: ApplicationJobRef & {
    descriptionMd: string | null;
    expectedHours: number | null;
    commitment: { slug: string } | null;
    workType: { slug: string } | null;
    specialization: { title: string } | null;
    startDate: string | null;
    postedWhen: string | null;
    estimatedLength: { enumValue: string } | null;
    isCoaching: boolean | null;
    isToptalProject: boolean | null;
  };
  jobApplication: {
    id: string;
    requestedHourlyRate: { decimal: string } | null;
  } | null;
  engagement: {
    id: string;
    startDate: string | null;
    endDate: string | null;
    commitment: { slug: string } | null;
    expectedHours: number | null;
  } | null;
}

/**
 * Aggregate stats payload returned by `stats()`. `total` is the sum
 * across all status groups (also the cross-check value — the
 * unfiltered list call returns the same number); each entry in
 * `groups` is a server-provided count for the named status group.
 */
export interface ApplicationsStats {
  total: number;
  groups: { name: StatusGroup; count: number }[];
}

// ---------------------------------------------------------------------
// GraphQL operation strings (full-document queries — no APQ pinning)
//
// Mirror `../research/graphql/gateway/operations/mobile/JobActivityItems.graphql`
// and `JobActivityItem.graphql`, but with selection sets trimmed to the
// shape this service surfaces. The operation NAMES are kept verbatim so
// any future server-side allowlisting that gates on operation name
// continues to recognize them.
//
// **Schema gap acknowledged**: the synthesized SDL at
// `../research/graphql/gateway/schema.graphql` declares
// `viewer.jobActivityList: JobActivityList!` and
// `viewer.jobActivityItem: TalentJobActivityItem!` with NO arguments.
// The captured operation passes `keywords`, `onlyStatusGroupFilter`,
// `id` — empirically these work (the mobile app sends them daily). The
// E2E tests are the authority on this contract.
//
// Pagination wire-arg types (issue #377):
//
// - `$page: Int` — nullable Int. INFERRED from the sibling
//   `eligibleJobs` precedent (#138 verified `$page: Int` empirically:
//   `BlogPosts`, `GetJobsForDashboard`, `GetTalentReferralTrackers`
//   all declare `$page: Int`). `jobActivityList` lives on the SAME
//   mobile-gateway; the type is reused by inference, not capture.
//
// - `$pageSize: PageSize` — CUSTOM SCALAR, NOT `Int`. The #138 E2E
//   run proved the gateway rejects `Int` in a `PageSize`-typed
//   position for `eligibleJobs` (HTTP 400 `Variable "$pageSize" of
//   type "Int!" used in position expecting type "PageSize"`). The
//   `PageSize` scalar is reused here by inference (same gateway). If
//   the gated `applications list` E2E reveals `jobActivityList`
//   expects `Int` instead, the fix is a one-token scalar swap in this
//   document — flagged in the #377 PR body.
//
// Both args are nullable (no `!`): `stats()` passes them as `null`
// (pagination is meaningless for an aggregate count; `totalCount` is
// the grand total regardless of slice), and the gateway applies its
// default slice.
// ---------------------------------------------------------------------

// `availabilityRequest.metadata.offeredHourlyRate { decimal verbose }`
// surfaces the recruiter-pinned Fixed rate (#410). The schema declares
// `AvailabilityRequest.metadata: AvailabilityRequestFixedMetadata!` and
// `AvailabilityRequestFixedMetadata.offeredHourlyRate: Money!`, both
// non-null when an AR exists. The hand-authored selection lives in the
// schema-coverage gap region (`JobActivityItems` is T1 per
// `docs/wire-validation-routing.md`), so the live E2E run is the
// authority — the existing `15-applications-list.e2e.test.ts` /
// `16-applications-show.e2e.test.ts` extend with `fixedRate` shape
// assertions to gate the schema/contract rule.
const JOB_ACTIVITY_LIST_QUERY = `query JobActivityItems($keywords: [String!], $onlyStatusGroupFilter: [JobActivityItemStatusGroupEnum!], $page: Int, $pageSize: PageSize) {
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
        jobApplication { __typename id }
        engagement { __typename id }
        availabilityRequest {
          __typename
          id
          metadata {
            __typename
            offeredHourlyRate { __typename decimal verbose }
          }
        }
        interview { __typename id }
      }
      totalCount
    }
  }
}`;

const JOB_ACTIVITY_ITEM_QUERY = `query JobActivityItem($id: ID!) {
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
        postedWhen
        commitment { __typename slug }
        workType { __typename slug }
        specialization { __typename title }
        estimatedLength { __typename enumValue }
        isCoaching
        isToptalProject
        client { __typename id fullName }
      }
      jobApplication {
        __typename
        id
        requestedHourlyRate { __typename decimal }
      }
      engagement {
        __typename
        id
        startDate
        endDate
        commitment { __typename slug }
        expectedHours
      }
      availabilityRequest {
        __typename
        id
        metadata {
          __typename
          offeredHourlyRate { __typename decimal verbose }
        }
      }
      interview { __typename id }
    }
  }
}`;

// Stats reuses JOB_ACTIVITY_LIST_QUERY but ignores `entities` — the
// caller only reads `totalCount`. Issuing a separate "count-only" query
// here would be cosmetic; the gateway returns the entities anyway.
// Five small parallel calls keep the wall-clock cost flat (≈ one
// round-trip).

/**
 * Wire-side shape of `availabilityRequest` as returned by the trimmed
 * `JobActivityItems` / `JobActivityItem` selection set. `id` is the
 * presence indicator; `metadata.offeredHourlyRate` (the Money shape) is
 * the recruiter-pinned Fixed rate (#410). The flatten step in
 * {@link projectActivityItem} lifts `offeredHourlyRate` into the
 * row-level `fixedRate` projection field so callers (CLI, MCP, LLM
 * agents) can rate-triage without traversing the AR sub-shape.
 */
interface AvailabilityRequestWireEntity {
  id: string;
  metadata: {
    offeredHourlyRate: {
      decimal: string;
      verbose: string;
    };
  };
}

/**
 * Wire-side row shape for `jobActivityList.entities[]`. Decouples the
 * raw wire selection (`availabilityRequest` carries `metadata.offered...`)
 * from the public projection shape (which surfaces a flat
 * `fixedRate: FixedRate | null` field at the row level). The projection
 * step lives in {@link projectActivityItem}.
 */
interface JobActivityItemWireEntity {
  id: string;
  statusV2: ApplicationStatus;
  statusGroupV2: ApplicationStatus;
  statusColor: string | null;
  lastUpdatedAt: string;
  job: ApplicationJobRef;
  jobApplication: { id: string } | null;
  engagement: { id: string } | null;
  availabilityRequest: AvailabilityRequestWireEntity | null;
  interview: { id: string } | null;
}

/**
 * Wire-side detail shape for `viewer.jobActivityItem(id:)`. Narrows
 * {@link JobActivityItemWireEntity} with richer `job` / `jobApplication`
 * / `engagement` selections (mirroring the public {@link
 * JobActivityItemDetail} extends {@link JobActivityItem} pattern). The
 * AR shape is inherited unchanged — the detail selection set picks the
 * same `metadata.offeredHourlyRate` fields as the list selection.
 */
interface JobActivityItemDetailWireEntity extends JobActivityItemWireEntity {
  job: ApplicationJobRef & {
    descriptionMd: string | null;
    expectedHours: number | null;
    commitment: { slug: string } | null;
    workType: { slug: string } | null;
    specialization: { title: string } | null;
    startDate: string | null;
    postedWhen: string | null;
    estimatedLength: { enumValue: string } | null;
    isCoaching: boolean | null;
    isToptalProject: boolean | null;
  };
  jobApplication: {
    id: string;
    requestedHourlyRate: { decimal: string } | null;
  } | null;
  engagement: {
    id: string;
    startDate: string | null;
    endDate: string | null;
    commitment: { slug: string } | null;
    expectedHours: number | null;
  } | null;
}

interface JobActivityListResponse {
  data?: {
    viewer: {
      id: string;
      jobActivityList: {
        entities: JobActivityItemWireEntity[] | null;
        totalCount: number;
      } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface JobActivityItemResponse {
  data?: {
    viewer: {
      id: string;
      jobActivityItem: JobActivityItemDetailWireEntity | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Lift the wire's `availabilityRequest.metadata.offeredHourlyRate` Money
 * shape into a row-level {@link FixedRate} projection field (#410).
 * Returns `null` when the row carries no AR (typical for `APPLIED` /
 * engagement-only rows) or when an AR exists but the metadata is absent
 * (defensive — schema declares both non-null, but the live wire is the
 * authority).
 */
function projectFixedRate(ar: AvailabilityRequestWireEntity | null): FixedRate | null {
  if (ar === null) return null;
  const offered = ar.metadata.offeredHourlyRate;
  return { decimal: offered.decimal, verbose: offered.verbose };
}

/**
 * Project a wire-shape activity-item row into the public
 * {@link JobActivityItem} surface. The `availabilityRequest` field is
 * narrowed to its presence indicator `{ id }`; the recruiter Fixed
 * rate is flattened to `fixedRate`.
 */
function projectActivityItem(wire: JobActivityItemWireEntity): JobActivityItem {
  return {
    id: wire.id,
    statusV2: wire.statusV2,
    statusGroupV2: wire.statusGroupV2,
    statusColor: wire.statusColor,
    lastUpdatedAt: wire.lastUpdatedAt,
    job: wire.job,
    jobApplication: wire.jobApplication,
    engagement: wire.engagement,
    availabilityRequest: wire.availabilityRequest === null ? null : { id: wire.availabilityRequest.id },
    interview: wire.interview,
    fixedRate: projectFixedRate(wire.availabilityRequest),
  };
}

/**
 * Project a wire-shape detail row into {@link JobActivityItemDetail}.
 * Same flattening as {@link projectActivityItem}; the detail-only
 * fields pass through verbatim.
 */
function projectActivityItemDetail(wire: JobActivityItemDetailWireEntity): JobActivityItemDetail {
  return {
    id: wire.id,
    statusV2: wire.statusV2,
    statusGroupV2: wire.statusGroupV2,
    statusColor: wire.statusColor,
    lastUpdatedAt: wire.lastUpdatedAt,
    job: wire.job,
    jobApplication: wire.jobApplication,
    engagement: wire.engagement,
    availabilityRequest: wire.availabilityRequest === null ? null : { id: wire.availabilityRequest.id },
    interview: wire.interview,
    fixedRate: projectFixedRate(wire.availabilityRequest),
  };
}

/**
 * Thin per-service wrapper around {@link callGatewayShared} (issue
 * #329). Pins the mobile-gateway surface, the {@link ApplicationsError}
 * domain class, and the `requireViewer` flag — every `applications`
 * response carries `viewer` and we surface a `NO_VIEWER` whenever
 * the session is technically valid but no viewer is bound. The
 * generic constraint mirrors the previous local helper so call sites
 * stay type-checked.
 */
async function callGateway<T extends { viewer: { id: string } | null }>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return callGatewayShared<T, ApplicationsError>(
    "mobile-gateway",
    token,
    operationName,
    query,
    variables,
    ApplicationsError,
    { schema, requireViewer: true },
  );
}

/**
 * Sibling of {@link callGateway} for IR write-side ops whose response
 * root is `availabilityRequest` (confirm / reject mutations) or
 * `platformConfiguration` (reject-reasons query) — both are
 * top-level Query / Mutation fields that DO NOT carry a `viewer`
 * wrapper. The shared `requireViewer: true` check would always fail
 * on these shapes. Used only by the #411 write-side ops; existing
 * read-side ops keep the viewer-required wrapper.
 */
async function callGatewayNoViewer<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  return callGatewayShared<T, ApplicationsError>(
    "mobile-gateway",
    token,
    operationName,
    query,
    variables,
    ApplicationsError,
    {},
  );
}

/**
 * List the signed-in user's job activity items (applications,
 * availability requests, interviews, engagements).
 *
 * The returned `items` preserve server order; the CLI / MCP do not
 * re-sort.
 *
 * **Pagination (#377)**: `opts.page` (1-indexed) and `opts.perPage`
 * are forwarded to the wire's `jobActivityList.page` / `.pageSize`
 * args. Defaults: `page: 1, perPage: 20` (matching the pre-#377
 * server-default slice). Returns a {@link JobActivityListPage}
 * carrying `totalCount` so callers can render offset-style pagination
 * metadata. The wire `page` is INFERRED 1-indexed from the sibling
 * `eligibleJobs` precedent (#138) — threaded verbatim, no subtraction;
 * the gated E2E (`--page 1` vs `--page 2` returns different rows) is
 * the authority.
 *
 * **AC scope adjustment** (per #15 user decision 2026-05-10): the
 * operation still accepts NO date filter. `--from` / `--to` flags
 * remain deliberately unexposed. See `.tmp/workitem-15.md` § Open
 * Questions (RESOLVED) for the rationale.
 */
export async function list(token: string, opts: ListOptions = {}): Promise<JobActivityListPage> {
  const page = opts.page ?? DEFAULT_PAGE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const variables: Record<string, unknown> = {};
  if (opts.keywords !== undefined && opts.keywords.length > 0) {
    variables["keywords"] = opts.keywords;
  } else {
    variables["keywords"] = null;
  }
  if (opts.statusGroups !== undefined && opts.statusGroups.length > 0) {
    variables["onlyStatusGroupFilter"] = opts.statusGroups;
  } else {
    variables["onlyStatusGroupFilter"] = null;
  }
  variables["page"] = page;
  variables["pageSize"] = perPage;
  const data = await callGateway<JobActivityListResponse["data"] & object>(
    token,
    "JobActivityItems",
    JOB_ACTIVITY_LIST_QUERY,
    variables,
  );
  // The cast above is the awkward part of dropping codegen here; the
  // shape narrowing below is the single source of runtime truth.
  if (data.viewer === null || data.viewer.jobActivityList === null) {
    return { items: [], totalCount: 0, page, perPage };
  }
  const entities = data.viewer.jobActivityList.entities ?? [];
  return {
    items: entities.map(projectActivityItem),
    totalCount: data.viewer.jobActivityList.totalCount,
    page,
    perPage,
  };
}

/**
 * Fetch a single activity item by id.
 *
 * Throws `ApplicationsError("NOT_FOUND")` for two distinct wire shapes
 * — both meaning "id doesn't resolve to a viewable item":
 *
 * 1. **Top-level GraphQL error matched by {@link NOT_FOUND_MESSAGE_PATTERN}**
 *    — the shared regex covers `Record not found` (the empirical
 *    happy-sad path on `JobActivityItem(id:)`, verified live on
 *    2026-05-10), `Invalid ID` (jobs-service precedent), and
 *    `Node id ... resolves to ...` (the Relay decode error per
 *    `project-toptal-wire-quirks` memory; load-bearing for the
 *    pre-apply read suite added in #424 where `viewer.job(id:)`
 *    bad-ids surface as Relay decode errors). `callGateway` raises
 *    `GRAPHQL_ERROR`; we catch and translate.
 * 2. **Successful response with `viewer.jobActivityItem === null`** —
 *    not observed in practice but kept as defensive coverage in case
 *    the gateway ever switches to the data-shape sentinel.
 */
const NOT_FOUND_MESSAGE_PATTERN = /Record not found|Invalid ID|Node id .*? resolves to/i;

export async function show(token: string, id: string): Promise<JobActivityItemDetail> {
  let data: JobActivityItemResponse["data"] & object;
  try {
    data = await callGateway<JobActivityItemResponse["data"] & object>(
      token,
      "JobActivityItem",
      JOB_ACTIVITY_ITEM_QUERY,
      { id },
    );
  } catch (err) {
    if (
      err instanceof ApplicationsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new ApplicationsError(
        "NOT_FOUND",
        `No activity item found with id "${id}" (or you don't have access to it).`,
        { cause: err },
      );
    }
    throw err;
  }
  if (data.viewer === null) {
    // unreachable in practice — `callGateway` already threw — but the
    // null check keeps the type narrowing clean.
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.jobActivityItem === null) {
    throw new ApplicationsError(
      "NOT_FOUND",
      `No activity item found with id "${id}" (or you don't have access to it).`,
    );
  }
  return projectActivityItemDetail(data.viewer.jobActivityItem);
}

/**
 * Aggregate per-status-group counts plus the overall total. Issues N+1
 * `JobActivityItems` calls — one per `JobActivityItemStatusGroupEnum`
 * value — in parallel via `Promise.all`. Each call's
 * `data.viewer.jobActivityList.totalCount` is a server-provided
 * scalar; the helper does NOT count the returned `entities` array
 * (which would be the synthesis the AC forbids).
 *
 * `total` is the sum of per-group counts. The unfiltered call's
 * `totalCount` would yield the same number; we don't issue an extra
 * call to verify because the per-group sum is already authoritative.
 *
 * **Failure mode**: `Promise.all` rejects on the first failed call. A
 * single GraphQL error on one of the 5 groups loses the 4 successful
 * counts. This is intentional: `applications stats` is an aggregate;
 * surfacing partial counts (e.g. "118 total" when one group's call
 * failed) would be misleading because the user reads `total` as
 * authoritative. The right behavior on partial failure is "show no
 * stats and surface the error" — the caller (`runApplicationsStats`)
 * routes the rejection through the structured error envelope so the
 * user knows exactly what went wrong.
 */
export async function stats(token: string): Promise<ApplicationsStats> {
  const groupResults = await Promise.all(
    STATUS_GROUPS.map(async (group) => {
      const data = await callGateway<JobActivityListResponse["data"] & object>(
        token,
        "JobActivityItems",
        JOB_ACTIVITY_LIST_QUERY,
        // `page` / `pageSize` are `null` here: the shared query now
        // declares them (#377) but `stats()` is an aggregate — it
        // reads the grand-total `totalCount`, which the gateway
        // returns independent of the paginated slice. Explicit `null`
        // (vs omitted) keeps the wire payload deterministic across the
        // 5 parallel count calls.
        { keywords: null, onlyStatusGroupFilter: [group], page: null, pageSize: null },
      );
      const count = data.viewer?.jobActivityList?.totalCount ?? 0;
      return { name: group, count };
    }),
  );
  const total = groupResults.reduce((sum, g) => sum + g.count, 0);
  return { total, groups: groupResults };
}

// ---------------------------------------------------------------------
// Pre-apply read suite (#424) — `applyData`, `applyQuestions`,
// `rateInsight`. All three wrap viewer-rooted queries against
// `mobile-gateway`, returning trimmed projections of the captured
// `JobApplyData`, `JobApplicationQuestions`, and
// `JobApplicationRateInsight` operation documents (see
// `../research/graphql/gateway/operations/mobile/`). All three captured
// operation names appear in `codegen.config.ts`'s
// `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` — they touch schema-gap regions
// (`JobOperationsApply.errors` types, the unresolved `JobExpertiseQuestion`
// type, the `TalentJobRateInsight` union when `BigDecimal` fields land
// on the schema-gap side), so codegen refuses to emit types and the
// inline-string convention pinned by the rest of this module applies.
//
// The trimmed selection sets below select ONLY what the public
// projection surfaces (REQ-A4 rate default, REQ-D1 rate insight,
// REQ-Q1 / REQ-Q2 question discovery, partial REQ-A1 pre-fetch source
// per ADR-008 § Decision Part 5). The captured `JobApplyData`
// additionally pulls in the pitch / talent-card / market-condition
// cascades; those are deliberately elided here. Downstream issues that
// need extra fields widen these queries additively without changing
// the public projection's shape.
//
// CLAUDE.md schema/contract validation rule TRIGGERED — the three
// operations are hand-authored from captured wire. Live E2E coverage
// is deferred to #445 (`51-jobs-apply-data.e2e.test.ts`) per ADR-008
// § Decision Part 5; PR body declares the trigger + Track 1
// (snapshots) disposition. Wire-shape snapshots commit in #445.
//
// The CLI `schema-contract-disposition` CI gate's file-path triggers
// cover `packages/core/src/auth.ts` + `packages/core/src/services/profile/**`
// — `applications/` is not in the gate's scan set, so the gate doesn't
// mechanically fire for this issue. The rule's INTENT is preserved
// via the explicit cross-issue commitment to #445.
//
// Surface coverage gate (`scripts/check-surface-coverage.ts`) does
// not currently scope `applications/` either (covered domains:
// `profile`, `engagements`, `payments`, `timesheet`, `scheduler`).
// The `// surface-exempt:` markers below are documentary +
// forward-compatible per the #424 issue's instruction; they take
// mechanical effect only if the gate's domain set is later extended
// to include `applications/`. Remove the markers once #426 (apply
// core fn), #436 (MCP tools), and #437 (`jobs show --with-questions`)
// wire the fns to user-facing surfaces.
// ---------------------------------------------------------------------

/**
 * One entry of `viewer.job.operations.apply.errors` (#424). Schema
 * declares both fields as `String!` — non-null — but the projection
 * helper {@link projectApplyErrors} keeps a defensive list-entry null
 * filter because the WIRE shape on the schema-gap path (this op is in
 * `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`) is best-effort.
 */
export interface ApplyError {
  code: string;
  message: string;
}

/**
 * Aggregate pre-apply context returned by {@link applyData} (#424).
 *
 * Surfaces the load-bearing scalars from the captured `JobApplyData`
 * operation — the suggested rate (REQ-A4), platform validation
 * bounds, the apply-state errors, and basic job context — trimmed of
 * the heavy pitch / talent-card / market-condition cascades the
 * captured op also pulls in. Downstream consumers:
 *
 *   - **#426 (apply core fn)** — reads `canApply` to short-circuit
 *     before the mutation, uses `suggestedRate` as the
 *     `requestedHourlyRate` default, validates against `rateValidation`.
 *   - **#437 (`jobs show`)** — surfaces `applyErrors` so the user can
 *     see WHY they can't apply (already applied, job closed, etc.)
 *     directly on the job-detail view.
 *
 * `canApply` is a convenience boolean derived from
 * `applyErrors.length === 0` — kept as a separate field so callers
 * don't have to recompute it.
 */
export interface PreApplyData {
  job: {
    id: string;
    isCoaching: boolean | null;
    hasRequiredApplicationPitch: boolean | null;
  };
  /** Empty when the talent may apply; populated lists the blocking reasons. */
  applyErrors: ApplyError[];
  /** Convenience: `true` iff `applyErrors` is empty. */
  canApply: boolean;
  /**
   * Talent's configured hourly rate (`viewerRole.rates.hourly`). The
   * apply path uses this as the `requestedHourlyRate` default
   * (REQ-A4). `null` when the viewerRole is absent (defensive — the
   * schema declares `ViewerRole.rates.hourly: String!`, but absence
   * is treated as null projection rather than a hard error).
   */
  suggestedRate: string | null;
  /**
   * Platform hourly-rate validation bounds. `null` when the platform
   * configuration block is absent (defensive — the schema declares
   * `PlatformConfiguration.rateValidationRules: TalentRateValidationRules!`
   * non-null, but gateway-side absence is surfaced as null projection
   * rather than a hard error). Note `rateStep` is `Int` on the wire,
   * not a decimal string.
   */
  rateValidation: { minRate: string; rateStep: number } | null;
}

/**
 * One question on the apply form (#424). The four-field shape is
 * uniform across matcher and expertise variants per REQ-Q1:
 *
 *   - `identifier` — the wire `id` field (`JobPositionQuestion.id` /
 *     `JobExpertiseQuestion.id`). Used as the `questionId` key when
 *     building the apply-mutation `JobPositionAnswerInput[]` /
 *     `JobExpertiseAnswerInput[]` arrays per ADR-008 § Decision Part 2
 *     `--answers-file` grammar.
 *   - `prompt` — the human-readable question text. For matcher
 *     questions: the wire `question` field. For expertise questions:
 *     the `subject.name` (`Industry.name` or `Skill.name`) — expertise
 *     questions ask "which of your profile items demonstrates this
 *     skill / industry?", so the subject's name IS the prompt the
 *     user sees.
 *   - `type` — TTCtl-side discriminant `"matcher" | "expertise"`,
 *     making each question self-describing if consumers flatten the
 *     two arrays (e.g., #426's answers-file template builder).
 *   - `isMandatory` — for matcher questions, the wire `isRequired`
 *     field. For expertise questions: projected as `true`. The
 *     captured `JobApplicationQuestions` operation selects no
 *     per-question mandatory flag on `expertiseQuestions` (and the
 *     synthesized schema doesn't even declare `JobExpertiseQuestion`),
 *     but the `JobApply` mutation takes
 *     `$expertiseQuestionsAnswers: [JobExpertiseAnswerInput!]` as a
 *     required apply-payload field (research note
 *     `03-applications.md` § Apply flow specifics: "Both question
 *     types ... must be fetched first ... The client cannot guess
 *     them"). Documented inference; #445 live E2E is the wire
 *     authority and may refine this projection if real data surfaces
 *     a more nuanced mandatory-ness signal.
 */
export interface ApplicationQuestion {
  identifier: string;
  prompt: string;
  type: "matcher" | "expertise";
  isMandatory: boolean;
}

/**
 * Questions inventory returned by {@link applyQuestions} (#424).
 * Mirrors the captured `JobApplicationQuestions` operation's two
 * parallel selections — `viewer.job.questions(hideExpertiseQuestion:
 * true)` for matcher questions, `viewer.job.expertiseQuestions` for
 * expertise — projecting each entry to the four-field
 * {@link ApplicationQuestion} shape. Empty arrays surface verbatim
 * when the job has no questions of that kind.
 */
export interface ApplicationQuestions {
  matcherQuestions: ApplicationQuestion[];
  expertiseQuestions: ApplicationQuestion[];
}

/**
 * Rate insight when the talent's rate (or default rate) is judged
 * COMPETITIVE relative to the job's market (#424). Discriminated-union
 * member of {@link RateInsight}; surfaces the captured wire's
 * `TalentJobRateInsightCompetitive` fields verbatim.
 *
 * All revenue / rate fields are `BigDecimal` decimal-string scalars
 * per the captured wire (the captured
 * `JobApplicationRateInsight.graphql` operation selects them bare,
 * no `{ }` sub-selection; the synthesized schema confirms
 * `BigDecimal`). They are NOT a `Money { decimal verbose }` shape —
 * see PR body for the deviation from the issue parenthetical.
 */
export interface CompetitiveRateInsight {
  kind: "competitive";
  /** Estimated revenue at the supplied rate (BigDecimal scalar). */
  estimatedRevenue: string | null;
  /** Server-localised prose explaining the revenue estimate. */
  estimatedRevenueExplanation: string | null;
  /** Server-localised disclaimer about long-term engagement assumptions. */
  longTermDisclaimer: string | null;
}

/**
 * Rate insight when the talent's rate (or default rate) is judged
 * UNCOMPETITIVE relative to the job's market (#424).
 * Discriminated-union member of {@link RateInsight}; surfaces the
 * captured wire's `TalentJobRateInsightUncompetitive` fields verbatim.
 *
 * `recentApplicationRate` + `recommendedRate` together form the
 * "range guidance" the apply path uses to inform the talent
 * (`recentApplicationRate` = empirical rate of recent successful
 * applicants on this specific job; `recommendedRate` = Toptal's
 * suggested rate to be competitive). Both are `BigDecimal`
 * decimal-string scalars on the wire.
 */
export interface UncompetitiveRateInsight {
  kind: "uncompetitive";
  estimatedRevenue: string | null;
  estimatedRevenueExplanation: string | null;
  /** Empirical rate of recent successful applicants (BigDecimal scalar). */
  recentApplicationRate: string | null;
  /** Toptal's suggested rate to be competitive (BigDecimal scalar). */
  recommendedRate: string | null;
}

/**
 * Discriminated-union projection of the wire's `TalentJobRateInsight`
 * union (members `TalentJobRateInsightCompetitive` |
 * `TalentJobRateInsightUncompetitive`). The `kind` discriminant
 * narrows access to the variant-specific fields. Returned by
 * {@link rateInsight}; `null` when the gateway omits the rate-insight
 * payload (viewer null, job null, or `rateInsight` field null).
 */
export type RateInsight = CompetitiveRateInsight | UncompetitiveRateInsight;

// ---------------------------------------------------------------------
// Trimmed inline query strings for the three pre-apply read ops
// (#424). Operation NAMES are kept verbatim from the captured wire
// (`JobApplyData`, `JobApplicationQuestions`,
// `JobApplicationRateInsight`) — any future server-side allowlisting
// that gates on operation name continues to recognize them.
//
// Schema gaps acknowledged:
//   - `TalentJob.operations { apply { errors } }` — `JobOperationsApply.errors`
//     types are in the schema (`JobOperationsApplyError { code, message }`),
//     but the OP shape itself is captured-only; the captured-op
//     selection is the wire authority.
//   - `TalentJob.expertiseQuestions` — not present in the synthesized
//     schema at all; selection mirrors the captured-op shape verbatim
//     (`{ id subject { ... on Industry / Skill } }`).
//   - `TalentJob.rateInsight(onlyHourlyRates, requestedRate)` — also
//     not in the synthesized schema with that argument signature; the
//     captured op passes both args, schema declares the field with no
//     args (same pattern as `jobActivityList`).
//   - Un-aliased union-member fields on `TalentJobRateInsight`: the
//     captured `JobApplicationRateInsight.graphql` aliases
//     `competitiveRevenue: estimatedRevenue` /
//     `uncompetitiveRevenue: estimatedRevenue` (Apollo client-side
//     normalization hint to avoid same-name-different-meaning
//     collisions on the cache side). The inline query below selects
//     them BARE — spec-conformant per GraphQL FieldsInSetCanMerge
//     since both wire members carry `BigDecimal estimatedRevenue` /
//     `BigDecimal estimatedRevenueExplanation` (same scalar type, so
//     same-name selection across union members merges cleanly).
//     {@link projectRateInsight} consumes the un-aliased response
//     keys. If the server ever rejects un-aliased selections, #445
//     E2E catches it on the live wire (this is a Track 1 op).
// ---------------------------------------------------------------------

const JOB_APPLY_DATA_QUERY = `query JobApplyData($jobId: ID!) {
  viewer {
    __typename
    id
    viewerRole {
      __typename
      rates { __typename hourly }
    }
    job(id: $jobId) {
      __typename
      id
      isCoaching
      hasRequiredApplicationPitch
      operations {
        __typename
        apply {
          __typename
          errors { __typename code message }
        }
      }
    }
  }
  platformConfiguration {
    __typename
    id
    rateValidationRules {
      __typename
      hourly { __typename minRate rateStep }
    }
  }
}`;

const JOB_APPLICATION_QUESTIONS_QUERY = `query JobApplicationQuestions($jobId: ID!) {
  viewer {
    __typename
    id
    job(id: $jobId) {
      __typename
      id
      questions(hideExpertiseQuestion: true) {
        __typename
        id
        question
        isRequired
      }
      expertiseQuestions {
        __typename
        id
        subject {
          __typename
          ... on Industry { __typename id name }
          ... on Skill { __typename id name }
        }
      }
    }
  }
}`;

// `$requestedRate: BigDecimal` is kept in the operation signature to
// stay verbatim-faithful to the captured wire (per the
// schema/contract rule's "live API is the authority" principle).
// The public {@link rateInsight} signature does NOT expose
// `requestedRate` per #424 AC; the variable is always threaded as
// `null`, which the wire treats equivalently to "show me the insight
// for my default rate". Re-exposing the parameter is a future-issue
// widening — surface stays additive.
const JOB_APPLICATION_RATE_INSIGHT_QUERY = `query JobApplicationRateInsight($jobId: ID!, $requestedRate: BigDecimal) {
  viewer {
    __typename
    id
    job(id: $jobId) {
      __typename
      id
      hourlyRateInsights: rateInsight(onlyHourlyRates: true, requestedRate: $requestedRate) {
        __typename
        ... on TalentJobRateInsightCompetitive {
          __typename
          estimatedRevenue
          estimatedRevenueExplanation
          longTermDisclaimer
        }
        ... on TalentJobRateInsightUncompetitive {
          __typename
          estimatedRevenue
          estimatedRevenueExplanation
          recentApplicationRate
          recommendedRate
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------
// Wire-side response shapes for the three pre-apply queries. The
// projection helpers + public fns below collapse these into the
// `PreApplyData` / `ApplicationQuestions` / `RateInsight` public
// types.
// ---------------------------------------------------------------------

interface ApplyErrorWire {
  code: string;
  message: string;
}

interface JobApplyDataWireJob {
  id: string;
  isCoaching: boolean | null;
  hasRequiredApplicationPitch: boolean | null;
  operations: {
    apply: {
      errors: (ApplyErrorWire | null)[] | null;
    };
  };
}

interface JobApplyDataResponse {
  data?: {
    viewer: {
      id: string;
      viewerRole: { rates: { hourly: string } } | null;
      job: JobApplyDataWireJob | null;
    } | null;
    platformConfiguration: {
      id: string;
      rateValidationRules: {
        hourly: { minRate: string; rateStep: number };
      } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface MatcherQuestionWire {
  id: string;
  question: string;
  isRequired: boolean | null;
}

interface ExpertiseQuestionSubjectWire {
  __typename: string;
  id?: string;
  name?: string;
}

interface ExpertiseQuestionWire {
  id: string;
  subject: ExpertiseQuestionSubjectWire | null;
}

interface JobApplicationQuestionsResponse {
  data?: {
    viewer: {
      id: string;
      job: {
        id: string;
        questions: (MatcherQuestionWire | null)[] | null;
        expertiseQuestions: (ExpertiseQuestionWire | null)[] | null;
      } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

type RateInsightWire =
  | {
      __typename: "TalentJobRateInsightCompetitive";
      estimatedRevenue: string | null;
      estimatedRevenueExplanation: string | null;
      longTermDisclaimer: string | null;
    }
  | {
      __typename: "TalentJobRateInsightUncompetitive";
      estimatedRevenue: string | null;
      estimatedRevenueExplanation: string | null;
      recentApplicationRate: string | null;
      recommendedRate: string | null;
    };

interface JobApplicationRateInsightResponse {
  data?: {
    viewer: {
      id: string;
      job: {
        id: string;
        hourlyRateInsights: RateInsightWire | null;
      } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Project `viewer.job.operations.apply.errors` from the captured wire
 * shape into the public {@link ApplyError}[] form. Filters list-entry
 * nulls defensively (the schema declares
 * `JobOperationsApply.errors: [JobOperationsApplyError]!` — non-null
 * LIST but nullable ENTRIES); the resulting list always carries
 * non-null entries.
 */
function projectApplyErrors(errors: (ApplyErrorWire | null)[] | null | undefined): ApplyError[] {
  if (errors == null) return [];
  return errors.filter((e): e is ApplyErrorWire => e !== null).map((e) => ({ code: e.code, message: e.message }));
}

function projectMatcherQuestion(wire: MatcherQuestionWire): ApplicationQuestion {
  return {
    identifier: wire.id,
    prompt: wire.question,
    type: "matcher",
    isMandatory: wire.isRequired ?? false,
  };
}

function projectExpertiseQuestion(wire: ExpertiseQuestionWire): ApplicationQuestion {
  // `subject.name` is selected on both `Industry` and `Skill` inline
  // fragments in the captured op; defensive `?? ""` covers a
  // wire-shape regression where neither inline fragment matched (the
  // server returned an as-yet-unknown subject variant). #445 live
  // E2E is the wire authority on what subject variants exist.
  const prompt = wire.subject?.name ?? "";
  return {
    identifier: wire.id,
    prompt,
    type: "expertise",
    // The captured `JobApplicationQuestions` operation selects no
    // `isRequired` on `expertiseQuestions` — projected as `true`
    // here because the apply flow requires expertise answers. See
    // {@link ApplicationQuestion.isMandatory} JSDoc for the
    // grounded inference + the #445 wire-authority follow-up.
    isMandatory: true,
  };
}

function projectRateInsight(wire: RateInsightWire): RateInsight {
  if (wire.__typename === "TalentJobRateInsightCompetitive") {
    return {
      kind: "competitive",
      estimatedRevenue: wire.estimatedRevenue,
      estimatedRevenueExplanation: wire.estimatedRevenueExplanation,
      longTermDisclaimer: wire.longTermDisclaimer,
    };
  }
  // Capture the discriminant through a widened `string` local so the
  // runtime defense below survives ESLint's `no-unnecessary-condition`
  // rule — without the widening, the narrower would prove the
  // !== arm dead (TS exhausts the closed union to
  // `TalentJobRateInsightUncompetitive` after the early return above).
  // At RUNTIME, this op is in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` and
  // the wire may carry a `__typename` outside the closed type union
  // (future server-side union extension lands here even though the
  // type system thinks it's unreachable). Mirrors the
  // {@link kindFromMetadataTypename} pattern below (L1939+):
  // unknown typename → typed `WIRE_SHAPE_ERROR` with the offending
  // value echoed, instead of silently mislabelling as `uncompetitive`
  // with `undefined` `recentApplicationRate` / `recommendedRate`.
  const typename: string = wire.__typename;
  if (typename !== "TalentJobRateInsightUncompetitive") {
    throw new ApplicationsError("WIRE_SHAPE_ERROR", `Unknown rate insight variant: "${typename}".`);
  }
  return {
    kind: "uncompetitive",
    estimatedRevenue: wire.estimatedRevenue,
    estimatedRevenueExplanation: wire.estimatedRevenueExplanation,
    recentApplicationRate: wire.recentApplicationRate,
    recommendedRate: wire.recommendedRate,
  };
}

/**
 * Pre-apply aggregate context for a job (#424). Wraps `JobApplyData
 * ($jobId)` — the mobile gateway's aggregate pre-apply query — and
 * trims the response to the load-bearing scalars (REQ-A4 rate
 * default, apply-state errors, platform validation bounds, plus
 * basic job context). The captured operation also pulls in the
 * pitch / talent-card / market-condition cascades; those are
 * deliberately elided here. The apply path (#426) takes the pitch
 * from `--pitch-file` per ADR-008's grammar, NOT from
 * `suggestedPitch` / `lastPitches`, and `applyQuestions` /
 * `rateInsight` cover the other captured slices. Future widening is
 * additive.
 *
 * **Wire authority**: hand-authored from the captured
 * `JobApplyData.graphql` selection set; CLAUDE.md schema/contract
 * rule TRIGGERED for #424, live E2E coverage in #445.
 *
 * **Bad-id behavior**: `viewer.job(id:)` returns the Relay decode
 * error (per `project-toptal-wire-quirks` memory) when the supplied
 * id doesn't resolve to a viewable job; remapped to
 * `ApplicationsError("NOT_FOUND")` via the shared
 * {@link NOT_FOUND_MESSAGE_PATTERN} (widened in #424).
 *
 * @throws `ApplicationsError("NOT_FOUND")` when the job id doesn't
 *   resolve (Relay decode error, `Invalid ID`, `Record not found`,
 *   or successful response with `viewer.job === null`).
 * @throws `ApplicationsError("NO_VIEWER")` when the session is valid
 *   but no viewer is bound (defensive — `callGateway` with
 *   `requireViewer: true` already raises this case, but the
 *   post-call null check keeps the type narrowing clean).
 */
// surface-exempt: covered by downstream apply path (#426, #436, #437)
export async function applyData(token: string, jobId: string): Promise<PreApplyData> {
  let data: JobApplyDataResponse["data"] & object;
  try {
    data = await callGateway<JobApplyDataResponse["data"] & object>(token, "JobApplyData", JOB_APPLY_DATA_QUERY, {
      jobId,
    });
  } catch (err) {
    if (
      err instanceof ApplicationsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new ApplicationsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.job === null) {
    throw new ApplicationsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`);
  }
  const jobWire = data.viewer.job;
  const applyErrors = projectApplyErrors(jobWire.operations.apply.errors);
  const suggestedRate = data.viewer.viewerRole?.rates.hourly ?? null;
  const rateValidationWire = data.platformConfiguration?.rateValidationRules?.hourly ?? null;
  const rateValidation: PreApplyData["rateValidation"] =
    rateValidationWire === null ? null : { minRate: rateValidationWire.minRate, rateStep: rateValidationWire.rateStep };
  return {
    job: {
      id: jobWire.id,
      isCoaching: jobWire.isCoaching,
      hasRequiredApplicationPitch: jobWire.hasRequiredApplicationPitch,
    },
    applyErrors,
    canApply: applyErrors.length === 0,
    suggestedRate,
    rateValidation,
  };
}

/**
 * Pre-apply matcher + expertise questions inventory for a job (#424).
 * Wraps `JobApplicationQuestions($jobId)`; trims the captured
 * operation's `subject.possibleAnswers` cascades — the four-field
 * {@link ApplicationQuestion} shape is the public projection per
 * #424 AC.
 *
 * The two arrays surface verbatim presence: empty when the job has
 * no questions of that kind. Order is server-supplied; no
 * client-side re-sorting.
 *
 * **Bad-id behavior + NOT_FOUND mapping**: identical to
 * {@link applyData}.
 *
 * @throws `ApplicationsError("NOT_FOUND")` for unresolved job ids.
 * @throws `ApplicationsError("NO_VIEWER")` for sessions with no
 *   bound viewer.
 */
// surface-exempt: covered by downstream apply path (#426, #436, #437)
export async function applyQuestions(token: string, jobId: string): Promise<ApplicationQuestions> {
  let data: JobApplicationQuestionsResponse["data"] & object;
  try {
    data = await callGateway<JobApplicationQuestionsResponse["data"] & object>(
      token,
      "JobApplicationQuestions",
      JOB_APPLICATION_QUESTIONS_QUERY,
      { jobId },
    );
  } catch (err) {
    if (
      err instanceof ApplicationsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new ApplicationsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.job === null) {
    throw new ApplicationsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`);
  }
  const jobWire = data.viewer.job;
  const matcherWire = jobWire.questions ?? [];
  const expertiseWire = jobWire.expertiseQuestions ?? [];
  return {
    matcherQuestions: matcherWire.filter((q): q is MatcherQuestionWire => q !== null).map(projectMatcherQuestion),
    expertiseQuestions: expertiseWire
      .filter((q): q is ExpertiseQuestionWire => q !== null)
      .map(projectExpertiseQuestion),
  };
}

/**
 * Pre-apply rate guidance for a job (#424). Wraps
 * `JobApplicationRateInsight($jobId)`; surfaces the captured
 * operation's `TalentJobRateInsight` discriminated union as
 * {@link RateInsight}. Returns `null` when the gateway omits the
 * insight payload (the `rateInsight` field on the job resolves to
 * null).
 *
 * The operation declares `$requestedRate: BigDecimal` (verbatim from
 * the captured wire) but the public signature does NOT expose
 * `requestedRate` per #424 AC — the variable is threaded as `null`,
 * which the gateway treats as "show me the insight for the talent's
 * default rate". Re-exposing the parameter is a future widening.
 *
 * **Wire shape**: union members carry `BigDecimal` scalar fields
 * (`estimatedRevenue`, `recommendedRate`, `recentApplicationRate`)
 * — NOT `Money { decimal verbose }` objects. The captured
 * `JobApplicationRateInsight.graphql` operation selects them bare
 * (no sub-selection), and the synthesized schema confirms
 * `BigDecimal`. The #424 issue parenthetical "Money shape `{ decimal,
 * verbose }` + range guidance" reflects an intuition rather than the
 * captured wire; the captured operation's selection set is
 * authoritative per the issue's own primary directive ("define shape
 * based on captured operation's selection set"). PR body documents
 * the deviation.
 *
 * **Bad-id behavior + NOT_FOUND mapping**: identical to
 * {@link applyData}.
 *
 * @throws `ApplicationsError("NOT_FOUND")` for unresolved job ids.
 * @throws `ApplicationsError("NO_VIEWER")` for sessions with no
 *   bound viewer.
 */
// surface-exempt: covered by downstream apply path (#426, #436, #437)
export async function rateInsight(token: string, jobId: string): Promise<RateInsight | null> {
  let data: JobApplicationRateInsightResponse["data"] & object;
  try {
    data = await callGateway<JobApplicationRateInsightResponse["data"] & object>(
      token,
      "JobApplicationRateInsight",
      JOB_APPLICATION_RATE_INSIGHT_QUERY,
      { jobId, requestedRate: null },
    );
  } catch (err) {
    if (
      err instanceof ApplicationsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new ApplicationsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.job === null) {
    throw new ApplicationsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`);
  }
  const insightWire = data.viewer.job.hourlyRateInsights;
  if (insightWire === null) return null;
  return projectRateInsight(insightWire);
}

// ---------------------------------------------------------------------
// Interest Request write-side ops (#411) — `confirm` / `reject` /
// `rejectReasons`. All three are HAND-AUTHORED inline strings, NOT
// codegen-driven:
//
//   - `ConfirmAvailabilityRequest` and `RejectAvailabilityRequest` are
//     listed in `codegen.config.ts`'s `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`
//     (lines 222, 259). They reference `AvailabilityRequestKindEnum`
//     (the schema-gap enum `_UNKNOWN`) and the inferred input shape;
//     codegen refuses to emit types for them.
//   - `AvailabilityRequestRejectReasons` is a NEW minimal query (mobile-
//     side, not in research/graphql today). It selects only
//     `platformConfiguration.availabilityRequestRejectReasonsV3` —
//     the trimmed cousin of the portal's heavy `GetPlatformConfiguration`.
//     New ops follow the inline-string convention pinned by the
//     applications module precedent (`JobActivityItems` / `JobActivityItem`).
//
// CLAUDE.md schema/contract validation rule TRIGGERED for this file.
// The gated E2E tests at `packages/e2e/src/{44,45,46}-applications-*.e2e.test.ts`
// are the wire-shape authority. Track 1 disposition (snapshots, not
// codegen-Zod) per the hybrid wire-validation model: all three ops are
// excluded from codegen, so no generated Zod schema exists.
// ---------------------------------------------------------------------

const CONFIRM_AVAILABILITY_REQUEST_MUTATION = `mutation ConfirmAvailabilityRequest($id: ID!, $comment: String, $matcherQuestionsAnswers: [JobPositionAnswerInput!], $expertiseQuestionsAnswers: [JobExpertiseAnswerInput!], $requestedHourlyRate: BigDecimal!, $pitchInput: PitchInput, $kind: AvailabilityRequestKindEnum!) {
  availabilityRequest(id: $id) {
    __typename
    confirm(input: {
      talentComment: $comment
      matcherQuestionsAnswers: $matcherQuestionsAnswers
      expertiseQuestionsAnswers: $expertiseQuestionsAnswers
      pitchData: $pitchInput
      requestedHourlyRate: $requestedHourlyRate
      kind: $kind
    }) {
      __typename
      success
      errors { __typename code key message }
      availabilityRequest {
        __typename
        id
        answeredAt
        statusV2 { __typename value verbose }
        talentComment
        requestedHourlyRate { __typename decimal verbose }
        rejectReason
      }
    }
  }
}`;

const REJECT_AVAILABILITY_REQUEST_MUTATION = `mutation RejectAvailabilityRequest($id: ID!, $reason: String!, $comment: String) {
  availabilityRequest(id: $id) {
    __typename
    reject(input: {
      talentComment: $comment
      rejectReason: $reason
    }) {
      __typename
      success
      errors { __typename code key message }
      availabilityRequest {
        __typename
        id
        answeredAt
        statusV2 { __typename value verbose }
        talentComment
        requestedHourlyRate { __typename decimal verbose }
        rejectReason
      }
    }
  }
}`;

const AVAILABILITY_REQUEST_REJECT_REASONS_QUERY = `query AvailabilityRequestRejectReasons {
  platformConfiguration {
    __typename
    id
    availabilityRequestRejectReasonsV3 {
      __typename
      fixed { __typename key value customPlaceholder isMandatory }
      flexible { __typename key value customPlaceholder isMandatory }
    }
  }
}`;

// Query to resolve the AR `kind` from its metadata `__typename` when
// the caller of `confirm()` omits `ConfirmInput.kind`. Minimal selection
// — id + metadata typename + offeredHourlyRate for the Fixed-kind
// rate-default. This is a separate hand-authored query (NOT
// `AvailabilityRequest($id)` which is in `KNOWN_UNTRUSTED_OPS` because
// it selects subfields on `Unknown`-typed positions). Renamed
// (`GetAvailabilityRequestKind`) to avoid the operation-name collision
// with the captured-but-untrusted op.
const GET_AVAILABILITY_REQUEST_KIND_QUERY = `query GetAvailabilityRequestKind($id: ID!) {
  viewer {
    __typename
    id
    availabilityRequest(id: $id) {
      __typename
      id
      metadata {
        __typename
        ... on AvailabilityRequestFixedMetadata {
          __typename
          offeredHourlyRate { __typename decimal verbose }
        }
        ... on AvailabilityRequestFlexibleMetadata { __typename }
        ... on MarketplaceAvailabilityRequestFlexibleMetadata { __typename }
      }
    }
  }
}`;

interface MutationResultErrors {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface AvailabilityRequestRespondWire {
  id: string;
  answeredAt: string | null;
  statusV2: ApplicationStatus;
  talentComment: string | null;
  requestedHourlyRate: { decimal: string; verbose: string } | null;
  rejectReason: string | null;
}

interface AvailabilityRequestOpsPayloadWire {
  success: boolean;
  errors: MutationResultErrors[] | null;
  availabilityRequest: AvailabilityRequestRespondWire | null;
}

interface ConfirmAvailabilityRequestResponse {
  availabilityRequest: {
    confirm: AvailabilityRequestOpsPayloadWire | null;
  } | null;
}

interface RejectAvailabilityRequestResponse {
  availabilityRequest: {
    reject: AvailabilityRequestOpsPayloadWire | null;
  } | null;
}

interface AvailabilityRequestRejectReasonsResponse {
  platformConfiguration: {
    id: string;
    availabilityRequestRejectReasonsV3: {
      fixed: AvailabilityRequestRejectReason[] | null;
      flexible: AvailabilityRequestRejectReason[] | null;
    } | null;
  } | null;
}

type FixedMetadataKindWire = {
  __typename: "AvailabilityRequestFixedMetadata";
  offeredHourlyRate: { decimal: string; verbose: string };
};

type FlexibleMetadataKindWire = {
  __typename: "AvailabilityRequestFlexibleMetadata";
};

type MarketplaceFlexibleMetadataKindWire = {
  __typename: "MarketplaceAvailabilityRequestFlexibleMetadata";
};

type AvailabilityRequestKindMetadataWire =
  | FixedMetadataKindWire
  | FlexibleMetadataKindWire
  | MarketplaceFlexibleMetadataKindWire;

interface GetAvailabilityRequestKindResponse {
  viewer: {
    id: string;
    availabilityRequest: {
      id: string;
      metadata: AvailabilityRequestKindMetadataWire | null;
    } | null;
  } | null;
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

function projectRespondPayload(wire: AvailabilityRequestRespondWire): AvailabilityRequestRespondPayload {
  return {
    id: wire.id,
    answeredAt: wire.answeredAt,
    statusV2: wire.statusV2,
    talentComment: wire.talentComment,
    requestedHourlyRate:
      wire.requestedHourlyRate === null
        ? null
        : { decimal: wire.requestedHourlyRate.decimal, verbose: wire.requestedHourlyRate.verbose },
    rejectReason: wire.rejectReason,
  };
}

/**
 * Map an AR metadata `__typename` to the INFERRED
 * {@link AvailabilityRequestKind} enum value. Returns `null` when the
 * typename is not one of the three known variants — defensive: callers
 * fall back to throwing rather than guessing.
 */
function kindFromMetadataTypename(typename: string | null | undefined): AvailabilityRequestKind | null {
  switch (typename) {
    case "AvailabilityRequestFixedMetadata":
      return "FIXED";
    case "AvailabilityRequestFlexibleMetadata":
      return "FLEXIBLE";
    case "MarketplaceAvailabilityRequestFlexibleMetadata":
      return "MARKETPLACE_FLEXIBLE";
    default:
      return null;
  }
}

/**
 * Resolve `kind` and (when Fixed) the default `requestedHourlyRate`
 * from the AR's metadata. Called by {@link confirm} when the caller
 * omits either field. Single dedicated query — avoids reusing the
 * untrusted `AvailabilityRequest($id)` op.
 *
 * Returns `null` when the AR doesn't resolve (analogous to
 * `show()`'s NOT_FOUND); the caller surfaces a typed error.
 */
async function resolveConfirmDefaults(
  token: string,
  id: string,
): Promise<{ kind: AvailabilityRequestKind; defaultRate: string | null } | null> {
  let data: GetAvailabilityRequestKindResponse;
  try {
    data = await callGateway<GetAvailabilityRequestKindResponse>(
      token,
      "GetAvailabilityRequestKind",
      GET_AVAILABILITY_REQUEST_KIND_QUERY,
      { id },
    );
  } catch (err) {
    if (
      err instanceof ApplicationsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      return null;
    }
    throw err;
  }
  if (data.viewer === null || data.viewer.availabilityRequest === null) {
    return null;
  }
  const metadata = data.viewer.availabilityRequest.metadata;
  const kind = kindFromMetadataTypename(metadata?.__typename ?? null);
  if (kind === null) {
    throw new ApplicationsError(
      "WIRE_SHAPE_ERROR",
      `AvailabilityRequest "${id}" returned an unknown metadata typename: ${metadata?.__typename ?? "null"}.`,
    );
  }
  const defaultRate =
    metadata !== null && metadata.__typename === "AvailabilityRequestFixedMetadata"
      ? metadata.offeredHourlyRate.decimal
      : null;
  return { kind, defaultRate };
}

/**
 * Confirm an Interest Request — wire `ConfirmAvailabilityRequest` (#411).
 *
 * - `id` is the **`AvailabilityRequest.id`** (NOT the
 *   `TalentJobActivityItem.id`). Activity-item callers should chain via
 *   `show(token, activityId).availabilityRequest?.id` or
 *   `list(...).items[].availabilityRequest?.id`.
 * - When {@link ConfirmInput.kind} is omitted, the service issues a
 *   `GetAvailabilityRequestKind($id)` pre-fetch to resolve the kind
 *   from the AR's metadata `__typename`. When the AR is Fixed-kind and
 *   `requestedHourlyRate` is also omitted, the pre-fetch additionally
 *   supplies the recruiter's offered rate as the default.
 * - When the AR is Flexible / MarketplaceFlexible AND
 *   `requestedHourlyRate` is omitted, throws
 *   `MUTATION_ERROR("requestedHourlyRate is required for FLEXIBLE/MARKETPLACE_FLEXIBLE
 *   ARs — pass an explicit rate")`.
 *
 * Dry-run path (`options.dryRun === true`): skips the pre-fetch
 * entirely and emits a {@link DryRunPreview} with placeholder strings
 * for any fields that would have been resolved live. Matches the
 * `availability.workingHours.set` skipped-prefetch pattern.
 *
 * Bad-id behavior (per project auto-memory `project_toptal_wire_quirks.md`):
 * mutations against bad ids return HTTP 500. The service does NOT
 * pre-validate id existence; callers see `GRAPHQL_ERROR` and may
 * recover by issuing a `show()` first.
 *
 * Throws `MUTATION_ERROR` when the gateway responds with
 * `success: false` (validation failure, e.g. already-confirmed AR,
 * unknown enum value, malformed BigDecimal).
 */
export async function confirm(
  token: string,
  id: string,
  input: ConfirmInput = {},
  options: DryRunOptions = {},
): Promise<ConfirmOutcome> {
  if (options.dryRun === true) {
    // Skip the pre-fetch entirely (zero transport calls under dry-run)
    // and emit a preview with placeholders for unresolved fields. The
    // wire SHAPE (operation + variable types + nullness) is verbatim;
    // only the resolved values differ.
    const previewVariables: Record<string, unknown> = {
      id,
      comment: input.comment ?? null,
      matcherQuestionsAnswers: input.matcherQuestionsAnswers ?? null,
      expertiseQuestionsAnswers: input.expertiseQuestionsAnswers ?? null,
      requestedHourlyRate: input.requestedHourlyRate ?? "<resolved at apply time>",
      pitchInput: input.pitchInput ?? null,
      kind: input.kind ?? "<resolved at apply time>",
    };
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: {
          operationName: "ConfirmAvailabilityRequest",
          query: CONFIRM_AVAILABILITY_REQUEST_MUTATION,
          variables: previewVariables,
        },
      }),
    };
  }

  // Resolve kind + defaultRate if either is missing. Pre-fetch is
  // skipped when both are supplied — fewer round-trips for advanced
  // callers.
  let kind = input.kind;
  let requestedHourlyRate = input.requestedHourlyRate;
  if (kind === undefined || requestedHourlyRate === undefined) {
    const defaults = await resolveConfirmDefaults(token, id);
    if (defaults === null) {
      throw new ApplicationsError(
        "NOT_FOUND",
        `No availability request found with id "${id}" (or you don't have access to it).`,
      );
    }
    if (kind === undefined) kind = defaults.kind;
    if (requestedHourlyRate === undefined) {
      if (defaults.defaultRate === null) {
        throw new ApplicationsError(
          "MUTATION_ERROR",
          `requestedHourlyRate is required for ${kind} AvailabilityRequests — pass an explicit rate.`,
        );
      }
      requestedHourlyRate = defaults.defaultRate;
    }
  }

  const variables: Record<string, unknown> = {
    id,
    comment: input.comment ?? null,
    matcherQuestionsAnswers: input.matcherQuestionsAnswers ?? null,
    expertiseQuestionsAnswers: input.expertiseQuestionsAnswers ?? null,
    requestedHourlyRate,
    pitchInput: input.pitchInput ?? null,
    kind,
  };

  const data = await callGatewayNoViewer<ConfirmAvailabilityRequestResponse>(
    token,
    "ConfirmAvailabilityRequest",
    CONFIRM_AVAILABILITY_REQUEST_MUTATION,
    variables,
  );
  if (data.availabilityRequest === null || data.availabilityRequest.confirm === null) {
    throw new ApplicationsError("UNKNOWN", "ConfirmAvailabilityRequest returned a null payload.");
  }
  const payload = data.availabilityRequest.confirm;
  if (!payload.success) {
    throw new ApplicationsError(
      "MUTATION_ERROR",
      formatMutationErrors("ConfirmAvailabilityRequest failed", payload.errors),
    );
  }
  if (payload.availabilityRequest === null) {
    throw new ApplicationsError(
      "UNKNOWN",
      "ConfirmAvailabilityRequest returned success but the availabilityRequest echo was null.",
    );
  }
  return { kind: "applied", result: projectRespondPayload(payload.availabilityRequest) };
}

/**
 * Reject an Interest Request — wire `RejectAvailabilityRequest` (#411).
 *
 * - `id` is the **`AvailabilityRequest.id`** (same as {@link confirm}).
 * - `input.reason` is the `key` from {@link rejectReasons}. The
 *   service does NOT validate the key locally; the wire rejects
 *   unknown keys with a top-level GraphQL error.
 * - `input.comment` is optional; required by the wire only when the
 *   chosen reason has `isMandatory: true`. The service does not
 *   pre-validate (cheaper to let the wire be the authority).
 *
 * Dry-run path (`options.dryRun === true`): emits a {@link DryRunPreview}
 * without invoking the gateway. No pre-fetch is performed in any path
 * (reject does not need to resolve kind / rate).
 *
 * Throws `MUTATION_ERROR` on `success: false`.
 */
export async function reject(
  token: string,
  id: string,
  input: RejectInput,
  options: DryRunOptions = {},
): Promise<RejectOutcome> {
  const variables: Record<string, unknown> = {
    id,
    reason: input.reason,
    comment: input.comment ?? null,
  };
  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: {
          operationName: "RejectAvailabilityRequest",
          query: REJECT_AVAILABILITY_REQUEST_MUTATION,
          variables,
        },
      }),
    };
  }
  const data = await callGatewayNoViewer<RejectAvailabilityRequestResponse>(
    token,
    "RejectAvailabilityRequest",
    REJECT_AVAILABILITY_REQUEST_MUTATION,
    variables,
  );
  if (data.availabilityRequest === null || data.availabilityRequest.reject === null) {
    throw new ApplicationsError("UNKNOWN", "RejectAvailabilityRequest returned a null payload.");
  }
  const payload = data.availabilityRequest.reject;
  if (!payload.success) {
    throw new ApplicationsError(
      "MUTATION_ERROR",
      formatMutationErrors("RejectAvailabilityRequest failed", payload.errors),
    );
  }
  if (payload.availabilityRequest === null) {
    throw new ApplicationsError(
      "UNKNOWN",
      "RejectAvailabilityRequest returned success but the availabilityRequest echo was null.",
    );
  }
  return { kind: "applied", result: projectRespondPayload(payload.availabilityRequest) };
}

/**
 * Fetch the IR decline-reason inventory from
 * `Query.platformConfiguration.availabilityRequestRejectReasonsV3`.
 *
 * Returns `{ fixed, flexible }` arrays — the portal renders only the
 * slice matching the AR's `kind`. Callers should likewise pick the
 * slice that matches the AR being declined.
 *
 * Empty arrays (no reasons of that kind) are surfaced verbatim.
 * Throws `WIRE_SHAPE_ERROR` if the platform config is absent (the
 * field is non-null in the schema; absence is wire-shape drift).
 */
export async function rejectReasons(token: string): Promise<AvailabilityRequestRejectReasons> {
  const data = await callGatewayNoViewer<AvailabilityRequestRejectReasonsResponse>(
    token,
    "AvailabilityRequestRejectReasons",
    AVAILABILITY_REQUEST_REJECT_REASONS_QUERY,
    {},
  );
  if (data.platformConfiguration === null || data.platformConfiguration.availabilityRequestRejectReasonsV3 === null) {
    throw new ApplicationsError(
      "WIRE_SHAPE_ERROR",
      "PlatformConfiguration.availabilityRequestRejectReasonsV3 was null — schema declares non-null.",
    );
  }
  const reasons = data.platformConfiguration.availabilityRequestRejectReasonsV3;
  return {
    fixed: reasons.fixed ?? [],
    flexible: reasons.flexible ?? [],
  };
}
