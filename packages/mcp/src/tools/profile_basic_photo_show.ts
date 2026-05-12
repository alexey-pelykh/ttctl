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

const TOOL_NAME = "ttctl_profile_basic_photo_show";

/**
 * Register the `ttctl_profile_basic_photo_show` MCP tool. Read-only.
 *
 * Dry-run path (issue #165): when `dryRun: true`, returns a preview of
 * the `GET_PHOTO` query (talent-profile surface) that WOULD have been
 * sent. The `profileId` variable carries `DRY_RUN_PROFILE_ID_PLACEHOLDER`
 * because the apply path resolves it via a sibling `show()` call at
 * execution time — the dry-run path skips that read entirely so no
 * transport is invoked.
 */
export function registerProfileBasicPhotoShowTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show profile photo URLs",
      description: [
        "Fetch the URLs of the signed-in user's profile photo (default / original / small variants plus the recommended crop rectangle and a `isResolutionSatisfied` flag).",
        "",
        "Pass `dryRun: true` to preview the request without firing the query.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Show me my Toptal profile photo."',
        '  - "What are the URLs of my profile photo variants?"',
        '  - "Is my profile photo resolution OK?"',
      ].join("\n"),
      inputSchema: {
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with the GET_PHOTO operation; `variables.profileId` is a placeholder that the apply path would have resolved via a sibling profile read. Default: false.",
          ),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "GET_PHOTO",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }

      try {
        const payload = await profile.basic.photoShow(auth.token);
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
