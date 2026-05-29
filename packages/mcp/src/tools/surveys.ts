// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { surveys } from "@ttctl/core";
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
 * Register the `ttctl_surveys_list` MCP tool. Read-only access to the
 * viewer's pending surveys. Tool name is the canonical CLI path joined
 * with `_` per project policy.
 */
export function registerSurveysTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_surveys_list",
    {
      title: "List pending surveys",
      description: [
        "List the signed-in user's pending Toptal surveys (post-interview `INTERVIEW_ENDED`",
        "feedback, NPS, engagement surveys, etc.).",
        "",
        "Each survey carries `id`, `kind` (e.g. INTERVIEW_ENDED, NPS, ENGAGEMENT_ENDED), `title`,",
        "`isMandatory`, `alreadyAnswered`, and `questions[]`. Each question carries `id`, `label`,",
        "`inputType`, `isMandatory`, and the selectable `answers[]` (`id` / `label` / `value`) —",
        "everything needed to drive a future survey-answer flow.",
        "",
        "Read-only — listing never mutates survey state.",
        "",
        "Example user prompts:",
        '  - "What surveys do I have pending on Toptal?"',
        '  - "Show me my post-interview feedback requests."',
      ].join("\n"),
      inputSchema: {
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("PendingSurveys", "mobile-gateway", {}, auth.token));
      }
      try {
        const items = await surveys.list(auth.token);
        return successResponse(items);
      } catch (err) {
        return mapSurveysError(err);
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

function mapSurveysError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof surveys.SurveysError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Error: ${err.message}`,
            "",
            "Recovery: Retry; if the failure persists, file an issue.",
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
          `Error: surveys request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
