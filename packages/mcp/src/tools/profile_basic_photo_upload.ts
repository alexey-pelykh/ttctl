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
 *
 * Dry-run path (issue #165): when `dryRun: true`, returns a preview of
 * the `UploadProfilePhoto` mutation's GraphQL operations envelope (the
 * top-level fields of the multipart form's `operations` part). The
 * multipart binary payload itself is NOT described — only the GraphQL
 * request shape that would be sent in the `operations` part of the
 * multipart envelope. `variables.input.profileId` is the placeholder
 * `DRY_RUN_PROFILE_ID_PLACEHOLDER` (apply path resolves it via a
 * sibling profile read).
 */
export function registerProfileBasicPhotoUploadTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Upload profile photo",
      description: [
        "Upload a new profile photo from a local image file (jpg / png / gif / webp). Image content-type is inferred from the file extension.",
        "",
        "Pass `dryRun: true` to preview the request without firing the mutation. The preview describes the GraphQL `operations` envelope only (not the multipart binary body).",
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
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` for the UploadProfilePhoto operation; the multipart binary body is NOT enumerated (only the GraphQL operations envelope). Default: false.",
          ),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        // The multipart envelope's `operations` part carries:
        //   { operationName, query, variables: { input: <UpdatePhotoInput, file=null> } }
        // — the actual file lives in a separate multipart part referenced
        // via the `map` field. The dry-run preview describes the operations
        // envelope only (mirroring the wire shape that `photoUpload` builds
        // in core/services/profile/basic/index.ts).
        return dryRunResponse(
          buildMcpDryRunPreview(
            "UploadProfilePhoto",
            "talent-profile",
            {
              input: {
                profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER,
                photo: null,
                transformation: { cropped: { x: 0, y: 0, width: 0, height: 0 } },
              },
            },
            auth.token,
          ),
        );
      }

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
