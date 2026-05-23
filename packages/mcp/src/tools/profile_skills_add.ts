// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
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

// `ProficiencyRating` includes `NOVICE` as a read-accepted legacy value;
// for writes the user-visible Toptal UI exposes only the three values
// below (empirically verified via live UI inspection 2026-05-19). The MCP
// tool restricts writes to the documented three; if Toptal restores
// `NOVICE` as a write-acceptable value, this enum will need extension.
const PROFICIENCY_RATING = z.enum(["COMPETENT", "STRONG", "EXPERT"]);

export function registerProfileSkillsAddTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Add a skill to profile",
      description: [
        "Add a skill to the signed-in user's profile.",
        "Pass `name` alone — the tool searches the catalog and transparently binds to the matching catalog Skill on a single exact match (case-insensitive). If no catalog skill matches, a custom (non-catalog) skill is created from `name`. If ≥2 catalog skills match the name exactly, an actionable error lists the duplicates and you disambiguate by passing `skillId` (discoverable via `ttctl_profile_skills_autocomplete`).",
        "Proficiency dimensions (`rating`, `experience`, `public`) all have sensible defaults — pass them only when overriding.",
        "",
        "Defaults applied when omitted:",
        "  - `rating`: COMPETENT (lowest user-visible rating)",
        "  - `experience`: 1",
        "  - `public`: false (private)",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Add TypeScript to my Toptal skills." → `{ name: "TypeScript" }` (auto-binds if catalog has exactly one "TypeScript")',
        '  - "Add PostgreSQL at expert level with 5 years experience, public." → `{ name: "PostgreSQL", rating: "EXPERT", experience: 5, public: true }`',
        '  - Disambiguate ≥2 exact-name duplicates: `{ name: "Java", skillId: "V1-Skill-12345" }`',
      ].join("\n"),
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(
            "Skill name. The tool searches the catalog for `name`: a single exact match (case-insensitive, trimmed) auto-binds to that catalog Skill; ≥2 exact matches surface an actionable error with `skillId` nudge; no exact match falls back to creating a custom (non-catalog) Skill. Override the resolution with `skillId` when needed.",
          ),
        rating: PROFICIENCY_RATING.optional().describe(
          "Proficiency rating. One of COMPETENT | STRONG | EXPERT. Defaults to COMPETENT.",
        ),
        experience: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Total experience on the skill (integer). Defaults to 1."),
        public: z.boolean().optional().describe("Show the skill on the public profile. Defaults to false (private)."),
        skillId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional catalog Skill id (e.g., `V1-Skill-278891`) to bind this entry to a catalog skill explicitly. Discover via `ttctl_profile_skills_autocomplete`. Use this to bypass `name`-based auto-resolution (e.g., when ≥2 catalog skills match `name` exactly and the auto-resolution surfaces a disambiguation error).",
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      const fields: profile.skills.AddSkillFields = { name: input.name };
      if (input.rating !== undefined) fields.rating = input.rating;
      if (input.experience !== undefined) fields.experience = input.experience;
      if (input.public !== undefined) fields.public = input.public;
      if (input.skillId !== undefined) fields.skillId = input.skillId;

      try {
        // Delegate to the core service for both dry-run and apply paths so
        // the preview's wire shape is byte-for-byte the same as the live
        // mutation would transmit (matches #395 employment.add pattern).
        const outcome = await profile.skills.add(auth.token, fields, { dryRun: input.dryRun === true });
        if (outcome.kind === "preview") {
          return dryRunResponse(outcome.preview);
        }
        return jsonResponse(outcome.result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        // `extractProfileId` (apply path) throws `profile.basic.ProfileError`,
        // not `SkillsError` — match the sibling skills tools' combined check.
        if (err instanceof profile.skills.SkillsError || err instanceof profile.basic.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
