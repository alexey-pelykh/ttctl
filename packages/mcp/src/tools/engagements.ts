// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engagements } from "@ttctl/core";
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
 * Pagination input fields for `ttctl_engagements_list` (issue #375),
 * mirroring the four paginating `ttctl_jobs_*` tools (#369).
 * Constraints match the CLI's `parsePaginationFlag` (positive integer
 * ≥ 1); the wire's per-page upper bound is server-enforced. The
 * service-layer defaults (`page: 1, perPage: 20`) kick in when either
 * field is omitted, so existing MCP callers see no behavioral change.
 */
const PAGE_FIELD = z.number().int().min(1).optional().describe("1-indexed page number (≥ 1). Default: 1.");

const PER_PAGE_FIELD = z.number().int().min(1).optional().describe("Items per page (≥ 1; server-capped). Default: 20.");

/**
 * Offset-style pagination metadata surfaced alongside `items` on
 * `ttctl_engagements_list` (#375). Mirrors the CLI's
 * `EnvelopePageInfo` shape (`packages/cli/src/lib/envelopes.ts`) and
 * the `ttctl_jobs_*` `JobsPageInfo` shape so LLM clients can detect
 * "more pages available" via `hasNextPage` and iterate.
 */
interface EngagementsPageInfo {
  currentPage: number;
  perPage: number;
  totalPages: number;
  hasNextPage: boolean;
}

function buildEngagementsPageInfo(page: engagements.EngagementListPage): EngagementsPageInfo {
  const totalPages = Math.max(1, Math.ceil(page.totalCount / page.perPage));
  return {
    currentPage: page.page,
    perPage: page.perPage,
    totalPages,
    hasNextPage: page.page < totalPages,
  };
}

/**
 * Register the `ttctl_engagements_*` MCP tools (initial #147 spec
 * extended by #155 with `breaks_reschedule`). Tool names use the
 * `ttctl_` prefix and the canonical CLI path joined with `_`:
 *
 *   - `ttctl_engagements_list`
 *   - `ttctl_engagements_show`
 *   - `ttctl_engagements_stats`
 *   - `ttctl_engagements_breaks_list`
 *   - `ttctl_engagements_breaks_add`
 *   - `ttctl_engagements_breaks_remove`
 *   - `ttctl_engagements_breaks_reschedule` (#155)
 *
 * Each tool maps 1:1 to a CLI leaf — the schemas describe the same set
 * of fields. The `<id>` argument is the `jobActivityItem.id` (the row
 * id from `engagements_list`); `<break-id>` is the
 * `engagementBreak.id` (the id returned by `engagements_breaks_list`).
 *
 * Per #147 scope amendment (2026-05-10), `allocated-hours` is NOT
 * surfaced here — that scope moved to `availability` (#146) since the
 * underlying mutation (`UpdateAllocatedHours`) operates on
 * `viewerRole`, not per-engagement.
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`. The
 * three read-only tools and `breaks_list` use MCP-layer preview building;
 * the two break mutations are passthrough — `core.engagements.breaks.{add,remove}`
 * already support `{ dryRun: true }` (#163), so the MCP layer forwards
 * the flag and reformats the resulting `{ kind: "preview", preview }`
 * outcome as the uniform `{ ok, dryRun, preview }` envelope. `stats`
 * uses the plural `{ previews: [...] }` envelope (2 parallel
 * `JobActivityItems` calls — one per status group).
 */
export function registerEngagementsTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_engagements_list",
    {
      title: "List engagements",
      description: [
        "List the signed-in user's Toptal Talent engagements (active by default).",
        "An engagement is an active assignment between the user and a client",
        "(= what users colloquially call 'current job' or 'current contract').",
        "",
        "Filter via `status`:",
        "  - `active` (default): currently active engagements",
        "  - `past`: closed engagements",
        "  - `all`: both",
        "",
        "Optional `keywords` is a free-text filter (AND across multiple).",
        "",
        "Pagination (#375): pass `page` (1-indexed) / `perPage` to walk",
        "beyond the default first slice. Returns `{ items, pageInfo }`",
        "where `pageInfo` is `{ currentPage, perPage, totalPages,",
        "hasNextPage }` — iterate while `hasNextPage` is true.",
        "",
        "Example user prompts:",
        '  - "What are my active Toptal engagements?"',
        '  - "Show me my past Toptal contracts."',
        '  - "List all my Toptal jobs, current and past."',
        '  - "Show me page 2 of my past engagements."',
      ].join("\n"),
      inputSchema: {
        status: z
          .enum([...engagements.ENGAGEMENT_LIST_STATUSES])
          .optional()
          .describe("Filter by engagement status: active (default), past, or all"),
        keywords: z.array(z.string()).optional().describe("Free-text keyword filter (AND across multiple)"),
        page: PAGE_FIELD,
        perPage: PER_PAGE_FIELD,
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const opts: engagements.ListOptions = {};
      if (args.status !== undefined) opts.status = args.status;
      if (args.keywords !== undefined) opts.keywords = args.keywords;
      if (args.page !== undefined) opts.page = args.page;
      if (args.perPage !== undefined) opts.perPage = args.perPage;
      if (args.dryRun === true) {
        // Mirror the apply-path mapping from `--status` to
        // JobActivityItemStatusGroupEnum so the preview's
        // `onlyStatusGroupFilter` matches what the wire call would send.
        // Apply path: core/services/engagements/index.ts `listStatusToGroups`.
        const status = opts.status ?? "active";
        const statusGroups =
          status === "active"
            ? ["ACTIVE_ENGAGEMENT"]
            : status === "past"
              ? ["CLOSED_ENGAGEMENT"]
              : ["ACTIVE_ENGAGEMENT", "CLOSED_ENGAGEMENT"];
        // Resolve page/pageSize to the same DEFAULT_* constants the
        // core's apply path uses (#375), so the dry-run preview renders
        // the EXACT variables the live call would send — mirroring
        // `buildJobsListVariables` in `tools/jobs.ts`.
        const variables: Record<string, unknown> = {
          keywords: opts.keywords !== undefined && opts.keywords.length > 0 ? opts.keywords : null,
          onlyStatusGroupFilter: statusGroups,
          page: opts.page ?? engagements.DEFAULT_PAGE,
          pageSize: opts.perPage ?? engagements.DEFAULT_PER_PAGE,
        };
        return dryRunResponse(buildMcpDryRunPreview("JobActivityItems", "mobile-gateway", variables, auth.token));
      }
      try {
        // Issue #375: surface pagination metadata alongside items so
        // LLM callers can detect `hasNextPage` and iterate. The wrapped
        // `{ items, pageInfo }` shape mirrors the `ttctl_jobs_*` tools
        // (#369); `result.items` is byte-identical to the pre-#375
        // bare-array payload (payload addition, not a shape break).
        const page = await engagements.list(auth.token, opts);
        return successResponse({ items: page.items, pageInfo: buildEngagementsPageInfo(page) });
      } catch (err) {
        return mapEngagementsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_engagements_show",
    {
      title: "Show one engagement",
      description: [
        "Fetch a single engagement's full detail by id (the row id from",
        "`ttctl_engagements_list`, which is the underlying TalentJobActivityItem id).",
        "Returns the engagement metadata (status, start/end dates, expected hours,",
        "commitment), the underlying job (title, client, description, work type),",
        "the current agreement (rates, commitment), earnings summary, any scheduled",
        "breaks, the client-side hiring-manager contacts (`job.contacts`), and the",
        "Toptal-side recruiter points-of-contact (`job.pointsOfContact.current` /",
        "`.handoff`).",
        "",
        "Example user prompts:",
        '  - "Show me the details of engagement act_xyz."',
        '  - "What is my hourly rate on engagement act_abc?"',
        '  - "Are there any scheduled breaks on my current Toptal engagement?"',
        '  - "Who is my recruiter on engagement act_xyz?"',
        '  - "Who is the client-side contact on engagement act_abc?"',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Engagement id (the TalentJobActivityItem id from `engagements_list`)"),
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
        const item = await engagements.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapEngagementsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_engagements_stats",
    {
      title: "Per-status engagement counts",
      description: [
        "Aggregate engagement counts: returns per-status totals (active, past) plus",
        "the overall sum.",
        "",
        "Issues 2 server calls in parallel (one per engagement-bearing status group).",
        "Each count is server-provided (totalCount on JobActivityList) — no",
        "client-side aggregation.",
        "",
        "Example user prompts:",
        '  - "How many Toptal engagements have I had in total?"',
        '  - "Show me a breakdown of my Toptal engagements by status."',
        "",
        "Dry-run note: returns `{ ok: true, dryRun: true, previews: [...] }` (plural `previews`) — one `JobActivityItems` preview per engagement status group (2 total: ACTIVE_ENGAGEMENT, CLOSED_ENGAGEMENT), matching the 2 parallel calls the apply path fires.",
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        const previews: DryRunPreview[] = engagements.ENGAGEMENT_STATUS_GROUPS.map((group) =>
          buildMcpDryRunPreview(
            "JobActivityItems",
            "mobile-gateway",
            { keywords: null, onlyStatusGroupFilter: [group] },
            auth.token,
          ),
        );
        return dryRunMultiResponse(previews);
      }
      try {
        const stats = await engagements.stats(auth.token);
        return successResponse(stats);
      } catch (err) {
        return mapEngagementsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_engagements_breaks_list",
    {
      title: "List breaks on an engagement",
      description: [
        "List the scheduled break windows for a specific engagement.",
        "A break is a planned period when the talent will not be working on the",
        "engagement (vacation, time off, etc.).",
        "",
        "The id parameter is the engagement id (TalentJobActivityItem id), the",
        "same id used by `ttctl_engagements_show`.",
        "",
        "Example user prompts:",
        '  - "Show me the scheduled breaks on engagement act_xyz."',
        '  - "Do I have any vacations planned on my current Toptal engagement?"',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Engagement id (the TalentJobActivityItem id from `engagements_list`)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("EngagementBreaks", "mobile-gateway", { jobActivityItemId: args.id }, auth.token),
        );
      }
      try {
        const items = await engagements.breaks.list(auth.token, args.id);
        return successResponse(items);
      } catch (err) {
        return mapEngagementsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_engagements_breaks_reasons_list",
    {
      title: "List valid break reasons (catalog)",
      description: [
        "List the server-side catalog of valid break-reason identifiers for",
        "`ttctl_engagements_breaks_add` (the `reasonIdentifier` argument).",
        "",
        "Reads `platformConfiguration.engagementBreakReasons` from the mobile",
        "gateway. Returns an array of `{identifier, nameForRole}` sorted by",
        "`identifier`. `identifier` is what the user supplies to",
        "`ttctl_engagements_breaks_add`; `nameForRole` is the human-readable",
        "label.",
        "",
        "Use this tool to discover valid `reasonIdentifier` values before",
        "scheduling a break — the catalog can change over time.",
        "",
        "Example user prompts:",
        '  - "What break reasons can I use when scheduling a Toptal engagement break?"',
        '  - "List the valid --reason-id values for `ttctl engagements breaks add`."',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("PlatformConfiguration", "mobile-gateway", {}, auth.token));
      }
      try {
        const items = await engagements.breaks.reasonsList(auth.token);
        return successResponse(items);
      } catch (err) {
        return mapEngagementsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_engagements_breaks_add",
    {
      title: "Schedule a break on an engagement",
      description: [
        "Schedule a new break window on an engagement.",
        "",
        "Required: `id` (engagement id), `startDate` (YYYY-MM-DD), `endDate`",
        "(YYYY-MM-DD), `reasonIdentifier` (server-side reason key — known",
        "values: `talent_on_vacation`, `client_needs_preparation`,",
        "`client_on_vacation`, `other`).",
        "Optional: `comment` (free-text note).",
        "",
        "**This is a write operation**: it modifies the user's scheduled time-off",
        "on the live Toptal Talent platform. Confirm with the user before invoking.",
        "",
        "Example user prompts:",
        '  - "Schedule a break on engagement act_xyz from June 1 to June 8."',
        '  - "Add a vacation window to my current Toptal engagement next week."',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Engagement id (the TalentJobActivityItem id from `engagements_list`)"),
        startDate: z.string().describe("Break start date (YYYY-MM-DD)"),
        endDate: z.string().describe("Break end date (YYYY-MM-DD)"),
        reasonIdentifier: z
          .string()
          .describe(
            "Server-side reason key (known: talent_on_vacation, client_needs_preparation, client_on_vacation, other)",
          ),
        comment: z.string().optional().describe("Optional free-text comment"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const opts: engagements.AddBreakOptions = {
          startDate: args.startDate,
          endDate: args.endDate,
          reasonIdentifier: args.reasonIdentifier,
        };
        if (args.comment !== undefined) opts.comment = args.comment;
        const outcome = await engagements.breaks.add(auth.token, args.id, opts, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapEngagementsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_engagements_breaks_remove",
    {
      title: "Cancel a scheduled break",
      description: [
        "Cancel a previously-scheduled break by its id (the id returned by",
        "`ttctl_engagements_breaks_list`).",
        "",
        "**This is a write operation**: it cancels a scheduled break on the live",
        "Toptal Talent platform. Confirm with the user before invoking.",
        "",
        "Example user prompts:",
        '  - "Cancel break br_abc on engagement act_xyz."',
        '  - "Remove the scheduled break starting June 1 on my Toptal engagement."',
      ].join("\n"),
      inputSchema: {
        breakId: z.string().describe("Engagement break id (the engagementBreak id from `engagements_breaks_list`)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await engagements.breaks.remove(auth.token, args.breakId, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapEngagementsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_engagements_breaks_reschedule",
    {
      title: "Reschedule a scheduled break to a new date window",
      description: [
        "Move an existing scheduled break to a new date window in-place, without",
        "removing and re-adding it. Preserves the existing break's reason and",
        "comment (the wire mutation only carries the new startDate + endDate).",
        "",
        "Required: `breakId` (the engagementBreak id, from `engagements_breaks_list`),",
        "`startDate` (YYYY-MM-DD), `endDate` (YYYY-MM-DD).",
        "",
        "**This is a write operation**: it changes a scheduled break's dates on the",
        "live Toptal Talent platform. Confirm with the user before invoking.",
        "",
        "Example user prompts:",
        '  - "Reschedule break br_abc to July 1 through July 8."',
        '  - "Move my scheduled vacation from June 1-8 to June 15-22."',
        '  - "Push back the start of my upcoming break by a week."',
      ].join("\n"),
      inputSchema: {
        breakId: z.string().describe("Engagement break id (the engagementBreak id from `engagements_breaks_list`)"),
        startDate: z.string().describe("New break start date (YYYY-MM-DD)"),
        endDate: z.string().describe("New break end date (YYYY-MM-DD)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await engagements.breaks.reschedule(
          auth.token,
          args.breakId,
          { startDate: args.startDate, endDate: args.endDate },
          { dryRun: args.dryRun ?? false },
        );
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapEngagementsError(err);
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

function mapEngagementsError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof engagements.EngagementsError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [`Error: ${err.message}`, "", recoveryForCode(err.code), "", `(Code: ${err.code})`].join("\n"),
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
          `Error: engagements request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}

function recoveryForCode(code: engagements.EngagementsErrorCode): string {
  switch (code) {
    case "NOT_FOUND":
      return "Recovery: Verify the engagement id (use `ttctl_engagements_list` to discover it).";
    case "NO_ENGAGEMENT":
      return "Recovery: This activity item is not an engagement (likely an application or interview). Use `ttctl_applications_show` instead.";
    case "MUTATION_ERROR":
      return "Recovery: The mutation was rejected by the server (often: overlapping break dates or validation). Check the message above and adjust the input.";
    default:
      return "Recovery: Adjust the tool input or retry; see the code below.";
  }
}
