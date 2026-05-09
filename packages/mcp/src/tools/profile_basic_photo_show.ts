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

const TOOL_NAME = "ttctl_profile_basic_photo_show";

export function registerProfileBasicPhotoShowTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show profile photo URLs",
      description: [
        "Fetch the URLs of the signed-in user's profile photo (default / original / small variants plus the recommended crop rectangle and a `isResolutionSatisfied` flag).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Show me my Toptal profile photo."',
        '  - "What are the URLs of my profile photo variants?"',
        '  - "Is my profile photo resolution OK?"',
      ].join("\n"),
      inputSchema: {},
    },
    async () => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

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
