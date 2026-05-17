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

const TOOL_NAME = "ttctl_profile_external_show";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_profile_external_show` MCP tool. Mirrors the
 * `ttctl profile external show` CLI leaf — the primary read for the
 * stored external profile URLs (linkedin / github / website / twitter /
 * behance / dribbble) plus `id` and the last talent-side edit timestamp.
 *
 * This is the read counterpart of `ttctl_profile_external_update`. Agents
 * should use this instead of a no-op update to inspect current URL state
 * (a no-op update is a write-disguised-as-read and risks an unintended
 * write). Closes the read-side asymmetry documented in issue #343.
 */
export function registerProfileExternalShowTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show stored external profile URLs",
      description: [
        "Read the talent's stored external profile URLs (linkedin, github, website, twitter, behance, dribbble) plus the last talent-side edit timestamp.",
        "",
        "This is the READ counterpart of ttctl_profile_external_update — use it to inspect current URL state instead of a no-op update (a no-op update is a write-disguised-as-read).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What are my current external profile links?"',
        '  - "Show me my stored LinkedIn / GitHub / website URLs."',
        '  - "What Twitter handle is on my Toptal profile?"',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "getExternalProfiles",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }

      try {
        const result = await profile.external.show(auth.token);
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
