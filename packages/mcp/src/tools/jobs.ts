// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jobs } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import type { ToolErrorResponse } from "../errors.js";
import { buildMcpDryRunPreview, dryRunResponse, type ToolRegistrationContext } from "./_shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Build the variables payload `core.jobs` (`buildListVariables` in
 * `core/services/jobs/index.ts`) sends to `JobsList` so a dry-run
 * preview from the MCP layer matches the apply path's wire shape.
 * Mirrors the apply-path "empty/undefined → null" coercion so listed
 * filters render the same way as the actual wire call.
 */
function buildJobsListVariables(
  opts: jobs.ListOptions,
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
    saved: extras.saved !== undefined ? { eq: extras.saved } : null,
    notInterested: extras.notInterested !== undefined ? { eq: extras.notInterested } : null,
  };
  return variables;
}

/**
 * Register the `ttctl_jobs_*` MCP tools per #148. Tool names use the
 * `ttctl_` prefix and the canonical CLI path joined with `_`. Per the
 * AC, MCP tools use the canonical `jobs_*` prefix only — no
 * `opportunities_*` aliasing (MCP tool names must be deterministic for
 * LLM clients).
 *
 * Tool surface (13 tools):
 *   - `ttctl_jobs_list`
 *   - `ttctl_jobs_show`
 *   - `ttctl_jobs_save`
 *   - `ttctl_jobs_unsave`
 *   - `ttctl_jobs_saved`
 *   - `ttctl_jobs_viewed`
 *   - `ttctl_jobs_mark_viewed`
 *   - `ttctl_jobs_not_interested`
 *   - `ttctl_jobs_not_interested_list`
 *   - `ttctl_jobs_clear_interest`
 *   - `ttctl_jobs_search_list`
 *   - `ttctl_jobs_search_save`
 *   - `ttctl_jobs_search_remove`
 *
 * **Wire-shape notes** (R1 / R2): `jobs_viewed` is scoped to the first
 * page (≤20 jobs, client-side filter); `jobs_search_*` operates on a
 * single subscription per user. The tool descriptions surface these.
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`. Read
 * tools build the preview at the MCP layer; the 7 mutations (save,
 * unsave, mark_viewed, not_interested, clear_interest, search_save,
 * search_remove) passthrough-forward `{ dryRun: true }` to the core
 * (which already supports dryRun per #162) and reformat the
 * `{ kind: "preview", preview }` outcome as the uniform envelope.
 */
export function registerJobsTools(server: McpServer, ctx: ToolRegistrationContext): void {
  // -------- list ---------------------------------------------------------
  server.registerTool(
    "ttctl_jobs_list",
    {
      title: "Browse current job opportunities",
      description: [
        "Browse the user's current job opportunities on Toptal Talent.",
        "Returns the first page of eligible jobs (≤20).",
        "",
        "Optional filters:",
        "  - `skills` / `keywords`: AND-across filter on required skills / free text",
        "  - `excludeSkills` / `excludeKeywords`: exclusion filters",
        "  - `commitments`: e.g. FULL_TIME, PART_TIME",
        "  - `workTypes`: e.g. REMOTE, ONSITE",
        "  - `estimatedLengths`: e.g. SHORT_TERM, LONG_TERM",
        "  - `sortTarget`: e.g. visible_at, posted_at",
        "",
        "Example user prompts:",
        '  - "Show me current Toptal job opportunities."',
        '  - "List remote part-time Toptal jobs with React skills."',
      ].join("\n"),
      inputSchema: {
        skills: z.array(z.string()).optional().describe("Required skill names (AND across)"),
        keywords: z.array(z.string()).optional().describe("Free-text keywords (AND across)"),
        excludeSkills: z.array(z.string()).optional().describe("Skills to exclude"),
        excludeKeywords: z.array(z.string()).optional().describe("Keywords to exclude"),
        commitments: z.array(z.string()).optional().describe("JobCommitmentFilterEnum values"),
        workTypes: z.array(z.string()).optional().describe("JobWorkTypeSlug values"),
        estimatedLengths: z.array(z.string()).optional().describe("EstimatedLengthFilterEnum values"),
        sortTarget: z.string().optional().describe("Sort target (e.g. visible_at, posted_at)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const opts: jobs.ListOptions = {};
      if (args.skills !== undefined) opts.skills = args.skills;
      if (args.keywords !== undefined) opts.keywords = args.keywords;
      if (args.excludeSkills !== undefined) opts.excludeSkills = args.excludeSkills;
      if (args.excludeKeywords !== undefined) opts.excludeKeywords = args.excludeKeywords;
      if (args.commitments !== undefined) opts.commitments = args.commitments;
      if (args.workTypes !== undefined) opts.workTypes = args.workTypes;
      if (args.estimatedLengths !== undefined) opts.estimatedLengths = args.estimatedLengths;
      if (args.sortTarget !== undefined) opts.sortTarget = args.sortTarget;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("JobsList", "mobile-gateway", buildJobsListVariables(opts, {}), auth.token),
        );
      }
      try {
        // MCP unwraps the JobListPage to items only (issue #138 wires
        // pagination on the CLI surface; MCP pagination is a separate
        // follow-up). The wire still returns totalCount + page/perPage
        // — those are discarded here to preserve the MCP output
        // contract (`JobListItem[]`).
        const page = await jobs.list(auth.token, opts);
        return successResponse(page.items);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- show ---------------------------------------------------------
  server.registerTool(
    "ttctl_jobs_show",
    {
      title: "Show one job by id",
      description: [
        "Fetch a single job's detail view by id.",
        "Returns title, description, skills, client metadata, time-zone, rates, and interest-state flags.",
        "",
        "Example user prompts:",
        '  - "Show me Toptal job job_abc123."',
        '  - "What\'s the description for that job I just listed?"',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Job id (from `ttctl_jobs_list`)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("JobShow", "mobile-gateway", { id: args.id }, auth.token));
      }
      try {
        const item = await jobs.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- save ---------------------------------------------------------
  server.registerTool(
    "ttctl_jobs_save",
    {
      title: "Save a job (bookmark)",
      description: [
        "Mark a Toptal job as saved (bookmark). The job appears in `ttctl_jobs_saved` afterwards.",
        "",
        "If the job was previously marked not-interested, this mutation clears that flag (the wire's interest-status model is one-of-three: saved / not-interested / cleared).",
      ].join("\n"),
      inputSchema: { id: z.string().describe("Job id"), dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await jobs.save(auth.token, args.id, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- unsave -------------------------------------------------------
  server.registerTool(
    "ttctl_jobs_unsave",
    {
      title: "Remove a job from saved",
      description: [
        "Clear interest flags on a Toptal job — the wire's only 'remove saved' path.",
        "Note that this ALSO clears `not-interested` (single wire mutation covers both signals).",
      ].join("\n"),
      inputSchema: { id: z.string().describe("Job id"), dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await jobs.unsave(auth.token, args.id, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- saved --------------------------------------------------------
  server.registerTool(
    "ttctl_jobs_saved",
    {
      title: "List saved jobs",
      description: "List the user's saved (bookmarked) Toptal jobs.",
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("JobsList", "mobile-gateway", buildJobsListVariables({}, { saved: true }), auth.token),
        );
      }
      try {
        // MCP unwraps the JobListPage to items only (issue #138; see
        // jobs_list for rationale).
        const page = await jobs.saved(auth.token);
        return successResponse(page.items);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- viewed -------------------------------------------------------
  server.registerTool(
    "ttctl_jobs_viewed",
    {
      title: "List viewed jobs (best-effort, first page only)",
      description: [
        "List Toptal jobs the user has marked as viewed.",
        "",
        "**Limitation (R1)**: the wire has no `viewed` filter on eligibleJobs.",
        "This tool fetches the first page of eligible jobs (≤20) and filters",
        "client-side on the `viewed` boolean. Jobs viewed but on subsequent",
        "pages will not appear.",
        "",
        "Dry-run note: the apply path issues `JobsList` (the same query used by `ttctl_jobs_list`) and filters client-side on `viewed` — the preview reflects the wire call accordingly.",
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("JobsList", "mobile-gateway", buildJobsListVariables({}, {}), auth.token),
        );
      }
      try {
        // MCP unwraps the JobListPage to items only (issue #138; see
        // jobs_list for rationale). totalCount here reflects the
        // underlying eligibleJobs fetch (pre-`viewed` filter), not the
        // returned items.length.
        const page = await jobs.viewedList(auth.token);
        return successResponse(page.items);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- mark_viewed --------------------------------------------------
  server.registerTool(
    "ttctl_jobs_mark_viewed",
    {
      title: "Explicitly mark a job as viewed",
      description: [
        "Mark a Toptal job as viewed.",
        "The web UI normally auto-marks on detail-page open — this tool exposes the mutation for completeness.",
      ].join("\n"),
      inputSchema: { id: z.string().describe("Job id"), dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await jobs.markViewed(auth.token, args.id, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- not_interested -----------------------------------------------
  server.registerTool(
    "ttctl_jobs_not_interested",
    {
      title: "Mark a job as not-interested",
      description: [
        "Mark a Toptal job as not-interested with a reason.",
        "`reason` is required (server rejects empty strings).",
        "",
        "If the job was previously saved, this mutation clears the saved flag.",
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Job id"),
        reason: z.string().min(1).describe("Reason for dismissing (free-text)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await jobs.notInterested(
          auth.token,
          args.id,
          { reason: args.reason },
          { dryRun: args.dryRun ?? false },
        );
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- not_interested_list ------------------------------------------
  server.registerTool(
    "ttctl_jobs_not_interested_list",
    {
      title: "List jobs marked as not-interested",
      description: "List Toptal jobs the user marked as not-interested.",
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "JobsList",
            "mobile-gateway",
            buildJobsListVariables({}, { notInterested: true }),
            auth.token,
          ),
        );
      }
      try {
        // MCP unwraps the JobListPage to items only (issue #138; see
        // jobs_list for rationale).
        const page = await jobs.notInterestedList(auth.token);
        return successResponse(page.items);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- clear_interest -----------------------------------------------
  server.registerTool(
    "ttctl_jobs_clear_interest",
    {
      title: "Clear interest flags on a job",
      description: [
        "Clear interest flags (both `saved` and `not-interested`) on a job.",
        "Use this to undo a previous `not-interested` mark, or to remove a job from saved.",
      ].join("\n"),
      inputSchema: { id: z.string().describe("Job id"), dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await jobs.clearInterest(auth.token, args.id, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- search_list --------------------------------------------------
  server.registerTool(
    "ttctl_jobs_search_list",
    {
      title: "Show the active job-search subscription",
      description: [
        "Show the user's current job-search subscription state.",
        "",
        "**Cardinality note (R2)**: the platform supports a SINGLE subscription per user — there is no list of named subscriptions.",
        "Returns `{ active: false, filters: null }` when no subscription is active, or the active subscription filters when one is.",
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("JobSearchSubscriptionShow", "mobile-gateway", {}, auth.token));
      }
      try {
        const state = await jobs.searchSubscriptionShow(auth.token);
        return successResponse(state);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- search_save --------------------------------------------------
  server.registerTool(
    "ttctl_jobs_search_save",
    {
      title: "Start (or replace) the job-search subscription",
      description: [
        "Start a new job-search subscription with the supplied filters.",
        "If a subscription is already active, it is replaced.",
        "",
        "Returns the post-mutation subscription state.",
      ].join("\n"),
      inputSchema: {
        skills: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
        excludeSkills: z.array(z.string()).optional(),
        excludeKeywords: z.array(z.string()).optional(),
        commitments: z.array(z.string()).optional(),
        workTypes: z.array(z.string()).optional(),
        estimatedLengths: z.array(z.string()).optional(),
        excludeUnspecifiedBudget: z.boolean().optional(),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const filters: jobs.SearchSubscriptionFilters = {};
        if (args.skills !== undefined) filters.skills = args.skills;
        if (args.keywords !== undefined) filters.keywords = args.keywords;
        if (args.excludeSkills !== undefined) filters.excludeSkills = args.excludeSkills;
        if (args.excludeKeywords !== undefined) filters.excludeKeywords = args.excludeKeywords;
        if (args.commitments !== undefined) filters.commitments = args.commitments;
        if (args.workTypes !== undefined) filters.workTypes = args.workTypes;
        if (args.estimatedLengths !== undefined) filters.estimatedLengths = args.estimatedLengths;
        if (args.excludeUnspecifiedBudget !== undefined) {
          filters.excludeUnspecifiedBudget = args.excludeUnspecifiedBudget;
        }
        const outcome = await jobs.searchSubscriptionSave(auth.token, filters, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapJobsError(err);
      }
    },
  );

  // -------- search_remove ------------------------------------------------
  server.registerTool(
    "ttctl_jobs_search_remove",
    {
      title: "Terminate the active job-search subscription",
      description: [
        "Terminate the user's active job-search subscription.",
        "Idempotent — terminating a non-active subscription returns success.",
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await jobs.searchSubscriptionRemove(auth.token, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapJobsError(err);
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

function mapJobsError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof jobs.JobsError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Error: ${err.message}`,
            "",
            err.code === "NOT_FOUND"
              ? "Recovery: Verify the job id (use ttctl_jobs_list to discover it)."
              : err.code === "MUTATION_ERROR"
                ? "Recovery: Check the mutation input — the server reported a per-field validation failure."
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
          `Error: jobs request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
