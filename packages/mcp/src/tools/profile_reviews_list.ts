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

const TOOL_NAME = "ttctl_profile_reviews_list";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_profile_reviews_list` MCP tool. Mirrors the
 * `ttctl profile reviews list` CLI leaf — lists pending section reviews
 * for the signed-in talent.
 *
 * Each row carries the section-review ID (passed to
 * `ttctl_profile_reviews_approve_section`) plus an `items` array; each
 * item carries its own ID (passed to
 * `ttctl_profile_reviews_approve_item`) and the underlying entity ID.
 * Use this tool first before invoking the approval tools to obtain the
 * required IDs.
 */
export function registerProfileReviewsListTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "List pending section reviews",
      description: [
        "List pending section reviews for the signed-in talent. Each row carries the section-review ID, section name, requestedAt timestamp, and an `items` array (each with its own id, itemId, requestedAt). Returns an empty array when no reviews are pending.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What\'s pending review on my profile?"',
        '  - "Show me my section reviews."',
        '  - "Are there any unapproved changes on my profile?"',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "sectionReviews",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }

      try {
        const result = await profile.reviews.list(auth.token);
        return jsonResponse(result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.reviews.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
