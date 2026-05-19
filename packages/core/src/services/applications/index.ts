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
 * 1. **Top-level GraphQL error `Record not found`** (the empirical
 *    happy-sad path — verified live on 2026-05-10). The gateway
 *    short-circuits with a top-level `errors[]` carrying the literal
 *    message "Record not found" rather than returning `data: null`.
 *    `callGateway` raises `GRAPHQL_ERROR`; we catch and translate.
 * 2. **Successful response with `viewer.jobActivityItem === null`** —
 *    not observed in practice but kept as defensive coverage in case
 *    the gateway ever switches to the data-shape sentinel.
 */
const NOT_FOUND_MESSAGE_PATTERN = /Record not found/i;

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
