// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../../errors.js";
import type { ToolErrorResponse } from "../../errors.js";
import { UPLOAD_CATEGORIES, decodeFileUploadInput, fileUploadInputSchema } from "../file-upload.js";
import { buildMcpDryRunPreview, dryRunResponse, jsonResponse, type ToolRegistrationContext } from "../_shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the two `ttctl_profile_resume_*` MCP tools.
 *
 * Tool names use the canonical sub-domain `resume` (NOT the CLI alias
 * `cv`) per project policy.
 *
 * Dry-run path (issue #165): both tools accept `dryRun?: boolean`. On
 * `dryRun: true` they return the uniform `{ ok, dryRun, preview }`
 * envelope describing the GraphQL operations envelope (multipart binary
 * body is not enumerated for `upload` — only the operations envelope
 * with `input.file = null` per the wire shape that core sends).
 */
export function registerResumeTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_profile_resume_upload",
    {
      title: "Upload a resume file",
      description:
        "Upload the user's resume (PDF or DOCX). Supply EITHER `filePath` (server-relative; preferred when the host has filesystem access — Claude Desktop, Claude Code) OR `content` (base64-encoded; for web-hosted clients without filesystem access). Returns `{ success: true }` on a server-confirmed success. Pass `dryRun: true` to preview the GraphQL operations envelope without firing.",
      inputSchema: { ...fileUploadInputSchema, dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("uploadResume", "talent-profile", { input: { file: null } }, auth.token),
        );
      }
      const decoded = decodeFileUploadInput(args, UPLOAD_CATEGORIES.resume);
      if ("isError" in decoded) return decoded;
      try {
        const result = await profile.resume.upload(auth.token, decoded);
        return jsonResponse(result);
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
        "Cancel any in-flight resume upload, clearing half-uploaded server-side state. Idempotent — returns success even when no upload is in flight. Pass `dryRun: true` to preview the request without firing.",
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("cancelResumeUpload", "talent-profile", { input: {} }, auth.token));
      }
      try {
        const result = await profile.resume.cancelUpload(auth.token);
        return jsonResponse(result);
      } catch (err) {
        return mapResumeError(err);
      }
    },
  );
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
