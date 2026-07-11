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

import type { JobExpertiseAnswerInput, JobPositionAnswerInput, PitchInput } from "../../__generated__/zod-schemas.js";
import {
  JobExpertiseAnswerInputSchema,
  JobPositionAnswerInputSchema,
  PitchInputSchema,
} from "../../__generated__/zod-schemas.js";
import { buildDryRunPreview } from "../../transport/index.js";
import type { DryRunPreview } from "../../transport/index.js";
import { callGatewayShared } from "../_shared/transport.js";
import type { GraphQLErrorEntry } from "../profile/shared.js";

// Re-export the recovered input types AND their Zod schema factories so
// the CLI / MCP layers can consume them via `@ttctl/core`
// (`applications.JobPositionAnswerInput`,
// `applications.JobPositionAnswerInputSchema()`, …) without crossing the
// `__generated__/` boundary directly. Mirrors the re-export posture for
// other recovered types in this module (e.g. `MutationResult` fields
// surface here, not as direct codegen imports).
//
// The schema factories return fresh Zod objects on each call — callers
// that want strict-mode rejection of unknown keys must wrap with
// `.strict()` at the call site (`JobPositionAnswerInputSchema().strict()`).
// Codegen's default is "strip unknown" which would silently pass extra
// keys; the AC "extra unknown key in payload rejected with field-path
// error" requires the caller's explicit `.strict()`.
export type { JobExpertiseAnswerInput, JobPositionAnswerInput, PitchInput };
export { JobExpertiseAnswerInputSchema, JobPositionAnswerInputSchema, PitchInputSchema };

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
  /**
   * Direct-apply consent gate (#426). The wire's `consentIssued: Boolean!`
   * is a legal-compliance attestation; the service refuses to issue the
   * mutation unless the caller explicitly passes `consentIssued: true`
   * on {@link ApplyInput}. Same posture #411 took on the DESTRUCTIVE
   * IR mutations, with the legal dimension added. Fired before any wire
   * call.
   */
  | "CONSENT_REQUIRED"
  /**
   * Direct-apply double-application gate (#426). The wire returns
   * `success: false` with `errors[].key === "already_applied"` when the
   * talent has previously applied to the same job. Mapped to a typed
   * code so callers (CLI / MCP / agents) can surface a "you already
   * applied" hint pointing at `ttctl applications show <activity-id>`
   * instead of the generic `MUTATION_ERROR` envelope.
   */
  | "ALREADY_APPLIED"
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
 * Recruiter contact identity surfaced on `AvailabilityRequest.recruiter`
 * (#539). The synthesized SDL declares only `fullName: String!` on the
 * `Recruiter` type (`../research/graphql/gateway/schema.graphql:1384`);
 * `firstName` / `lastName` are **INFERRED — present on the wire** per
 * empirical probe (issue #539). The selection set in the
 * `AvailabilityRequest` query and the embedded `availabilityRequest
 * { ... }` sub-selections in `JobActivityList` / `JobActivityItem` add
 * all three fields so consumers can address recruiters by first name
 * without dropping to manual GraphQL.
 *
 * All three are nullable defensively — the wire returns server-typed
 * non-null strings in practice, but the projection guards against
 * future trimmed selections and per-account empty-state oddities.
 */
export interface RecruiterRef {
  /** Recruiter's first name. INFERRED — present on the wire (#539). */
  firstName: string | null;
  /** Recruiter's last name. INFERRED — present on the wire (#539). */
  lastName: string | null;
  /** Recruiter's full name. `String!` in synthesized SDL. */
  fullName: string | null;
}

/**
 * Embedded availability-request projection on activity-item rows (#539).
 * Surfaces the talent's own response data — comment, counter-rate,
 * reject reason — plus the recruiter contact identity, lifted from the
 * `availabilityRequest { ... }` sub-selection on `JobActivityList` /
 * `JobActivityItem` queries.
 *
 * `id` is the {@link AvailabilityRequest} handle (the same id the
 * `applications.availabilityRequests.show()` /
 * `applications.confirm()` / `applications.reject()` calls accept).
 *
 * Talent-response fields (`talentComment` / `requestedHourlyRate` /
 * `rejectReason`) are typically null for rows whose AR is still
 * `PENDING` — they populate after the talent confirms or rejects.
 * `recruiter` is populated regardless of lifecycle stage when the
 * recruiter identity is bound on the wire.
 */
export interface AvailabilityRequestEmbed {
  id: string;
  /** Talent's own free-text response. `null` pre-response or wire-elided. */
  talentComment: string | null;
  /** Hourly rate the talent posted in response (Money shape). `null` pre-response. */
  requestedHourlyRate: FixedRate | null;
  /** Reject-reason `key` (e.g. `"rate_too_low"`) when rejected. `null` otherwise. */
  rejectReason: string | null;
  /** Recruiter contact identity. `null` when the wire elides the recruiter. */
  recruiter: RecruiterRef | null;
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
 * - `matcherQuestionsAnswers`, `expertiseQuestionsAnswers`, `pitchInput`
 *   (optional) — structural inputs for AR confirmations that require
 *   matcher / expertise question answers or a custom pitch. Stage-2
 *   (#438) types these against the recovered SDL shapes —
 *   {@link JobPositionAnswerInput}, {@link JobExpertiseAnswerInput},
 *   {@link PitchInput} (regenerated from #425's recovery output).
 *   `matcherQuestionsAnswers` entries use `id` (NOT `questionId`) per
 *   the SDL; `expertiseQuestionsAnswers` entries use `questionId`.
 *   The service still passes them through to the wire opaquely; the
 *   typing is the boundary contract for CLI / MCP / direct-Core
 *   callers.
 */
export interface ConfirmInput {
  /** Optional talent-side free-text message. Wire field: `talentComment`. */
  comment?: string;
  /** Hourly rate the talent requests for this engagement. Decimal string (matches `BigDecimal!`). Auto-filled from the AR's Fixed metadata when omitted. */
  requestedHourlyRate?: string;
  /** AR kind. Auto-detected from `metadata.__typename` when omitted. INFERRED enum values — see {@link AvailabilityRequestKind}. */
  kind?: AvailabilityRequestKind;
  /** Optional matcher-questions answers — wire shape `JobPositionAnswerInput[]` (`{ id, answer }`). */
  matcherQuestionsAnswers?: JobPositionAnswerInput[];
  /** Optional expertise-questions answers — wire shape `JobExpertiseAnswerInput[]` (`{ questionId, other, subjectId }`). */
  expertiseQuestionsAnswers?: JobExpertiseAnswerInput[];
  /** Optional pitch input — wire shape `PitchInput`. */
  pitchInput?: PitchInput;
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
 * additionally carries the recruiter Fixed-rate offer (#410).
 * `mostRelevantApplication` (#547) is an id-only presence indicator, like
 * the trio above — the platform-blessed pointer at the AvailabilityRequest
 * that matters most for this row (see its field doc below).
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
  /**
   * Availability-request projection (#539 — extended from the prior
   * `{ id }` presence indicator). Surfaces talent-response data
   * (`talentComment`, `requestedHourlyRate`, `rejectReason`) and the
   * `recruiter` contact identity at row level when the activity has an
   * associated AR. Backwards-compatible widening: existing consumers
   * that only read `.id` continue to work; the additional fields are
   * additive.
   */
  availabilityRequest: AvailabilityRequestEmbed | null;
  interview: { id: string } | null;
  /**
   * Platform-blessed "this is the application that matters" pointer
   * (#547). Originally `mostRelevantApplication: AvailabilityRequest` in
   * the synthesized SDL; Toptal has since split it into a polymorphic
   * supertype whose members include `AvailabilityRequest` and
   * `JobApplication`, so a bare `id` selection 400s (#530 — mirrors the
   * earlier `metadata` polymorphic split fixed in #562). The query selects
   * `id` per concrete member via inline fragments
   * (`... on AvailabilityRequest { id } ... on JobApplication { id }`),
   * which collapse to the same `{ id }` wire shape. For a row with
   * multiple historical applications (job re-opened, multiple negotiation
   * rounds) this is the platform's pick of the closest historical fit —
   * the one consumers deep-link into via
   * `applications.availabilityRequests.show(<id>)`.
   *
   * Projected id-only — a presence-indicator pointer like
   * {@link jobApplication} / {@link interview}, NOT a re-projection of the
   * full shape (the row's own {@link availabilityRequest} already carries
   * that when the relevant application is this row's AR). `null` when the
   * row has no associated application.
   */
  mostRelevantApplication: { id: string } | null;
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
// surfaces the recruiter-pinned Fixed rate (#410). Per the #530 schema
// split, `AvailabilityRequest.metadata: AvailabilityRequestMetadata!` is
// a polymorphic supertype with three known variants — `offeredHourlyRate`
// lives only on `AvailabilityRequestFixedMetadata` (as `Money!`), so the
// selection wraps it in an inline fragment and the Flexible /
// MarketplaceFlexible variants return `metadata` without the rate.
// `projectFixedRate` handles the absent-on-non-Fixed branch by short-
// circuiting to `null`. The hand-authored selection lives in the
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
          talentComment
          requestedHourlyRate { __typename decimal verbose }
          rejectReason
          recruiter { __typename firstName lastName fullName }
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
        mostRelevantApplication { __typename ... on AvailabilityRequest { id } ... on JobApplication { id } }
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
        talentComment
        requestedHourlyRate { __typename decimal verbose }
        rejectReason
        recruiter { __typename firstName lastName fullName }
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
      mostRelevantApplication { __typename ... on AvailabilityRequest { id } ... on JobApplication { id } }
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
 * Wire-side shape of `availabilityRequest` as returned by the
 * `JobActivityItems` / `JobActivityItem` selection set. `id` is the
 * AR handle; `metadata.offeredHourlyRate` (the Money shape) is the
 * recruiter-pinned Fixed rate (#410) and is only selected on the
 * `AvailabilityRequestFixedMetadata` variant — Flexible / marketplace
 * variants return `metadata` without `offeredHourlyRate` (#530). The
 * flatten step in {@link projectActivityItem} lifts `offeredHourlyRate`
 * into the row-level `fixedRate` projection field so callers (CLI, MCP,
 * LLM agents) can rate-triage without traversing the AR sub-shape.
 *
 * Extended in #539 with talent-response data
 * (`talentComment`, `requestedHourlyRate`, `rejectReason`) and the
 * `recruiter` contact identity. `talentComment` /
 * `requestedHourlyRate` are well-typed in the synth SDL (`String!` /
 * `Money!`) so are required wire-side when present; the projection
 * still guards against wire elisions defensively (post-projection
 * shape is uniformly nullable). `rejectReason` is `Unknown`-typed in
 * the synth SDL — treated as `string | null` here (the wire returns
 * a `rejectReason.key` string when rejected, null otherwise).
 * `recruiter` is absent from the synth SDL on `AvailabilityRequest`
 * (the field itself is INFERRED) — `firstName` / `lastName` are
 * additionally INFERRED on the `Recruiter` type, which the synth SDL
 * declares with only `fullName`.
 */
interface AvailabilityRequestWireEntity {
  id: string;
  talentComment?: string | null;
  requestedHourlyRate?: {
    decimal: string;
    verbose: string;
  } | null;
  rejectReason?: string | null;
  recruiter?: {
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
  } | null;
  metadata: {
    __typename?: string | null;
    offeredHourlyRate?: {
      decimal: string;
      verbose: string;
    } | null;
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
  /**
   * `mostRelevantApplication` (#547) — selected via inline fragments per
   * the polymorphic-supertype split (`... on AvailabilityRequest { id }
   * ... on JobApplication { id }`, #530), which collapse to a single
   * `{ id }` wire shape regardless of the concrete member. Always
   * selected, so the wire returns it as `null` (no associated
   * application) or an id-bearing object. Optional-typed defensively
   * (older fixtures / a trimmed selection may elide it);
   * {@link projectMostRelevantApplication} collapses `undefined` to
   * `null`.
   */
  mostRelevantApplication?: { id: string } | null;
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
 * Returns `null` when:
 *
 * - The row carries no AR (typical for `APPLIED` / engagement-only rows).
 * - The AR's `metadata` resolves to a non-Fixed variant
 *   (`AvailabilityRequestFlexibleMetadata`,
 *   `MarketplaceAvailabilityRequestFlexibleMetadata`, or a future variant) —
 *   `offeredHourlyRate` is only selected on the Fixed inline fragment, so it
 *   is absent on the wire for non-Fixed metadata (#530 schema split of
 *   `AvailabilityRequestMetadata` into a polymorphic supertype).
 * - The metadata shape is defensively partial (decimal or verbose missing).
 */
function projectFixedRate(ar: AvailabilityRequestWireEntity | null): FixedRate | null {
  if (ar === null) return null;
  const offered = ar.metadata.offeredHourlyRate;
  if (offered == null) return null;
  if (typeof offered.decimal !== "string" || typeof offered.verbose !== "string") return null;
  return { decimal: offered.decimal, verbose: offered.verbose };
}

/**
 * Project the wire's embedded `availabilityRequest { ... }` selection
 * into the public {@link AvailabilityRequestEmbed} shape (#539). Returns
 * `null` when the row carries no AR. Talent-response fields
 * (`talentComment`, `requestedHourlyRate`, `rejectReason`) coerce to
 * `null` when the wire elides them (pre-response rows); `recruiter`
 * coerces to `null` when the wire elides the recruiter sub-selection.
 *
 * `requestedHourlyRate` projects via the same defensive partial-Money
 * guard as {@link projectFixedRate} — a wire shape carrying decimal but
 * not verbose (or vice versa) coerces to `null` rather than passing a
 * half-populated Money through to consumers.
 */
function projectAvailabilityRequestEmbed(ar: AvailabilityRequestWireEntity | null): AvailabilityRequestEmbed | null {
  if (ar === null) return null;
  const reqRate = ar.requestedHourlyRate;
  const requestedHourlyRate: FixedRate | null =
    reqRate != null && typeof reqRate.decimal === "string" && typeof reqRate.verbose === "string"
      ? { decimal: reqRate.decimal, verbose: reqRate.verbose }
      : null;
  const recruiterWire = ar.recruiter;
  const recruiter: RecruiterRef | null =
    recruiterWire == null
      ? null
      : {
          firstName: recruiterWire.firstName ?? null,
          lastName: recruiterWire.lastName ?? null,
          fullName: recruiterWire.fullName ?? null,
        };
  return {
    id: ar.id,
    talentComment: ar.talentComment ?? null,
    requestedHourlyRate,
    rejectReason: ar.rejectReason ?? null,
    recruiter,
  };
}

/**
 * Project the wire's `mostRelevantApplication` selection (#547) into the
 * public id-only pointer on {@link JobActivityItem}. The field is a
 * polymorphic supertype (members `AvailabilityRequest` | `JobApplication`,
 * nullable) selected via inline fragments that collapse to a single
 * `{ id }` shape (#530), so this projection is member-agnostic. Returns
 * `null` when the row has no associated application (absent / null wire
 * value). Id-only by design: the field is a deep-link pointer into
 * `applications.availabilityRequests.show(<id>)`, NOT a place to
 * re-project the full AR shape (which {@link projectAvailabilityRequestEmbed}
 * already covers for the row's own AR). Defensively guards against an
 * object-present-but-id-missing wire shape, mirroring {@link projectFixedRate}.
 */
function projectMostRelevantApplication(mra: { id: string } | null | undefined): { id: string } | null {
  if (mra == null || typeof mra.id !== "string") return null;
  return { id: mra.id };
}

/**
 * Project a wire-shape activity-item row into the public
 * {@link JobActivityItem} surface. The `availabilityRequest` field is
 * projected into the {@link AvailabilityRequestEmbed} shape (#539 —
 * extended from the prior `{ id }` presence indicator); the recruiter
 * Fixed rate is additionally flattened into `fixedRate` so consumers
 * can rate-triage without traversing the AR sub-shape.
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
    availabilityRequest: projectAvailabilityRequestEmbed(wire.availabilityRequest),
    interview: wire.interview,
    mostRelevantApplication: projectMostRelevantApplication(wire.mostRelevantApplication),
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
    availabilityRequest: projectAvailabilityRequestEmbed(wire.availabilityRequest),
    interview: wire.interview,
    mostRelevantApplication: projectMostRelevantApplication(wire.mostRelevantApplication),
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
// cover `packages/core/src/auth/**` + `packages/core/src/services/profile/**`
// — `applications/` is not in the gate's scan set, so the gate doesn't
// mechanically fire for this issue. The rule's INTENT is preserved
// via the explicit cross-issue commitment to #445.
//
// Surface coverage gate (`scripts/check-surface-coverage.ts`) does
// not currently scope `applications/` either (covered domains:
// `profile`, `engagements`, `payments`, `timesheet`, `scheduler`).
// The `applyData` / `applyQuestions` / `rateInsight` fns are wired
// to user-facing surfaces:
//   - `apply()` — `ttctl_jobs_apply` (#436)
//   - `applyData()` — `ttctl_jobs_apply_data` (#436) + (CLI #437 will
//     surface the questions-only projection via `jobs show
//     --with-questions`)
//   - `applyQuestions()` — `ttctl_jobs_apply_questions` (#436) +
//     `jobs show --with-questions` (#437)
//   - `rateInsight()` — `ttctl_jobs_apply_rate_insight` (#436)
// The forward-compatible `// surface-exempt:` markers below have
// therefore been removed (the fns are now genuinely surfaced).
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
 * One question on the apply form (#424, #584). The shape is uniform
 * across matcher and expertise variants per REQ-Q1; the choice-metadata
 * fields (`options` / `suggestedAnswer` / `inputType`, added in #584) are
 * meaningfully populated for matcher questions only and carry neutral
 * defaults for expertise questions (documented per-field below).
 *
 *   - `identifier` — the wire `id` field (`JobPositionQuestion.id` /
 *     `JobExpertiseQuestion.id`). Threaded into the apply-mutation
 *     answer arrays at asymmetric field names per the recovered SDL:
 *     `JobPositionAnswerInput.id` (matcher) and
 *     `JobExpertiseAnswerInput.questionId` (expertise). Both reference
 *     this same `identifier`; see ADR-008 § Decision Part 2 and #438
 *     for the recovered-shape rationale.
 *   - `prompt` — the human-readable question text. For matcher
 *     questions: the wire `question` field. For expertise questions:
 *     the `subject.name` (`Industry.name` or `Skill.name`) — expertise
 *     questions ask "which of your profile items demonstrates this
 *     skill / industry?", so the subject's name IS the prompt the
 *     user sees. (Note: the public field is `prompt`, NOT `body` — a
 *     prior `ttctl_jobs_apply_questions` docstring drifted to `body`;
 *     reconciled in #584.)
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
 *   - `options` — allowed values for a choice-style (dropdown) matcher
 *     question (#584). The wire's `JobPositionQuestion.options` scalar
 *     list, projected to a clean `string[]` (nulls / non-strings
 *     filtered). EMPTY for free-text matcher questions and for ALL
 *     expertise questions — expertise answers are profile-item
 *     selections (`subject.connections`), not an enumerable choice list
 *     at this surface, so the option cascade is intentionally not
 *     projected here (see #585 for the interest-request-accept reuse).
 *   - `suggestedAnswer` — the recruiter-preselected value the Toptal
 *     portal renders for a dropdown matcher question (#584). The wire's
 *     `JobPositionQuestion.suggestedAnswer { answer }`, lifted to the
 *     bare string. `null` when absent (free-text questions, dropdowns
 *     with no preselection) and always `null` for expertise questions.
 *   - `inputType` — input-mode discriminator derived MECHANICALLY from
 *     options-presence (#584): `"dropdown"` iff `options.length > 0`,
 *     else `"free-text"`. Lets a caller build a valid `matcherAnswers`
 *     entry without guessing the input mode (`options`-presence cleanly
 *     discriminates per the issue). Expertise questions always project
 *     `"free-text"` here (no enumerable options at this surface — the
 *     value is a faithful function of the empty `options`, NOT a claim
 *     that expertise answers are free text; their real answer mechanism
 *     is `expertiseQuestionsAnswers`).
 *
 * **`options` / `suggestedAnswer` are [INFERRED — UNVERIFIED]**: neither
 * field is in the synthesized schema (`JobPositionQuestion` declares only
 * `id` / `question`), and the captured op selects `suggestedAnswer
 * { __typename }` without `answer`. The selection-set expansion is
 * recovered from #584's manual GraphQL query; the live `*.e2e.test.ts`
 * (gated by `TTCTL_E2E=1`) is the wire authority per the schema/contract
 * rule.
 */
export interface ApplicationQuestion {
  identifier: string;
  prompt: string;
  type: "matcher" | "expertise";
  isMandatory: boolean;
  options: string[];
  suggestedAnswer: string | null;
  inputType: "dropdown" | "free-text";
}

/**
 * Questions inventory returned by {@link applyQuestions} (#424).
 * Mirrors the captured `JobApplicationQuestions` operation's two
 * parallel selections — `viewer.job.questions(hideExpertiseQuestion:
 * true)` for matcher questions, `viewer.job.expertiseQuestions` for
 * expertise — projecting each entry to the {@link ApplicationQuestion}
 * shape (including the #584 choice-metadata fields `options` /
 * `suggestedAnswer` / `inputType`). Empty arrays surface verbatim
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
//   - Per-variant aliases on `TalentJobRateInsight` union members
//     (`competitiveRevenue` / `uncompetitiveRevenue` for
//     `estimatedRevenue`, plus the matching `*Explanation` pair):
//     bare same-name selection was rejected with HTTP 400 on the
//     live wire (#610) despite the synthesized SDL declaring both
//     members compatible under FieldsInSetCanMerge. {@link RateInsightWire}
//     consumes the aliased keys.
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

// Reusable matcher-question selection (#584). Extracted as a named
// fragment-string so the interest-request-accept path (#585) can embed
// the IDENTICAL field set without duplicating the projection contract —
// the DEPENDENCY NOTE's "shared selection fragment + mapper" requirement.
// `options` + `suggestedAnswer { answer }` are the #584 additions: both
// are [INFERRED] (absent from the synthesized `JobPositionQuestion`,
// which declares only `id` / `question`; the captured op selected
// `suggestedAnswer { __typename }` with no `answer`). The live E2E is the
// wire authority per the schema/contract rule. Pair this string with the
// {@link projectMatcherQuestion} mapper + {@link MatcherQuestionWire}
// wire type — the three together are the single reuse seam for #585.
const MATCHER_QUESTION_SELECTION = `__typename
        id
        question
        isRequired
        options
        suggestedAnswer { __typename answer }`;

const JOB_APPLICATION_QUESTIONS_QUERY = `query JobApplicationQuestions($jobId: ID!) {
  viewer {
    __typename
    id
    job(id: $jobId) {
      __typename
      id
      questions(hideExpertiseQuestion: true) {
        ${MATCHER_QUESTION_SELECTION}
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
          competitiveRevenue: estimatedRevenue
          competitiveRevenueExplanation: estimatedRevenueExplanation
          longTermDisclaimer
        }
        ... on TalentJobRateInsightUncompetitive {
          __typename
          uncompetitiveRevenue: estimatedRevenue
          uncompetitiveRevenueExplanation: estimatedRevenueExplanation
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
  // #584 additions — [INFERRED]. `options` is the dropdown's allowed
  // values (scalar list, selected bare in #584's manual query); typed
  // as nullable-item list defensively since the wire-list nullability is
  // unverified. `suggestedAnswer` is an object with an `answer` field
  // (the captured op proved `suggestedAnswer` is an object by selecting
  // `{ __typename }`; the `answer` sub-field is the #584 inference).
  // Optional on the wire shape so pre-#584 fixtures still project.
  options?: (string | null)[] | null;
  suggestedAnswer?: { answer?: string | null } | null;
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

// Wire shape uses per-variant aliased keys (#610 — see query body for
// rationale); the public `RateInsight` type shares `estimatedRevenue` across
// kind-narrowed branches. {@link projectRateInsight} bridges. Adding a field
// here without updating the projection breaks at the type level.
type RateInsightWire =
  | {
      __typename: "TalentJobRateInsightCompetitive";
      competitiveRevenue: string | null;
      competitiveRevenueExplanation: string | null;
      longTermDisclaimer: string | null;
    }
  | {
      __typename: "TalentJobRateInsightUncompetitive";
      uncompetitiveRevenue: string | null;
      uncompetitiveRevenueExplanation: string | null;
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

/**
 * Project the wire `options` scalar list into a clean `string[]` (#584),
 * dropping null / non-string entries defensively (the wire-list item
 * nullability is unverified [INFERRED]). Absent / null list → `[]`.
 */
function projectQuestionOptions(options: (string | null)[] | null | undefined): string[] {
  if (options == null) return [];
  return options.filter((o): o is string => typeof o === "string");
}

/**
 * Project a wire matcher question into the public {@link ApplicationQuestion}
 * shape (#424, #584). The single mapper for the matcher-question contract —
 * reused by #585's interest-request-accept path alongside
 * {@link MATCHER_QUESTION_SELECTION} + {@link MatcherQuestionWire}.
 * `inputType` is derived MECHANICALLY from options-presence so it stays a
 * faithful function of the projected `options`.
 */
function projectMatcherQuestion(wire: MatcherQuestionWire): ApplicationQuestion {
  const options = projectQuestionOptions(wire.options);
  return {
    identifier: wire.id,
    prompt: wire.question,
    type: "matcher",
    isMandatory: wire.isRequired ?? false,
    options,
    suggestedAnswer: wire.suggestedAnswer?.answer ?? null,
    inputType: options.length > 0 ? "dropdown" : "free-text",
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
    // #584 choice-metadata fields are matcher-scoped. Expertise answers
    // are profile-item selections (`subject.connections`), not an
    // enumerable choice list at this surface, so neutral defaults apply:
    // empty options ⇒ `inputType: "free-text"` by the same mechanical
    // rule as matcher questions. See {@link ApplicationQuestion} JSDoc.
    options: [],
    suggestedAnswer: null,
    inputType: "free-text",
  };
}

function projectRateInsight(wire: RateInsightWire): RateInsight {
  if (wire.__typename === "TalentJobRateInsightCompetitive") {
    return {
      kind: "competitive",
      estimatedRevenue: wire.competitiveRevenue,
      estimatedRevenueExplanation: wire.competitiveRevenueExplanation,
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
    estimatedRevenue: wire.uncompetitiveRevenue,
    estimatedRevenueExplanation: wire.uncompetitiveRevenueExplanation,
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
 * Pre-apply matcher + expertise questions inventory for a job (#424,
 * #584). Wraps `JobApplicationQuestions($jobId)`; trims the captured
 * operation's expertise `subject.possibleAnswers` cascades — the
 * {@link ApplicationQuestion} shape is the public projection. Matcher
 * questions additionally surface the #584 choice metadata (`options` /
 * `suggestedAnswer` / `inputType`) so a caller can answer a dropdown
 * matcher question without dropping to raw GraphQL.
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
  FixedMetadataKindWire | FlexibleMetadataKindWire | MarketplaceFlexibleMetadataKindWire;

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
 * Dry-run path (`options.dryRun === true`): performs the SAME read-only
 * resolution as the apply path (the `GetAvailabilityRequestKind`
 * pre-fetch) when `kind` / `requestedHourlyRate` are omitted, then emits
 * a {@link DryRunPreview} carrying the CONCRETE resolved values — so an
 * irreversible accept is fully verifiable before commit (#593). The
 * irreversible `ConfirmAvailabilityRequest` mutation is NEVER issued
 * under dry-run; only the read-only resolution runs. When the caller
 * supplies BOTH `kind` and `requestedHourlyRate` explicitly, no
 * resolution is needed and dry-run stays zero-transport. Surfacing the
 * resolution under dry-run also catches a failing rate-resolution path
 * (an unknown id, or a #530-style metadata wire-break) in PREVIEW
 * rather than on the irreversible commit.
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
  // Resolve kind + defaultRate if either is missing — identically for
  // dry-run and apply, so the dry-run preview reflects the EXACT wire
  // request the apply path would send (#593). The resolution is a single
  // READ-ONLY `GetAvailabilityRequestKind` query; the irreversible
  // `ConfirmAvailabilityRequest` mutation is issued only on the apply
  // path below. When both are supplied, the pre-fetch is skipped — fewer
  // round-trips for advanced callers, and dry-run stays zero-transport.
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

  if (options.dryRun === true) {
    // Preview the EXACT wire request the apply path would send — the
    // resolution above has already filled `kind` / `requestedHourlyRate`
    // with the concrete values (#593). The irreversible mutation is
    // NEVER issued under dry-run; only the read-only resolution ran.
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: {
          operationName: "ConfirmAvailabilityRequest",
          query: CONFIRM_AVAILABILITY_REQUEST_MUTATION,
          variables,
        },
      }),
    };
  }

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

// ---------------------------------------------------------------------
// Direct-apply write-side op (#426) — `apply`. Wraps `JobApply` per
// ADR-008 § Decision Part 5: the new apply verb lives on the
// `applications` domain (symmetric with `applications.confirm` /
// `applications.reject` from #411) — NOT on `jobs.*`. The user-facing
// CLI verb is `ttctl jobs apply <job-id>` (#430) and the MCP tool is
// `ttctl_jobs_apply` (#436); both delegate into this fn.
//
// HAND-AUTHORED inline mutation string per the convention pinned by
// the rest of this module. `JobApply` is listed in `codegen.config.ts`'s
// `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` (the captured op selects
// fragments touching `Unknown`-typed positions on `JobOperationsApply`
// and the `NotificationContext` union; codegen refuses to emit types).
// The trimmed selection here picks ONLY the fields the
// {@link JobApplicationRecord} projection surfaces.
//
// CLAUDE.md schema/contract validation rule TRIGGERED — live E2E
// coverage deferred to #445 (`52-jobs-apply.e2e.test.ts`). Track 1
// disposition (snapshots) per the hybrid wire-validation model; the
// `<OpName>.snapshot.json` is committed in #445.
//
// Wire-quirk Q3 (consent field name): the variable is named
// `$consentIssued: Boolean!` but the input field on
// `JobApplyInput` is `understand` — confirmed against the captured
// `JobApply.graphql` operation document. The mutation string below
// maps `understand: $consentIssued` verbatim. If #445 live E2E reveals
// the field has been renamed (e.g. `consent_issued`, `acceptedTerms`),
// the inline mutation is the single place to fix.
//
// Wire-quirk Q1 (pitch variable name): the variable is named
// `$talentCard: PitchInput` (captured op) but the input field is
// `pitchData`. The {@link ApplyInput} surface uses ADR-008's
// MCP-side key name (`pitchData`) and the wire variable is mapped
// internally — the variable-name preservation matches the captured
// op verbatim, which keeps APQ pinning compatible if Toptal ever
// enables it server-side.
// ---------------------------------------------------------------------

/**
 * Input for {@link apply}. Field names mirror ADR-008's locked grammar
 * (`matcherAnswers` / `expertiseAnswers` / `pitchData` / `message`)
 * which is the MCP-side schema key set, NOT the wire-side variable
 * names (`matcherQuestionsAnswers`, `expertiseQuestionsAnswers`,
 * `talentCard`, `comment`). The service maps the public field names
 * onto the wire variables internally.
 *
 * **Consent gate**: `consentIssued` is the literal `true` — the
 * tightest type-system constraint TS supports, matching ADR-008
 * § Decision Part 4. The runtime check covers `as`-cast bypasses
 * and JSON-sourced inputs from the CLI/MCP layers where the type
 * system can't reach. Auto-filling consent on the caller's behalf is
 * FORBIDDEN by the same ADR; the service throws
 * `CONSENT_REQUIRED` BEFORE any wire call when omitted.
 *
 * **Rate default**: `requestedHourlyRate` is optional at the input
 * surface. When omitted, the service threads
 * `PreApplyData.suggestedRate` (the talent's own configured rate
 * `viewerRole.rates.hourly`) into the mutation per REQ-A4. If the
 * talent has no configured rate, the service throws `MUTATION_ERROR`.
 * The `rateInsight` payload returned by the pre-fetch suite serves as
 * additional guidance for the caller (CLI / MCP / agent) — not as a
 * silent default; callers surface it to the user before the apply.
 *
 * **Answer arrays**: `matcherAnswers` / `expertiseAnswers` are typed
 * against the recovered `JobPositionAnswerInput[]` /
 * `JobExpertiseAnswerInput[]` shapes (Stage 2 per #438; the recovered
 * schemas are committed in `packages/core/src/__generated__/zod-schemas.ts`).
 * The service validates each entry's id field against the inventory
 * returned by `applyQuestions(jobId)` and rejects unknown ids with
 * `WIRE_SHAPE_ERROR`. The id-field name is **asymmetric** per the
 * recovered SDL — matcher entries carry `id`, expertise entries carry
 * `questionId`.
 */
export interface ApplyInput {
  /**
   * Consent attestation — MUST be the literal `true`. Auto-filling
   * this field on the caller's behalf is FORBIDDEN per ADR-008
   * § Decision Part 4 (legal compliance).
   */
  consentIssued: true;
  /**
   * Hourly rate the talent requests for this engagement. Decimal
   * string (matches `BigDecimal!`). When omitted, the service
   * defaults from `PreApplyData.suggestedRate` (REQ-A4).
   */
  requestedHourlyRate?: string;
  /**
   * Optional talent-side free-text accompanying message. Mapped to
   * the wire's `$comment` variable / `JobApplyInput.comment` field.
   */
  message?: string;
  /**
   * Matcher-question answers (`JobPositionAnswerInput[]`). Each
   * entry MUST carry an `id` field matching one returned from
   * `applyQuestions(jobId).matcherQuestions[].identifier` — the
   * service rejects unknown ids with `WIRE_SHAPE_ERROR`. Stage 2
   * (#438) types the array against the recovered SDL shape
   * `{ answer: string, id: string }` (NOT `questionId` — distinct
   * from the expertise shape; this field-name asymmetry is per the
   * recovered SDL).
   */
  matcherAnswers?: JobPositionAnswerInput[];
  /**
   * Expertise-question answers (`JobExpertiseAnswerInput[]`). Each
   * entry's `questionId` is validated against
   * `applyQuestions(jobId).expertiseQuestions[].identifier`. Stage 2
   * (#438) types the array against the recovered SDL shape
   * `{ other: string|null, questionId: string, subjectId: string|null }`.
   */
  expertiseAnswers?: JobExpertiseAnswerInput[];
  /**
   * Pitch input (`PitchInput`). Mapped to the wire's `$talentCard`
   * variable / `JobApplyInput.pitchData` field. Stage 2 (#438) types
   * the field against the recovered `PitchInput` shape (`mentorship`
   * remains `unknown` per ADR-008 spike outcome — the position is
   * untyped in the SDL).
   */
  pitchData?: PitchInput;
}

/**
 * Projected `JobApplication` record returned by {@link apply} on the
 * apply-success path. Reads the post-mutation `JobApplication` echo
 * routed through the new activity-item's nested `jobApplication`
 * field on `TalentJob.activityItem`.
 *
 * Shape is the conservative initial projection per #426 AC; #445 live
 * E2E is the wire authority and may widen the projection if real
 * responses surface fields the CLI / MCP need to render.
 */
export interface JobApplicationRecord {
  /** `JobApplication.id` — the new application's identifier. */
  id: string;
  /** Application status (specific value + verbose label, projected from `TalentJobActivityItem.statusV2`). */
  statusV2: ApplicationStatus;
  /**
   * The rate the wire echoes back on the new `JobApplication`. The
   * captured op selects `requestedHourlyRate { decimal }` only — no
   * `verbose` — and the projection mirrors that selection until #445
   * confirms `verbose` is selectable on this position.
   */
  requestedHourlyRate: { decimal: string } | null;
  /**
   * The `TalentJobActivityItem.id` that wraps the new application —
   * the id callers pass to `applications show` to view the new row.
   */
  jobActivityItemId: string;
}

/**
 * Apply-path outcome for {@link apply}. Carries the post-mutation
 * {@link JobApplicationRecord} projection.
 */
export interface JobApplyAppliedOutcome {
  kind: "applied";
  result: JobApplicationRecord;
}

/**
 * Dry-run outcome for {@link apply}. Mirrors the
 * `AvailabilityRequestDryRunPreviewOutcome` pattern from #411 —
 * named separately for surface symmetry on the apply path.
 */
export interface JobApplyDryRunPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link apply}.
 */
export type ApplyOutcome = JobApplyAppliedOutcome | JobApplyDryRunPreviewOutcome;

const JOB_APPLY_MUTATION = `mutation JobApply($id: ID!, $comment: String, $matcherQuestionsAnswers: [JobPositionAnswerInput!], $expertiseQuestionsAnswers: [JobExpertiseAnswerInput!], $consentIssued: Boolean!, $requestedHourlyRate: BigDecimal!, $talentCard: PitchInput) {
  job(id: $id) {
    __typename
    apply(input: {
      comment: $comment
      matcherQuestionsAnswers: $matcherQuestionsAnswers
      expertiseQuestionsAnswers: $expertiseQuestionsAnswers
      understand: $consentIssued
      requestedHourlyRate: $requestedHourlyRate
      pitchData: $talentCard
    }) {
      __typename
      success
      errors { __typename code key message }
      job {
        __typename
        id
        activityItem {
          __typename
          id
          statusV2 { __typename value verbose }
          jobApplication {
            __typename
            id
            requestedHourlyRate { __typename decimal }
          }
        }
      }
    }
  }
}`;

interface JobApplyJobApplicationWire {
  id: string;
  requestedHourlyRate: { decimal: string } | null;
}

interface JobApplyActivityItemWire {
  id: string;
  statusV2: ApplicationStatus;
  jobApplication: JobApplyJobApplicationWire | null;
}

interface JobApplyPayloadWire {
  success: boolean;
  errors: MutationResultErrors[] | null;
  job: {
    id: string;
    activityItem: JobApplyActivityItemWire | null;
  } | null;
}

interface JobApplyResponse {
  job: {
    apply: JobApplyPayloadWire | null;
  } | null;
}

function projectJobApplicationRecord(activityItem: JobApplyActivityItemWire): JobApplicationRecord {
  if (activityItem.jobApplication === null) {
    throw new ApplicationsError("UNKNOWN", "JobApply returned success but activityItem.jobApplication was null.");
  }
  return {
    id: activityItem.jobApplication.id,
    statusV2: activityItem.statusV2,
    requestedHourlyRate: activityItem.jobApplication.requestedHourlyRate,
    jobActivityItemId: activityItem.id,
  };
}

/**
 * Structural validation: every entry in `answers[]` must carry a
 * string id at `idField` matching one of `validIds`. Rejects unknown
 * ids with `WIRE_SHAPE_ERROR` carrying the offending array path
 * (e.g. `matcherAnswers[2]`) so callers can fix the input.
 *
 * `idField` is parameterized because the recovered SDL uses
 * **asymmetric field names** across the two answer types — matcher
 * answers (`JobPositionAnswerInput`) carry the id at `id`, while
 * expertise answers (`JobExpertiseAnswerInput`) carry it at
 * `questionId`. See #438 § Stage-2 tightening (the recovered shapes
 * are committed in `packages/core/src/__generated__/zod-schemas.ts`
 * and treated as the canonical wire-contract authority).
 */
function validateAnswerIds(
  answers: readonly unknown[] | undefined,
  validIds: Set<string>,
  path: string,
  idField: "id" | "questionId",
): void {
  if (answers === undefined) return;
  for (let i = 0; i < answers.length; i++) {
    const entry = answers[i];
    if (typeof entry !== "object" || entry === null) {
      throw new ApplicationsError(
        "WIRE_SHAPE_ERROR",
        `${path}[${i}]: not an object — expected { ${idField}, answer, ... }.`,
      );
    }
    const qid = (entry as Record<string, unknown>)[idField];
    if (typeof qid !== "string") {
      throw new ApplicationsError("WIRE_SHAPE_ERROR", `${path}[${i}]: missing or non-string "${idField}" property.`);
    }
    if (!validIds.has(qid)) {
      throw new ApplicationsError(
        "WIRE_SHAPE_ERROR",
        `${path}[${i}]: ${idField} "${qid}" does not match any question returned from applyQuestions().`,
      );
    }
  }
}

/**
 * Direct-apply to a Toptal job — wire `JobApply` (#426, ADR-008
 * § Decision Part 5).
 *
 * Flow:
 *
 *   1. **Consent gate**: refuses the call (`CONSENT_REQUIRED`) BEFORE
 *      any wire call when `input.consentIssued !== true`. Type-system
 *      gate at `ApplyInput.consentIssued: true` covers compile-time;
 *      the runtime check covers `as`-cast bypasses and JSON-sourced
 *      inputs.
 *   2. **Dry-run short-circuit**: when `options.dryRun === true`,
 *      emits a {@link DryRunPreview} with the prepared variables
 *      (including `<resolved at apply time>` placeholders for fields
 *      that would have been resolved by the pre-fetch) and returns
 *      `{ kind: "preview", preview }`. Zero wire calls under dry-run —
 *      including the 3 pre-fetch calls.
 *   3. **Pre-fetch via Promise.all**: runs `applyData` +
 *      `applyQuestions` + `rateInsight` concurrently. Promise.all
 *      rejects-on-first; any pre-fetch failure (NOT_FOUND,
 *      GRAPHQL_ERROR, AuthRevokedError) blocks the apply.
 *   4. **Answer validation**: every `matcherAnswers[]` /
 *      `expertiseAnswers[]` entry's `questionId` must resolve against
 *      the inventory; unknown ids throw `WIRE_SHAPE_ERROR` with the
 *      offending array path.
 *   5. **Rate default**: when `input.requestedHourlyRate` is omitted,
 *      threads `PreApplyData.suggestedRate` (the talent's own
 *      configured rate). Throws `MUTATION_ERROR` if neither source
 *      yields a rate.
 *   6. **Wire call**: issues `JobApply` against the mobile gateway.
 *   7. **Error mapping**: a `MutationResult.errors[]` entry with
 *      `key === "already_applied"` is mapped to `ALREADY_APPLIED`
 *      with a hint pointing at `ttctl applications show
 *      <activity-id>`. Other `success: false` responses surface as
 *      `MUTATION_ERROR` with the formatted error detail.
 *
 * **Bad-id behavior**: mutations crash 500 on bad ids per
 * `project-toptal-wire-quirks` auto-memory. The service does NOT
 * pre-validate the job id; the pre-fetch suite (`applyData` etc.)
 * already surfaces NOT_FOUND via the shared widened
 * {@link NOT_FOUND_MESSAGE_PATTERN} when the bad id is detected
 * read-side.
 */
export async function apply(
  token: string,
  jobId: string,
  input: ApplyInput,
  options: DryRunOptions = {},
): Promise<ApplyOutcome> {
  // Consent gate — runtime check covers `as`-cast bypasses and
  // JSON-sourced inputs from CLI/MCP. Fires BEFORE any wire call (no
  // pre-fetch under refusal either — the dry-run path below still
  // honors the consent gate so a probe with `consentIssued: false`
  // does not emit a preview for a call that would have been refused).
  //
  // The widening cast (`as { consentIssued: unknown }`) is load-bearing:
  // the static type `consentIssued: true` (literal) narrows the value
  // to compile-time-true, which makes `!== true` look like dead code to
  // the linter. The runtime check exists for the bypass paths the type
  // system can't reach (CLI / MCP / agents passing JSON), where the
  // value may genuinely be `undefined` or `false`.
  if ((input as { consentIssued: unknown }).consentIssued !== true) {
    throw new ApplicationsError(
      "CONSENT_REQUIRED",
      "Apply requires explicit consent: `consentIssued: true` is mandatory before any wire call.",
    );
  }

  if (options.dryRun === true) {
    // Skip the pre-fetch entirely (zero transport calls under dry-run)
    // and emit a preview with placeholders for fields that would have
    // been resolved live. Matches the
    // `applications.confirm()` skipped-prefetch pattern.
    const previewVariables: Record<string, unknown> = {
      id: jobId,
      comment: input.message ?? null,
      matcherQuestionsAnswers: input.matcherAnswers ?? null,
      expertiseQuestionsAnswers: input.expertiseAnswers ?? null,
      consentIssued: true,
      requestedHourlyRate: input.requestedHourlyRate ?? "<resolved at apply time>",
      talentCard: input.pitchData ?? null,
    };
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: {
          operationName: "JobApply",
          query: JOB_APPLY_MUTATION,
          variables: previewVariables,
        },
      }),
    };
  }

  const [preApply, questions] = await Promise.all([applyData(token, jobId), applyQuestions(token, jobId)]);

  // #426 wire-traffic parity; result unused but the mobile app issues
  // this alongside the blocking pre-fetches. Fire-and-forget per #610
  // so a rate-insight wire regression cannot block JobApply.
  void rateInsight(token, jobId).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: JobApplicationRateInsight pre-fetch failed (apply continues): ${message}\n`);
  });

  // Structural validation: every answer's id must resolve against
  // the inventory. The id-field name is asymmetric per the recovered
  // SDL — matcher answers use `id`, expertise answers use
  // `questionId` (see {@link validateAnswerIds} for the rationale).
  const matcherIds = new Set(questions.matcherQuestions.map((q) => q.identifier));
  const expertiseIds = new Set(questions.expertiseQuestions.map((q) => q.identifier));
  validateAnswerIds(input.matcherAnswers, matcherIds, "matcherAnswers", "id");
  validateAnswerIds(input.expertiseAnswers, expertiseIds, "expertiseAnswers", "questionId");

  // Rate default per REQ-A4 — caller-supplied overrides
  // `PreApplyData.suggestedRate`. Throw `MUTATION_ERROR` if neither
  // source produces a rate; the wire `$requestedHourlyRate` is
  // `BigDecimal!` (non-null).
  const requestedHourlyRate = input.requestedHourlyRate ?? preApply.suggestedRate;
  if (requestedHourlyRate === null) {
    throw new ApplicationsError(
      "MUTATION_ERROR",
      "requestedHourlyRate is required and could not be defaulted from PreApplyData.suggestedRate — pass an explicit rate.",
    );
  }

  const variables: Record<string, unknown> = {
    id: jobId,
    comment: input.message ?? null,
    matcherQuestionsAnswers: input.matcherAnswers ?? null,
    expertiseQuestionsAnswers: input.expertiseAnswers ?? null,
    consentIssued: true,
    requestedHourlyRate,
    talentCard: input.pitchData ?? null,
  };

  const data = await callGatewayNoViewer<JobApplyResponse>(token, "JobApply", JOB_APPLY_MUTATION, variables);
  if (data.job === null || data.job.apply === null) {
    throw new ApplicationsError("UNKNOWN", "JobApply returned a null payload.");
  }
  const payload = data.job.apply;
  if (!payload.success) {
    // Map the wire's `already_applied` key to the typed
    // `ALREADY_APPLIED` code so callers can render a targeted "you
    // already applied" hint. Other `success: false` envelopes flow
    // through the generic `MUTATION_ERROR` taxonomy.
    const errors = payload.errors ?? [];
    if (errors.some((e) => e.key === "already_applied")) {
      throw new ApplicationsError(
        "ALREADY_APPLIED",
        `You have already applied to job "${jobId}". Run \`ttctl applications show <activity-id>\` to find your existing application.`,
      );
    }
    throw new ApplicationsError("MUTATION_ERROR", formatMutationErrors("JobApply failed", errors));
  }
  if (payload.job === null || payload.job.activityItem === null) {
    throw new ApplicationsError("UNKNOWN", "JobApply returned success but the job / activityItem echo was null.");
  }
  return { kind: "applied", result: projectJobApplicationRecord(payload.job.activityItem) };
}

// ---------------------------------------------------------------------
// Opt-in similar-answer suggestion read op (#452) — `similarAnswers`.
// Wraps `SimilarJobQuestionAnswers($id)` against the mobile gateway.
//
// HAND-AUTHORED inline query string per the convention pinned by the
// rest of this module. `SimilarJobQuestionAnswers` is listed in
// `codegen.config.ts`'s `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` (line 273)
// because the captured op uses the `JobPositionAnswerFiltersInput`
// shape (with `forQuestionsSimilarToQuestionId: ID!` and `uniqueAnswer:
// Boolean`) which is not declared in the synthesized schema
// (`viewer.jobPositionAnswers` is declared with no arguments); codegen
// refuses to emit types for the op. T1 disposition (snapshot) per the
// hybrid wire-validation model.
//
// CLAUDE.md schema/contract validation rule TRIGGERED — the operation
// is hand-authored. Live E2E coverage ships in this PR
// (`packages/e2e/src/53-jobs-apply-similar-answers.e2e.test.ts`) with
// the wire-shape snapshot at
// `packages/e2e/src/wire-snapshots/SimilarJobQuestionAnswers.snapshot.json`.
//
// **Wire shape vs issue body deviation**: the captured op selects
// `nodes { id answer createdAt }` — the `JobPositionAnswer` shape on
// the wire carries `{ id, answer }` (per
// `research/graphql/gateway/schema.graphql:1134`) plus a `createdAt`
// scalar that is not in the synthesized schema (gap region). The
// captured op does NOT select a source-job reference (no `sourceJobId`
// / `sourceJobTitle`). The issue body's proposed projection
// `{ value, sourceJobId, sourceJobTitle }` was an authoring intuition;
// the captured op is authoritative per CLAUDE.md "define shape based
// on captured operation's selection set". The public projection here
// surfaces the captured fields as `{ id, answer, createdAt }`.
//
// **Cardinality**: the wire takes ONE `questionId` per call (the
// filter `forQuestionsSimilarToQuestionId: $id`). To fetch suggestions
// for every question on a job, the fn first resolves the question
// inventory via {@link applyQuestions} then issues N parallel
// `SimilarJobQuestionAnswers` calls (one per matcher + expertise
// question) via `Promise.all`. The N+1 fan-out is intentional — the
// mobile app's apply screen exhibits the same fan-out pattern (one
// fetch per question's autocomplete dropdown).
//
// **Off the critical path**: this op is deliberately NOT in the
// 3-query pre-apply suite of `apply()`. Adding it would slow EVERY
// apply call (semantic-similarity computation server-side); the CLI
// `--suggest-answers` flag is opt-in for the same reason.
// ---------------------------------------------------------------------

/**
 * One historical answer to a question similar to the queried one.
 * Wire selection: `JobPositionAnswer { id answer createdAt }` per the
 * captured `SimilarJobQuestionAnswers.graphql` operation. `createdAt`
 * is selected on a schema-gap position (`JobPositionAnswer.createdAt`
 * is not declared on the synthesized SDL — see the schema-gap note in
 * the inline query string below); the projection is `string` here per
 * the empirical wire shape, the T1 snapshot is the authority.
 */
export interface SimilarJobAnswer {
  /** `JobPositionAnswer.id` — the historical answer's identifier. */
  id: string;
  /** The historical answer text (`JobPositionAnswer.answer`). */
  answer: string;
  /** ISO 8601 timestamp the historical answer was authored. */
  createdAt: string;
}

/**
 * One group of suggestions, keyed by the question identifier the
 * suggestions were resolved against. `questionId` mirrors the wire
 * filter (`forQuestionsSimilarToQuestionId: <questionId>`). The
 * `suggestions` array carries the talent's own historical answers to
 * SIMILAR questions on prior applications — useful as autocomplete
 * candidates the user can review and selectively re-use when authoring
 * an application.
 *
 * Empty `suggestions` arrays surface verbatim: the wire returned zero
 * similar-job history for this question. Common for new talent
 * accounts and unique question prompts.
 */
export interface SimilarJobAnswerGroup {
  /**
   * The `ApplicationQuestion.identifier` (from
   * {@link ApplicationQuestion}) the suggestions were resolved
   * against — both matcher and expertise question identifiers are
   * accepted.
   */
  questionId: string;
  /**
   * Historical answers to questions semantically similar to the one
   * identified by `questionId`. Order is server-supplied; the helper
   * does NOT re-sort.
   */
  suggestions: SimilarJobAnswer[];
}

// Captured operation document at
// `../research/graphql/gateway/operations/mobile/SimilarJobQuestionAnswers.graphql`
// and `research/apk/decoded/smali/fn/ji.smali:89` (verbatim:
// `query SimilarJobQuestionAnswers($id: ID!) { viewer { __typename id
// jobPositionAnswers(filters: { forQuestionsSimilarToQuestionId: $id
// uniqueAnswer: true } , pageSize: 10) { __typename nodes
// { __typename id answer createdAt } } } }`).
//
// Schema gaps:
//   - `viewer.jobPositionAnswers(filters:, pageSize:)` — the
//     synthesized schema declares the field as
//     `viewer.jobPositionAnswers: [JobPositionAnswer]!` with no args
//     (line 814). The captured op passes both `filters` (a
//     `JobPositionAnswerFiltersInput { forQuestionsSimilarToQuestionId,
//     uniqueAnswer }`) and `pageSize`. Empirically these work — the
//     mobile app calls this every time the apply screen renders a
//     question autocomplete; the live E2E + T1 snapshot are the
//     authority.
//   - The return shape on the wire is a connection-like
//     `{ nodes: JobPositionAnswer[] }` rather than the schema's bare
//     `[JobPositionAnswer]!` list. The captured op selects `nodes`
//     verbatim; the projection unwraps to the bare list.
//   - `JobPositionAnswer.createdAt` is not declared in the synthesized
//     SDL (`type JobPositionAnswer` at line 1134 carries only `answer`,
//     `id`, `question`). The captured op selects it anyway — same gap
//     pattern as `availabilityRequest.metadata.offeredHourlyRate` (#410)
//     where the trimmed mobile selection extends the schema. T1 snapshot
//     is the authority.
const SIMILAR_JOB_QUESTION_ANSWERS_QUERY = `query SimilarJobQuestionAnswers($id: ID!) {
  viewer {
    __typename
    id
    jobPositionAnswers(filters: { forQuestionsSimilarToQuestionId: $id, uniqueAnswer: true }, pageSize: 10) {
      __typename
      nodes {
        __typename
        id
        answer
        createdAt
      }
    }
  }
}`;

interface SimilarJobAnswerWire {
  id: string;
  answer: string;
  createdAt: string;
}

interface SimilarJobQuestionAnswersResponse {
  data?: {
    viewer: {
      id: string;
      jobPositionAnswers: {
        nodes: (SimilarJobAnswerWire | null)[] | null;
      } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Project the wire's `jobPositionAnswers.nodes[]` into the public
 * {@link SimilarJobAnswer}[] shape. Filters list-entry nulls
 * defensively (the schema declares `[JobPositionAnswer]!` as a
 * non-null LIST with nullable entries; the captured op honors the
 * same nullability); the resulting list always carries non-null
 * entries.
 */
function projectSimilarAnswers(nodes: (SimilarJobAnswerWire | null)[] | null | undefined): SimilarJobAnswer[] {
  if (nodes == null) return [];
  return nodes
    .filter((n): n is SimilarJobAnswerWire => n !== null)
    .map((n) => ({ id: n.id, answer: n.answer, createdAt: n.createdAt }));
}

/**
 * Fetch one question's similar-answer suggestions from the gateway.
 * Internal helper; the public surface is {@link similarAnswers} which
 * fans out across the full question inventory of a job.
 *
 * `questionId` is the `ApplicationQuestion.identifier` (either matcher
 * or expertise — the wire accepts both since they're both `Node`-typed
 * via `JobPositionQuestion.id` / `JobExpertiseQuestion.id`).
 *
 * Bad-id behavior: an unknown `questionId` surfaces as the shared
 * Relay decode error pattern (`Node id ... resolves to ...`) and is
 * remapped to `NOT_FOUND` via the widened
 * {@link NOT_FOUND_MESSAGE_PATTERN}.
 *
 * @throws `ApplicationsError("NOT_FOUND")` when the questionId
 *   doesn't resolve.
 * @throws `ApplicationsError("NO_VIEWER")` when the session is valid
 *   but no viewer is bound (defensive — `callGateway` with
 *   `requireViewer: true` already raises this case).
 */
async function similarAnswersForQuestion(token: string, questionId: string): Promise<SimilarJobAnswer[]> {
  let data: SimilarJobQuestionAnswersResponse["data"] & object;
  try {
    data = await callGateway<SimilarJobQuestionAnswersResponse["data"] & object>(
      token,
      "SimilarJobQuestionAnswers",
      SIMILAR_JOB_QUESTION_ANSWERS_QUERY,
      { id: questionId },
    );
  } catch (err) {
    if (
      err instanceof ApplicationsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new ApplicationsError(
        "NOT_FOUND",
        `No question found with id "${questionId}" (or you don't have access to it).`,
        { cause: err },
      );
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  // The wire returns `jobPositionAnswers: null` for unknown ids on
  // some accounts (instead of a top-level GraphQL error). Treat the
  // null connection as "no similar answers" rather than NOT_FOUND —
  // the wire authoritatively returned a successful response.
  if (data.viewer.jobPositionAnswers === null) return [];
  return projectSimilarAnswers(data.viewer.jobPositionAnswers.nodes);
}

/**
 * Fetch the talent's similar-answer suggestions for every question on
 * a job's apply form (#452).
 *
 * Returns one {@link SimilarJobAnswerGroup} per question — matcher
 * AND expertise. The order mirrors the underlying
 * {@link applyQuestions} inventory (matcher questions first, then
 * expertise; server-supplied order within each section).
 *
 * **Cardinality**: N+1 wire calls — first an {@link applyQuestions}
 * fetch to resolve the question identifier list, then N parallel
 * `SimilarJobQuestionAnswers` calls (one per question) via
 * `Promise.all`. The fan-out matches the mobile app's apply-screen
 * autocomplete behavior; aggregating server-side is not exposed by
 * the wire.
 *
 * **Bad-id behavior**: a bad `jobId` surfaces NOT_FOUND from
 * `applyQuestions` (same mapping as the rest of the pre-apply suite).
 * A per-question `SimilarJobQuestionAnswers` call that surfaces
 * NOT_FOUND propagates verbatim via `Promise.all`'s reject-on-first
 * — intentional: callers that want graceful per-question fallback
 * (e.g. the CLI's `--suggest-answers` flag) should catch the rejection
 * and continue without suggestions.
 *
 * **Performance**: when the job has zero questions, the call resolves
 * to `[]` after the single `applyQuestions` fetch — no wasted parallel
 * round-trips. When the job has questions but the talent's account
 * has no similar-job history, each per-question call returns an empty
 * `suggestions` array; surface the empty grouping verbatim.
 *
 * **Off the critical apply path**: this fn is NOT called from
 * {@link apply}. It's opt-in via the CLI's `--suggest-answers` flag
 * (#452) and the MCP's `ttctl_jobs_apply_similar_answers` tool. The
 * design rationale is in the ADR-008 follow-ups thread.
 *
 * @param token - Bearer token from the resolved auth config.
 * @param jobId - The `TalentJob.id` to resolve questions against.
 * @throws `ApplicationsError("NOT_FOUND")` when the jobId or a
 *   resolved questionId doesn't resolve.
 * @throws `ApplicationsError("NO_VIEWER")` for sessions with no
 *   bound viewer.
 */
export async function similarAnswers(token: string, jobId: string): Promise<SimilarJobAnswerGroup[]> {
  const questions = await applyQuestions(token, jobId);
  const allIdentifiers = [
    ...questions.matcherQuestions.map((q) => q.identifier),
    ...questions.expertiseQuestions.map((q) => q.identifier),
  ];
  if (allIdentifiers.length === 0) return [];
  const suggestions = await Promise.all(allIdentifiers.map((qid) => similarAnswersForQuestion(token, qid)));
  return allIdentifiers.map((questionId, i) => ({ questionId, suggestions: suggestions[i] ?? [] }));
}

// ---------------------------------------------------------------------
// Interview detail (#439)
//
// `applications.interviews.show(id)` — read-only fetch of one
// `TalentInterview` via the mobile-gateway `Interview` query. The id is
// the `TalentInterview.id` surfaced on `applications.show(<activityId>)`
// as the `Interview: <id>` line. Where `applications.show` is the
// activity-row detail with an interview-presence indicator, this leaf
// is the rich interview detail — interviewer contacts, scheduled slot,
// agenda link, prep-guide ref, and the talent's own notes.
//
// **Operation document**: the captured
// `research/graphql/gateway/operations/mobile/Interview.graphql` is a
// large cascade (~25 types via `interviewWithJobActivityFields →
// jobActivityItemData`). Same posture as `JobActivityItem` (line 651):
// inline a trimmed selection that touches only the fields the CLI / MCP
// renders. Authoritative wire shape is the captured doc; selection is
// the projection contract.
//
// **T1 disposition (#439)**: `Interview` is in
// `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`), so no
// `InterviewQuery` type is generated. Wire shape is pinned by the
// committed `Interview.snapshot.json` and asserted on every
// `TTCTL_E2E=1` run via `assertWireShapeStable`.
// ---------------------------------------------------------------------

/**
 * `InterviewStatusEnum` values from the synthesized schema
 * (`../research/graphql/gateway/schema.graphql`). Closed set.
 */
export type InterviewStatus =
  "ACCEPTED" | "MISSED" | "PENDING" | "REJECTED" | "SCHEDULED" | "TIME_ACCEPTED" | "TIME_REJECTED";

export const INTERVIEW_STATUSES: readonly InterviewStatus[] = [
  "ACCEPTED",
  "MISSED",
  "PENDING",
  "REJECTED",
  "SCHEDULED",
  "TIME_ACCEPTED",
  "TIME_REJECTED",
] as const;

/**
 * `InterviewKindEnum` values from the synthesized schema. `INTERNAL`
 * = interview between talent and Toptal (vetting); `EXTERNAL` =
 * interview between talent and client (post-match).
 */
export type InterviewKind = "EXTERNAL" | "INTERNAL";

/**
 * `TalentInterviewMethodTypeEnum` values from the synthesized schema.
 * Typed as a string for forward compatibility with un-enumerated future
 * members (the wire is untrusted; new method types may appear without
 * codegen warning).
 */
export type InterviewMethodType = string;

/**
 * Time-zone descriptor. `value` is the IANA-ish zone name; `location`
 * is a human-readable label. Either may be `null` when the wire omits
 * the field.
 */
export interface InterviewTimeZone {
  value: string | null;
  location: string | null;
}

/** One file attached to a contact's TopChat conversation thread. */
export interface InterviewTopChatUpload {
  id: string;
  filename: string | null;
  url: string | null;
}

/**
 * Discovery handle for the TopChat conversation thread on an interviewer
 * contact: conversation id, Slack channel, and attached-file metadata. The
 * full conversation surface (messages, downloads) is out of scope here.
 */
export interface InterviewTopChatConversation {
  id: string;
  /** From the conversation `service`, when it is a Slack service. */
  slackChannelId: string | null;
  uploads: InterviewTopChatUpload[];
}

/**
 * One interviewer-side contact (recruiter, client representative, etc.).
 * `main: true` flags the primary contact on the interview.
 */
export interface InterviewContact {
  id: string;
  fullName: string | null;
  email: string | null;
  phoneNumber: string | null;
  position: string | null;
  main: boolean | null;
  timeZone: InterviewTimeZone | null;
  topChatConversation: InterviewTopChatConversation | null;
}

/**
 * Method by which the interview will be conducted (Zoom, phone, etc.).
 *
 * - `typeV2` — one of the `TalentInterviewMethodTypeEnum` members
 *   (`ZOOM`, `PHONE`, `BLUEJEANS`, `CUSTOM_WEB_CONFERENCE`,
 *   `GOOGLE_HANGOUTS`, `SKYPE`). Stringly-typed because the wire is
 *   untrusted; the codegen-exclusion may add new members.
 * - `conferenceUrl` — meeting link for `ZOOM` / `BLUEJEANS` /
 *   `GOOGLE_HANGOUTS` / `CUSTOM_WEB_CONFERENCE` methods.
 * - `resource` — free-text channel string (phone number for `PHONE`,
 *   handle for `SKYPE`).
 */
export interface InterviewMethod {
  typeV2: InterviewMethodType | null;
  conferenceUrl: string | null;
  resource: string | null;
}

/**
 * One free-form note the talent has attached to the interview. `section`
 * is one of the `InterviewGuideSectionIdentifierEnum` members
 * (`ASK_YOUR_CLIENT`, `GAPS`, `JOB_HIGHLIGHTS`, `POTENTIAL_QUESTIONS`,
 * `PRO_TIPS`, `STRENGTHS`) or `null` when the note isn't section-pinned.
 */
export interface InterviewTalentNote {
  id: string;
  section: string | null;
  note: string | null;
}

/**
 * Back-pointer to the parent job + activity item, plus the job `title`
 * for at-a-glance identification (#696). The heavy `jobActivityItemData`
 * cascade stays trimmed — drill in via `applications show <activityId>`.
 */
export interface InterviewJobRef {
  /** `TalentJob.id`. */
  id: string;
  /** `TalentJob.title` — human-readable job title. `null` when the wire elides it. */
  title: string | null;
  /** `TalentJobActivityItem.id` for the activity row containing this interview. */
  activityItemId: string | null;
}

/** Reachable client-side channels. */
export interface InterviewClientContactFields {
  communitySlackId: string | null;
  email: string | null;
  phoneNumber: string | null;
  skype: string | null;
}

/** Client-side contact. `contactFields` is `null` when the client has no channels. */
export interface InterviewClientContactInfo {
  id: string;
  contactFields: InterviewClientContactFields | null;
}

/**
 * Projected interview detail returned by `interviews.show()`. The shape
 * the CLI's pretty renderer and the MCP tool's JSON payload depend on.
 */
export interface InterviewDetail {
  id: string;
  /** `InterviewStatusEnum` member (see {@link INTERVIEW_STATUSES}) or null. */
  status: InterviewStatus | null;
  /** `InterviewKindEnum` member or null. */
  kind: InterviewKind | null;
  /** Free-text interview-type label (legacy; modern wire prefers {@link kind}). */
  interviewType: string | null;
  /** Duration / display string (e.g. `"30 minutes"`). */
  interviewTime: string | null;
  /** Recruiter brief, markdown-formatted. */
  information: string | null;
  /** Who scheduled the interview (display string). */
  initiator: string | null;
  /** Proposed slot timestamps (ISO 8601). */
  scheduledAtTimes: string[];
  /** Free-text scheduling comment from the initiator. */
  schedulingComment: string | null;
  /** Conference method (Zoom, phone, …) — `null` until the slot is locked. */
  method: InterviewMethod | null;
  /** Interviewer contacts. Server-supplied order preserved. */
  contacts: InterviewContact[];
  /** Client-side contact, distinct from {@link contacts}. `null` on INTERNAL interviews. */
  clientContactInfo: InterviewClientContactInfo | null;
  /** Prep-guide id (presence indicator). Full guide is the `InterviewGuide` op, out of scope here. */
  guideId: string | null;
  /** Talent's own notes attached to the interview. Server order preserved. */
  talentNotes: InterviewTalentNote[];
  /** Back-pointer to the parent job + activity item. */
  job: InterviewJobRef | null;
  /** Server-supplied last-mutation timestamp (ISO 8601). */
  updatedAt: string | null;
}

// ---------------------------------------------------------------------
// Wire shape (private to the interviews namespace)
// ---------------------------------------------------------------------

interface WireInterviewTimeZone {
  value?: string | null;
  location?: string | null;
}

interface WireInterviewTopChatUpload {
  id: string;
  filename?: string | null;
  url?: string | null;
}

// `service` is a single-member union; the inline fragment on
// TopChatConversationSlackService flattens to `channelId` at projection time.
interface WireInterviewTopChatConversationService {
  channelId?: string | null;
}

interface WireInterviewTopChatConversation {
  id: string;
  service?: WireInterviewTopChatConversationService | null;
  uploads?: (WireInterviewTopChatUpload | null)[] | null;
}

interface WireInterviewContact {
  id: string;
  fullName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  position?: string | null;
  main?: boolean | null;
  timeZone?: WireInterviewTimeZone | null;
  topChatConversation?: WireInterviewTopChatConversation | null;
}

interface WireInterviewClientContactFields {
  communitySlackId?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  skype?: string | null;
}

interface WireInterviewClientContactInfo {
  id: string;
  contactFields?: WireInterviewClientContactFields | null;
}

interface WireInterviewMethod {
  typeV2?: string | null;
  conferenceUrl?: string | null;
  resource?: string | null;
}

interface WireInterviewTalentNote {
  id: string;
  section?: string | null;
  note?: string | null;
}

interface WireInterviewGuide {
  id: string;
}

interface WireInterviewJobRef {
  id: string;
  title?: string | null;
  activityItem?: { id: string } | null;
}

interface WireInterviewStatusV2 {
  value?: string | null;
}

interface WireInterview {
  id: string;
  /**
   * Aliased on the wire as `interviewStatus: statusV2`. The captured
   * `interviewFields` fragment uses this alias to avoid collision with
   * other `statusV2` shapes in the response.
   */
  interviewStatus?: WireInterviewStatusV2 | null;
  kind?: string | null;
  interviewType?: string | null;
  interviewTime?: string | null;
  information?: string | null;
  initiator?: string | null;
  scheduledAtTimes?: (string | null)[] | null;
  schedulingComment?: string | null;
  interviewMethod?: WireInterviewMethod | null;
  interviewContacts?: (WireInterviewContact | null)[] | null;
  // Aliased on the wire as `clientContactInfo: client`.
  clientContactInfo?: WireInterviewClientContactInfo | null;
  guide?: WireInterviewGuide | null;
  talentNotes?: (WireInterviewTalentNote | null)[] | null;
  job?: WireInterviewJobRef | null;
  updatedAt?: string | null;
}

interface InterviewResponse {
  viewer: {
    id: string;
    interview: WireInterview | null;
  } | null;
}

// Strict subset of the captured Interview op in
// `research/graphql/gateway/operations/mobile/Interview.graphql`.
// Authoritative wire shape is the captured doc; selection is the
// projection contract (by-design trims documented on `interviewsShow`).
// `statuses: ALL` keeps parity with the captured op so any interview
// state is fetchable.
const INTERVIEW_QUERY = `query Interview($id: ID!) {
  viewer {
    __typename
    id
    interview(id: $id, statuses: ALL) {
      __typename
      id
      interviewStatus: statusV2 { __typename value }
      kind
      interviewType
      interviewTime
      information
      initiator
      scheduledAtTimes
      schedulingComment
      interviewMethod {
        __typename
        typeV2
        conferenceUrl
        resource
      }
      interviewContacts {
        __typename
        id
        fullName
        email
        phoneNumber
        main
        position
        timeZone { __typename value location }
        topChatConversation {
          __typename
          id
          service {
            __typename
            ... on TopChatConversationSlackService {
              __typename
              channelId
            }
          }
          uploads {
            __typename
            id
            filename
            url
          }
        }
      }
      clientContactInfo: client {
        __typename
        id
        contactFields {
          __typename
          communitySlackId
          email
          phoneNumber
          skype
        }
      }
      guide { __typename id }
      talentNotes {
        __typename
        id
        section
        note
      }
      job {
        __typename
        id
        title
        activityItem { __typename id }
      }
      updatedAt
    }
  }
}`;

function projectInterviewTopChatConversation(c: WireInterviewTopChatConversation): InterviewTopChatConversation {
  return {
    id: c.id,
    slackChannelId: c.service?.channelId ?? null,
    uploads: (c.uploads ?? [])
      .filter((u): u is WireInterviewTopChatUpload => u != null)
      .map((u) => ({ id: u.id, filename: u.filename ?? null, url: u.url ?? null })),
  };
}

function projectInterviewContact(c: WireInterviewContact): InterviewContact {
  return {
    id: c.id,
    fullName: c.fullName ?? null,
    email: c.email ?? null,
    phoneNumber: c.phoneNumber ?? null,
    position: c.position ?? null,
    main: c.main ?? null,
    timeZone:
      c.timeZone == null
        ? null
        : {
            value: c.timeZone.value ?? null,
            location: c.timeZone.location ?? null,
          },
    topChatConversation:
      c.topChatConversation == null ? null : projectInterviewTopChatConversation(c.topChatConversation),
  };
}

function projectInterviewClientContactInfo(c: WireInterviewClientContactInfo): InterviewClientContactInfo {
  return {
    id: c.id,
    contactFields:
      c.contactFields == null
        ? null
        : {
            communitySlackId: c.contactFields.communitySlackId ?? null,
            email: c.contactFields.email ?? null,
            phoneNumber: c.contactFields.phoneNumber ?? null,
            skype: c.contactFields.skype ?? null,
          },
  };
}

function projectInterviewDetail(w: WireInterview): InterviewDetail {
  return {
    id: w.id,
    status: (w.interviewStatus?.value ?? null) as InterviewStatus | null,
    kind: (w.kind ?? null) as InterviewKind | null,
    interviewType: w.interviewType ?? null,
    interviewTime: w.interviewTime ?? null,
    information: w.information ?? null,
    initiator: w.initiator ?? null,
    scheduledAtTimes: (w.scheduledAtTimes ?? []).filter((s): s is string => typeof s === "string"),
    schedulingComment: w.schedulingComment ?? null,
    method:
      w.interviewMethod == null
        ? null
        : {
            typeV2: w.interviewMethod.typeV2 ?? null,
            conferenceUrl: w.interviewMethod.conferenceUrl ?? null,
            resource: w.interviewMethod.resource ?? null,
          },
    contacts: (w.interviewContacts ?? [])
      .filter((c): c is WireInterviewContact => c != null)
      .map(projectInterviewContact),
    clientContactInfo: w.clientContactInfo == null ? null : projectInterviewClientContactInfo(w.clientContactInfo),
    guideId: w.guide?.id ?? null,
    talentNotes: (w.talentNotes ?? [])
      .filter((n): n is WireInterviewTalentNote => n != null)
      .map((n) => ({
        id: n.id,
        section: n.section ?? null,
        note: n.note ?? null,
      })),
    job:
      w.job == null
        ? null
        : {
            id: w.job.id,
            title: w.job.title ?? null,
            activityItemId: w.job.activityItem?.id ?? null,
          },
    updatedAt: w.updatedAt ?? null,
  };
}

/**
 * Read one `TalentInterview` by id via the mobile-gateway `Interview`
 * query (#439). Sibling sub-namespace to the top-level activity-row
 * leaves (`list` / `show` / `stats`) — fetches the rich interview
 * detail once the user knows the id from `applications show
 * <activityId>` (the `Interview: <id>` line).
 *
 * **BY-DESIGN wire trim (title OVERRIDE, #696)**: `job` carries id,
 * `title`, and an activity-item back-pointer; the heavy
 * `job → jobActivityItemData` cascade (~50 fields — skills, client,
 * languages, jobTimeZone, statusV2, engagement, …), a duplicate of the
 * activity-row context, stays trimmed. Reach the full job context via
 * `ttctl applications show <activityId>`.
 *
 * @throws `ApplicationsError("NOT_FOUND")` when the id doesn't resolve
 *   to an interview the signed-in user can see, OR when the wire
 *   surfaces a `NOT_FOUND_MESSAGE_PATTERN`-matched GraphQL error
 *   (`Record not found` / `Invalid ID` / Relay `Node id ... resolves to`).
 * @throws `ApplicationsError("NO_VIEWER")` when the session is valid
 *   but no viewer is bound.
 */
async function interviewsShow(token: string, id: string): Promise<InterviewDetail> {
  let data: InterviewResponse & { viewer: { id: string } | null };
  try {
    data = await callGateway<InterviewResponse & { viewer: { id: string } | null }>(
      token,
      "Interview",
      INTERVIEW_QUERY,
      { id },
    );
  } catch (err) {
    if (
      err instanceof ApplicationsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new ApplicationsError("NOT_FOUND", `No interview found with id "${id}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.viewer === null) {
    // Defensive — `callGateway` with `requireViewer: true` already
    // raises `NO_VIEWER` for this case; keep the check for type
    // narrowing parity with sibling `show()` / `stats()`.
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.interview === null) {
    throw new ApplicationsError("NOT_FOUND", `No interview found with id "${id}" (or you don't have access to it).`);
  }
  return projectInterviewDetail(data.viewer.interview);
}

// ---------------------------------------------------------------------
// Interview notes (#440)
//
// `applications.interviews.notes.show(jobId)` — read-only fetch of the
// talent's prep notes for the interview attached to a given job, via
// the portal-side `GetInterviewNotes` query (dispatched against the
// same `mobile-gateway` endpoint — the portal and mobile gateways
// share one backend; the operation document is classified as
// portal-side per its research-repo location, sibling pattern to
// #447 / #448).
//
// **Wire input mismatch with the issue body**: the issue body
// (`Input: id — interview id`) does NOT match the wire op, which
// takes `$jobId: ID!` (TalentJob.id) and traverses
// `viewer.job(id).activityItem.interview.{id, kind, talentNotes{…}}`.
// We follow the wire reality — input is the JOB id, not the interview
// id. The talent can discover the job id via
// `ttctl applications interview show <interviewId>` (the `Job → Job id`
// line surfaced by the #439 sub-namespace) or
// `ttctl applications show <activityId>`. Precedent: PR #518
// (#439 interview show) similarly resolved an issue-body ambiguity
// in the PR body's "Issue-body resolution" section.
//
// **T1 disposition**: `GetInterviewNotes` is in
// `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`), so no
// generated operation type exists — the disposition is structurally
// forced to T1 per ADR-006. Wire shape is pinned by the committed
// `GetInterviewNotes.snapshot.json` (when discovery succeeds during
// the gated E2E run) and asserted on every `TTCTL_E2E=1` run via
// `assertWireShapeStable`.
//
// **Relationship to #439's `Interview` op**: the mobile `Interview`
// op (#439) also surfaces `talentNotes` as part of the full
// interview-detail projection. This leaf is a portal-side,
// notes-focused projection — same data, different surface entry
// point, smaller projection. Adding the portal-side wrapper:
//   1. Provides wire-spec coverage for the portal `GetInterviewNotes`
//      operation (extends our portal-side surface inventory),
//   2. Is a lightweight projection (talent doesn't have to fetch the
//      full interview detail just to read notes), and
//   3. Matches the natural CLI verb hierarchy:
//      `applications interview notes show`.
// ---------------------------------------------------------------------

/**
 * Projected response returned by `interviews.notes.show()`. Shape the
 * CLI's pretty renderer and the MCP tool's JSON payload depend on.
 *
 * `jobId` is the input echo (always populated). `interviewId` /
 * `interviewKind` are populated when the job has an attached interview;
 * `null` when the job's `activityItem.interview` is null on the wire
 * (e.g. the job exists but no interview was scheduled). `notes`
 * preserves server order; empty array when the interview has no
 * recorded prep notes.
 */
export interface InterviewNotesProjection {
  jobId: string;
  interviewId: string | null;
  interviewKind: InterviewKind | null;
  notes: InterviewTalentNote[];
}

// ---------------------------------------------------------------------
// Wire shape (private to the interviews.notes namespace)
// ---------------------------------------------------------------------

interface WireInterviewNotesInterview {
  id: string;
  kind?: string | null;
  talentNotes?: (WireInterviewTalentNote | null)[] | null;
}

interface WireInterviewNotesActivityItem {
  interview?: WireInterviewNotesInterview | null;
}

interface WireInterviewNotesJob {
  activityItem?: WireInterviewNotesActivityItem | null;
}

interface InterviewNotesResponse {
  viewer: {
    id: string;
    job: WireInterviewNotesJob | null;
  } | null;
}

// Strict subset of the captured `GetInterviewNotes` op in
// `research/graphql/gateway/operations/portal/GetInterviewNotes.graphql`,
// keeping only `viewer.job(id).activityItem.interview.{id, kind,
// talentNotes{…}}`. Authoritative wire shape is the captured doc;
// selection is the projection contract (by-design trims documented on
// `interviewsNotesShow`).
const GET_INTERVIEW_NOTES_QUERY = `query GetInterviewNotes($jobId: ID!) {
  viewer {
    __typename
    id
    job(id: $jobId) {
      __typename
      activityItem {
        __typename
        interview {
          __typename
          id
          kind
          talentNotes { __typename id note section }
        }
      }
    }
  }
}`;

/**
 * Read the talent's prep notes for the interview attached to a given
 * job via the portal-side `GetInterviewNotes` query (#440). Sub-sub-
 * namespace leaf of `applications.interviews.*` — wraps the same
 * read-only path the portal matcher UI uses to load interview notes.
 *
 * **BY-DESIGN wire trim**: the projection omits the captured op's heavy
 * job-context cascade (~25 types — `JobClient`, `JobOperationsFragment`,
 * `JobMatcherData`, `JobSkillV2Data`, `JobIndustriesData`, …), keeping
 * only the interview's notes. Reach the job context via
 * `ttctl applications show <activityId>`.
 *
 * @param token   Captured bearer.
 * @param jobId   `TalentJob.id` (NOT the interview id). Discover via
 *                `applications interview show <interviewId>` (the
 *                `Job → Job id` line, populated by the #439 projection)
 *                or `applications show <activityId>`.
 *
 * @throws `ApplicationsError("NOT_FOUND")` when the job id doesn't
 *   resolve to a job the signed-in user can see, OR when the wire
 *   surfaces a `NOT_FOUND_MESSAGE_PATTERN`-matched GraphQL error
 *   (`Record not found` / `Invalid ID` / Relay `Node id ... resolves to`).
 * @throws `ApplicationsError("NO_VIEWER")` when the session is valid
 *   but no viewer is bound.
 */
async function interviewsNotesShow(token: string, jobId: string): Promise<InterviewNotesProjection> {
  let data: InterviewNotesResponse & { viewer: { id: string } | null };
  try {
    data = await callGateway<InterviewNotesResponse & { viewer: { id: string } | null }>(
      token,
      "GetInterviewNotes",
      GET_INTERVIEW_NOTES_QUERY,
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
    // Defensive — `callGateway` with `requireViewer: true` already
    // raises `NO_VIEWER` for this case; keep the check for type
    // narrowing parity with sibling leaves.
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.job === null) {
    throw new ApplicationsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`);
  }
  const interview = data.viewer.job.activityItem?.interview ?? null;
  return {
    jobId,
    interviewId: interview?.id ?? null,
    interviewKind: (interview?.kind ?? null) as InterviewKind | null,
    notes: (interview?.talentNotes ?? [])
      .filter((n): n is WireInterviewTalentNote => n != null)
      .map((n) => ({
        id: n.id,
        section: n.section ?? null,
        note: n.note ?? null,
      })),
  };
}

// ---------------------------------------------------------------------
// Interview guide (#470)
//
// `applications.interviews.guide.show(interviewId)` — read-only fetch of
// the interview-prep guide content (sections + tips) for one interview,
// via the mobile-gateway `InterviewGuide` query.
//
// **Input is the INTERVIEW id**, not the guide id. The wire op
// (`research/graphql/gateway/operations/mobile/InterviewGuide.graphql`)
// takes `$interviewId: ID!` and traverses
// `viewer.interview(id).guide.{id, sections[...]}` — the guide is
// materialized as a 1:1 child of the interview. The talent discovers the
// interview id via `applications interview show <interviewId>` or
// `applications show <activityId>` (the `Interview: <id>` line).
//
// **Issue-body resolution**: issue #470 said `Input: interviewType
// (enum or context-id — verify wire)` and `Returns: guide content
// (Markdown or HTML — verify)`. Wire reality verified: the input is
// the interview id (not a free-text interviewType enum), and the wire
// returns a structured `sections[].tips[]` shape (not a single Markdown
// or HTML blob — `tip.content` / `tip.hardcodedContent` are individual
// markdown strings). Precedent: PR #519 (#440) similarly resolved an
// issue-body ambiguity (interview id vs job id) in the PR body's
// "Issue-body resolution" section.
//
// **T1 disposition**: `InterviewGuide` is in
// `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`), so no
// generated operation type exists — the disposition is structurally
// forced to T1 per ADR-006. Wire shape is pinned by
// `InterviewGuide.snapshot.json` (when discovery succeeds during the
// gated E2E run) and asserted on every `TTCTL_E2E=1` run via
// `assertWireShapeStable`.
//
// **Relationship to #439's `Interview` op**: the mobile `Interview` op
// (#439) selects `guide { __typename id }` (presence indicator only).
// This leaf returns the full guide content (sections + tips). They
// share the back-pointer: `InterviewDetail.guideId` is the same id as
// `InterviewGuideProjection.guideId`. Two-step UX: discover via
// `applications interview show`, then fetch content via `applications
// interview guide show`.
//
// **Selection trim**: keeps only `viewer.interview(id).guide.{id,
// sections[].{identifier, title, subtitle, tips[].{identifier, title,
// content, hardcodedContent}}}`. Authoritative wire shape is the
// captured doc; selection is the projection contract (by-design trims
// documented on `interviewsGuideShow`). `statuses: ALL` keeps parity
// with the captured op so any interview state's guide is fetchable.
// ---------------------------------------------------------------------

/**
 * `InterviewGuideSectionIdentifierEnum` values from the synthesized
 * schema (`../research/graphql/gateway/schema.graphql`). Closed set —
 * statically extractable from the schema. The mobile portal uses these
 * as the prep-guide section spine: `STRENGTHS` (talent's job-match
 * strengths), `GAPS` (likely follow-up topics), `JOB_HIGHLIGHTS` (key
 * job characteristics), `POTENTIAL_QUESTIONS` (questions to expect),
 * `PRO_TIPS` (Toptal interview tips), `ASK_YOUR_CLIENT` (questions to
 * ask the interviewer).
 */
export type InterviewGuideSectionIdentifier =
  "ASK_YOUR_CLIENT" | "GAPS" | "JOB_HIGHLIGHTS" | "POTENTIAL_QUESTIONS" | "PRO_TIPS" | "STRENGTHS";

export const INTERVIEW_GUIDE_SECTION_IDENTIFIERS: readonly InterviewGuideSectionIdentifier[] = [
  "ASK_YOUR_CLIENT",
  "GAPS",
  "JOB_HIGHLIGHTS",
  "POTENTIAL_QUESTIONS",
  "PRO_TIPS",
  "STRENGTHS",
] as const;

/**
 * `InterviewGuideTipIdentifierEnum` values from the synthesized schema
 * (`../research/graphql/gateway/schema.graphql`). Closed set —
 * statically extractable from the schema. Each tip identifier is a
 * named template slot the Toptal guide-rendering pipeline fills with
 * job/talent-specific content.
 */
export type InterviewGuideTipIdentifier =
  | "BE_PRESENTABLE"
  | "CAMERA_ON"
  | "DONT_DISCUSS_RATE"
  | "GAP_ANALYSIS"
  | "HIRING_FACTORS"
  | "JOB_SUMMARY"
  | "PROFILE_REFERENCES"
  | "QUESTIONS_TO_ASK"
  | "QUESTIONS_TO_PREPARE_FOR"
  | "SMALL_TALK"
  | "STANDARD_QUESTIONS"
  | "STRENGTHS_OVERLAP";

export const INTERVIEW_GUIDE_TIP_IDENTIFIERS: readonly InterviewGuideTipIdentifier[] = [
  "BE_PRESENTABLE",
  "CAMERA_ON",
  "DONT_DISCUSS_RATE",
  "GAP_ANALYSIS",
  "HIRING_FACTORS",
  "JOB_SUMMARY",
  "PROFILE_REFERENCES",
  "QUESTIONS_TO_ASK",
  "QUESTIONS_TO_PREPARE_FOR",
  "SMALL_TALK",
  "STANDARD_QUESTIONS",
  "STRENGTHS_OVERLAP",
] as const;

/**
 * One tip within an {@link InterviewGuideSection}. `content` is the
 * job/talent-personalized body (the Toptal guide-rendering pipeline
 * splices in job-specific examples); `hardcodedContent` is the generic
 * template body that ships with every guide regardless of job context.
 * Either or both may be populated; the renderer is responsible for
 * choosing precedence.
 */
export interface InterviewGuideTip {
  /** `InterviewGuideTipIdentifierEnum` member (see {@link INTERVIEW_GUIDE_TIP_IDENTIFIERS}) or null. */
  identifier: InterviewGuideTipIdentifier | null;
  title: string | null;
  /** Personalized tip body (markdown). May be null when no personalization applies. */
  content: string | null;
  /** Generic template body (markdown) shipped with every guide. May be null. */
  hardcodedContent: string | null;
}

/**
 * One section of the interview-prep guide.
 */
export interface InterviewGuideSection {
  /** `InterviewGuideSectionIdentifierEnum` member (see {@link INTERVIEW_GUIDE_SECTION_IDENTIFIERS}) or null. */
  identifier: InterviewGuideSectionIdentifier | null;
  title: string | null;
  subtitle: string | null;
  /** Server-supplied order preserved. */
  tips: InterviewGuideTip[];
}

/**
 * Projected guide payload returned by `interviews.guide.show()`. Shape
 * the CLI's pretty renderer and the MCP tool's JSON payload depend on.
 *
 * `interviewId` is the input echo (always populated). `guideId` /
 * `sections` are populated when the interview has an attached guide;
 * `guideId` is `null` and `sections` is `[]` when no guide is attached
 * to the interview (some interview types may not have a prep guide).
 */
export interface InterviewGuideProjection {
  /** Input echo. */
  interviewId: string;
  /** `TalentInterviewGuide.id` — matches `InterviewDetail.guideId` from #439. `null` when no guide is attached. */
  guideId: string | null;
  /** Guide sections in server-supplied order. Empty array when no guide is attached. */
  sections: InterviewGuideSection[];
}

// ---------------------------------------------------------------------
// Wire shape (private to the interviews.guide namespace)
// ---------------------------------------------------------------------

interface WireInterviewGuideTipPayload {
  identifier?: string | null;
  title?: string | null;
  content?: string | null;
  hardcodedContent?: string | null;
}

interface WireInterviewGuideSectionPayload {
  identifier?: string | null;
  title?: string | null;
  subtitle?: string | null;
  tips?: (WireInterviewGuideTipPayload | null)[] | null;
}

interface WireInterviewGuideContent {
  id: string;
  sections?: (WireInterviewGuideSectionPayload | null)[] | null;
}

interface WireInterviewWithGuide {
  id: string;
  guide?: WireInterviewGuideContent | null;
}

interface InterviewGuideResponse {
  viewer: {
    id: string;
    interview: WireInterviewWithGuide | null;
  } | null;
}

// Trimmed strict subset of the captured `InterviewGuide` op in
// `research/graphql/gateway/operations/mobile/InterviewGuide.graphql`.
// The captured doc selects a heavy cascade
// (`interviewContacts` + `job → jobData` + `client` + `mobileFeedbackForm`);
// this trim drops everything except the guide-specific selection on
// `viewer.interview(id).guide.{id, sections[].{identifier, title,
// subtitle, tips[].{identifier, title, content, hardcodedContent}}}`.
// Authoritative wire shape is the captured doc; selection is the
// projection contract. `statuses: ALL` keeps parity with the captured
// op so any interview state's guide is fetchable.
const INTERVIEW_GUIDE_QUERY = `query InterviewGuide($id: ID!) {
  viewer {
    __typename
    id
    interview(id: $id, statuses: ALL) {
      __typename
      id
      guide {
        __typename
        id
        sections {
          __typename
          identifier
          title
          subtitle
          tips {
            __typename
            identifier
            title
            content
            hardcodedContent
          }
        }
      }
    }
  }
}`;

/**
 * Read the interview-prep guide content (sections + tips) for one
 * interview via the mobile-gateway `InterviewGuide` query (#470).
 * Sub-sub-namespace leaf of `applications.interviews.*` — wraps the
 * mobile-portal interview-prep view that talents use to prepare.
 *
 * **BY-DESIGN wire trim**: the projection omits two captured sub-trees —
 * (1) the duplicate `viewer.interview` detail (interviewTime,
 * interviewType, interviewContacts, job, client, schedulingComment),
 * reachable via `ttctl applications interview show <interviewId>`; and
 * (2) `mobileFeedbackForm(feature: INTERVIEW_GUIDE)`, a UI feedback
 * prompt the CLI/MCP doesn't render. Keeps only the guide content.
 *
 * @param token        Captured bearer.
 * @param interviewId  `TalentInterview.id` (NOT the guide id). Discover
 *                     via `applications interview show <interviewId>`
 *                     or `applications show <activityId>`.
 *
 * @throws `ApplicationsError("NOT_FOUND")` when the id doesn't resolve
 *   to an interview the signed-in user can see, OR when the wire
 *   surfaces a `NOT_FOUND_MESSAGE_PATTERN`-matched GraphQL error
 *   (`Record not found` / `Invalid ID` / Relay `Node id ... resolves to`).
 * @throws `ApplicationsError("NO_VIEWER")` when the session is valid
 *   but no viewer is bound.
 */
async function interviewsGuideShow(token: string, interviewId: string): Promise<InterviewGuideProjection> {
  let data: InterviewGuideResponse & { viewer: { id: string } | null };
  try {
    data = await callGateway<InterviewGuideResponse & { viewer: { id: string } | null }>(
      token,
      "InterviewGuide",
      INTERVIEW_GUIDE_QUERY,
      { id: interviewId },
    );
  } catch (err) {
    if (
      err instanceof ApplicationsError &&
      err.code === "GRAPHQL_ERROR" &&
      NOT_FOUND_MESSAGE_PATTERN.test(err.message)
    ) {
      throw new ApplicationsError(
        "NOT_FOUND",
        `No interview found with id "${interviewId}" (or you don't have access to it).`,
        { cause: err },
      );
    }
    throw err;
  }
  if (data.viewer === null) {
    // Defensive — `callGateway` with `requireViewer: true` already
    // raises `NO_VIEWER` for this case; keep the check for type
    // narrowing parity with sibling leaves.
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.interview === null) {
    throw new ApplicationsError(
      "NOT_FOUND",
      `No interview found with id "${interviewId}" (or you don't have access to it).`,
    );
  }
  const wire = data.viewer.interview;
  return {
    interviewId,
    guideId: wire.guide?.id ?? null,
    sections: (wire.guide?.sections ?? [])
      .filter((s): s is WireInterviewGuideSectionPayload => s != null)
      .map((s) => ({
        identifier: (s.identifier ?? null) as InterviewGuideSectionIdentifier | null,
        title: s.title ?? null,
        subtitle: s.subtitle ?? null,
        tips: (s.tips ?? [])
          .filter((t): t is WireInterviewGuideTipPayload => t != null)
          .map((t) => ({
            identifier: (t.identifier ?? null) as InterviewGuideTipIdentifier | null,
            title: t.title ?? null,
            content: t.content ?? null,
            hardcodedContent: t.hardcodedContent ?? null,
          })),
      })),
  };
}

/**
 * `applications.interviews.*` sub-namespace. Read-only leaves for
 * interview-detail access — sibling to the top-level activity-row
 * leaves on this module. Sub-namespace grouping pattern follows
 * `payments.rate.*` (#447) and `payments.payouts.*` / `payments.methods.*`
 * (#149); the plural form here matches `payouts` / `methods` for
 * collection-style namespaces.
 *
 * Sub-sub-namespaces:
 *   - `interviews.notes.*` (#440) — portal-side notes-focused projection.
 *     `notes.show(jobId)` is the lightweight read of the talent's prep
 *     notes for one job's interview, paired with the heavier
 *     `interviews.show(interviewId)` from #439.
 *   - `interviews.guide.*` (#470) — mobile-gateway guide-content
 *     projection. `guide.show(interviewId)` is the read of the
 *     interview-prep guide (sections + tips). Paired with #439 —
 *     `interviews.show` surfaces the guide-id presence indicator;
 *     `interviews.guide.show` fetches the full content.
 */
export const interviews = {
  show: interviewsShow,
  notes: {
    show: interviewsNotesShow,
  },
  guide: {
    show: interviewsGuideShow,
  },
};

// ---------------------------------------------------------------------
// Availability-request detail (#442)
//
// `applications.availabilityRequests.show(id)` — read-only fetch of one
// `AvailabilityRequest` via the mobile-gateway `AvailabilityRequest`
// query. The id is the `AvailabilityRequest.id` surfaced on
// `applications.show(<activityId>)` as the `Availability request: <id>`
// line — the same id the #411 `confirm` / `reject` write-side ops take.
// Where `applications.show` is the activity-row detail with an AR
// presence indicator, this leaf is the rich availability-request detail
// — recruiter-pinned Fixed rate, recruiter comment, lifecycle
// timestamps, and the job the request is for.
//
// **Operation document**: the captured
// `research/graphql/gateway/operations/mobile/AvailabilityRequest.graphql`
// is a large cascade — its `availabilityRequestFields` fragment selects
// `job { ...jobData }`, a ~25-type `TalentJob` cascade that touches
// `Unknown`-typed positions (`jobApplyState.operations.apply.errors`).
// Same posture as #439's `Interview`: inline a trimmed selection that
// touches only the well-typed fields the CLI / MCP renders, and trim
// `job` to the {@link ApplicationJobRef} shape PLUS the matcher
// `questions(hideExpertiseQuestion: true)` selection added in #585 (the
// shared #584 {@link MATCHER_QUESTION_SELECTION} fragment-string — see
// {@link AvailabilityRequestDetail.matcherQuestions}). The captured doc
// is the authoritative wire shape; the selection is the projection
// contract. The `AvailabilityRequest` schema fields `jobExpertiseAnswers`
// (`[Unknown]!`) and `rejectReason` (`Unknown`) are deliberately NOT
// selected — `Unknown`-typed gap regions per
// `../research/graphql/gateway/schema.graphql`.
//
// **Schema/contract rule (#585)**: embedding `job.questions { options
// suggestedAnswer { answer } ... }` is a selection-set change adding the
// INFERRED `options` / `suggestedAnswer` fields (same provenance as #584,
// absent from the synthesized `JobPositionQuestion`). The op stays T1; the
// live `64-applications-availability-request-show.e2e.test.ts` run is the
// wire authority on the matcher-questions sub-shape.
//
// **Issue-body deviation**: issue #442 mentions a "requested
// availability window" — no such field exists on the captured
// `AvailabilityRequest` op (or its schema type). The projection
// surfaces what the captured op actually selects; the lifecycle
// timestamps (`createdAt` / `updatedAt` / `answeredAt`) are the
// closest wire-real analogue. Precedent: the #440 issue-body input
// mismatch (interview id vs job id) resolved captured-op-authoritative.
//
// **Distinct from `GetAvailabilityRequestKind`**: the #411 confirm path
// uses a minimal `GetAvailabilityRequestKind($id)` op (kind + Fixed
// rate-default only). This is the full read — a distinct op with a
// distinct projection. `GetAvailabilityRequestKind` was originally
// renamed precisely to reserve the `AvailabilityRequest` operation name
// for this wrapper (see the comment on `GET_AVAILABILITY_REQUEST_KIND_QUERY`).
//
// **T1 disposition (#442)**: `AvailabilityRequest` is in
// `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`), so no
// `AvailabilityRequestQuery` type is generated. Wire shape is pinned by
// the committed `AvailabilityRequest.snapshot.json` and asserted on
// every `TTCTL_E2E=1` run via `assertWireShapeStable`.
// ---------------------------------------------------------------------

/**
 * `AvailabilityRequestStatusEnum` values from the synthesized schema
 * (`../research/graphql/gateway/schema.graphql`). Closed set — unlike
 * the INFERRED {@link AvailabilityRequestKind} enum, the status enum is
 * statically extractable from the schema.
 *
 * NB: distinct from the GraphQL schema type *named* `AvailabilityRequestStatus`
 * (the `{ value: String! }` wrapper that `statusV2` / `jirStatus`
 * resolve to). This TS type is the closed set of `.value` spellings.
 */
export type AvailabilityRequestStatus = "CANCELLED" | "CONFIRMED" | "EXPIRED" | "PENDING" | "REJECTED" | "WITHDRAWN";

export const AVAILABILITY_REQUEST_STATUSES: readonly AvailabilityRequestStatus[] = [
  "CANCELLED",
  "CONFIRMED",
  "EXPIRED",
  "PENDING",
  "REJECTED",
  "WITHDRAWN",
] as const;

/**
 * Projected availability-request detail returned by
 * `availabilityRequests.show()`. The shape the CLI's pretty renderer
 * and the MCP tool's JSON payload depend on.
 */
export interface AvailabilityRequestDetail {
  id: string;
  /**
   * `AvailabilityRequestStatusEnum` member (see
   * {@link AVAILABILITY_REQUEST_STATUSES}) or `null`. Read off the
   * wire's `jirStatus` (aliased `statusV2`) `{ value }` wrapper.
   */
  status: AvailabilityRequestStatus | null;
  /**
   * AR kind, auto-detected from `metadata.__typename` via
   * {@link kindFromMetadataTypename}. `null` when metadata is absent or
   * an unrecognised variant.
   */
  kind: AvailabilityRequestKind | null;
  /**
   * Recruiter-pinned Fixed hourly rate (the `metadata.offeredHourlyRate`
   * Money shape). `null` for FLEXIBLE / MARKETPLACE_FLEXIBLE ARs — their
   * metadata carries no offered rate.
   */
  fixedRate: FixedRate | null;
  /** Recruiter's free-text note attached to the request. */
  comment: string | null;
  /**
   * Talent's own free-text response (#539). Populated post-response
   * (the wire `AvailabilityRequest.talentComment: String!` is the
   * mirror of the `comment` arg the talent passed to
   * `applications.confirm()` / `reject()`). `null` while the AR is
   * still `PENDING`.
   */
  talentComment: string | null;
  /**
   * Hourly rate the talent posted in response (#539). Money shape,
   * mirrors the `requestedHourlyRate` arg the talent passed to
   * `applications.confirm()`. `null` while the AR is still `PENDING`.
   */
  requestedHourlyRate: FixedRate | null;
  /**
   * Reject-reason `key` when the AR was declined (#539). One of the
   * `key` values from the inventory at {@link rejectReasons} (e.g.
   * `"rate_too_low"`). `null` when the AR is `PENDING` or `CONFIRMED`.
   * `Unknown`-typed in the synth SDL — treated as `string | null` per
   * the live wire shape.
   */
  rejectReason: string | null;
  /**
   * Recruiter contact identity (#539). Absent from synthesized SDL but
   * present on the wire per empirical probe. Useful for personalising
   * decline drafts (addressing the recruiter by first name).
   */
  recruiter: RecruiterRef | null;
  /** Server-supplied creation timestamp (ISO 8601). */
  createdAt: string | null;
  /** Server-supplied last-mutation timestamp (ISO 8601). */
  updatedAt: string | null;
  /**
   * Timestamp the talent answered the request (confirmed / rejected).
   * `null` while the request is still pending.
   */
  answeredAt: string | null;
  /** The job the availability request is for. */
  job: ApplicationJobRef | null;
  /**
   * Matcher questions the recruiter attached to this Interest Request
   * (#585), projected to the SAME {@link ApplicationQuestion} shape the
   * `applications.applyQuestions()` matcher path surfaces (#584) — each
   * entry carries `identifier`, `prompt`, `isMandatory`, plus the choice
   * metadata (`options` / `suggestedAnswer` / `inputType`) needed to
   * build a valid `matcherAnswers` payload for
   * `applications.confirm()` (the IR-accept write path).
   *
   * Lifted from the AR's `job.questions(hideExpertiseQuestion: true)`
   * via the IDENTICAL #584 reuse seam ({@link MATCHER_QUESTION_SELECTION}
   * fragment-string + {@link MatcherQuestionWire} wire type +
   * {@link projectMatcherQuestion} mapper) — NOT a re-derived shape. This
   * closes the IR-accept workflow gap (#585): fetch the AR by id → read
   * `matcherQuestions` (+ their `options`) → call `confirm()` with
   * `matcherQuestionsAnswers`, all keyed off the SAME AvailabilityRequest
   * id, no cross-referencing the job-apply tooling and no raw GraphQL.
   *
   * Empty array `[]` when the AR's job carries no matcher questions, or
   * the AR has no associated job. `type` is always `"matcher"` for these
   * entries; `inputType` is `"dropdown"` iff `options` is non-empty,
   * `"free-text"` otherwise (mechanically derived per #584).
   *
   * **Scope**: matcher questions only. Expertise questions are answered
   * via profile-item selections (`expertiseQuestionsAnswers`), not an
   * enumerable choice list at this surface, and carry no dropdown
   * options — deliberately out of #585 scope (see {@link ApplicationQuestion}
   * JSDoc on the options-cascade note).
   *
   * **`options` / `suggestedAnswer` are [INFERRED — UNVERIFIED]** — same
   * provenance as #584 (absent from the synthesized `JobPositionQuestion`;
   * recovered from a manual GraphQL query). The live `*.e2e.test.ts`
   * (gated by `TTCTL_E2E=1`) is the wire authority per the schema/contract
   * rule.
   */
  matcherQuestions: ApplicationQuestion[];
}

// ---------------------------------------------------------------------
// Wire shape (private to the availabilityRequests namespace)
// ---------------------------------------------------------------------

interface WireAvailabilityRequestStatusV2 {
  value?: string | null;
}

interface WireAvailabilityRequestMoney {
  decimal?: string | null;
  verbose?: string | null;
}

interface WireAvailabilityRequestMetadata {
  __typename?: string | null;
  offeredHourlyRate?: WireAvailabilityRequestMoney | null;
}

interface WireAvailabilityRequestJob {
  id: string;
  title?: string | null;
  url?: string | null;
  client?: { id: string; fullName?: string | null } | null;
  /**
   * Matcher questions on the job (#585). Selected via the shared
   * {@link MATCHER_QUESTION_SELECTION} fragment-string under
   * `job.questions(hideExpertiseQuestion: true)` — the SAME selection the
   * #584 `JobApplicationQuestions` op uses. Reuses {@link MatcherQuestionWire}
   * verbatim (the #584 wire type) so the projection stays a single
   * contract. Optional + nullable-item-list defensively: a job with no
   * matcher questions returns `[]`/`null`, and a trimmed selection (or a
   * pre-#585 captured fixture) elides the field entirely.
   */
  questions?: (MatcherQuestionWire | null)[] | null;
}

interface WireAvailabilityRequestRecruiter {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}

interface WireAvailabilityRequest {
  id: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  answeredAt?: string | null;
  comment?: string | null;
  /**
   * Aliased on the wire as `jirStatus: statusV2` — the captured
   * `availabilityRequestFields` fragment uses this alias. The
   * `{ value }` wrapper resolves to an `AvailabilityRequestStatus`
   * GraphQL type.
   */
  jirStatus?: WireAvailabilityRequestStatusV2 | null;
  /**
   * Talent's own free-text response (#539). `String!` in synth SDL but
   * empirically `null` for pre-response ARs — the projection treats
   * empty-string and null uniformly.
   */
  talentComment?: string | null;
  /**
   * Hourly rate the talent posted in response (#539). `Money!` in
   * synth SDL.
   */
  requestedHourlyRate?: WireAvailabilityRequestMoney | null;
  /**
   * Reject-reason `key` (#539). `Unknown`-typed in synth SDL —
   * empirically returns a `string | null` on the wire.
   */
  rejectReason?: string | null;
  /**
   * Recruiter contact identity (#539). Absent from synth SDL on
   * `AvailabilityRequest`; INFERRED present on the wire.
   */
  recruiter?: WireAvailabilityRequestRecruiter | null;
  metadata?: WireAvailabilityRequestMetadata | null;
  job?: WireAvailabilityRequestJob | null;
}

interface AvailabilityRequestResponse {
  viewer: {
    id: string;
    availabilityRequest: WireAvailabilityRequest | null;
  } | null;
}

// Strict subset of the captured AvailabilityRequest op in
// `research/graphql/gateway/operations/mobile/AvailabilityRequest.graphql`,
// keeping only the well-typed selection the CLI / MCP renders. The
// `metadata` selection mirrors `GET_AVAILABILITY_REQUEST_KIND_QUERY` —
// `__typename` per union variant (drives {@link kindFromMetadataTypename})
// plus `offeredHourlyRate` on the Fixed variant. Authoritative wire
// shape is the captured doc; selection is the projection contract
// (by-design trims documented on `availabilityRequestsShow`).
const AVAILABILITY_REQUEST_QUERY = `query AvailabilityRequest($id: ID!) {
  viewer {
    __typename
    id
    availabilityRequest(id: $id) {
      __typename
      id
      createdAt
      updatedAt
      answeredAt
      comment
      talentComment
      requestedHourlyRate { __typename decimal verbose }
      rejectReason
      recruiter { __typename firstName lastName fullName }
      jirStatus: statusV2 { __typename value }
      metadata {
        __typename
        ... on AvailabilityRequestFixedMetadata {
          __typename
          offeredHourlyRate { __typename decimal verbose }
        }
        ... on AvailabilityRequestFlexibleMetadata { __typename }
        ... on MarketplaceAvailabilityRequestFlexibleMetadata { __typename }
      }
      job {
        __typename
        id
        title
        url
        client { __typename id fullName }
        questions(hideExpertiseQuestion: true) {
          ${MATCHER_QUESTION_SELECTION}
        }
      }
    }
  }
}`;

function projectAvailabilityRequestDetail(w: WireAvailabilityRequest): AvailabilityRequestDetail {
  const offered = w.metadata?.offeredHourlyRate;
  const fixedRate: FixedRate | null =
    offered != null && typeof offered.decimal === "string" && typeof offered.verbose === "string"
      ? { decimal: offered.decimal, verbose: offered.verbose }
      : null;
  const reqRate = w.requestedHourlyRate;
  const requestedHourlyRate: FixedRate | null =
    reqRate != null && typeof reqRate.decimal === "string" && typeof reqRate.verbose === "string"
      ? { decimal: reqRate.decimal, verbose: reqRate.verbose }
      : null;
  const recruiterWire = w.recruiter;
  const recruiter: RecruiterRef | null =
    recruiterWire == null
      ? null
      : {
          firstName: recruiterWire.firstName ?? null,
          lastName: recruiterWire.lastName ?? null,
          fullName: recruiterWire.fullName ?? null,
        };
  // #585 — project the AR's job matcher questions via the SAME #584 seam
  // the `applyQuestions` matcher path uses (filter list-entry nulls, then
  // {@link projectMatcherQuestion}). Absent / null `questions` ⇒ `[]`,
  // matching the empty-state contract on
  // {@link AvailabilityRequestDetail.matcherQuestions}.
  const matcherQuestions: ApplicationQuestion[] = (w.job?.questions ?? [])
    .filter((q): q is MatcherQuestionWire => q !== null)
    .map(projectMatcherQuestion);
  return {
    id: w.id,
    status: (w.jirStatus?.value ?? null) as AvailabilityRequestStatus | null,
    kind: kindFromMetadataTypename(w.metadata?.__typename ?? null),
    fixedRate,
    comment: w.comment ?? null,
    talentComment: w.talentComment ?? null,
    requestedHourlyRate,
    rejectReason: w.rejectReason ?? null,
    recruiter,
    createdAt: w.createdAt ?? null,
    updatedAt: w.updatedAt ?? null,
    answeredAt: w.answeredAt ?? null,
    job:
      w.job == null
        ? null
        : {
            id: w.job.id,
            title: w.job.title ?? null,
            url: w.job.url ?? null,
            client: w.job.client == null ? null : { id: w.job.client.id, fullName: w.job.client.fullName ?? null },
          },
    matcherQuestions,
  };
}

/**
 * Read one `AvailabilityRequest` by id via the mobile-gateway
 * `AvailabilityRequest` query (#442). Sibling sub-namespace to the
 * top-level activity-row leaves (`list` / `show` / `stats`) and to
 * `interviews.show` (#439) — fetches the rich availability-request
 * detail once the user knows the id from `applications show
 * <activityId>` (the `Availability request: <id>` line). The id is the
 * same `AvailabilityRequest.id` the #411 `confirm` / `reject` write-side
 * ops accept.
 *
 * **BY-DESIGN wire trim**: the projection omits the captured op's
 * `job → jobData` cascade (~25 types, including `Unknown`-typed
 * positions), keeping `job` only as the {@link ApplicationJobRef} shape
 * (id, title, url, client). Reach the full job context via
 * `ttctl applications show <activityId>`.
 *
 * @throws `ApplicationsError("NOT_FOUND")` when the id doesn't resolve
 *   to an availability request the signed-in user can see, OR when the
 *   wire surfaces a `NOT_FOUND_MESSAGE_PATTERN`-matched GraphQL error
 *   (`Record not found` / `Invalid ID` / Relay `Node id ... resolves to`).
 * @throws `ApplicationsError("NO_VIEWER")` when the session is valid
 *   but no viewer is bound.
 */
async function availabilityRequestsShow(token: string, id: string): Promise<AvailabilityRequestDetail> {
  let data: AvailabilityRequestResponse & { viewer: { id: string } | null };
  try {
    data = await callGateway<AvailabilityRequestResponse & { viewer: { id: string } | null }>(
      token,
      "AvailabilityRequest",
      AVAILABILITY_REQUEST_QUERY,
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
        `No availability request found with id "${id}" (or you don't have access to it).`,
        { cause: err },
      );
    }
    throw err;
  }
  if (data.viewer === null) {
    // Defensive — `callGateway` with `requireViewer: true` already
    // raises `NO_VIEWER` for this case; keep the check for type
    // narrowing parity with sibling `interviews.show()`.
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.availabilityRequest === null) {
    throw new ApplicationsError(
      "NOT_FOUND",
      `No availability request found with id "${id}" (or you don't have access to it).`,
    );
  }
  return projectAvailabilityRequestDetail(data.viewer.availabilityRequest);
}

/**
 * `applications.availabilityRequests.*` sub-namespace. Read-only leaf
 * for availability-request-detail access — sibling to `interviews.*`
 * (#439 / #440) and to the top-level activity-row leaves. The plural
 * `availabilityRequests` form matches `interviews` / `payouts` /
 * `methods` for collection-style namespaces; the #411 write-side ops
 * (`confirm` / `reject` / `rejectReasons`) stay top-level flat exports
 * (they predate the sub-namespace convention).
 */
export const availabilityRequests = {
  show: availabilityRequestsShow,
};
