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

const TOOL_NAME = "ttctl_profile_basic_update";

/**
 * Register the `ttctl_profile_basic_update` MCP tool. Mirrors the
 * `ttctl profile basic update --bio --headline` CLI leaf — updates the
 * signed-in user's bio and/or headline via the talent-profile surface.
 *
 * Free-text input modes (stdin / `@file` / `--edit`) are CLI-specific
 * affordances and DO NOT apply here: MCP callers pass the resolved
 * string verbatim. The `bio` and `headline` parameters are both
 * optional; at least one must be supplied (the core layer validates
 * this and raises a `VALIDATION_ERROR` if both are omitted).
 */
export function registerProfileBasicUpdateTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Update profile basic info",
      description: [
        "Update the signed-in user's profile bio and/or headline. At least one must be supplied.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Update my bio to: Senior backend engineer specialising in Go and PostgreSQL."',
        "  - \"Change my Toptal headline to 'CTO at AcmeCo'.\"",
        '  - "Set my profile bio and headline."',
      ].join("\n"),
      inputSchema: {
        bio: z
          .string()
          .optional()
          .describe(
            "Long-form bio paragraph (multi-line). Maps to GraphQL `Profile.about`. Optional. The empty string is a valid value (clears the bio); pass `undefined` to leave the existing bio unchanged.",
          ),
        headline: z
          .string()
          .optional()
          .describe(
            "Short tagline shown above the user's photo (single line). Maps to GraphQL `Profile.quote`. Optional.",
          ),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      const changes: profile.basic.ProfileUpdate = {};
      if (input.bio !== undefined) changes.bio = input.bio;
      if (input.headline !== undefined) changes.headline = input.headline;

      try {
        const result = await profile.basic.set(auth.token, changes);
        return jsonResponse(result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.basic.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
