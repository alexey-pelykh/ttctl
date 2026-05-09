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

const TOOL_NAME = "ttctl_profile_external_custom_requirements_set";

/**
 * Register the `ttctl_profile_external_custom_requirements_set` MCP tool.
 * Mirrors the `ttctl profile external custom-requirements set` CLI leaf —
 * toggles one or more of the three onboarding-readiness booleans.
 *
 * Caller-omitted fields default to the current server state (the
 * underlying mutation has no PATCH semantics — the service layer fetches
 * current state and merges before sending).
 */
export function registerProfileExternalCustomRequirementsSetTool(
  server: McpServer,
  ctx: ToolRegistrationContext,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Update custom requirements",
      description: [
        "Toggle one or more of the three onboarding-readiness booleans (background-check, drug-test, time-tracking-tools). Caller-omitted fields default to the current server state. At least one field must be supplied.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Opt me into background-check screening."',
        '  - "Mark me as willing to use time-tracking tools."',
        '  - "Toggle off the drug-test flag on my profile."',
      ].join("\n"),
      inputSchema: {
        backgroundCheck: z
          .boolean()
          .optional()
          .describe("Willing to undergo a background check (true|false). Optional."),
        drugTest: z.boolean().optional().describe("Willing to undergo a drug test (true|false). Optional."),
        timeTrackingTools: z
          .boolean()
          .optional()
          .describe("Willing to use time-tracking tools (true|false). Optional."),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      const changes: profile.external.CustomRequirementsUpdate = {};
      if (input.backgroundCheck !== undefined) changes.backgroundCheck = input.backgroundCheck;
      if (input.drugTest !== undefined) changes.drugTest = input.drugTest;
      if (input.timeTrackingTools !== undefined) changes.timeTrackingTools = input.timeTrackingTools;

      try {
        const result = await profile.external.customRequirementsSet(auth.token, changes);
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
