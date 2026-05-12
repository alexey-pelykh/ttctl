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

const TOOL_NAME = "ttctl_profile_skills_add";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

export function registerProfileSkillsAddTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Add a skill to profile",
      description: [
        "Add a skill to the signed-in user's profile by its catalog name (e.g., `TypeScript`, `PostgreSQL`).",
        "Returns the new ProfileSkillSet with default rating/experience/visibility — configure those via `ttctl_profile_skills_update`.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Add TypeScript to my Toptal skills."',
        '  - "Add PostgreSQL as a skill on my profile."',
      ].join("\n"),
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(
            'Skill catalog name to add. The server resolves the name to a Skill id; if the name is ambiguous (e.g., "Postgres" vs "PostgreSQL"), use `ttctl_profile_skills_autocomplete` first to disambiguate.',
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "ADD_PROFILE_SKILL_SET",
            "talent-profile",
            { input: { name: input.name.trim() } },
            auth.token,
          ),
        );
      }

      try {
        const result = await profile.skills.add(auth.token, input.name);
        return jsonResponse(result);
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
