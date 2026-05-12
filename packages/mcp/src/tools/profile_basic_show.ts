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

const TOOL_NAME = "ttctl_profile_basic_show";

/**
 * Register the `ttctl_profile_basic_show` MCP tool. Mirrors the
 * `ttctl profile basic show` CLI leaf — fetches the signed-in user's
 * profile from the mobile-gateway and returns the typed payload.
 *
 * Auth token identifies the user, and the payload is always the full
 * `ProfileShow` shape (callers project as needed). MCP is the LLM-facing
 * surface, so the description includes three example user-intent phrases
 * the model can match against.
 *
 * Dry-run path (issue #165): when `dryRun: true`, the tool returns a
 * structured preview of the `ProfileShow` query that WOULD have been
 * sent to `mobile-gateway` — no transport call. Diagnostic value: an
 * MCP client can verify the request shape before running.
 */
export function registerProfileBasicShowTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show profile basic info",
      description: [
        "Fetch the signed-in user's Toptal Talent profile (identity, role, vertical, skills, hours, rate).",
        "",
        "Pass `dryRun: true` to preview the request without firing the query.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What\'s on my Toptal profile?"',
        '  - "Show me my Toptal Talent details."',
        '  - "What\'s my hourly rate and vertical?"',
      ].join("\n"),
      inputSchema: {
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview: DryRunPreview }` with operationName + variables + redacted bearer header. Default: false.",
          ),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("ProfileShow", "mobile-gateway", {}, auth.token));
      }

      try {
        const payload = await profile.basic.show(auth.token);
        return jsonResponse(payload);
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
