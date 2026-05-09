// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ttctlErrorToToolResponseOrNull } from "../../errors.js";
import type { ToolErrorResponse } from "../../errors.js";
import { decodeFileUploadInput, fileUploadInputSchema } from "../file-upload.js";
import type { ToolRegistrationContext } from "../_shared.js";

/**
 * Register the two `ttctl_profile_resume_*` MCP tools.
 *
 * Tool names use the canonical sub-domain `resume` (NOT the CLI alias
 * `cv`) per project policy.
 */
export function registerResumeTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_profile_resume_upload",
    {
      title: "Upload a resume file",
      description:
        "Upload the user's resume (PDF or DOCX). Supply EITHER `filePath` (server-relative; preferred when the host has filesystem access — Claude Desktop, Claude Code) OR `content` (base64-encoded; for web-hosted clients without filesystem access). Returns `{ success: true }` on a server-confirmed success.",
      inputSchema: fileUploadInputSchema,
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const decoded = decodeFileUploadInput(args);
      if ("isError" in decoded) return decoded;
      try {
        const result = await profile.resume.upload(auth.token, decoded);
        return successResponse(result);
      } catch (err) {
        return mapResumeError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_resume_cancel_upload",
    {
      title: "Cancel an in-flight resume upload",
      description:
        "Cancel any in-flight resume upload, clearing half-uploaded server-side state. Idempotent — returns success even when no upload is in flight.",
      inputSchema: {},
    },
    async () => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const result = await profile.resume.cancelUpload(auth.token);
        return successResponse(result);
      } catch (err) {
        return mapResumeError(err);
      }
    },
  );
}

interface ToolSuccessResponse {
  [x: string]: unknown;
  content: [{ type: "text"; text: string }];
}

function successResponse(data: unknown): ToolSuccessResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function mapResumeError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof profile.resume.ResumeError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Error: ${err.message}`,
            "",
            "Recovery: Adjust the tool input or retry; see the code below.",
            "",
            `(Code: ${err.code})`,
          ].join("\n"),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          `Error: resume request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
