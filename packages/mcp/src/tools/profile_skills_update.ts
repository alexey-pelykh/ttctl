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
  jsonResponse,
  type ToolRegistrationContext,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_skills_update";

const RATING_VALUES = ["COMPETENT", "STRONG", "EXPERT", "NOVICE"] as const;

export function registerProfileSkillsUpdateTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Update a skill",
      description: [
        "Update one or more fields on an existing ProfileSkillSet — proficiency rating, years of experience, public/private visibility.",
        "At least one of `rating`, `experience`, or `public` must be supplied. Multi-flag updates fire sequential mutations; partial-failure surfaces as `PARTIAL_FAILURE` listing which fields landed.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Mark TypeScript as expert level on my profile." (after looking up its id)',
        '  - "Set my Python skill to public, expert level, 60 months of experience."',
        '  - "Hide my Bash skill from my public profile."',
      ].join("\n"),
      inputSchema: {
        id: z.string().min(1).describe("ProfileSkillSet id of the skill to update (NOT the Skill catalog id)."),
        rating: z
          .enum(RATING_VALUES)
          .optional()
          .describe("Proficiency rating. One of: COMPETENT, STRONG, EXPERT, NOVICE. Optional."),
        experience: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Total months of experience on this skill (integer, >= 0). E.g., 60 for 5 years. Optional."),
        public: z
          .boolean()
          .optional()
          .describe(
            "Whether the skill is visible on the public profile. `true` = public, `false` = private. Optional.",
          ),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      const fields: profile.skills.SkillUpdate = {};
      if (input.rating !== undefined) fields.rating = input.rating;
      if (input.experience !== undefined) fields.experience = input.experience;
      if (input.public !== undefined) fields.public = input.public;

      try {
        const result = await profile.skills.set(auth.token, input.id, fields);
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
