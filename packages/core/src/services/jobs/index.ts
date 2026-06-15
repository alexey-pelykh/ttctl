// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `jobs` service module — browse current job opportunities, manage
 * saved / viewed / not-interested signals, and manage the single
 * job-search subscription.
 *
 * In Toptal vocabulary, a "Job" is an opportunity (the listings talent
 * apply to). The CLI accepts `opportunities` as an alias of `jobs` at
 * the surface layer only; the service module name and operation names
 * stay canonical.
 *
 * | Leaf                          | Operation                                   |
 * |-------------------------------|---------------------------------------------|
 * | `list`                        | `eligibleJobs` (paginated; default scope)   |
 * | `show <id>`                   | `Job(id)`                                   |
 * | `save <id>`                   | `MarkJobAsSaved`                            |
 * | `unsave <id>`                 | `ClearJobInterestStatus` (clears all)       |
 * | `saved`                       | `eligibleJobs` (filter saved=true)          |
 * | `markViewed <id>`             | `MarkJobAsViewed`                           |
 * | `viewedList`                  | full-pool fetch + client-side filter (R1)   |
 * | `notInterested <id> <reason>` | `MarkJobAsNotInterested`                    |
 * | `notInterestedList`           | `eligibleJobs` (filter notInterested=true)  |
 * | `clearInterest <id>`          | `ClearJobInterestStatus`                    |
 * | `searchSubscriptionShow`      | `JobSubscription`                           |
 * | `searchSubscriptionSave`      | `StartJobsSearchSubscription`               |
 * | `searchSubscriptionRemove`    | `TerminateJobsSearchSubscription`           |
 *
 * **Routing**: All ops talk to the **mobile-gateway** surface
 * (`https://www.toptal.com/gateway/graphql/talent/graphql`) via
 * `stockTransport`. The gateway is plain HTTPS — no Cloudflare, no TLS
 * impersonation needed. Same surface as `applications`, `engagements`,
 * `availability`, and `profile.basic.show()`.
 *
 * **Operations are inlined as strings** (not codegen-driven) — same
 * pattern as `applications`, `engagements`, `availability`, and
 * `profile.skills` mutations. Captured documents in
 * `../research/graphql/gateway/operations/mobile/` carry a large
 * fragment cascade touching ~25 types; the trimmed inline strings here
 * select only the fields the CLI / MCP renders.
 *
 * **CLAUDE.md schema/contract validation rule**: the operations here
 * are **[INFERRED — UNVERIFIED]** until the gated `*.e2e.test.ts` files
 * pass against a live session. Mutation operations (`MarkJobAsSaved`,
 * `MarkJobAsNotInterested`, `MarkJobAsViewed`, `ClearJobInterestStatus`,
 * `StartJobsSearchSubscription`, `TerminateJobsSearchSubscription`)
 * trigger the rule — pre-merge requirement is the live E2E run, not
 * the unit tests.
 *
 * **Wire-shape notes:**
 *
 * - **R1 — Viewed-list aggregation**: `eligibleJobs` exposes no
 *   `viewed` boolean filter on `BooleanFilter`, only `notInterested`
 *   and `saved` (decompile evidence: `research/jadx/sources/fn/x4.java`
 *   `InitialJobs` operation; `oh.java` `SavedJobs` operation — both
 *   list filter fields exhaustively, neither uses `viewed`). Per #372,
 *   {@link viewedList} iterates the FULL eligibleJobs pool, applies a
 *   client-side filter on `viewed === true`, dedups by job id, and
 *   slices to the caller's `page` / `perPage`. `JobListPage.totalCount`
 *   reflects the post-filter total. Cost: O(N/20) wire calls per
 *   invocation, capped at `VIEWED_LIST_MAX_INTERNAL_PAGES = 50`
 *   internal pages (~1000 eligible jobs scanned worst-case). This is
 *   the explicit stop-gap until Toptal exposes a wire-level filter.
 *
 * - **R2 — Search subscription cardinality**: `viewer.searchSubscription`
 *   is a single nullable object, not a list. The platform supports ONE
 *   active subscription at a time. {@link searchSubscriptionShow}
 *   returns a typed null when there's no active subscription;
 *   {@link searchSubscriptionSave} starts a new one (replacing any
 *   existing); {@link searchSubscriptionRemove} terminates the active
 *   subscription. The CLI/MCP surface accepts `--name` as advisory
 *   (cosmetic, no wire field) and an optional `<id>` on remove (ignored,
 *   only one subscription exists).
 *
 * **Pagination (#138)**: `list` / `saved` / `notInterestedList` accept
 * optional `{ page?, perPage? }` in {@link ListOptions} (1-indexed
 * user-facing; threaded verbatim into the wire's `eligibleJobs.page`
 * inside {@link buildListVariables}). Defaults are `page: 1, perPage:
 * 20` — matching the pre-#138 hardcoded values. The service returns
 * {@link JobListPage} carrying `{items, totalCount, page, perPage}`
 * so the CLI layer can render the offset-style `pageInfo` block in
 * the list envelope. {@link viewedList} accepts the same shape but
 * `page` / `perPage` slice the POST-FILTER aggregated list (per #372
 * — the wire has no `viewed` filter, so the function iterates ALL
 * underlying pages and applies a client-side filter); `totalCount`
 * is the post-filter total.
 *
 * **Application funnel** (`jobs apply`): in scope per ADR-008 (ttctl)
 * — `hq/engineering/adr/ADR-008-application-funnel-write-side.md`. The
 * `ttctl jobs apply <job-id>` CLI verb delegates to
 * `applications.apply()`; see ADR-008 § Decision Part 5 for the
 * service-module placement rationale.
 *
 * **Out of scope for v1**:
 * - Bulk save / bulk dismiss — single-id verbs only per the issue's
 *   safety boundary.
 * - Recommendation tuning / preference editing — deferred to post-v1.
 */

import type { z } from "zod";

import { buildDryRunPreview } from "../../transport/index.js";
import type { DryRunPreview } from "../../transport/index.js";
import { callGatewayShared } from "../_shared/transport.js";

/**
 * Jobs-domain error codes. Mirrors the `EngagementsError` /
 * `ApplicationsError` shape per project convention.
 *
 * - `NO_VIEWER`: HTTP 200 + `data.viewer === null` (defensive — the
 *   gateway signals auth revoke differently, but kept for coverage).
 * - `NOT_FOUND`: caller's job id doesn't resolve to a viewable job.
 *   Two wire shapes fold into this code: top-level `Record not found`
 *   GraphQL error AND `data.viewer.job === null`.
 * - `GRAPHQL_ERROR`: top-level `errors[]` from the gateway, not
 *   auth-revoked and not `Record not found`.
 * - `MUTATION_ERROR`: `MutationResult.errors[]` payload (operation
 *   succeeded at the GraphQL level, but the mutation itself reports
 *   per-field errors — validation, conflict, etc.).
 * - `NETWORK_ERROR`, `UNKNOWN`: standard transport failure modes.
 *
 * Auth-revoked failures throw `AuthRevokedError` (cross-cutting
 * `TtctlError` subclass per #77), not a code on this enum.
 */
export type JobsErrorCode =
  | "NO_VIEWER"
  | "NOT_FOUND"
  | "GRAPHQL_ERROR"
  | "MUTATION_ERROR"
  | "NETWORK_ERROR"
  | "WIRE_SHAPE_ERROR"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export class JobsError extends Error {
  override readonly name = "JobsError";
  constructor(
    public readonly code: JobsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Reason identifier supplied with `MarkJobAsNotInterested`. The wire
 * mutation marks `reason: String!` and rejects empty strings server-
 * side. A free-text reason is accepted; canonical short reasons
 * observed in the wild include `not_a_match`, `low_rate`,
 * `wrong_commitment`, `wrong_location`, `other`. The mutation does not
 * validate the value against a closed enum.
 */
export interface NotInterestedOptions {
  reason: string;
}

/**
 * Per-mutation option object for the dry-run short-circuit (issue #162,
 * mirroring the #52 reference pattern on `profile.basic.set()`). When
 * `dryRun === true`, the mutation builds a {@link DryRunPreview} and
 * returns `{ kind: "preview", preview }` WITHOUT invoking the gateway
 * transport. Default `false` — the apply path runs and a
 * `{ kind: "applied", result }` outcome is returned.
 *
 * Kept as a stand-alone interface (not a discriminated-union option) so
 * future per-mutation options (e.g. a hypothetical idempotency-key
 * parameter) can extend the same shape additively. The signature is
 * deliberately uniform across the 7 jobs mutations.
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
 * Apply-path outcome for a jobs interest-state mutation
 * (`save` / `unsave` / `markViewed` / `notInterested` / `clearInterest`).
 * Wraps the server-confirmed `JobInterestState` in a discriminated
 * union so callers can branch deterministically between the apply path
 * (`kind: "applied"`) and the dry-run path (`kind: "preview"`, see
 * {@link JobsDryRunPreviewOutcome}).
 */
export interface JobInterestAppliedOutcome {
  kind: "applied";
  result: JobInterestState;
}

/**
 * Dry-run outcome shared by every jobs mutation. Carries a
 * {@link DryRunPreview} (operation name, surface, transport, endpoint,
 * variables payload, redacted headers) — emitted verbatim by the CLI's
 * dry-run envelope (`emitDryRunSuccess` in
 * `packages/cli/src/lib/envelopes.ts`).
 */
export interface JobsDryRunPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link save}. The
 * apply path returns the post-mutation {@link JobInterestState} wrapped
 * in `{ kind: "applied", result }`; the dry-run path returns a
 * {@link DryRunPreview} wrapped in `{ kind: "preview", preview }`.
 *
 * Pre-1.0 the pre-#162 return type (`Promise<JobInterestState>`) no
 * longer exists — callers must branch on `outcome.kind` to access either
 * `outcome.result` or `outcome.preview`. The MCP layer (and any future
 * consumer) updates in lockstep with this rename.
 */
export type SaveOutcome = JobInterestAppliedOutcome | JobsDryRunPreviewOutcome;

/**
 * Discriminated-union return type for {@link unsave}. Identical shape
 * to {@link SaveOutcome} since `unsave` delegates to {@link
 * clearInterest} (same wire operation `JobClearInterest`).
 */
export type UnsaveOutcome = JobInterestAppliedOutcome | JobsDryRunPreviewOutcome;

/**
 * Discriminated-union return type for {@link markViewed}.
 */
export type MarkViewedOutcome = JobInterestAppliedOutcome | JobsDryRunPreviewOutcome;

/**
 * Discriminated-union return type for {@link notInterested}.
 */
export type NotInterestedOutcome = JobInterestAppliedOutcome | JobsDryRunPreviewOutcome;

/**
 * Discriminated-union return type for {@link clearInterest}.
 */
export type ClearInterestOutcome = JobInterestAppliedOutcome | JobsDryRunPreviewOutcome;

/**
 * Apply-path outcome for {@link searchSubscriptionSave}. Carries the
 * post-mutation {@link SearchSubscriptionState} (the active filters, or
 * `{ active: false, filters: null }` if the server unexpectedly reports
 * no subscription after a successful `start`).
 */
export interface SearchSubscriptionSaveAppliedOutcome {
  kind: "applied";
  result: SearchSubscriptionState;
}

/**
 * Discriminated-union return type for {@link searchSubscriptionSave}.
 */
export type SearchSubscriptionSaveOutcome = SearchSubscriptionSaveAppliedOutcome | JobsDryRunPreviewOutcome;

/**
 * Apply-path outcome for {@link searchSubscriptionRemove}. Carries the
 * `{ terminated: true }` confirmation that the wire's idempotent
 * `terminate` mutation returns.
 */
export interface SearchSubscriptionRemoveAppliedOutcome {
  kind: "applied";
  result: { terminated: true };
}

/**
 * Discriminated-union return type for {@link searchSubscriptionRemove}.
 */
export type SearchSubscriptionRemoveOutcome = SearchSubscriptionRemoveAppliedOutcome | JobsDryRunPreviewOutcome;

/**
 * Filter inputs for {@link list}. All fields fold into the captured
 * operation's variables. Empty arrays / undefined are passed through as
 * `null` so the wire defaults apply.
 */
export interface ListOptions {
  /** Skill names — AND across entries. */
  skills?: string[];
  /** Free-text keywords — AND across entries. */
  keywords?: string[];
  /** Skills to EXCLUDE from matching. */
  excludeSkills?: string[];
  /** Keywords to EXCLUDE from matching. */
  excludeKeywords?: string[];
  /** Job commitment slugs (e.g. `FULL_TIME`, `PART_TIME`). */
  commitments?: string[];
  /** Job work types (e.g. `REMOTE`, `ONSITE`). */
  workTypes?: string[];
  /** Estimated lengths (e.g. `SHORT_TERM`, `LONG_TERM`). */
  estimatedLengths?: string[];
  /**
   * Sort target — wire accepts `visible_at`, `posted_at`, etc.
   * Defaults to whatever the server picks when omitted.
   */
  sortTarget?: string;
  /**
   * 1-indexed page number (issue #138). Translated to the wire's
   * 0-indexed `eligibleJobs.page` argument by {@link buildListVariables}.
   * Default `1` when omitted (the wire's `page: 0`).
   */
  page?: number;
  /**
   * Items per page (issue #138). Forwarded verbatim to the wire's
   * `eligibleJobs.pageSize` argument. Default `20` when omitted,
   * matching the pre-#138 hardcoded value.
   */
  perPage?: number;
}

/**
 * Pagination for {@link recommended} — the algorithmic feed takes only
 * offset-list pagination (no filters); the filter-less sibling of
 * {@link ListOptions}. Defaults `page: 1, perPage: 20`.
 */
export interface RecommendedOptions {
  page?: number;
  perPage?: number;
}

/**
 * Pagination options for {@link getJobsForDashboard}. The
 * dashboard activity list (`viewer.jobActivityList`) is offset-paginated
 * like {@link recommended}; defaults are {@link DEFAULT_PAGE} /
 * {@link DEFAULT_PER_PAGE}. No status-group filter is exposed — the
 * unfiltered list surfaces every activity item (engagements,
 * applications, pending actions). Filtering by a single status group is
 * the {@link getJobsCountForDashboard} surface.
 */
export interface DashboardListOptions {
  page?: number;
  perPage?: number;
}

/**
 * Page wrapper returned by {@link list}, {@link saved}, and {@link
 * notInterestedList}. Carries the projected items plus the
 * server-reported `totalCount` and the resolved `page` / `perPage`
 * (i.e., the effective values used in the query, after defaults).
 *
 * The CLI layer (`packages/cli/src/commands/jobs/list.ts`) uses
 * `totalCount` to derive `pageInfo.totalPages` and
 * `pageInfo.hasNextPage` for the offset-style envelope (issue #138).
 *
 * Why not return `JobListItem[]` directly: pre-#138 the caller could
 * not present pagination metadata because the operation hardcoded
 * `page: 0, pageSize: 20`; with the wiring change, callers MUST have
 * access to `totalCount` to render the "Page X of Y" footer and to
 * populate the JSON envelope's `pageInfo`. Returning a structured
 * value is cheaper than threading the metadata through a side channel.
 */
export interface JobListPage {
  items: JobListItem[];
  totalCount: number;
  /** 1-indexed page number actually requested. */
  page: number;
  /** Items per page actually requested. */
  perPage: number;
}

/**
 * Default values for {@link ListOptions} pagination fields when the
 * caller does not specify them. Mirrors the pre-#138 hardcoded values
 * in `JOBS_LIST_QUERY` (`page: 0, pageSize: 20` on the wire — `page:
 * 1, perPage: 20` user-facing). Exposed so tests can assert against
 * the same constants the production code uses.
 */
export const DEFAULT_PAGE = 1 as const;
export const DEFAULT_PER_PAGE = 20 as const;

/**
 * Recruiter-pinned Fixed rate (#410) — surfaced alongside `maxRate` so
 * callers can disambiguate "marketplace ceiling" (`maxRate`, often null)
 * from "recruiter-pinned offer" (`fixedRate`, the Toptal portal's "Fixed"
 * badge). Projected from `viewer.job(id).activityItem.availabilityRequest.
 * metadata.offeredHourlyRate` (`Money` shape). `null` when:
 *
 * - the viewer has no activity item for this job (no prior interaction
 *   AND no recruiter-initiated AR), OR
 * - an activity item exists but carries no `availabilityRequest` (the
 *   job is in the browse pool but no recruiter has pinged the talent
 *   yet — typical for `eligibleJobs` rows the talent hasn't engaged).
 *
 * The same shape is reused on the AR-side surfaces in
 * `@ttctl/core/services/applications` ({@link FixedRate} there).
 */
export interface FixedRate {
  decimal: string;
  verbose: string;
}

/**
 * Single-row projection for jobs listings (browse + saved-list +
 * not-interested-list + viewed-list).
 */
export interface JobListItem {
  id: string;
  title: string | null;
  url: string | null;
  client: { id: string; fullName: string | null } | null;
  commitment: { slug: string } | null;
  workType: { slug: string } | null;
  specialization: { title: string } | null;
  expectedHours: number | null;
  maxRate: number | null;
  fixedRate: FixedRate | null;
  startDate: string | null;
  postedWhen: string | null;
  viewed: boolean | null;
  saved: boolean | null;
  notInterested: boolean | null;
}

/**
 * Single dashboard activity-item projection. `viewer.jobActivityList`
 * is the talent's "my activity" view — every job the talent has an
 * engagement, application, or pending action on — distinct from the
 * browse feeds ({@link list} / {@link recommended}). Each item wraps the
 * underlying {@link JobListItem} (reusing the shared list projection) plus
 * the activity-level status fields.
 *
 * - `status` — human-facing activity status (`statusV2` on the wire):
 *   `value` is the machine token, `verbose` the display label.
 * - `statusGroup` — the coarser grouping (`statusGroupV2.value`, e.g.
 *   `ACTIVE_ENGAGEMENT`, `ON_CLIENT_REVIEW`); the same vocabulary
 *   {@link getJobsCountForDashboard} filters by.
 * - `engagement` / `application` — `{ id }` presence markers (null when
 *   the activity carries neither); lifted from the heavy
 *   `TalentEngagement` / `JobApplication` wire objects to keep the
 *   projection lean.
 */
export interface DashboardJobItem {
  id: string;
  status: { value: string | null; verbose: string | null } | null;
  statusGroup: string | null;
  statusColor: string | null;
  lastUpdatedAt: string | null;
  engagement: { id: string } | null;
  application: { id: string } | null;
  job: JobListItem;
}

/**
 * Page wrapper returned by {@link getJobsForDashboard} — mirrors
 * {@link JobListPage} but carries {@link DashboardJobItem} rows. Same
 * `totalCount` / `page` / `perPage` offset-pagination contract.
 */
export interface DashboardJobPage {
  items: DashboardJobItem[];
  totalCount: number;
  page: number;
  perPage: number;
}

/**
 * Time-zone identity (subset of the well-typed `TimeZone` SDL type) —
 * `location`, `name`, and `value`. `location`/`value` mirror the
 * live-verified `timesheet.show` selection; `name` (the human-readable
 * label) is added per the #545 spec's `timeZone { name }` ask. Surfaced
 * on both {@link CompanyRepresentative} and {@link Recruiter} (#545).
 * Duplicated from `engagements.ContactTimeZone` per the per-service type
 * convention (cf. {@link FixedRate}).
 */
export interface ContactTimeZone {
  location: string | null;
  name: string | null;
  value: string | null;
}

/**
 * Recruiter contact channels (`ContactFields` SDL type) — mirrors the
 * live-verified `contactFieldsData` selection from `timesheet.show`.
 * Duplicated from `engagements.RecruiterContactFields` (#545).
 */
export interface RecruiterContactFields {
  communitySlackId: string | null;
  email: string | null;
  phoneNumber: string | null;
  skype: string | null;
}

/**
 * Toptal-side recruiter contact identity (`Recruiter` SDL type) — the
 * "who's the recruiter on this job" counterparty (#545). Mirrors the
 * live-verified `recruiterData` fragment from `timesheet.show`.
 *
 * **INFERRED note**: `Recruiter.vacation` is `Unknown` in the synth SDL;
 * the `{ id startDate endDate }` shape is proven by the shipped,
 * `TTCTL_E2E=1`-gated `timesheet.show` selection. Duplicated from
 * `engagements.Recruiter` per the per-service type convention.
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
 * Job points-of-contact (`PointsOfContact` SDL type) — `current` is the
 * active recruiter, `handoff` the prior/secondary recruiter, `kind` a
 * free-text discriminator (#545).
 *
 * **INFERRED note**: `PointsOfContact.handoff` is `Unknown` in the synth
 * SDL; the `Recruiter`-shaped selection is proven by the shipped,
 * `TTCTL_E2E=1`-gated `timesheet.show` `pointOfContactData` fragment.
 */
export interface PointsOfContact {
  current: Recruiter | null;
  handoff: Recruiter | null;
  kind: string | null;
}

/**
 * Client-side hiring-manager contact (`CompanyRepresentative` SDL type) —
 * the "who's the client-side contact on this job" counterparty (#545).
 * All fields are non-null in the synth SDL; typed nullable defensively.
 * Duplicated from `engagements.CompanyRepresentative`.
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
 * Detail-view shape for `jobs show <id>`. Extends {@link JobListItem}
 * with descriptive fields and client metadata. Field selection is
 * conservative — fields the CLI / MCP renders.
 */
export interface JobDetail extends JobListItem {
  descriptionMd: string | null;
  minimumHoursPerBillingCycle: number | null;
  isCoaching: boolean | null;
  isToptalProject: boolean | null;
  semiMonthlyBilling: boolean | null;
  positionsCount: number | null;
  jobTimeZone: {
    verbose: string | null;
    hoursOverlap: number | null;
    workingTimeFrom: string | null;
    workingTimeTo: string | null;
  } | null;
  client:
    | (JobListItem["client"] & {
        city: string | null;
        countryName: string | null;
        /**
         * Founding year of the client company (#546). `String?` in the SDL —
         * Toptal stores this as text (e.g. `"2005"`); typed nullable
         * defensively per project convention.
         */
        foundingYear: string | null;
        industry: string | null;
        isEnterprise: boolean | null;
        website: string | null;
        linkedin: string | null;
        teamSize: { value: string | null } | null;
      })
    | null;
  skills: { id: string; name: string; rating: number | null; isOptional: boolean | null }[];
  languages: { id: string; name: string | null }[];
  /** Client-side hiring-manager contacts (#545). `[]` when the wire elides them. */
  contacts: CompanyRepresentative[];
  /** Toptal-side recruiter points-of-contact (#545). `null` when the wire elides them. */
  pointsOfContact: PointsOfContact | null;
}

/**
 * One row of a job's match-quality breakdown — the platform's per-criterion
 * assessment (skills, rate, availability, …). `statusV2` is the per-criterion
 * status; the rest is human-facing copy. All nullable — the op is `Unknown`-
 * typed in the synthesized SDL (schema gap → T1), so non-null is unprovable.
 */
export interface JobMatchQualityMetric {
  name: string | null;
  slug: string | null;
  statusV2: string | null;
  description: string | null;
  explanation: string | null;
  isRequired: boolean | null;
  forAvailabilityRequest: boolean | null;
}

/**
 * A job's match-quality breakdown — returned by {@link matchQuality}.
 * The wire exposes no aggregate score; the breakdown IS the per-criterion
 * {@link JobMatchQualityMetric} list, each carrying its own `statusV2`.
 */
export interface JobMatchQuality {
  metrics: JobMatchQualityMetric[];
}

/**
 * A job's per-job rate insight — returned by {@link rateInsight}. The wire is
 * a `TalentJobRateInsight` union: `kind` discriminates the two variants. Both
 * carry `estimatedRevenue` + `estimatedRevenueExplanation`; the competitive
 * variant adds `longTermDisclaimer`, the uncompetitive variant adds
 * `recentApplicationRate` + `recommendedRate` (the recommended rate band).
 * Every rate is a BigDecimal kept verbatim as a string (ADR-006 wire-string
 * discipline) — never coerced to a number.
 */
export interface JobRateInsight {
  kind: "competitive" | "uncompetitive" | null;
  estimatedRevenue: string | null;
  estimatedRevenueExplanation: string | null;
  longTermDisclaimer: string | null;
  recentApplicationRate: string | null;
  recommendedRate: string | null;
}

/**
 * State payload returned by every mutation that toggles a job's
 * interest signals. Reflects the post-mutation server state.
 */
export interface JobInterestState {
  id: string;
  saved: boolean | null;
  notInterested: boolean | null;
  viewed: boolean | null;
}

/**
 * Filter inputs for the job-search subscription. Mirrors the wire's
 * `StartJobsSearchSubscription` variables. All fields optional —
 * omitting one passes `null` to the server, which interprets as
 * "no constraint on this axis".
 */
export interface SearchSubscriptionFilters {
  skills?: string[];
  keywords?: string[];
  excludeSkills?: string[];
  excludeKeywords?: string[];
  commitments?: string[];
  workTypes?: string[];
  estimatedLengths?: string[];
  excludeUnspecifiedBudget?: boolean;
}

/**
 * State of the user's single job-search subscription. `null` value of
 * `filters` means no active subscription (the user has not started
 * one, or terminated the active one).
 *
 * Note (R2): the wire shape carries a single subscription per viewer —
 * there is no list of named subscriptions. The CLI's `search list` /
 * `search save --name` / `search remove <id>` surface adapts to this
 * cardinality (returns 0-or-1; name is advisory; remove id is ignored).
 */
export interface SearchSubscriptionState {
  active: boolean;
  filters: SearchSubscriptionFilters | null;
}

// ---------------------------------------------------------------------
// GraphQL operation strings (full-document queries — no APQ pinning)
//
// Mirror the captured documents in
// `../research/graphql/gateway/operations/mobile/`, but with selection
// sets trimmed to the shape this service surfaces. Operation NAMES are
// kept distinct from the captured names because (a) we trim aggressively
// and (b) the captured names refer to flows we don't implement (e.g.
// `InitialJobs` selects fragments unrelated to this service's contract).
// ---------------------------------------------------------------------

// Shared `TalentJob` list-row selection. Both `JobsList`
// (`eligibleJobs.entities`) and `GetRecommendedJobs`
// (`recommendedJobsV2.entities`) project it through {@link projectListItem}
// into {@link JobListItem}. Sibling of {@link JOB_DETAIL_SELECTION} — keeps
// the two feeds from drifting.
//
// `activityItem.availabilityRequest.metadata.offeredHourlyRate` (#410)
// surfaces the recruiter-pinned Fixed rate per row. The schema declares
// `TalentJob.activityItem: TalentJobActivityItem!` (non-null) and
// `TalentJobActivityItem.availabilityRequest: AvailabilityRequest`
// (nullable) — eligibleJobs rows the talent hasn't engaged carry
// `availabilityRequest: null`, so `projectFixedRate` short-circuits to
// `null`. Adds one nested selection per row; size impact is small
// (3 strings when set, nothing when not). Disposition stays T1 per
// `docs/wire-validation-routing.md` — no committed snapshot to update.
const JOB_LIST_ENTITY_SELECTION = `__typename
        id
        title
        url
        commitment { __typename slug }
        workType { __typename slug }
        specialization { __typename title }
        expectedHours
        maxRate
        startDate
        postedWhen
        viewed
        saved
        notInterested
        client { __typename id fullName }
        activityItem {
          __typename
          id
          availabilityRequest {
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
        }`;

// Pagination variable types (issue #138) — apply to both `JobsList` and
// `GetRecommendedJobs` below:
//
// - `$page: Int` — nullable Int; server defaults to 0 when omitted.
//   Verified empirically: BlogPosts, GetJobsForDashboard, and
//   GetTalentReferralTrackers (in
//   `research/graphql/gateway/operations/`) all declare `$page: Int`.
//
// - `$pageSize: PageSize` — CUSTOM SCALAR, NOT `Int`. Captured operations
//   use the named `PageSize` scalar. The pre-#138 hardcoded literal
//   `pageSize: 20` worked because GraphQL accepts integer literals for
//   custom scalars without type-checking; once we extracted the value
//   to a variable, the server validated and (correctly) rejected
//   `Int` in a `PageSize`-typed position. The fix is to declare the
//   variable with the actual server type. Verified empirically: live
//   API returned HTTP 400 `Variable "$pageSize" of type "Int!" used
//   in position expecting type "PageSize"` during E2E pre-merge
//   verification — schema/contract validation rule caught it.
const JOBS_LIST_QUERY = `query JobsList($skills: [String!], $keywords: [String!], $excludeSkills: [String!], $excludeKeywords: [String!], $commitments: [JobCommitmentFilterEnum!], $workTypes: [JobWorkTypeSlug!], $estimatedLengths: [EstimatedLengthFilterEnum!], $notInterested: BooleanFilter, $saved: BooleanFilter, $sortTarget: String, $page: Int, $pageSize: PageSize) {
  viewer {
    __typename
    id
    eligibleJobs(
      page: $page
      pageSize: $pageSize
      sortTarget: $sortTarget
      skills: $skills
      keywords: $keywords
      excludeSkills: $excludeSkills
      excludeKeywords: $excludeKeywords
      commitmentsV2: $commitments
      workTypesV2: $workTypes
      estimatedLengths: $estimatedLengths
      filter: { notInterested: $notInterested, saved: $saved }
    ) {
      __typename
      entities {
        ${JOB_LIST_ENTITY_SELECTION}
      }
      totalCount
    }
  }
}`;

// GetRecommendedJobs — algorithmic feed, browse-sibling of `JobsList`.
// Wraps `viewer.recommendedJobsV2(page, pageSize)` — offset-list (ADR-007
// row 1), NOT the `--limit`/`--after` cursor the issue body guessed (the
// captured portal op is offset-paginated, hardcoding `page: 0, pageSize:
// 3`). `$pageSize: PageSize` mirrors `eligibleJobs` (an `Int` in that
// position is rejected — see the #138 note above). Schema gappy
// (`GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`) → T1.
const GET_RECOMMENDED_JOBS_QUERY = `query GetRecommendedJobs($page: Int, $pageSize: PageSize) {
  viewer {
    __typename
    id
    recommendedJobsV2(page: $page, pageSize: $pageSize) {
      __typename
      entities {
        ${JOB_LIST_ENTITY_SELECTION}
      }
      totalCount
    }
  }
}`;

// GetJobsForDashboard — the talent's "my activity" projection
// over `viewer.jobActivityList`. Schema gappy (`jobActivityList` resolves
// to `JobActivityList` whose `entities` are `TalentJobActivityItem`, but
// `JobActivityStatusGroup` is a bare scalar in the synthesized SDL) →
// `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` → T1. Hand-trimmed from the
// captured portal op: the inner `job` reuses `JOB_LIST_ENTITY_SELECTION`
// (it's a `TalentJob`, same as the browse feeds), and the heavy
// `engagement` / `availabilityRequest` sub-objects are reduced to `{ id }`
// presence markers. `$except` / `$only` mirror the captured op's
// `statusGroup` filter (both `[JobActivityStatusGroup!]`, defaulted null
// by the caller = no constraint = the full activity list); `$pageSize:
// PageSize` is the custom scalar, NOT `Int` (see the #138 note above).
const GET_JOBS_FOR_DASHBOARD_QUERY = `query GetJobsForDashboard($page: Int, $pageSize: PageSize, $except: [JobActivityStatusGroup!], $only: [JobActivityStatusGroup!]) {
  viewer {
    __typename
    id
    jobActivityList(page: $page, pageSize: $pageSize, statusGroup: { except: $except, only: $only }) {
      __typename
      totalCount
      entities {
        __typename
        id
        status: statusV2 {
          __typename
          value
          verbose
        }
        statusGroupV2 {
          __typename
          value
        }
        statusColor
        lastUpdatedAt
        engagement {
          __typename
          id
        }
        jobApplication {
          __typename
          id
        }
        job {
          ${JOB_LIST_ENTITY_SELECTION}
        }
      }
    }
  }
}`;

// GetJobsCountForDashboard — just the `totalCount` of
// `viewer.jobActivityList` for ONE status group. The captured op requires
// `$only: JobActivityStatusGroup!` (a single, REQUIRED value — wrapped in
// a list at the arg site), so the count cannot be input-less; the caller
// passes the status group it wants counted (e.g. `ACTIVE_ENGAGEMENT`).
// Same `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` → T1 classification.
const GET_JOBS_COUNT_FOR_DASHBOARD_QUERY = `query GetJobsCountForDashboard($only: JobActivityStatusGroup!) {
  viewer {
    __typename
    id
    jobActivityList(statusGroup: { only: [$only] }) {
      __typename
      totalCount
    }
  }
}`;

// Shared job-detail field selection — a hand-trimmed subset of the
// captured `jobData` fragment. `JobShow` (`viewer.job(id:)`) and
// `JobsByIDs` (`viewer.jobs(ids:)`) select identical fields so both
// project through `projectJobDetail` / `JobDetailEntity`; the constant
// keeps the two queries from drifting.
const JOB_DETAIL_SELECTION = `__typename
      id
      title
      url
      descriptionMd
      commitment { __typename slug }
      workType { __typename slug }
      specialization { __typename title }
      expectedHours
      minimumHoursPerBillingCycle
      maxRate
      startDate
      postedWhen
      viewed
      saved
      notInterested
      isCoaching
      isToptalProject
      semiMonthlyBilling
      positionsCount
      jobTimeZone {
        __typename
        verbose
        hoursOverlap
        workingTimeFrom
        workingTimeTo
      }
      client {
        __typename
        id
        city
        countryName
        foundingYear
        fullName
        industry
        isEnterprise
        website
        linkedin
        teamSize { __typename value }
      }
      contacts {
        __typename
        id
        email
        fullName
        phoneNumber
        position
        timeZone { __typename location name value }
      }
      pointsOfContact {
        __typename
        current {
          __typename
          id
          fullName
          contactFields { __typename communitySlackId email phoneNumber skype }
          photo { __typename small }
          vacation { __typename id startDate endDate }
          timeZone { __typename location name value }
        }
        handoff {
          __typename
          id
          fullName
          contactFields { __typename communitySlackId email phoneNumber skype }
          photo { __typename small }
          vacation { __typename id startDate endDate }
          timeZone { __typename location name value }
        }
        kind
      }
      jobSkillSetsV2 {
        __typename
        edges {
          __typename
          node {
            __typename
            rating
            isOptional
            theSkill { __typename id name }
          }
        }
      }
      languages { __typename id name }
      activityItem {
        __typename
        id
        availabilityRequest {
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
      }`;

const JOB_SHOW_QUERY = `query JobShow($id: ID!) {
  viewer {
    __typename
    id
    job(id: $id) {
      ${JOB_DETAIL_SELECTION}
    }
  }
}`;

// Bulk sibling of `JobShow`. `viewer.jobs(ids:)` batch-fetches the same
// trimmed selection for up to `MAX_SHOW_MANY_IDS` ids in one round-trip.
// The captured op also selects `pendingAvailabilityRequests` at the
// viewer level; ttctl trims that (parity with `JobShow`).
const JOBS_BY_IDS_QUERY = `query JobsByIDs($ids: [ID!]!) {
  viewer {
    __typename
    id
    jobs(ids: $ids) {
      ${JOB_DETAIL_SELECTION}
    }
  }
}`;

// GetJobMatchQualityMetrics — `viewer.job(id:).matchQuality.metrics[]`,
// the portal's per-criterion job-match breakdown. Hand-authored against the
// portal capture; `Unknown`-typed in the synthesized Viewer SDL
// (`GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`) → T1. Optional `$requestedRate` /
// `$requestedHourlyRate` (some criteria are rate-dependent) kept verbatim from
// the capture but omitted by the caller — server defaults to the talent's rate.
const GET_JOB_MATCH_QUALITY_QUERY = `query GetJobMatchQualityMetrics($jobId: ID!, $requestedRate: BigDecimal, $requestedHourlyRate: BigDecimal) {
  viewer {
    __typename
    id
    job(id: $jobId) {
      __typename
      id
      matchQuality(requestedRate: $requestedRate, requestedHourlyRate: $requestedHourlyRate) {
        __typename
        metrics {
          __typename
          name
          slug
          statusV2
          description
          explanation
          isRequired
          forAvailabilityRequest
        }
      }
    }
  }
}`;

// GetTalentJobRateInsight — `viewer.job(id:).rateInsight`, the portal's per-job
// rate-intelligence panel. Hand-authored against the portal capture; the
// `rateInsight` field returns a `TalentJobRateInsight` union, `Unknown`-typed
// in the synthesized Viewer SDL (`GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`) → T1.
// `estimatedRevenue` is `BigDecimal!` on the competitive member but
// `BigDecimal` on the uncompetitive one — live-verified (#474): selecting the
// bare field on both members 400s with a merge conflict, so the competitive
// member aliases it `competitiveEstimatedRevenue` (matching the portal
// capture). `estimatedRevenueExplanation` is the same type on both, so it
// merges cleanly. The capture's optional `$requestedRate` / `$onlyHourlyRates`
// rate-scenario vars are kept verbatim but omitted by the caller (server
// defaults to the talent's rate).
const GET_TALENT_JOB_RATE_INSIGHT_QUERY = `query GetTalentJobRateInsight($jobId: ID!, $requestedRate: BigDecimal, $onlyHourlyRates: Boolean) {
  viewer {
    __typename
    id
    job(id: $jobId) {
      __typename
      id
      rateInsight(requestedRate: $requestedRate, onlyHourlyRates: $onlyHourlyRates) {
        __typename
        ... on TalentJobRateInsightCompetitive {
          competitiveEstimatedRevenue: estimatedRevenue
          estimatedRevenueExplanation
          longTermDisclaimer
        }
        ... on TalentJobRateInsightUncompetitive {
          estimatedRevenue
          estimatedRevenueExplanation
          recentApplicationRate
          recommendedRate
        }
      }
    }
  }
}`;

const MARK_JOB_SAVED_MUTATION = `mutation JobMarkSaved($jobID: ID!) {
  job(id: $jobID) {
    __typename
    markSaved(input: {}) {
      __typename
      success
      errors { __typename key message code }
      job { __typename id saved notInterested viewed }
    }
  }
}`;

const MARK_JOB_NOT_INTERESTED_MUTATION = `mutation JobMarkNotInterested($jobID: ID!, $reason: String!) {
  job(id: $jobID) {
    __typename
    markNotInterested(input: { reason: $reason }) {
      __typename
      success
      errors { __typename key message code }
      job { __typename id saved notInterested viewed }
    }
  }
}`;

const MARK_JOB_VIEWED_MUTATION = `mutation JobMarkViewed($jobID: ID!) {
  job(id: $jobID) {
    __typename
    markViewed(input: {}) {
      __typename
      success
      errors { __typename key message code }
      job { __typename id saved notInterested viewed }
    }
  }
}`;

const CLEAR_JOB_INTEREST_MUTATION = `mutation JobClearInterest($jobID: ID!) {
  job(id: $jobID) {
    __typename
    clearInterestStatus(input: {}) {
      __typename
      success
      errors { __typename key message code }
      job { __typename id saved notInterested viewed }
    }
  }
}`;

const JOB_SEARCH_SUBSCRIPTION_QUERY = `query JobSearchSubscriptionShow {
  viewer {
    __typename
    id
    searchSubscription {
      __typename
      skills
      keywords
      excludeSkills
      excludeKeywords
      commitmentsV2
      workTypesV2
      estimatedLengths
      excludeUnspecifiedBudget
    }
  }
}`;

const START_JOB_SUBSCRIPTION_MUTATION = `mutation JobSearchSubscriptionStart($skills: [String!], $keywords: [String!], $excludeSkills: [String!], $excludeKeywords: [String!], $excludeUnspecifiedBudget: Boolean, $commitments: [JobCommitmentFilterEnum!], $workTypes: [JobWorkTypeSlug!], $estimatedLengths: [EstimatedLengthFilterEnum!]) {
  searchSubscription {
    __typename
    start(input: {
      skills: $skills
      keywords: $keywords
      excludeSkills: $excludeSkills
      excludeKeywords: $excludeKeywords
      excludeUnspecifiedBudget: $excludeUnspecifiedBudget
      commitmentsV2: $commitments
      workTypesV2: $workTypes
      estimatedLengths: $estimatedLengths
    }) {
      __typename
      success
      errors { __typename key message code }
      viewer {
        __typename
        id
        searchSubscription {
          __typename
          skills
          keywords
          excludeSkills
          excludeKeywords
          commitmentsV2
          workTypesV2
          estimatedLengths
          excludeUnspecifiedBudget
        }
      }
    }
  }
}`;

const TERMINATE_JOB_SUBSCRIPTION_MUTATION = `mutation JobSearchSubscriptionTerminate {
  searchSubscription {
    __typename
    terminate(input: {}) {
      __typename
      success
      errors { __typename key message code }
    }
  }
}`;

// ---------------------------------------------------------------------
// Wire-shape interfaces (input to projection helpers)
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

/**
 * Wire-side shape of `TalentJob.activityItem.availabilityRequest`
 * sub-selection (#410). The schema marks `TalentJob.activityItem`
 * non-null, but the AR pointer below is nullable — eligibleJobs rows
 * the talent hasn't engaged carry `availabilityRequest: null`. The
 * metadata path (`metadata.offeredHourlyRate`) carries the recruiter
 * Fixed rate; per the #530 schema split, `AvailabilityRequestMetadata`
 * is a polymorphic supertype and `offeredHourlyRate` lives only on the
 * `AvailabilityRequestFixedMetadata` variant — Flexible / marketplace
 * variants return `metadata` without `offeredHourlyRate`. The
 * nullability cascade therefore has three branches: AR present + Fixed
 * variant → Fixed rate present, AR present + non-Fixed variant → Fixed
 * rate absent, AR null → row carries no Fixed rate.
 */
interface ActivityItemRateWire {
  id: string;
  availabilityRequest: {
    id: string;
    metadata: {
      __typename?: string | null;
      offeredHourlyRate?: {
        decimal: string;
        verbose: string;
      } | null;
    };
  } | null;
}

interface JobListEntity {
  id: string;
  title: string | null;
  url: string | null;
  commitment: { slug: string } | null;
  workType: { slug: string } | null;
  specialization: { title: string } | null;
  expectedHours: number | null;
  maxRate: number | null;
  startDate: string | null;
  postedWhen: string | null;
  viewed: boolean | null;
  saved: boolean | null;
  notInterested: boolean | null;
  client: { id: string; fullName: string | null } | null;
  /**
   * Per-row activity-item sub-selection carrying the recruiter Fixed
   * rate (#410). Optional in the wire shape so fixtures that pre-date
   * the #410 selection (or future trimmed-selection regressions) can
   * still be projected; `projectFixedRate` short-circuits to `null`
   * on absence.
   */
  activityItem?: ActivityItemRateWire | null;
}

interface JobsListResponse {
  viewer: {
    id: string;
    eligibleJobs: {
      entities: JobListEntity[] | null;
      totalCount: number;
    } | null;
  } | null;
}

// `GetRecommendedJobs` wire shape — mirrors {@link JobsListResponse} with
// the `recommendedJobsV2` connection in place of `eligibleJobs`.
interface RecommendedJobsResponse {
  viewer: {
    id: string;
    recommendedJobsV2: {
      entities: JobListEntity[] | null;
      totalCount: number;
    } | null;
  } | null;
}

// `GetJobsForDashboard` wire shape. `entities` is
// `[TalentJobActivityItem]!` on the wire — a non-null list of NULLABLE
// items; `getJobsForDashboard` filters the nulls. The inner `job` reuses
// {@link JobListEntity} so `projectListItem` applies unchanged.
interface DashboardActivityEntity {
  id: string;
  status: { value: string | null; verbose: string | null } | null;
  statusGroupV2: { value: string | null } | null;
  statusColor: string | null;
  lastUpdatedAt: string | null;
  engagement: { id: string } | null;
  jobApplication: { id: string } | null;
  job: JobListEntity;
}

interface JobsForDashboardResponse {
  viewer: {
    id: string;
    jobActivityList: {
      entities: (DashboardActivityEntity | null)[] | null;
      totalCount: number;
    } | null;
  } | null;
}

// `GetJobsCountForDashboard` wire shape — just the count.
interface JobsCountForDashboardResponse {
  viewer: {
    id: string;
    jobActivityList: {
      totalCount: number;
    } | null;
  } | null;
}

interface JobDetailEntity extends JobListEntity {
  descriptionMd: string | null;
  minimumHoursPerBillingCycle: number | null;
  isCoaching: boolean | null;
  isToptalProject: boolean | null;
  semiMonthlyBilling: boolean | null;
  positionsCount: number | null;
  jobTimeZone: {
    verbose: string | null;
    hoursOverlap: number | null;
    workingTimeFrom: string | null;
    workingTimeTo: string | null;
  } | null;
  client: {
    id: string;
    fullName: string | null;
    city: string | null;
    countryName: string | null;
    foundingYear: string | null;
    industry: string | null;
    isEnterprise: boolean | null;
    website: string | null;
    linkedin: string | null;
    teamSize: { value: string | null } | null;
  } | null;
  jobSkillSetsV2: {
    edges:
      | {
          node: {
            rating: number | null;
            isOptional: boolean | null;
            theSkill: { id: string; name: string } | null;
          };
        }[]
      | null;
  } | null;
  languages: { id: string; name: string | null }[] | null;
  // `contacts` is `[CompanyRepresentative]!` on the wire — a non-null list
  // of NULLABLE items; outer `| null` tolerates fixtures that pre-date the
  // #545 selection. `projectContacts` filters the nulls.
  contacts: (CompanyRepresentative | null)[] | null;
  pointsOfContact: PointsOfContact | null;
}

interface JobShowResponse {
  viewer: {
    id: string;
    job: JobDetailEntity | null;
  } | null;
}

// `viewer.jobs(ids:)` return shape. List + item nullability are INFERRED
// — the synthesized Viewer SDL carries neither `job(id:)` nor
// `jobs(ids:)` (schema gap → T1). Typed defensively; `showMany` filters
// null items and re-orders by input id. Live E2E validates the shape.
interface JobsByIdsResponse {
  viewer: {
    id: string;
    jobs: (JobDetailEntity | null)[] | null;
  } | null;
}

// `GetJobMatchQualityMetrics` wire shape — INFERRED end-to-end (`matchQuality`
// is `Unknown`-typed in the synthesized Viewer SDL → T1). Typed defensively
// (every hop nullable, every metric field optional); the projection normalizes
// to the public {@link JobMatchQuality}. Live E2E validates the shape.
interface JobMatchQualityMetricWire {
  name?: string | null;
  slug?: string | null;
  statusV2?: string | null;
  description?: string | null;
  explanation?: string | null;
  isRequired?: boolean | null;
  forAvailabilityRequest?: boolean | null;
}

interface JobMatchQualityResponse {
  viewer: {
    id: string;
    job: {
      id: string;
      matchQuality: {
        metrics: JobMatchQualityMetricWire[] | null;
      } | null;
    } | null;
  } | null;
}

// `GetTalentJobRateInsight` wire shape — INFERRED (`rateInsight` is
// `Unknown`-typed in the synthesized Viewer SDL → T1). The union is flattened:
// every member field is optional, `__typename` discriminates. The projection
// normalizes to the public {@link JobRateInsight}. Live E2E validates the shape.
interface JobRateInsightWire {
  __typename?: string | null;
  // Uncompetitive member's `estimatedRevenue` (BigDecimal); the competitive
  // member's non-null `estimatedRevenue` arrives under the alias below.
  estimatedRevenue?: string | null;
  competitiveEstimatedRevenue?: string | null;
  estimatedRevenueExplanation?: string | null;
  longTermDisclaimer?: string | null;
  recentApplicationRate?: string | null;
  recommendedRate?: string | null;
}

interface JobRateInsightResponse {
  viewer: {
    id: string;
    job: {
      id: string;
      rateInsight: JobRateInsightWire | null;
    } | null;
  } | null;
}

interface MarkJobMutationResponse {
  job: {
    markSaved?:
      | (MutationResult & {
          job: { id: string; saved: boolean | null; notInterested: boolean | null; viewed: boolean | null } | null;
        })
      | null;
    markNotInterested?:
      | (MutationResult & {
          job: { id: string; saved: boolean | null; notInterested: boolean | null; viewed: boolean | null } | null;
        })
      | null;
    markViewed?:
      | (MutationResult & {
          job: { id: string; saved: boolean | null; notInterested: boolean | null; viewed: boolean | null } | null;
        })
      | null;
    clearInterestStatus?:
      | (MutationResult & {
          job: { id: string; saved: boolean | null; notInterested: boolean | null; viewed: boolean | null } | null;
        })
      | null;
  } | null;
}

interface SearchSubscriptionEntity {
  skills: string[] | null;
  keywords: string[] | null;
  excludeSkills: string[] | null;
  excludeKeywords: string[] | null;
  commitmentsV2: string[] | null;
  workTypesV2: string[] | null;
  estimatedLengths: string[] | null;
  excludeUnspecifiedBudget: boolean | null;
}

interface SearchSubscriptionShowResponse {
  viewer: {
    id: string;
    searchSubscription: SearchSubscriptionEntity | null;
  } | null;
}

interface StartSearchSubscriptionResponse {
  searchSubscription: {
    start:
      | (MutationResult & {
          viewer: { id: string; searchSubscription: SearchSubscriptionEntity | null } | null;
        })
      | null;
  } | null;
}

interface TerminateSearchSubscriptionResponse {
  searchSubscription: {
    terminate: MutationResult | null;
  } | null;
}

// The mobile-gateway returns at least two distinct GraphQL error
// messages that both mean "no such job from the caller's perspective":
//   - `"Record not found"`     for some lookup paths (kept for safety;
//                              originally inferred, not yet observed)
//   - `"Invalid ID"`           for malformed/unparseable IDs (live-
//                              observed during #148 E2E — see #166)
// A successful response with `viewer.eligibleJob === null` is the
// third (live-observed) NOT_FOUND signal; that branch is handled
// inline in `show()` and `markViewed()` and is not regex-driven.
const NOT_FOUND_MESSAGE_PATTERN = /Record not found|Invalid ID/i;

/**
 * Thin per-service wrapper around {@link callGatewayShared} (issue
 * #329). Pins the mobile-gateway surface and the {@link JobsError}
 * domain class.
 */
async function callGateway<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return callGatewayShared<T, JobsError>("mobile-gateway", token, operationName, query, variables, JobsError, {
    schema,
  });
}

/**
 * Lift the wire's nested `activityItem.availabilityRequest.metadata.
 * offeredHourlyRate` (Money shape) into a row-level {@link FixedRate}
 * field (#410). Short-circuits at every nullable hop:
 *
 * 1. `activityItem` may be wire-absent or wire-null (defensive —
 *    schema declares non-null but the trimmed selection here keeps
 *    the null-tolerant branch). Accepts `undefined` so callers
 *    constructing partial fixtures don't have to populate every
 *    detail of the wire shape.
 * 2. `activityItem.availabilityRequest` is nullable per schema (the
 *    common case for `eligibleJobs` rows the talent hasn't engaged).
 * 3. `metadata.offeredHourlyRate` is selected only on the
 *    `AvailabilityRequestFixedMetadata` inline fragment (#530); rows
 *    whose AR resolves to `AvailabilityRequestFlexibleMetadata` /
 *    `MarketplaceAvailabilityRequestFlexibleMetadata` return `metadata`
 *    without `offeredHourlyRate`.
 * 4. The Money shape itself is schema-non-null when present, but a
 *    defensive partial check guards against future trimmed selections.
 */
function projectFixedRate(activityItem: ActivityItemRateWire | null | undefined): FixedRate | null {
  if (activityItem === null || activityItem === undefined) return null;
  if (activityItem.availabilityRequest === null) return null;
  const offered = activityItem.availabilityRequest.metadata.offeredHourlyRate;
  if (offered == null) return null;
  if (typeof offered.decimal !== "string" || typeof offered.verbose !== "string") return null;
  return { decimal: offered.decimal, verbose: offered.verbose };
}

function projectListItem(entity: JobListEntity): JobListItem {
  return {
    id: entity.id,
    title: entity.title,
    url: entity.url,
    client: entity.client,
    commitment: entity.commitment,
    workType: entity.workType,
    specialization: entity.specialization,
    expectedHours: entity.expectedHours,
    maxRate: entity.maxRate,
    fixedRate: projectFixedRate(entity.activityItem),
    startDate: entity.startDate,
    postedWhen: entity.postedWhen,
    viewed: entity.viewed,
    saved: entity.saved,
    notInterested: entity.notInterested,
  };
}

// Lift a wire `TalentJobActivityItem` into a {@link DashboardJobItem}:
// coalesce the nullable status hops and reduce
// engagement/application to `{ id }` presence markers; the inner `job`
// rides the shared {@link projectListItem}.
function projectDashboardItem(entity: DashboardActivityEntity): DashboardJobItem {
  return {
    id: entity.id,
    status: entity.status === null ? null : { value: entity.status.value, verbose: entity.status.verbose },
    statusGroup: entity.statusGroupV2?.value ?? null,
    statusColor: entity.statusColor,
    lastUpdatedAt: entity.lastUpdatedAt,
    engagement: entity.engagement === null ? null : { id: entity.engagement.id },
    application: entity.jobApplication === null ? null : { id: entity.jobApplication.id },
    job: projectListItem(entity.job),
  };
}

/**
 * Project the wire `Recruiter` sub-shape into the public {@link Recruiter}
 * type (#545), defensively coalescing every nullable hop and dropping the
 * wire `__typename`. Returns `null` when the wire elides the recruiter.
 * Duplicated from `engagements.index.ts` per the per-service convention.
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

function projectJobDetail(entity: JobDetailEntity): JobDetail {
  const skills: JobDetail["skills"] = [];
  const edges = entity.jobSkillSetsV2?.edges ?? [];
  for (const edge of edges) {
    const node = edge.node;
    const theSkill = node.theSkill;
    if (theSkill !== null) {
      skills.push({
        id: theSkill.id,
        name: theSkill.name,
        rating: node.rating,
        isOptional: node.isOptional,
      });
    }
  }
  return {
    ...projectListItem(entity),
    descriptionMd: entity.descriptionMd,
    minimumHoursPerBillingCycle: entity.minimumHoursPerBillingCycle,
    isCoaching: entity.isCoaching,
    isToptalProject: entity.isToptalProject,
    semiMonthlyBilling: entity.semiMonthlyBilling,
    positionsCount: entity.positionsCount,
    jobTimeZone: entity.jobTimeZone,
    client: entity.client,
    skills,
    languages: (entity.languages ?? []).map((lang) => ({ id: lang.id, name: lang.name })),
    contacts: projectContacts(entity.contacts),
    pointsOfContact: projectPointsOfContact(entity.pointsOfContact),
  };
}

function projectSubscription(entity: SearchSubscriptionEntity | null): SearchSubscriptionState {
  if (entity === null) {
    return { active: false, filters: null };
  }
  const filters: SearchSubscriptionFilters = {};
  if (entity.skills !== null) filters.skills = entity.skills;
  if (entity.keywords !== null) filters.keywords = entity.keywords;
  if (entity.excludeSkills !== null) filters.excludeSkills = entity.excludeSkills;
  if (entity.excludeKeywords !== null) filters.excludeKeywords = entity.excludeKeywords;
  if (entity.commitmentsV2 !== null) filters.commitments = entity.commitmentsV2;
  if (entity.workTypesV2 !== null) filters.workTypes = entity.workTypesV2;
  if (entity.estimatedLengths !== null) filters.estimatedLengths = entity.estimatedLengths;
  if (entity.excludeUnspecifiedBudget !== null) filters.excludeUnspecifiedBudget = entity.excludeUnspecifiedBudget;
  return { active: true, filters };
}

function formatMutationErrors(operationName: string, errors: MutationResultErrors[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return `${operationName}: mutation reported failure but returned no errors`;
  }
  return `${operationName}: ${errors
    .map((e) => `${e.key ?? "(no key)"}: ${e.message ?? "(no message)"} (code: ${e.code ?? "unknown"})`)
    .join("; ")}`;
}

function buildListVariables(
  opts: ListOptions,
  extras: { saved?: boolean; notInterested?: boolean },
): Record<string, unknown> {
  // Pagination defaults: `page: 1, perPage: 20` map to the wire's
  // 1-indexed `page: 1` (= first page). The captured `InitialJobs`
  // operation hardcoded `page: 0` literally, but empirical E2E
  // testing during #138 verification revealed the wire's `page` field
  // is **1-indexed** — `page: 0` and `page: 1` both return the same
  // first slice (the gateway treats 0 as a default-to-first alias).
  // Pages 2, 3, … navigate normally. The pre-#138 hardcoded `page: 0`
  // worked because of this aliasing, NOT because the wire is
  // 0-indexed. The user-facing `--page` is 1-indexed and threads
  // through verbatim; no subtraction.
  const page = opts.page ?? DEFAULT_PAGE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const variables: Record<string, unknown> = {
    skills: opts.skills && opts.skills.length > 0 ? opts.skills : null,
    keywords: opts.keywords && opts.keywords.length > 0 ? opts.keywords : null,
    excludeSkills: opts.excludeSkills && opts.excludeSkills.length > 0 ? opts.excludeSkills : null,
    excludeKeywords: opts.excludeKeywords && opts.excludeKeywords.length > 0 ? opts.excludeKeywords : null,
    commitments: opts.commitments && opts.commitments.length > 0 ? opts.commitments : null,
    workTypes: opts.workTypes && opts.workTypes.length > 0 ? opts.workTypes : null,
    estimatedLengths: opts.estimatedLengths && opts.estimatedLengths.length > 0 ? opts.estimatedLengths : null,
    sortTarget: opts.sortTarget ?? null,
    page,
    pageSize: perPage,
  };
  variables["saved"] = extras.saved !== undefined ? { eq: extras.saved } : null;
  variables["notInterested"] = extras.notInterested !== undefined ? { eq: extras.notInterested } : null;
  return variables;
}

// ---------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------

/**
 * Browse current job opportunities (default sort, paginated).
 *
 * Filters fold straight through to the wire (`eligibleJobs`
 * arguments). Empty arrays / undefined values pass as `null`, letting
 * the server apply its defaults.
 *
 * Pagination (#138): `opts.page` (1-indexed) and `opts.perPage` are
 * forwarded to the wire's 1-indexed `eligibleJobs.page` and
 * `pageSize`. Defaults: `page: 1, perPage: 20`. The wire's `page` is
 * 1-indexed — see {@link buildListVariables} for the empirical
 * findings from #138 E2E verification. Returns a {@link
 * JobListPage} carrying `totalCount` so callers can render
 * offset-style pagination metadata.
 */
export async function list(token: string, opts: ListOptions = {}): Promise<JobListPage> {
  const page = opts.page ?? DEFAULT_PAGE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const data = await callGateway<JobsListResponse>(token, "JobsList", JOBS_LIST_QUERY, buildListVariables(opts, {}));
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.eligibleJobs === null) {
    return { items: [], totalCount: 0, page, perPage };
  }
  const items = (data.viewer.eligibleJobs.entities ?? []).map(projectListItem);
  return { items, totalCount: data.viewer.eligibleJobs.totalCount, page, perPage };
}

/**
 * Algorithmic job-recommendation feed (Toptal's "recommended for you") —
 * the browse-sibling of {@link list}, which returns the full eligible pool.
 * Same {@link JobListPage} shape; defaults `page: 1, perPage: 20`.
 */
export async function recommended(token: string, opts: RecommendedOptions = {}): Promise<JobListPage> {
  const page = opts.page ?? DEFAULT_PAGE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const data = await callGateway<RecommendedJobsResponse>(token, "GetRecommendedJobs", GET_RECOMMENDED_JOBS_QUERY, {
    page,
    pageSize: perPage,
  });
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.recommendedJobsV2 === null) {
    return { items: [], totalCount: 0, page, perPage };
  }
  const items = (data.viewer.recommendedJobsV2.entities ?? []).map(projectListItem);
  return { items, totalCount: data.viewer.recommendedJobsV2.totalCount, page, perPage };
}

/**
 * Dashboard job-activity list — the talent's "my activity"
 * projection over `viewer.jobActivityList` (engagements, applications,
 * pending actions), distinct from the {@link list} / {@link recommended}
 * browse feeds. Same {@link DashboardJobPage} offset-pagination contract;
 * defaults `page: 1, perPage: 20`. The unfiltered list surfaces every
 * activity item (no status-group constraint).
 */
export async function getJobsForDashboard(token: string, opts: DashboardListOptions = {}): Promise<DashboardJobPage> {
  const page = opts.page ?? DEFAULT_PAGE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const data = await callGateway<JobsForDashboardResponse>(token, "GetJobsForDashboard", GET_JOBS_FOR_DASHBOARD_QUERY, {
    page,
    pageSize: perPage,
    // No status-group filter — the full activity list (the captured op's
    // `statusGroup` filter vars defaulted null = no constraint).
    except: null,
    only: null,
  });
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.jobActivityList === null) {
    return { items: [], totalCount: 0, page, perPage };
  }
  const items = (data.viewer.jobActivityList.entities ?? [])
    .filter((e): e is DashboardActivityEntity => e !== null)
    .map(projectDashboardItem);
  return { items, totalCount: data.viewer.jobActivityList.totalCount, page, perPage };
}

/**
 * Count of dashboard job-activity items in ONE status group. The wire op
 * requires `$only: JobActivityStatusGroup!` (a single, REQUIRED value), so
 * the caller MUST name the group to count (e.g. `ACTIVE_ENGAGEMENT`,
 * `CLOSED_ENGAGEMENT`, `ON_CLIENT_REVIEW`, `ON_RECRUITER_REVIEW`).
 * `JobActivityStatusGroup` is a bare scalar in the synthesized SDL, so
 * the value is passed through verbatim (no closed-enum validation, like
 * {@link NotInterestedOptions}'s `reason`).
 */
export async function getJobsCountForDashboard(token: string, statusGroup: string): Promise<number> {
  if (statusGroup.trim() === "") {
    throw new JobsError("VALIDATION_ERROR", "getJobsCountForDashboard requires a non-empty status group.");
  }
  const data = await callGateway<JobsCountForDashboardResponse>(
    token,
    "GetJobsCountForDashboard",
    GET_JOBS_COUNT_FOR_DASHBOARD_QUERY,
    { only: statusGroup },
  );
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  return data.viewer.jobActivityList?.totalCount ?? 0;
}

/**
 * Fetch a single job by id. Throws `JobsError("NOT_FOUND")` for two
 * wire shapes: top-level `Record not found` GraphQL error AND a
 * successful response with `viewer.job === null`.
 */
export async function show(token: string, id: string): Promise<JobDetail> {
  let data: JobShowResponse;
  try {
    data = await callGateway<JobShowResponse>(token, "JobShow", JOB_SHOW_QUERY, { id });
  } catch (err) {
    if (err instanceof JobsError && err.code === "GRAPHQL_ERROR" && NOT_FOUND_MESSAGE_PATTERN.test(err.message)) {
      throw new JobsError("NOT_FOUND", `No job found with id "${id}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.job === null) {
    throw new JobsError("NOT_FOUND", `No job found with id "${id}" (or you don't have access to it).`);
  }
  return projectJobDetail(data.viewer.job);
}

/** Upper bound on the id list accepted by {@link showMany}. */
export const MAX_SHOW_MANY_IDS = 20 as const;

/**
 * Batch-fetch jobs by id — the bulk sibling of {@link show}, wrapping
 * mobile-gateway `JobsByIDs`. Returns found jobs in INPUT order: the wire
 * does not guarantee positional correspondence, so the result is
 * re-ordered client-side by matching each requested id against the
 * returned `id`.
 *
 * Throws `JobsError("VALIDATION_ERROR")` for an empty list or more than
 * {@link MAX_SHOW_MANY_IDS} ids.
 *
 * Unresolvable-id handling is wire-determined and NOT uniform (verified
 * live): an id the wire silently drops is omitted from the result
 * (partial fetch, never a `NOT_FOUND`), but some invalid ids instead make
 * the wire reject the WHOLE batch with `GRAPHQL_ERROR("Invalid ids")`,
 * which propagates verbatim. The service cannot pre-distinguish the two
 * classes, so callers passing untrusted ids must handle either outcome.
 */
export async function showMany(token: string, ids: string[]): Promise<JobDetail[]> {
  if (ids.length === 0) {
    throw new JobsError("VALIDATION_ERROR", "showMany requires at least one job id.");
  }
  if (ids.length > MAX_SHOW_MANY_IDS) {
    throw new JobsError(
      "VALIDATION_ERROR",
      `showMany accepts at most ${MAX_SHOW_MANY_IDS.toString()} ids (got ${ids.length.toString()}).`,
    );
  }
  const data = await callGateway<JobsByIdsResponse>(token, "JobsByIDs", JOBS_BY_IDS_QUERY, { ids });
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  const byId = new Map<string, JobDetail>();
  for (const entity of data.viewer.jobs ?? []) {
    if (entity === null) continue;
    byId.set(entity.id, projectJobDetail(entity));
  }
  const out: JobDetail[] = [];
  for (const id of ids) {
    const job = byId.get(id);
    if (job !== undefined) out.push(job);
  }
  return out;
}

function projectMatchQualityMetric(metric: JobMatchQualityMetricWire): JobMatchQualityMetric {
  return {
    name: metric.name ?? null,
    slug: metric.slug ?? null,
    statusV2: metric.statusV2 ?? null,
    description: metric.description ?? null,
    explanation: metric.explanation ?? null,
    isRequired: metric.isRequired ?? null,
    forAvailabilityRequest: metric.forAvailabilityRequest ?? null,
  };
}

/**
 * Fetch a job's match-quality breakdown by id — the platform's
 * per-criterion assessment of how well the talent matches the job (the
 * portal's job-match panel). Returns a {@link JobMatchQuality} whose `metrics`
 * is `[]` when the wire elides `matchQuality` (e.g. an already-engaged job, or
 * one the platform surfaces no assessment for).
 *
 * Throws `JobsError("NOT_FOUND")` for an unknown / inaccessible id — both the
 * top-level `Record not found` GraphQL error and a `viewer.job === null`
 * response — mirroring {@link show}.
 */
export async function matchQuality(token: string, jobId: string): Promise<JobMatchQuality> {
  let data: JobMatchQualityResponse;
  try {
    data = await callGateway<JobMatchQualityResponse>(token, "GetJobMatchQualityMetrics", GET_JOB_MATCH_QUALITY_QUERY, {
      jobId,
    });
  } catch (err) {
    if (err instanceof JobsError && err.code === "GRAPHQL_ERROR" && NOT_FOUND_MESSAGE_PATTERN.test(err.message)) {
      throw new JobsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.job === null) {
    throw new JobsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`);
  }
  const metrics = (data.viewer.job.matchQuality?.metrics ?? []).map(projectMatchQualityMetric);
  return { metrics };
}

function projectRateInsight(wire: JobRateInsightWire): JobRateInsight {
  const kind =
    wire.__typename === "TalentJobRateInsightCompetitive"
      ? "competitive"
      : wire.__typename === "TalentJobRateInsightUncompetitive"
        ? "uncompetitive"
        : null;
  return {
    kind,
    // The competitive member returns `estimatedRevenue` under the
    // `competitiveEstimatedRevenue` alias (see the query); coalesce both.
    estimatedRevenue: wire.estimatedRevenue ?? wire.competitiveEstimatedRevenue ?? null,
    estimatedRevenueExplanation: wire.estimatedRevenueExplanation ?? null,
    longTermDisclaimer: wire.longTermDisclaimer ?? null,
    recentApplicationRate: wire.recentApplicationRate ?? null,
    recommendedRate: wire.recommendedRate ?? null,
  };
}

/**
 * Fetch a job's rate insight by id — the platform's per-job rate-intelligence
 * panel (the portal's "is your rate competitive for this job" projection).
 * Returns a {@link JobRateInsight} (`kind` discriminates competitive vs
 * uncompetitive), or `null` when the platform surfaces no rate insight for the
 * job (e.g. an already-engaged or ineligible job — the wire elides
 * `rateInsight`).
 *
 * Throws `JobsError("NOT_FOUND")` for an unknown / inaccessible id — both the
 * top-level `Record not found` GraphQL error and a `viewer.job === null`
 * response — mirroring {@link show} and {@link matchQuality}.
 */
export async function rateInsight(token: string, jobId: string): Promise<JobRateInsight | null> {
  let data: JobRateInsightResponse;
  try {
    data = await callGateway<JobRateInsightResponse>(
      token,
      "GetTalentJobRateInsight",
      GET_TALENT_JOB_RATE_INSIGHT_QUERY,
      {
        jobId,
      },
    );
  } catch (err) {
    if (err instanceof JobsError && err.code === "GRAPHQL_ERROR" && NOT_FOUND_MESSAGE_PATTERN.test(err.message)) {
      throw new JobsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`, {
        cause: err,
      });
    }
    throw err;
  }
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.job === null) {
    throw new JobsError("NOT_FOUND", `No job found with id "${jobId}" (or you don't have access to it).`);
  }
  const wire = data.viewer.job.rateInsight;
  return wire === null ? null : projectRateInsight(wire);
}

/**
 * List saved jobs (the bookmark / favorites view).
 *
 * Implementation: `eligibleJobs` with `filter: { saved: { eq: true } }`
 * — the same projection as {@link list} so the CLI can reuse the table
 * renderer.
 *
 * Pagination (#138): accepts `opts.page` / `opts.perPage`; returns
 * a {@link JobListPage} for offset-style envelope rendering.
 */
export async function saved(token: string, opts: ListOptions = {}): Promise<JobListPage> {
  const page = opts.page ?? DEFAULT_PAGE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const data = await callGateway<JobsListResponse>(
    token,
    "JobsList",
    JOBS_LIST_QUERY,
    buildListVariables(opts, { saved: true }),
  );
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.eligibleJobs === null) {
    return { items: [], totalCount: 0, page, perPage };
  }
  const items = (data.viewer.eligibleJobs.entities ?? []).map(projectListItem);
  return { items, totalCount: data.viewer.eligibleJobs.totalCount, page, perPage };
}

/**
 * List jobs marked as not-interested. Implementation: `eligibleJobs`
 * with `filter: { notInterested: { eq: true } }`.
 *
 * Pagination (#138): accepts `opts.page` / `opts.perPage`; returns
 * a {@link JobListPage} for offset-style envelope rendering.
 */
export async function notInterestedList(token: string, opts: ListOptions = {}): Promise<JobListPage> {
  const page = opts.page ?? DEFAULT_PAGE;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const data = await callGateway<JobsListResponse>(
    token,
    "JobsList",
    JOBS_LIST_QUERY,
    buildListVariables(opts, { notInterested: true }),
  );
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.eligibleJobs === null) {
    return { items: [], totalCount: 0, page, perPage };
  }
  const items = (data.viewer.eligibleJobs.entities ?? []).map(projectListItem);
  return { items, totalCount: data.viewer.eligibleJobs.totalCount, page, perPage };
}

/**
 * Safety cap on the number of underlying `JobsList` page fetches
 * {@link viewedList} will issue while aggregating the viewed-jobs
 * pool. With the wire's default page size (20), this caps the total
 * pool scanned at ~`VIEWED_LIST_MAX_INTERNAL_PAGES * 20 = 1000` jobs.
 * Pathologically-large pools cease iteration with a `console.warn`;
 * the returned slice reflects only the pages scanned. Conservative
 * upper bound — empirically, no test account in the project has more
 * than a few hundred eligible jobs, so the cap is academic in
 * practice and exists only to bound the worst case if the wire's
 * `totalCount` ever drifts from `hasNextPage` reality.
 */
const VIEWED_LIST_MAX_INTERNAL_PAGES = 50;

/**
 * List jobs marked as viewed.
 *
 * **R1 — Wire-shape limitation**: the `eligibleJobs` query exposes
 * `BooleanFilter`-typed inputs only on `saved` and `notInterested`.
 * The Toptal mobile app's `InitialJobs` and `SavedJobs` operations
 * (decompiled from APK source — see `research/jadx/sources/fn/x4.java`
 * and `oh.java`) confirm the filter input type carries no `viewed`
 * field; the wire has no server-side path to filter by `viewed`.
 *
 * **Fallback (per #372)**: this function iterates the FULL eligible-
 * jobs pool — fetching consecutive `eligibleJobs` pages via {@link
 * list} until `hasNextPage` is false — applies a client-side filter
 * on `viewed === true`, and dedups by job id (the wire can return the
 * same id on adjacent pages near a sort-boundary; see the per-page
 * note in `24-jobs.e2e.test.ts`). The caller's `opts.page` and
 * `opts.perPage` then slice the POST-FILTER list, NOT the underlying
 * fetch — so `JobListPage.totalCount` reflects the post-filter total
 * (the real count of viewed jobs), matching what users intuitively
 * expect from a "viewed jobs" listing.
 *
 * **Cost trade-off**: O(N/20) wire calls per invocation (one per
 * underlying page of eligible jobs). Capped at {@link
 * VIEWED_LIST_MAX_INTERNAL_PAGES} pages for safety. Acceptable as a
 * stop-gap until Toptal exposes a wire-level `viewed` filter.
 *
 * **Internal fetch page size**: always {@link DEFAULT_PER_PAGE} (20),
 * matching the Toptal mobile app's captured `pageSize`. The caller's
 * `opts.perPage` controls the OUTPUT slice, not the wire fetch — the
 * wire's per-page cap is server-enforced and unverified beyond 20.
 */
export async function viewedList(token: string, opts: ListOptions = {}): Promise<JobListPage> {
  const userPage = opts.page ?? DEFAULT_PAGE;
  const userPerPage = opts.perPage ?? DEFAULT_PER_PAGE;

  // Filter inputs that DO apply to the underlying eligibleJobs fetch
  // (skills, keywords, commitments, …) carry through verbatim — they
  // narrow the underlying pool before the client-side `viewed` pass.
  // `opts.page` / `opts.perPage` do NOT thread through; they apply
  // post-filter on the aggregated pool.
  const fetchOpts: ListOptions = { ...opts };
  delete fetchOpts.page;
  delete fetchOpts.perPage;

  const allViewed: JobListItem[] = [];
  const seenIds = new Set<string>();
  let internalPage = 1;
  let exhausted = false;

  while (internalPage <= VIEWED_LIST_MAX_INTERNAL_PAGES) {
    const result = await list(token, { ...fetchOpts, page: internalPage, perPage: DEFAULT_PER_PAGE });

    for (const item of result.items) {
      if (item.viewed === true && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        allViewed.push(item);
      }
    }

    // Two termination signals: (1) the underlying page returned fewer
    // items than requested (final page); (2) we've scanned through
    // `totalCount` items total. Either suffices.
    const scannedItemCount = internalPage * DEFAULT_PER_PAGE;
    if (result.items.length < DEFAULT_PER_PAGE || scannedItemCount >= result.totalCount) {
      exhausted = true;
      break;
    }
    internalPage += 1;
  }

  if (!exhausted) {
    // Hit the safety cap; the aggregated slice reflects only the
    // pages scanned. Surface a one-line warning on stderr so
    // ops-debugging users notice the truncation; the JSON envelope
    // is unaffected (the slice is still valid, just incomplete).
    console.warn(
      `[ttctl] jobs.viewedList: hit internal fetch cap (${VIEWED_LIST_MAX_INTERNAL_PAGES.toString()} pages × ${DEFAULT_PER_PAGE.toString()} items). Returning post-filter slice over the first ${(VIEWED_LIST_MAX_INTERNAL_PAGES * DEFAULT_PER_PAGE).toString()} eligible jobs only.`,
    );
  }

  // Slice the aggregated post-filter list to the caller's requested page.
  const start = (userPage - 1) * userPerPage;
  const sliced = allViewed.slice(start, start + userPerPage);
  return {
    items: sliced,
    totalCount: allViewed.length,
    page: userPage,
    perPage: userPerPage,
  };
}

/**
 * Mark a job as saved (bookmark). The wire mutation
 * (`MarkJobAsSaved`) toggles `saved=true` and clears `notInterested=false`
 * if it was set — the server's interest-status model is one-of-three
 * (`saved` | `not-interested` | `cleared`).
 *
 * Dry-run path (issue #162): when invoked with `options.dryRun === true`,
 * builds a {@link DryRunPreview} of the mutation without invoking the
 * gateway transport and returns it wrapped in {@link
 * JobsDryRunPreviewOutcome}. The bearer token is redacted per the
 * `DryRunPreview` contract; the `jobID` variable carries the caller's
 * literal id (no sibling read needed for this surface).
 */
export async function save(token: string, id: string, options: DryRunOptions = {}): Promise<SaveOutcome> {
  const variables = { jobID: id };
  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: { operationName: "JobMarkSaved", query: MARK_JOB_SAVED_MUTATION, variables },
      }),
    };
  }
  const data = await callGateway<MarkJobMutationResponse>(token, "JobMarkSaved", MARK_JOB_SAVED_MUTATION, variables);
  return { kind: "applied", result: narrowMutation(data, "markSaved", id, "JobMarkSaved") };
}

/**
 * Clear all interest-status flags on a job. The CLI exposes this as
 * `jobs unsave <id>` (matching the AC) — semantically it also clears
 * `notInterested` because the wire only offers one path
 * (`ClearJobInterestStatus`) to clear EITHER signal. Callers wanting
 * the "remove saved without affecting not-interested" semantics aren't
 * supported by the wire; they would need to re-mark not-interested
 * after.
 *
 * Delegates to {@link clearInterest} (same wire operation
 * `JobClearInterest`) — the dry-run preview therefore reports
 * `operationName: "JobClearInterest"`. The CLI envelope's
 * surface-level `operation` field is `jobs.unsave` (kept distinct so
 * users see the verb they invoked).
 */
export async function unsave(token: string, id: string, options: DryRunOptions = {}): Promise<UnsaveOutcome> {
  return clearInterest(token, id, options);
}

/**
 * Mark a job as not-interested with the supplied reason. The wire
 * mutation (`MarkJobAsNotInterested`) toggles `notInterested=true`
 * and clears `saved=false` if it was set.
 *
 * `reason` is server-side `String!` — rejects empty strings with
 * `code=blank, key=reason`. Caller must supply a non-empty value; the
 * wire does not validate against a closed enum, so free-text is fine.
 *
 * Dry-run path (issue #162): when invoked with `options.dryRun === true`,
 * builds a {@link DryRunPreview} of the mutation without invoking the
 * gateway transport and returns it wrapped in {@link
 * JobsDryRunPreviewOutcome}. The `reason` variable is preserved in the
 * preview's variables payload (it carries no session-bound material) so
 * callers can verify the wire-shape end-to-end.
 */
export async function notInterested(
  token: string,
  id: string,
  opts: NotInterestedOptions,
  options: DryRunOptions = {},
): Promise<NotInterestedOutcome> {
  const variables = { jobID: id, reason: opts.reason };
  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: { operationName: "JobMarkNotInterested", query: MARK_JOB_NOT_INTERESTED_MUTATION, variables },
      }),
    };
  }
  const data = await callGateway<MarkJobMutationResponse>(
    token,
    "JobMarkNotInterested",
    MARK_JOB_NOT_INTERESTED_MUTATION,
    variables,
  );
  return { kind: "applied", result: narrowMutation(data, "markNotInterested", id, "JobMarkNotInterested") };
}

/**
 * Mark a job as viewed (UX-only signal — typically the UI auto-marks
 * on detail-page open; this surface lets the CLI do it explicitly).
 *
 * Dry-run path (issue #162): when invoked with `options.dryRun === true`,
 * builds a {@link DryRunPreview} of the mutation without invoking the
 * gateway transport and returns it wrapped in {@link
 * JobsDryRunPreviewOutcome}.
 */
export async function markViewed(token: string, id: string, options: DryRunOptions = {}): Promise<MarkViewedOutcome> {
  const variables = { jobID: id };
  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: { operationName: "JobMarkViewed", query: MARK_JOB_VIEWED_MUTATION, variables },
      }),
    };
  }
  const data = await callGateway<MarkJobMutationResponse>(token, "JobMarkViewed", MARK_JOB_VIEWED_MUTATION, variables);
  return { kind: "applied", result: narrowMutation(data, "markViewed", id, "JobMarkViewed") };
}

/**
 * Clear the interest-status flags (both `saved` and `notInterested`)
 * on a job. The wire's "undo" path for either save or not-interested.
 *
 * Dry-run path (issue #162): when invoked with `options.dryRun === true`,
 * builds a {@link DryRunPreview} of the mutation without invoking the
 * gateway transport and returns it wrapped in {@link
 * JobsDryRunPreviewOutcome}.
 */
export async function clearInterest(
  token: string,
  id: string,
  options: DryRunOptions = {},
): Promise<ClearInterestOutcome> {
  const variables = { jobID: id };
  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: { operationName: "JobClearInterest", query: CLEAR_JOB_INTEREST_MUTATION, variables },
      }),
    };
  }
  const data = await callGateway<MarkJobMutationResponse>(
    token,
    "JobClearInterest",
    CLEAR_JOB_INTEREST_MUTATION,
    variables,
  );
  return { kind: "applied", result: narrowMutation(data, "clearInterestStatus", id, "JobClearInterest") };
}

function narrowMutation(
  data: MarkJobMutationResponse,
  field: "markSaved" | "markNotInterested" | "markViewed" | "clearInterestStatus",
  id: string,
  operationName: string,
): JobInterestState {
  if (data.job === null) {
    throw new JobsError("NOT_FOUND", `No job found with id "${id}" (or you don't have access to it).`);
  }
  const result = data.job[field];
  if (result === null || result === undefined) {
    throw new JobsError("UNKNOWN", `${operationName} returned a null payload for field "${field}".`);
  }
  if (!result.success) {
    throw new JobsError("MUTATION_ERROR", formatMutationErrors(operationName, result.errors));
  }
  if (result.job === null) {
    throw new JobsError("UNKNOWN", `${operationName} returned success but the \`job\` payload was null.`);
  }
  return {
    id: result.job.id,
    saved: result.job.saved,
    notInterested: result.job.notInterested,
    viewed: result.job.viewed,
  };
}

/**
 * Show the current job-search subscription state. Returns
 * `{ active: false, filters: null }` when no subscription is active.
 *
 * **R2**: the wire models a single subscription per viewer — there is
 * no list. The CLI's `search list` maps this to a 0-or-1 envelope.
 */
export async function searchSubscriptionShow(token: string): Promise<SearchSubscriptionState> {
  const data = await callGateway<SearchSubscriptionShowResponse>(
    token,
    "JobSearchSubscriptionShow",
    JOB_SEARCH_SUBSCRIPTION_QUERY,
    {},
  );
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  return projectSubscription(data.viewer.searchSubscription);
}

/**
 * Start the job-search subscription with the supplied filters. If a
 * subscription is already active, the wire's `start` mutation replaces
 * it (the server does NOT error on "already subscribed").
 *
 * Returns the post-mutation subscription state.
 *
 * Dry-run path (issue #162): when invoked with `options.dryRun === true`,
 * builds a {@link DryRunPreview} of the mutation without invoking the
 * gateway transport and returns it wrapped in {@link
 * JobsDryRunPreviewOutcome}. The filters payload is normalised
 * identically to the apply path so the preview's `variables` reflect
 * the exact wire shape that WOULD have been sent.
 */
export async function searchSubscriptionSave(
  token: string,
  filters: SearchSubscriptionFilters,
  options: DryRunOptions = {},
): Promise<SearchSubscriptionSaveOutcome> {
  const variables: Record<string, unknown> = {
    skills: filters.skills && filters.skills.length > 0 ? filters.skills : null,
    keywords: filters.keywords && filters.keywords.length > 0 ? filters.keywords : null,
    excludeSkills: filters.excludeSkills && filters.excludeSkills.length > 0 ? filters.excludeSkills : null,
    excludeKeywords: filters.excludeKeywords && filters.excludeKeywords.length > 0 ? filters.excludeKeywords : null,
    commitments: filters.commitments && filters.commitments.length > 0 ? filters.commitments : null,
    workTypes: filters.workTypes && filters.workTypes.length > 0 ? filters.workTypes : null,
    estimatedLengths: filters.estimatedLengths && filters.estimatedLengths.length > 0 ? filters.estimatedLengths : null,
    excludeUnspecifiedBudget: filters.excludeUnspecifiedBudget ?? null,
  };
  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: { operationName: "JobSearchSubscriptionStart", query: START_JOB_SUBSCRIPTION_MUTATION, variables },
      }),
    };
  }
  const data = await callGateway<StartSearchSubscriptionResponse>(
    token,
    "JobSearchSubscriptionStart",
    START_JOB_SUBSCRIPTION_MUTATION,
    variables,
  );
  if (data.searchSubscription === null) {
    throw new JobsError("UNKNOWN", "JobSearchSubscriptionStart returned a null `searchSubscription` payload.");
  }
  const result = data.searchSubscription.start;
  if (result === null) {
    throw new JobsError("UNKNOWN", "JobSearchSubscriptionStart returned a null `start` payload.");
  }
  if (!result.success) {
    throw new JobsError("MUTATION_ERROR", formatMutationErrors("JobSearchSubscriptionStart", result.errors));
  }
  return { kind: "applied", result: projectSubscription(result.viewer?.searchSubscription ?? null) };
}

/**
 * Terminate the active job-search subscription. The wire's `terminate`
 * mutation is idempotent — terminating a non-active subscription
 * returns `success: true` with no errors.
 *
 * Returns `{ terminated: true }` on success. The post-terminate
 * subscription state is implicit (`active: false`) and is not re-
 * fetched here.
 *
 * Dry-run path (issue #162): when invoked with `options.dryRun === true`,
 * builds a {@link DryRunPreview} of the mutation without invoking the
 * gateway transport and returns it wrapped in {@link
 * JobsDryRunPreviewOutcome}. The variables payload is `{}` (the wire
 * `terminate` mutation takes no variables).
 */
export async function searchSubscriptionRemove(
  token: string,
  options: DryRunOptions = {},
): Promise<SearchSubscriptionRemoveOutcome> {
  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "mobile-gateway",
        authToken: token,
        body: {
          operationName: "JobSearchSubscriptionTerminate",
          query: TERMINATE_JOB_SUBSCRIPTION_MUTATION,
          variables: {},
        },
      }),
    };
  }
  const data = await callGateway<TerminateSearchSubscriptionResponse>(
    token,
    "JobSearchSubscriptionTerminate",
    TERMINATE_JOB_SUBSCRIPTION_MUTATION,
    {},
  );
  if (data.searchSubscription === null) {
    throw new JobsError("UNKNOWN", "JobSearchSubscriptionTerminate returned a null `searchSubscription` payload.");
  }
  const result = data.searchSubscription.terminate;
  if (result === null) {
    throw new JobsError("UNKNOWN", "JobSearchSubscriptionTerminate returned a null `terminate` payload.");
  }
  if (!result.success) {
    throw new JobsError("MUTATION_ERROR", formatMutationErrors("JobSearchSubscriptionTerminate", result.errors));
  }
  return { kind: "applied", result: { terminated: true } };
}
