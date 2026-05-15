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
 * **Out of scope for v1** (deliberate; see `.tmp/workitem-15.md`):
 * - Date range filters (`--from` / `--to`) — captured operation accepts no
 *   date args.
 * - Pagination (`--page` / `--per-page`) — captured operation has no
 *   `page` / `pageSize` args. Will land via the global #138 work.
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

import { AuthRevokedError, TtctlError } from "../../auth/errors.js";
import { buildWireShapeError } from "../../lib/wire-shape.js";
import { stockTransport } from "../../transport.js";
import type { TransportResponse } from "../../transport.js";
import { isAuthRevokedExtensionCode } from "../profile/shared.js";

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
}

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
 * One row in the activity list — the CLI's `applications list` and the
 * MCP's `ttctl_applications_list` both surface this shape. `engagement`,
 * `jobApplication`, `availabilityRequest`, and `interview` are all
 * presence indicators (only `id` is selected) — a non-null value tells
 * the consumer "this row has reached the corresponding lifecycle
 * stage". The `mostRelevantApplication` union from the captured
 * operation is intentionally elided here: it duplicates information
 * `jobApplication` / `availabilityRequest` already carry.
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
// ---------------------------------------------------------------------

const JOB_ACTIVITY_LIST_QUERY = `query JobActivityItems($keywords: [String!], $onlyStatusGroupFilter: [JobActivityItemStatusGroupEnum!]) {
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
        jobApplication { __typename id }
        engagement { __typename id }
        availabilityRequest { __typename id }
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
      availabilityRequest { __typename id }
      interview { __typename id }
    }
  }
}`;

// Stats reuses JOB_ACTIVITY_LIST_QUERY but ignores `entities` — the
// caller only reads `totalCount`. Issuing a separate "count-only" query
// here would be cosmetic; the gateway returns the entities anyway.
// Five small parallel calls keep the wall-clock cost flat (≈ one
// round-trip).

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface JobActivityListResponse {
  data?: {
    viewer: {
      id: string;
      jobActivityList: {
        entities: JobActivityItem[] | null;
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
      jobActivityItem: JobActivityItemDetail | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Issue a GraphQL request against the mobile-gateway surface and
 * normalize transport / GraphQL outcomes into typed `ApplicationsError`
 * throws. Mirrors the helper pattern in `profile.skills` (sub-domain
 * carries its own helper rather than depending on
 * `profile/shared.ts#callTalentProfile`, which is `talent-profile`-
 * specific).
 *
 * Error mapping:
 * - `TtctlError` subclasses (`Cf403Error`, `AuthRevokedError`, etc.)
 *   propagate as-is so the CLI / MCP surfaces apply their uniform
 *   `recovery` rendering.
 * - Other transport throws → `ApplicationsError("NETWORK_ERROR")`.
 * - HTTP 401 → `AuthRevokedError`.
 * - Non-2xx → `ApplicationsError("UNKNOWN")` with the status code.
 * - Top-level `errors[]` with an auth-revoked extension code →
 *   `AuthRevokedError`.
 * - Top-level `errors[]` otherwise → `ApplicationsError("GRAPHQL_ERROR")`.
 * - Missing `data` field → `ApplicationsError("UNKNOWN")`.
 * - `data.viewer === null` → `ApplicationsError("NO_VIEWER")`.
 */
async function callGateway<T extends { viewer: { id: string } | null }>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
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
    throw new ApplicationsError("NETWORK_ERROR", `${operationName} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApplicationsError("UNKNOWN", `${operationName} returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as { data?: T | null; errors?: GraphQLErrorEntry[] | null } | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ApplicationsError("GRAPHQL_ERROR", `${operationName} failed: ${first?.message ?? "GraphQL error"}`);
  }
  if (!body?.data) {
    throw new ApplicationsError("UNKNOWN", `${operationName} response had no \`data\` field`);
  }
  let data: T;
  if (schema !== undefined) {
    const parsed = schema.safeParse(body.data);
    if (!parsed.success) {
      const payload = buildWireShapeError(operationName, parsed.error, body.data);
      throw new ApplicationsError("WIRE_SHAPE_ERROR", payload.message, { cause: parsed.error });
    }
    data = parsed.data;
  } else {
    data = body.data;
  }
  if (data.viewer === null) {
    throw new ApplicationsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  return data;
}

/**
 * List the signed-in user's job activity items (applications,
 * availability requests, interviews, engagements).
 *
 * Default scope is whatever the server returns when neither filter is
 * supplied (empirically the full unpaginated set, capped at the
 * server's default limit). The returned array preserves server order;
 * the CLI / MCP do not re-sort.
 *
 * **AC scope adjustment** (per #15 user decision 2026-05-10): the
 * operation accepts NO date filter and NO pagination args. `--from` /
 * `--to` and `--page` / `--per-page` flags are deliberately not exposed
 * by this leaf; the AC items that referenced them are deferred. See
 * `.tmp/workitem-15.md` § Open Questions (RESOLVED) for the rationale.
 */
export async function list(token: string, opts: ListOptions = {}): Promise<JobActivityItem[]> {
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
  const data = await callGateway<JobActivityListResponse["data"] & object>(
    token,
    "JobActivityItems",
    JOB_ACTIVITY_LIST_QUERY,
    variables,
  );
  // The cast above is the awkward part of dropping codegen here; the
  // shape narrowing below is the single source of runtime truth.
  if (data.viewer === null || data.viewer.jobActivityList === null) {
    return [];
  }
  return data.viewer.jobActivityList.entities ?? [];
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
  return data.viewer.jobActivityItem;
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
        { keywords: null, onlyStatusGroupFilter: [group] },
      );
      const count = data.viewer?.jobActivityList?.totalCount ?? 0;
      return { name: group, count };
    }),
  );
  const total = groupResults.reduce((sum, g) => sum + g.count, 0);
  return { total, groups: groupResults };
}
