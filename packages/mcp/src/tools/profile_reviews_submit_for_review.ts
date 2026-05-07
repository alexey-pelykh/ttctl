// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  domainErrorResponse,
  genericErrorResponse,
  isToolErrorResponse,
  jsonResponse,
  loadTokenForTool,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_reviews_submit_for_review";

/**
 * Register the `ttctl_profile_reviews_submit_for_review` MCP tool.
 * Mirrors the `ttctl profile reviews submit-for-review` CLI leaf — re-
 * submits the talent's profile for platform-side re-review.
 *
 * The platform may reject if the profile is not yet ready (cross-check
 * via `ttctl_profile_external_readiness`). The mutation's input shape is
 * **INFERRED — UNVERIFIED** (`{ profileId: ID! }`); deviations would
 * surface as `USER_ERROR` at runtime.
 */
export function registerProfileReviewsSubmitForReviewTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Submit profile for platform re-review",
      description: [
        "Submit the talent's profile for platform-side re-review. Used after profile edits that need re-verification (skills, employments, etc.). The platform may reject if the profile is not yet ready (use `ttctl_profile_external_readiness` to check first).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Submit my profile for review."',
        '  - "Re-submit my Toptal profile after my edits."',
        '  - "I\'m done editing — submit for re-review."',
      ].join("\n"),
      inputSchema: {},
    },
    async () => {
      const auth = await loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const result = await profile.reviews.submitForReview(auth.token);
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
