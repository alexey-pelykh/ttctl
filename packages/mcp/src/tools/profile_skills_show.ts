// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  buildMcpDryRunPreview,
  domainErrorResponse,
  dryRunResponse,
  genericErrorResponse,
  isToolErrorResponse,
  jsonResponse,
  type ToolRegistrationContext,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_skills_show";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

export function registerProfileSkillsShowTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show a skill",
      description: [
        "Fetch details of a single ProfileSkillSet by id — name, rating, experience, visibility, and the count of connection edges (linked portfolio items / employment / education / certifications).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Show me the details of my TypeScript skill on Toptal." (after looking up its id)',
        '  - "What\'s the rating and connection count for skill ss-abc123?"',
      ].join("\n"),
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("ProfileSkillSet id (NOT the Skill catalog id). Obtain via `ttctl_profile_skills_list`."),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("GetSkillSetWithConnections", "talent-profile", { id: input.id }, auth.token),
        );
      }

      try {
        const payload = await profile.skills.show(auth.token, input.id);
        return jsonResponse(payload);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.skills.SkillsError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
