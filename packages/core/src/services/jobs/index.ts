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
 * | `list`                        | `eligibleJobs` (page 0, default scope)      |
 * | `show <id>`                   | `Job(id)`                                   |
 * | `save <id>`                   | `MarkJobAsSaved`                            |
 * | `unsave <id>`                 | `ClearJobInterestStatus` (clears all)       |
 * | `saved`                       | `eligibleJobs` (filter saved=true)          |
 * | `markViewed <id>`             | `MarkJobAsViewed`                           |
 * | `viewedList`                  | client-side filter on `eligibleJobs` (R1)   |
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
 * - **R1 — Viewed-list scope**: `eligibleJobs` exposes no `viewed`
 *   boolean filter, only `notInterested` and `saved`. {@link viewedList}
 *   fetches the first page of jobs and applies a client-side filter on
 *   the `viewed` field. This is best-effort and scoped to the server's
 *   default page size (20). Document in the CLI / MCP help text.
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
 * **Out of scope for v1**:
 * - Application funnel (`jobs apply` etc.) — lives in `applications`
 *   group (#15) as the funnel-crossing verb.
 * - Bulk save / bulk dismiss — single-id verbs only per the issue's
 *   safety boundary.
 * - Recommendation tuning / preference editing — deferred to post-v1.
 * - Pagination — wire supports `page` / `pageSize` but v1 keeps the
 *   default first-page surface. Will land via the global #138 work.
 */

import { AuthRevokedError, TtctlError } from "../../auth/errors.js";
import { stockTransport } from "../../transport.js";
import type { TransportResponse } from "../../transport.js";
import { isAuthRevokedExtensionCode } from "../profile/shared.js";

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
  startDate: string | null;
  postedWhen: string | null;
  viewed: boolean | null;
  saved: boolean | null;
  notInterested: boolean | null;
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
        industry: string | null;
        isEnterprise: boolean | null;
        website: string | null;
        linkedin: string | null;
        teamSize: { value: string | null } | null;
      })
    | null;
  skills: { id: string; name: string; rating: number | null; isOptional: boolean | null }[];
  languages: { id: string; name: string | null }[];
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

const JOBS_LIST_QUERY = `query JobsList($skills: [String!], $keywords: [String!], $excludeSkills: [String!], $excludeKeywords: [String!], $commitments: [JobCommitmentFilterEnum!], $workTypes: [JobWorkTypeSlug!], $estimatedLengths: [EstimatedLengthFilterEnum!], $notInterested: BooleanFilter, $saved: BooleanFilter, $sortTarget: String) {
  viewer {
    __typename
    id
    eligibleJobs(
      page: 0
      pageSize: 20
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
        __typename
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
      }
      totalCount
    }
  }
}`;

const JOB_SHOW_QUERY = `query JobShow($id: ID!) {
  viewer {
    __typename
    id
    job(id: $id) {
      __typename
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
        fullName
        industry
        isEnterprise
        website
        linkedin
        teamSize { __typename value }
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
}

interface JobShowResponse {
  viewer: {
    id: string;
    job: JobDetailEntity | null;
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

const NOT_FOUND_MESSAGE_PATTERN = /Record not found/i;

/**
 * Issue a GraphQL request against the mobile-gateway surface and
 * normalize transport / GraphQL outcomes into typed `JobsError` throws.
 * Mirrors the `callGateway` helpers in `applications` / `engagements`.
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
    throw new JobsError("NETWORK_ERROR", `${operationName} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new JobsError("UNKNOWN", `${operationName} returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as { data?: T | null; errors?: GraphQLErrorEntry[] | null } | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new JobsError("GRAPHQL_ERROR", `${operationName} failed: ${first?.message ?? "GraphQL error"}`);
  }
  if (!body?.data) {
    throw new JobsError("UNKNOWN", `${operationName} response had no \`data\` field`);
  }
  return body.data;
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
    startDate: entity.startDate,
    postedWhen: entity.postedWhen,
    viewed: entity.viewed,
    saved: entity.saved,
    notInterested: entity.notInterested,
  };
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
  const variables: Record<string, unknown> = {
    skills: opts.skills && opts.skills.length > 0 ? opts.skills : null,
    keywords: opts.keywords && opts.keywords.length > 0 ? opts.keywords : null,
    excludeSkills: opts.excludeSkills && opts.excludeSkills.length > 0 ? opts.excludeSkills : null,
    excludeKeywords: opts.excludeKeywords && opts.excludeKeywords.length > 0 ? opts.excludeKeywords : null,
    commitments: opts.commitments && opts.commitments.length > 0 ? opts.commitments : null,
    workTypes: opts.workTypes && opts.workTypes.length > 0 ? opts.workTypes : null,
    estimatedLengths: opts.estimatedLengths && opts.estimatedLengths.length > 0 ? opts.estimatedLengths : null,
    sortTarget: opts.sortTarget ?? null,
  };
  variables["saved"] = extras.saved !== undefined ? { eq: extras.saved } : null;
  variables["notInterested"] = extras.notInterested !== undefined ? { eq: extras.notInterested } : null;
  return variables;
}

// ---------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------

/**
 * Browse current job opportunities (page 0, default sort).
 *
 * Filters fold straight through to the wire (`eligibleJobs` arguments).
 * Empty arrays / undefined values pass as `null`, letting the server
 * apply its defaults.
 */
export async function list(token: string, opts: ListOptions = {}): Promise<JobListItem[]> {
  const data = await callGateway<JobsListResponse>(token, "JobsList", JOBS_LIST_QUERY, buildListVariables(opts, {}));
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.eligibleJobs === null) {
    return [];
  }
  return (data.viewer.eligibleJobs.entities ?? []).map(projectListItem);
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

/**
 * List saved jobs (the bookmark / favorites view).
 *
 * Implementation: `eligibleJobs` with `filter: { saved: { eq: true } }`
 * — the same projection as {@link list} so the CLI can reuse the table
 * renderer.
 */
export async function saved(token: string): Promise<JobListItem[]> {
  const data = await callGateway<JobsListResponse>(
    token,
    "JobsList",
    JOBS_LIST_QUERY,
    buildListVariables({}, { saved: true }),
  );
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.eligibleJobs === null) {
    return [];
  }
  return (data.viewer.eligibleJobs.entities ?? []).map(projectListItem);
}

/**
 * List jobs marked as not-interested. Implementation: `eligibleJobs`
 * with `filter: { notInterested: { eq: true } }`.
 */
export async function notInterestedList(token: string): Promise<JobListItem[]> {
  const data = await callGateway<JobsListResponse>(
    token,
    "JobsList",
    JOBS_LIST_QUERY,
    buildListVariables({}, { notInterested: true }),
  );
  if (data.viewer === null) {
    throw new JobsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  if (data.viewer.eligibleJobs === null) {
    return [];
  }
  return (data.viewer.eligibleJobs.entities ?? []).map(projectListItem);
}

/**
 * List jobs marked as viewed.
 *
 * **R1 — Wire-shape gap**: the `eligibleJobs` query exposes filters
 * only for `saved` and `notInterested`, not `viewed`. This function
 * fetches the first page of jobs ({@link list}) and applies a
 * client-side filter on the `viewed` boolean. The result is scoped to
 * the first 20 jobs the server returned — jobs the user has viewed but
 * are on subsequent pages will not appear.
 *
 * The CLI / MCP help text surfaces this caveat. A wire-level filter
 * would be the right long-term fix and is tracked as a follow-up.
 */
export async function viewedList(token: string): Promise<JobListItem[]> {
  const items = await list(token);
  return items.filter((it) => it.viewed === true);
}

/**
 * Mark a job as saved (bookmark). The wire mutation
 * (`MarkJobAsSaved`) toggles `saved=true` and clears `notInterested=false`
 * if it was set — the server's interest-status model is one-of-three
 * (`saved` | `not-interested` | `cleared`).
 */
export async function save(token: string, id: string): Promise<JobInterestState> {
  const data = await callGateway<MarkJobMutationResponse>(token, "JobMarkSaved", MARK_JOB_SAVED_MUTATION, {
    jobID: id,
  });
  return narrowMutation(data, "markSaved", id, "JobMarkSaved");
}

/**
 * Clear all interest-status flags on a job. The CLI exposes this as
 * `jobs unsave <id>` (matching the AC) — semantically it also clears
 * `notInterested` because the wire only offers one path
 * (`ClearJobInterestStatus`) to clear EITHER signal. Callers wanting
 * the "remove saved without affecting not-interested" semantics aren't
 * supported by the wire; they would need to re-mark not-interested
 * after.
 */
export async function unsave(token: string, id: string): Promise<JobInterestState> {
  return clearInterest(token, id);
}

/**
 * Mark a job as not-interested with the supplied reason. The wire
 * mutation (`MarkJobAsNotInterested`) toggles `notInterested=true`
 * and clears `saved=false` if it was set.
 *
 * `reason` is server-side `String!` — rejects empty strings with
 * `code=blank, key=reason`. Caller must supply a non-empty value; the
 * wire does not validate against a closed enum, so free-text is fine.
 */
export async function notInterested(token: string, id: string, opts: NotInterestedOptions): Promise<JobInterestState> {
  const data = await callGateway<MarkJobMutationResponse>(
    token,
    "JobMarkNotInterested",
    MARK_JOB_NOT_INTERESTED_MUTATION,
    { jobID: id, reason: opts.reason },
  );
  return narrowMutation(data, "markNotInterested", id, "JobMarkNotInterested");
}

/**
 * Mark a job as viewed (UX-only signal — typically the UI auto-marks
 * on detail-page open; this surface lets the CLI do it explicitly).
 */
export async function markViewed(token: string, id: string): Promise<JobInterestState> {
  const data = await callGateway<MarkJobMutationResponse>(token, "JobMarkViewed", MARK_JOB_VIEWED_MUTATION, {
    jobID: id,
  });
  return narrowMutation(data, "markViewed", id, "JobMarkViewed");
}

/**
 * Clear the interest-status flags (both `saved` and `notInterested`)
 * on a job. The wire's "undo" path for either save or not-interested.
 */
export async function clearInterest(token: string, id: string): Promise<JobInterestState> {
  const data = await callGateway<MarkJobMutationResponse>(token, "JobClearInterest", CLEAR_JOB_INTEREST_MUTATION, {
    jobID: id,
  });
  return narrowMutation(data, "clearInterestStatus", id, "JobClearInterest");
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
 */
export async function searchSubscriptionSave(
  token: string,
  filters: SearchSubscriptionFilters,
): Promise<SearchSubscriptionState> {
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
  return projectSubscription(result.viewer?.searchSubscription ?? null);
}

/**
 * Terminate the active job-search subscription. The wire's `terminate`
 * mutation is idempotent — terminating a non-active subscription
 * returns `success: true` with no errors.
 *
 * Returns `{ terminated: true }` on success. The post-terminate
 * subscription state is implicit (`active: false`) and is not re-
 * fetched here.
 */
export async function searchSubscriptionRemove(token: string): Promise<{ terminated: true }> {
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
  return { terminated: true };
}
