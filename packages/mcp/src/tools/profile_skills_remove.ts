// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  domainErrorResponse,
  genericErrorResponse,
  isToolErrorResponse,
  type ToolRegistrationContext,
  textResponse,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_skills_remove";

export function registerProfileSkillsRemoveTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Remove a skill from profile",
      description: [
        "Remove a skill from the signed-in user's profile by its `ProfileSkillSet` id (NOT the Skill catalog id).",
        "Get the id from `ttctl_profile_skills_list` first if you only know the skill name.",
        "Removal cascades to any connections (portfolio items, education, employment, certifications).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Remove the TypeScript skill from my profile." (after looking up its id)',
        '  - "Drop skill ss-abc123 from my profile."',
      ].join("\n"),
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("ProfileSkillSet id to remove (NOT the Skill catalog id). Obtain via `ttctl_profile_skills_list`."),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        await profile.skills.rm(auth.token, input.id);
        return textResponse(`Removed skill ${input.id}.`);
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
