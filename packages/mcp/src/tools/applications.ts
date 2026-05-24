// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applications } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import type { ToolErrorResponse } from "../errors.js";
import { buildMcpDryRunPreview, dryRunMultiResponse, dryRunResponse, type ToolRegistrationContext } from "./_shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Pagination input fields for `ttctl_applications_list` (issue #377).
 * Constraints mirror the CLI's `parsePaginationFlag` (positive integer
 * ≥ 1); the per-page upper bound is server-enforced. The service-layer
 * defaults (`page: 1, perPage: 20`) kick in when either field is
 * omitted, so existing MCP callers see no behavioral change. Same
 * shape as the four paginating `ttctl_jobs_*` tools (#369).
 */
const PAGE_FIELD = z.number().int().min(1).optional().describe("1-indexed page number (≥ 1). Default: 1.");

const PER_PAGE_FIELD = z.number().int().min(1).optional().describe("Items per page (≥ 1; server-capped). Default: 20.");

/**
 * Build the variables payload the core `applications.list()` sends to
 * `JobActivityItems` so a dry-run preview matches the apply path's
 * wire shape EXACTLY (issue #377). Mirrors the core's "empty/undefined
 * → null" coercion for `keywords` / `onlyStatusGroupFilter` plus the
 * resolved `page` / `pageSize` (defaults applied via
 * `applications.DEFAULT_PAGE` / `DEFAULT_PER_PAGE`). Structural twin of
 * jobs.ts's `buildJobsListVariables` (#369).
 */
function buildApplicationsListVariables(opts: applications.ListOptions): Record<string, unknown> {
  return {
    keywords: opts.keywords && opts.keywords.length > 0 ? opts.keywords : null,
    onlyStatusGroupFilter: opts.statusGroups && opts.statusGroups.length > 0 ? opts.statusGroups : null,
    page: opts.page ?? applications.DEFAULT_PAGE,
    pageSize: opts.perPage ?? applications.DEFAULT_PER_PAGE,
  };
}

/**
 * Offset-style pagination metadata surfaced alongside `items` on
 * `ttctl_applications_list` (#377). Mirrors the CLI's
 * `EnvelopePageInfo` shape (and the jobs MCP `JobsPageInfo`) so LLM
 * clients detect "more pages available" via `hasNextPage` and iterate.
 *
 * Structural twin of
 * `packages/cli/src/commands/applications/shared.ts#buildApplicationsPageInfo`
 * per the project's no-cross-surface-import convention (cli ⊥ mcp;
 * both depend on core but never on each other — see
 * `applications/shared.ts` § module note). The duplication is
 * intentional; deduplicating would require a new shared package or
 * promoting the helper into core, both out of scope for #377.
 */
interface ApplicationsPageInfo {
  currentPage: number;
  perPage: number;
  totalPages: number;
  hasNextPage: boolean;
}

function buildApplicationsPageInfo(page: applications.JobActivityListPage): ApplicationsPageInfo {
  const totalPages = Math.max(1, Math.ceil(page.totalCount / page.perPage));
  return {
    currentPage: page.page,
    perPage: page.perPage,
    totalPages,
    hasNextPage: page.page < totalPages,
  };
}

/**
 * Register the seven `ttctl_applications_*` MCP tools per #15 / #439 / #440 / #442 / #470.
 * Tool names use the `ttctl_` prefix and the canonical CLI path joined
 * with `_` per project naming policy:
 *
 *   - `ttctl_applications_list`
 *   - `ttctl_applications_show`
 *   - `ttctl_applications_stats`
 *   - `ttctl_applications_interview_show` (#439, sub-namespace leaf)
 *   - `ttctl_applications_interview_notes_show` (#440, sub-sub-namespace leaf)
 *   - `ttctl_applications_interview_guide_show` (#470, sub-sub-namespace leaf)
 *   - `ttctl_applications_availability_request_show` (#442, sub-namespace leaf)
 *
 * Each tool maps 1:1 to a CLI leaf — the schemas describe the same set
 * of fields. The list tool's `keywords` and `statusGroups` mirror the
 * `--keywords` / `--status-group` CLI flags.
 *
 * **Pagination (#377)**: `ttctl_applications_list` accepts optional
 * `page` (1-indexed) and `perPage` (server-capped) integers — mirroring
 * the CLI's `--page` / `--per-page` flags and the four paginating
 * `ttctl_jobs_*` tools (#369). The apply-path response is
 * `{ items, pageInfo }` where `pageInfo` mirrors the CLI's
 * `EnvelopePageInfo` shape so LLM callers detect `hasNextPage` and
 * iterate. `#377` added the `$page` / `$pageSize` wire args to the
 * hand-authored `JobActivityItems` document (a wire-shape change gated
 * by the mandatory live E2E per the schema/contract rule).
 *
 * **Read-only** — per project non-goals (#15), no apply / withdraw /
 * edit tools are exposed. `applications` is intentionally a smaller
 * surface than the profile sub-domains.
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`.
 * `list` and `show` emit the singular `{ preview }` envelope (one
 * operation per call); `stats` emits the plural `{ previews: [...] }`
 * envelope because the apply path fires 5 parallel `JobActivityItems`
 * calls (one per STATUS_GROUPS member) — see {@link dryRunMultiResponse}.
 */
export function registerApplicationsTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_applications_list",
    {
      title: "List activity items",
      description: [
        "List the signed-in user's Toptal Talent activity items.",
        "Each row represents an application, availability request, interview, or engagement —",
        "Toptal collapses these into a single 'TalentJobActivityItem' resource.",
        "",
        "Optional filters:",
        "  - `keywords`: free-text search against indexed job fields",
        "  - `statusGroups`: restrict to one or more JobActivityItemStatusGroupEnum values",
        "",
        "UI ↔ API status-group mapping (portal label → `statusGroups` enum value):",
        "  - 'Interest Requests' / 'Job Interest Request' → `ON_RECRUITER_REVIEW`",
        "    (specifically `statusV2.value: AVAILABILITY_REQUEST_PENDING`,",
        '    `statusV2.verbose: "Job Interest Request"`)',
        "  - 'On Client Review' → `ON_CLIENT_REVIEW`",
        "  - 'Active Engagement' → `ACTIVE_ENGAGEMENT`",
        "  - 'Closed Engagement' → `CLOSED_ENGAGEMENT`",
        "  - 'Archive' / 'Archived' → `ARCHIVED`",
        "",
        "Each row's response `statusV2.verbose` is the exact label the portal shows",
        '(e.g. "Job Interest Request", "Active", "Archived"); `statusV2.value` is the',
        "wire enum (e.g. `AVAILABILITY_REQUEST_PENDING`).",
        "",
        "Pagination (#377): returns one page of activity items plus offset-style",
        "`pageInfo` (`currentPage`, `perPage`, `totalPages`, `hasNextPage`) so callers",
        "can iterate beyond the default first page (≤20).",
        "  - `page`: 1-indexed page number (≥ 1). Default: 1.",
        "  - `perPage`: items per page (≥ 1; server-capped). Default: 20.",
        "",
        "Each row also carries `mostRelevantApplication` (#547) — the platform's id-only pointer",
        "at the AvailabilityRequest that matters most for that row (`null` when none); chain it",
        "into `ttctl_applications_availability_request_show` for context.",
        "",
        "Example user prompts:",
        '  - "Show me my recent Toptal applications."',
        '  - "Where are my interest requests?" (filter `statusGroups: [ON_RECRUITER_REVIEW]`)',
        '  - "What active engagements do I have on Toptal?"',
        '  - "List my archived Toptal job activity."',
      ].join("\n"),
      inputSchema: {
        keywords: z.array(z.string()).optional().describe("Free-text keyword filter (AND across multiple)"),
        statusGroups: z
          .array(z.enum([...applications.STATUS_GROUPS]))
          .optional()
          .describe(
            "Restrict to one or more JobActivityItemStatusGroupEnum values: ACTIVE_ENGAGEMENT, ARCHIVED, CLOSED_ENGAGEMENT, ON_CLIENT_REVIEW, ON_RECRUITER_REVIEW",
          ),
        page: PAGE_FIELD,
        perPage: PER_PAGE_FIELD,
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const opts: applications.ListOptions = {};
      if (args.keywords !== undefined) opts.keywords = args.keywords;
      if (args.statusGroups !== undefined) opts.statusGroups = args.statusGroups;
      if (args.page !== undefined) opts.page = args.page;
      if (args.perPage !== undefined) opts.perPage = args.perPage;
      if (args.dryRun === true) {
        // Mirror the apply path's wire shape EXACTLY (incl. the
        // resolved page/pageSize and null-coerced filters) so the
        // preview is faithful — #377 / #369 dry-run discipline.
        return dryRunResponse(
          buildMcpDryRunPreview("JobActivityItems", "mobile-gateway", buildApplicationsListVariables(opts), auth.token),
        );
      }
      try {
        const page = await applications.list(auth.token, opts);
        return successResponse({ items: page.items, pageInfo: buildApplicationsPageInfo(page) });
      } catch (err) {
        return mapApplicationsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_applications_show",
    {
      title: "Show one activity item",
      description: [
        "Fetch a single activity item by id (the row id, not the underlying job id).",
        "Returns the full detail view: status, job metadata (title, description, commitment),",
        "application info (id, requested rate), engagement info (start date, commitment) where present,",
        "and (when an Interest Request is associated) the embedded `availabilityRequest` sub-object",
        "carrying `id`, talent-side response data (`talentComment`, `requestedHourlyRate`,",
        "`rejectReason`), and the `recruiter` contact identity (`firstName` / `lastName` /",
        "`fullName`) per #539. For the full AR detail use `ttctl_applications_availability_request_show`.",
        "Also surfaces `mostRelevantApplication` (#547) — the platform's id-only pointer at the",
        "AvailabilityRequest that matters most for this row (use that id with",
        "`ttctl_applications_availability_request_show`); `null` when no AR is associated. Most",
        "useful on rows with multiple historical ARs, where it disambiguates the relevant one.",
        "",
        "Example user prompts:",
        '  - "Show me the details of activity item act_abc123."',
        '  - "What does my application app_xyz look like?" (use the activity id, not the application id)',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Activity item id (the TalentJobActivityItem id)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("JobActivityItem", "mobile-gateway", { id: args.id }, auth.token));
      }
      try {
        const item = await applications.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapApplicationsError(err);
      }
    },
  );

  // #439 — Interview detail (sibling sub-namespace `applications.interviews.show`).
  // Read-only; mirrors the CLI `ttctl applications interview show <id>`.
  // Dry-run path emits a single-op `Interview` preview. Apply path calls
  // `applications.interviews.show(token, id)` and surfaces the projected
  // {@link applications.InterviewDetail} as the JSON payload.
  server.registerTool(
    "ttctl_applications_interview_show",
    {
      title: "Show one interview detail",
      description: [
        "Fetch a single interview by id (the TalentInterview id, NOT the activity item id).",
        "Returns the full interview detail: status, kind (EXTERNAL/INTERNAL), scheduled slots,",
        "method (Zoom / phone / etc.), interviewer contacts, talent notes, and prep-guide id.",
        "",
        "Discover the id via `ttctl_applications_show` — the activity-row detail includes",
        "an `interview.id` field when one is associated.",
        "",
        "Example user prompts:",
        '  - "Show me the details of interview int_abc123."',
        '  - "Who am I interviewing with, and when?" (use the interview id from the activity row)',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Interview id (the TalentInterview id)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("Interview", "mobile-gateway", { id: args.id }, auth.token));
      }
      try {
        const item = await applications.interviews.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapApplicationsError(err);
      }
    },
  );

  // #440 — Interview prep notes (sub-sub-namespace
  // `applications.interviews.notes.show`). Read-only; mirrors the CLI
  // `ttctl applications interview notes show <jobId>`. **Input is the
  // JOB id, NOT the interview id** — the portal-side
  // `GetInterviewNotes` op takes `$jobId: ID!` and traverses
  // `viewer.job(id).activityItem.interview.{id, kind, talentNotes}`.
  // Dry-run path emits a single-op `GetInterviewNotes` preview against
  // the mobile-gateway surface (portal + mobile share the same backend
  // — same dispatch as #447 / #448).
  server.registerTool(
    "ttctl_applications_interview_notes_show",
    {
      title: "Read the talent's prep notes for an interview",
      description: [
        "Fetch the talent's prep notes for the interview attached to a given job.",
        "",
        "Input is the JOB id (the TalentJob id), NOT the interview id. Discover the",
        "job id via `ttctl_applications_interview_show` (the `job.id` field on the",
        "interview detail) or `ttctl_applications_show` (the `job.id` field on the",
        "activity row).",
        "",
        "Returns the projected notes payload: the job id (echo), the interview id",
        "and kind (EXTERNAL/INTERNAL) when one is attached, and the list of",
        "talent-authored prep notes grouped by InterviewGuideSection identifier.",
        "",
        "Example user prompts:",
        '  - "Show me my prep notes for the interview on job job_xyz789."',
        '  - "What did I write down for the upcoming interview?" (after fetching the job id from `ttctl_applications_interview_show`)',
      ].join("\n"),
      inputSchema: {
        id: z
          .string()
          .describe("TalentJob id (NOT the interview id — discover via ttctl_applications_interview_show → job.id)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("GetInterviewNotes", "mobile-gateway", { jobId: args.id }, auth.token),
        );
      }
      try {
        const item = await applications.interviews.notes.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapApplicationsError(err);
      }
    },
  );

  // #470 — Interview prep guide (sub-sub-namespace
  // `applications.interviews.guide.show`). Read-only; mirrors the CLI
  // `ttctl applications interview guide show <interviewId>`. Input is
  // the INTERVIEW id — the wire op (`InterviewGuide`) takes
  // `$interviewId: ID!` and traverses `viewer.interview(id).guide.{
  // id, sections[...]}`. Dry-run path emits a single-op `InterviewGuide`
  // preview against the mobile-gateway surface.
  server.registerTool(
    "ttctl_applications_interview_guide_show",
    {
      title: "Read the interview-prep guide content for one interview",
      description: [
        "Fetch the interview-prep guide content (sections + tips) for one interview.",
        "",
        "Input is the INTERVIEW id (the TalentInterview id), NOT the guide id. Discover",
        "it via `ttctl_applications_interview_show` (the `guideId` field on the interview",
        "detail is the back-pointer; the guide CONTENT lives behind this tool).",
        "",
        "Returns the projected guide: the interview id (echo), the guide id (when one is",
        "attached), and the list of sections. Each section carries an identifier",
        "(`InterviewGuideSectionIdentifierEnum`: STRENGTHS, GAPS, JOB_HIGHLIGHTS,",
        "POTENTIAL_QUESTIONS, PRO_TIPS, ASK_YOUR_CLIENT), title, optional subtitle, and",
        "a list of tips. Each tip carries an identifier",
        "(`InterviewGuideTipIdentifierEnum`: 12 members including STANDARD_QUESTIONS,",
        "CAMERA_ON, BE_PRESENTABLE, GAP_ANALYSIS, …), title, and TWO content fields:",
        "`content` (job/talent-personalized markdown body) and `hardcodedContent`",
        "(generic template body shipped with every guide).",
        "",
        "Example user prompts:",
        '  - "Show me the prep guide for interview int_abc123."',
        '  - "What should I prepare for the upcoming interview?" (use the interview id from `ttctl_applications_interview_show`)',
        '  - "Are there any pro-tips for this interview?"',
      ].join("\n"),
      inputSchema: {
        id: z
          .string()
          .describe("TalentInterview id (NOT the guide id — discover via ttctl_applications_interview_show)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("InterviewGuide", "mobile-gateway", { id: args.id }, auth.token));
      }
      try {
        const item = await applications.interviews.guide.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapApplicationsError(err);
      }
    },
  );

  // #442 — Availability-request detail (sibling sub-namespace
  // `applications.availabilityRequests.show`). Read-only; mirrors the
  // CLI `ttctl applications availability-request show <id>`. The id is
  // the `AvailabilityRequest.id` — the SAME id `ttctl_applications_confirm`
  // / `_reject` accept, NOT the activity-item id. Dry-run path emits a
  // single-op `AvailabilityRequest` preview. Apply path calls
  // `applications.availabilityRequests.show(token, id)` and surfaces
  // the projected {@link applications.AvailabilityRequestDetail} as the
  // JSON payload.
  server.registerTool(
    "ttctl_applications_availability_request_show",
    {
      title: "Show one availability-request detail",
      description: [
        "Fetch a single availability request (Toptal portal label: 'Interest Request') by id —",
        "the AvailabilityRequest id, NOT the activity item id. Returns the full detail:",
        "status, kind (FIXED / FLEXIBLE / MARKETPLACE_FLEXIBLE), the recruiter-pinned Fixed",
        "hourly rate (when applicable), the recruiter's comment, lifecycle timestamps",
        "(created / updated / answered), the job, and (#539) the talent-side response data",
        "(`talentComment`, `requestedHourlyRate`, `rejectReason`) plus the `recruiter` contact",
        "identity (`firstName` / `lastName` / `fullName`).",
        "",
        "**`matcherQuestions` (#585)**: the matcher questions you must answer to accept this",
        "Interest Request, each with everything needed to build a valid `matcherAnswers` payload:",
        "`identifier` (pass as the answer's `id`), `prompt`, `inputType` (`dropdown` | `free-text`),",
        "`options` (allowed values for a dropdown), `suggestedAnswer` (recruiter-preselected value),",
        "and `isMandatory`. Empty array when the job carries no matcher questions. This is the",
        "single self-contained source for `ttctl_interest_requests_accept`'s `matcherAnswers` —",
        "no need to cross-reference `ttctl_jobs_apply_questions` or drop to raw GraphQL.",
        "",
        "Discover the id via `ttctl_interest_requests_list` (the `availabilityRequestId` field) —",
        "it is the SAME id `ttctl_interest_requests_accept` / `_reject` and the",
        "`ttctl applications confirm` / `reject` CLI commands accept (sibling write-side leaves).",
        "",
        "Example user prompts:",
        '  - "Show me the details of availability request ar_abc123."',
        '  - "What rate is the recruiter offering on this interest request?" (use the AR id from the activity row)',
        '  - "What did I write when I declined this IR?" (reads `talentComment` + `rejectReason`)',
        '  - "Who is the recruiter on this IR?" (reads `recruiter.fullName` / first/last name)',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("AvailabilityRequest id (NOT the activity-item id)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("AvailabilityRequest", "mobile-gateway", { id: args.id }, auth.token),
        );
      }
      try {
        const item = await applications.availabilityRequests.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapApplicationsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_applications_stats",
    {
      title: "Per-status-group activity counts",
      description: [
        "Aggregate activity-item counts: returns per-status-group totals plus the overall sum.",
        "",
        "Issues 5 server calls in parallel (one per JobActivityItemStatusGroupEnum value).",
        "Each count is server-provided (totalCount on JobActivityList) — no client-side aggregation.",
        "",
        "Example user prompts:",
        '  - "How many Toptal applications do I have in each status?"',
        '  - "Give me a breakdown of my Toptal activity by status group."',
        '  - "What\'s my total activity count on Toptal?"',
        "",
        "Dry-run note: returns `{ ok: true, dryRun: true, previews: [...] }` (plural `previews`) — one `JobActivityItems` preview per status group (5 total), matching the 5 parallel calls the apply path fires.",
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        const previews: DryRunPreview[] = applications.STATUS_GROUPS.map((group) =>
          // Mirror the apply-path wire shape EXACTLY (#377 / #369 dry-run
          // discipline): `applications.stats` issues 5 parallel calls each
          // with `{ keywords: null, onlyStatusGroupFilter: [group],
          // page: null, pageSize: null }`. The explicit-null page /
          // pageSize is the post-#377 deterministic wire-shape contract
          // (lets the gateway apply its own defaults); the preview must
          // mirror it.
          buildMcpDryRunPreview(
            "JobActivityItems",
            "mobile-gateway",
            { keywords: null, onlyStatusGroupFilter: [group], page: null, pageSize: null },
            auth.token,
          ),
        );
        return dryRunMultiResponse(previews);
      }
      try {
        const stats = await applications.stats(auth.token);
        return successResponse(stats);
      } catch (err) {
        return mapApplicationsError(err);
      }
    },
  );
}

interface ToolSuccessResponse {
  [x: string]: unknown;
  content: [{ type: "text"; text: string }];
}

function successResponse(data: unknown): ToolSuccessResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function mapApplicationsError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof applications.ApplicationsError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Error: ${err.message}`,
            "",
            err.code === "NOT_FOUND"
              ? "Recovery: Verify the activity id (use ttctl_applications_list to discover it)."
              : "Recovery: Adjust the tool input or retry; see the code below.",
            "",
            `(Code: ${err.code})`,
          ].join("\n"),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          `Error: applications request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
