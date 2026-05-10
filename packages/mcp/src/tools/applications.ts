// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applications } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import type { ToolErrorResponse } from "../errors.js";
import type { ToolRegistrationContext } from "./_shared.js";

/**
 * Register the three `ttctl_applications_*` MCP tools per the #15 spec.
 * Tool names use the `ttctl_` prefix and the canonical CLI path joined
 * with `_` per project naming policy:
 *
 *   - `ttctl_applications_list`
 *   - `ttctl_applications_show`
 *   - `ttctl_applications_stats`
 *
 * Each tool maps 1:1 to a CLI leaf — the schemas describe the same set
 * of fields. The list tool's `keywords` and `statusGroups` mirror the
 * `--keywords` / `--status-group` CLI flags.
 *
 * **Read-only** — per project non-goals (#15), no apply / withdraw /
 * edit tools are exposed. `applications` is intentionally a smaller
 * surface than the profile sub-domains.
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
        "Example user prompts:",
        '  - "Show me my recent Toptal applications."',
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
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const opts: applications.ListOptions = {};
        if (args.keywords !== undefined) opts.keywords = args.keywords;
        if (args.statusGroups !== undefined) opts.statusGroups = args.statusGroups;
        const items = await applications.list(auth.token, opts);
        return successResponse(items);
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
        "application info (id, requested rate), and engagement info (start date, commitment) where present.",
        "",
        "Example user prompts:",
        '  - "Show me the details of activity item act_abc123."',
        '  - "What does my application app_xyz look like?" (use the activity id, not the application id)',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Activity item id (the TalentJobActivityItem id)"),
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const item = await applications.show(auth.token, args.id);
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
      ].join("\n"),
      inputSchema: {},
    },
    async () => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
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
