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

const TOOL_NAME = "ttctl_profile_external_advanced_wizard_show";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_profile_external_advanced_wizard_show` MCP tool.
 * Mirrors the `ttctl profile external advanced-wizard show` CLI leaf —
 * reads the advanced-profile-wizard status plus a summary of the talent's
 * travel-visa list (count + IDs).
 *
 * Visa CRUD lives in the `ttctl_profile_visas_*` sub-domain — surfacing
 * the rich shape here would create a partial duplication that drifts as
 * the visas sub-domain evolves.
 */
export function registerProfileExternalAdvancedWizardShowTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show advanced-profile wizard status",
      description: [
        "Read the advanced-profile-wizard status plus a summary of the talent's travel-visa list (count + IDs).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What\'s the state of my advanced-profile wizard?"',
        '  - "Have I finished the advanced profile setup?"',
        '  - "Show me my travel-visa summary."',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "getAdvancedProfileData",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }

      try {
        const result = await profile.external.advancedWizardShow(auth.token);
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
