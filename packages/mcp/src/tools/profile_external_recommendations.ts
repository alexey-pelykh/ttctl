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

const TOOL_NAME = "ttctl_profile_external_recommendations";

/**
 * Register the `ttctl_profile_external_recommendations` MCP tool. Mirrors
 * the `ttctl profile external recommendations` CLI leaf — lists the
 * platform's "do this next" recommendations.
 *
 * Each recommendation has a discriminator `type` (e.g.
 * `EmploymentsCountRecommendation`, `ProfileFreshnessRecommendation`)
 * and a small payload of variant-specific scalar fields. Nested entity
 * lists are intentionally trimmed at the GraphQL level — drilling in
 * requires fetching the underlying domain directly.
 */
export function registerProfileExternalRecommendationsTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "List profile recommendations",
      description: [
        "List the platform's per-section 'do this next' recommendations for the signed-in talent. Each recommendation has a `type` discriminator and a small payload of scalar fields.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What does Toptal recommend I improve on my profile?"',
        '  - "What\'s next on my profile checklist?"',
        '  - "Show me the recommendations for my profile."',
      ].join("\n"),
      inputSchema: {},
    },
    async () => {
      const auth = await loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const result = await profile.external.recommendations(auth.token);
        return jsonResponse(result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.external.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
