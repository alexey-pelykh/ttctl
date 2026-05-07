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

const TOOL_NAME = "ttctl_profile_external_custom_requirements_show";

/**
 * Register the `ttctl_profile_external_custom_requirements_show` MCP tool.
 * Mirrors the `ttctl profile external custom-requirements show` CLI leaf —
 * reads the three onboarding-readiness toggles (background-check,
 * drug-test, time-tracking-tools).
 *
 * Despite the issue's "free-text" framing, the underlying API is a
 * boolean trio. See the service module top-comment for the spec/API
 * reconciliation.
 */
export function registerProfileExternalCustomRequirementsShowTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show custom requirements",
      description: [
        "Read the three onboarding-readiness toggles (background-check, drug-test, time-tracking-tools) for the signed-in talent.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Am I opted into background checks?"',
        '  - "What\'s my onboarding-readiness state?"',
        '  - "Show my custom requirements."',
      ].join("\n"),
      inputSchema: {},
    },
    async () => {
      const auth = await loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const result = await profile.external.customRequirementsShow(auth.token);
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
