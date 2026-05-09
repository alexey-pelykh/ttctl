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
  type ToolRegistrationContext,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_external_readiness";

/**
 * Register the `ttctl_profile_external_readiness` MCP tool. Mirrors the
 * `ttctl profile external readiness` CLI leaf — reads the per-section
 * profile-readiness checklist plus the rolled-up `submitAvailable` flag.
 *
 * Used to know which sections still need work before the talent can
 * submit-for-review.
 */
export function registerProfileExternalReadinessTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show profile readiness",
      description: [
        "Read the per-section profile-readiness checklist (photo, basic info, skills, employments, portfolio, working hours, etc.) plus the rolled-up `submitAvailable` flag.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Is my Toptal profile ready to submit?"',
        '  - "Which sections still need work?"',
        '  - "Show me my profile-readiness checklist."',
      ].join("\n"),
      inputSchema: {},
    },
    async () => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const result = await profile.external.readiness(auth.token);
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
