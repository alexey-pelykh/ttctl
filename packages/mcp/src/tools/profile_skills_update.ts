// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  buildMcpDryRunPreview,
  domainErrorResponse,
  dryRunMultiResponse,
  genericErrorResponse,
  isToolErrorResponse,
  jsonResponse,
  type ToolRegistrationContext,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_skills_update";

const RATING_VALUES = ["COMPETENT", "STRONG", "EXPERT", "NOVICE"] as const;

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the requests without executing. Returns `{ ok: true, dryRun: true, previews: [...] }` (NOTE: plural `previews` — this tool fires one mutation per supplied field, so the envelope carries an array). Default: false.",
  );

/**
 * Multi-mutation tool: `profile.skills.set` fires one mutation per
 * supplied field (rating, experience, publicity). Dry-run therefore emits
 * the plural `{ previews: [...] }` envelope (via {@link dryRunMultiResponse}),
 * one preview per mutation that would actually fire — order matches the
 * apply path's field iteration: rating → experience → public.
 */
export function registerProfileSkillsUpdateTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Update a skill",
      description: [
        "Update one or more fields on an existing ProfileSkillSet — proficiency rating, years of experience, public/private visibility.",
        "At least one of `rating`, `experience`, or `public` must be supplied. Multi-flag updates fire sequential mutations; partial-failure surfaces as `PARTIAL_FAILURE` listing which fields landed.",
        "",
        "Dry-run note: returns `{ ok: true, dryRun: true, previews: [...] }` (plural `previews`) — one preview per mutation that would actually fire, in apply-path order (rating → experience → public).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Mark TypeScript as expert level on my profile." (after looking up its id)',
        '  - "Set my Python skill to public, expert level, 5 years of experience."',
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
          .max(70)
          .optional()
          .describe("Total years of experience on this skill (integer, 0-70). E.g., 5 for 5 years. Optional."),
        public: z
          .boolean()
          .optional()
          .describe(
            "Whether the skill is visible on the public profile. `true` = public, `false` = private. Optional.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      const fields: profile.skills.SkillUpdate = {};
      if (input.rating !== undefined) fields.rating = input.rating;
      if (input.experience !== undefined) fields.experience = input.experience;
      if (input.public !== undefined) fields.public = input.public;

      if (input.dryRun === true) {
        if (Object.keys(fields).length === 0) {
          return domainErrorResponse(TOOL_NAME, {
            code: "VALIDATION_ERROR",
            message: "At least one of `rating`, `experience`, or `public` must be supplied to preview a skills update.",
          });
        }
        const previews: DryRunPreview[] = [];
        if (fields.rating !== undefined) {
          previews.push(
            buildMcpDryRunPreview(
              "UPDATE_PROFILE_SKILL_SET_RATING",
              "talent-profile",
              { input: { skillSetId: input.id, skillSet: { rating: fields.rating } } },
              auth.token,
            ),
          );
        }
        if (fields.experience !== undefined) {
          previews.push(
            buildMcpDryRunPreview(
              "UPDATE_PROFILE_SKILL_SET_EXPERIENCE",
              "talent-profile",
              { input: { skillSetId: input.id, skillSet: { experience: fields.experience } } },
              auth.token,
            ),
          );
        }
        if (fields.public !== undefined) {
          previews.push(
            buildMcpDryRunPreview(
              "UPDATE_PROFILE_SKILL_SET_PUBLICITY",
              "talent-profile",
              { input: { skillSetId: input.id, skillSet: { public: fields.public } } },
              auth.token,
            ),
          );
        }
        return dryRunMultiResponse(previews);
      }

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
