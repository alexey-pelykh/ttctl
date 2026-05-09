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

const TOOL_NAME = "ttctl_profile_basic_photo_upload";

/**
 * Register the `ttctl_profile_basic_photo_upload` MCP tool. Mirrors the
 * `ttctl profile basic photo upload <file>` CLI leaf — uploads a new
 * profile photo from a local file path.
 *
 * The tool accepts only a `file` path (string). Buffer input from the CLI
 * surface is not exposed here because MCP transports are JSON-only —
 * passing binary through MCP would require base64 wrapping that's brittle
 * and confusing for LLM clients. Use the CLI leaf if you need to upload
 * a buffer programmatically.
 */
export function registerProfileBasicPhotoUploadTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Upload profile photo",
      description: [
        "Upload a new profile photo from a local image file (jpg / png / gif / webp). Image content-type is inferred from the file extension.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Upload /Users/me/Pictures/headshot.jpg as my Toptal profile photo."',
        '  - "Set my profile photo to ./avatar.png."',
      ].join("\n"),
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe(
            "Absolute or relative path to the image file to upload. Must be readable by the MCP server process.",
          ),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const result = await profile.basic.photoUpload(auth.token, { file: input.file });
        return jsonResponse(result);
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
