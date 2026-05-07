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
  loadTokenForTool,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_skills_autocomplete";

export function registerProfileSkillsAutocompleteTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Search global skill catalog",
      description: [
        "Search the global Toptal skill catalog for entries matching `query` (suitable for disambiguating before calling `ttctl_profile_skills_add`).",
        "Results are scoped to skills the talent's vertical permits and exclude any ids passed in `withoutIds` (e.g., the talent's existing skills).",
        "",
        "Example user prompts that should map to this tool:",
        "  - \"Search Toptal's catalog for 'postgres' before I add it.\"",
        "  - \"Find skill names matching 'java'.\"",
      ].join("\n"),
      inputSchema: {
        query: z.string().min(1).describe("Substring to search for in skill names. Case-insensitive."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max number of suggestions to return. Defaults to 10. Range: 1-50."),
        withoutIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Skill catalog ids to exclude from the results — typically the talent's existing skill catalog ids so the dropdown doesn't suggest skills already on the profile.",
          ),
      },
    },
    async (input) => {
      const auth = await loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const profilePayload = await profile.basic.show(auth.token);
        const profileId = profilePayload.viewer?.viewerRole.profileId;
        if (profileId === undefined) {
          return domainErrorResponse(TOOL_NAME, {
            code: "NO_VIEWER",
            message: "No profile id bound to this session.",
          });
        }
        const options: { limit?: number; withoutIds?: string[] } = {};
        if (input.limit !== undefined) options.limit = input.limit;
        if (input.withoutIds !== undefined) options.withoutIds = input.withoutIds;
        const suggestions = await profile.skills.autocomplete(auth.token, profileId, input.query, options);
        return jsonResponse(suggestions);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.skills.SkillsError || err instanceof profile.basic.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
