// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { z } from "zod";

import type { ToolErrorResponse } from "../errors.js";

/**
 * Reusable input-schema fragment for tools that accept a file via either
 * a server-relative `filePath` (host has filesystem access) or
 * base64-encoded `content` (web-host without filesystem access).
 *
 * Tool descriptions should clarify which option the host prefers per the
 * issue spec:
 *
 *   - **Claude Desktop / Claude Code**: filesystem access; prefer `filePath`.
 *   - **Web-hosted clients (no filesystem)**: only `content` (base64) works.
 *
 * Exactly one of the two MUST be supplied. Schema accepts both as
 * optional; the runtime validation in `decodeFileUploadInput` enforces
 * the mutual-exclusion constraint. If we marked one of the two required,
 * Zod would reject calls that supplied only the other.
 */
export const fileUploadInputSchema = {
  filePath: z
    .string()
    .optional()
    .describe(
      "Server-relative path to the file. Preferred when the host has filesystem access (Claude Desktop, Claude Code). Mutually exclusive with `content`.",
    ),
  filename: z
    .string()
    .optional()
    .describe(
      "Filename to send to Toptal. Required when using `content` (no path to derive from). Optional when using `filePath` — the basename of the path is used by default.",
    ),
  content: z
    .string()
    .optional()
    .describe(
      "Base64-encoded file content. Use when the host lacks filesystem access (web-hosted clients). Mutually exclusive with `filePath`.",
    ),
  contentType: z
    .string()
    .optional()
    .describe("Content-Type for the file (e.g., `image/png`, `application/pdf`). Optional; server applies a default."),
};

export type FileUploadInput = {
  filePath?: string | undefined;
  filename?: string | undefined;
  content?: string | undefined;
  contentType?: string | undefined;
};

/**
 * Resolution variant matching the service-layer `FileSource` shape (so
 * the caller can pass the result directly to `profile.portfolio.upload*`
 * / `profile.resume.upload`). Buffer mode populates `contentType` only
 * when supplied — `exactOptionalPropertyTypes: true` rejects the
 * `string | undefined` form, so we omit the key in the absence case.
 */
export type FileSourceResolution =
  | {
      kind: "buffer";
      filename: string;
      content: Buffer;
      contentType?: string;
    }
  | { kind: "path"; path: string };

/**
 * Translate the typed input fragment into the {@link FileSource}
 * variant the service layer expects. Validates the mutual-exclusion
 * constraint and the per-mode requirements.
 *
 * Returns either:
 *   - A resolution object the caller passes to the service function, OR
 *   - A `ToolErrorResponse` carrying a `(VALIDATION_ERROR)` block for the
 *     tool callback to return directly.
 */
export function decodeFileUploadInput(input: FileUploadInput): FileSourceResolution | ToolErrorResponse {
  const hasPath = input.filePath !== undefined && input.filePath !== "";
  const hasContent = input.content !== undefined && input.content !== "";
  if (hasPath && hasContent) {
    return validationError("`filePath` and `content` are mutually exclusive — supply exactly one.");
  }
  if (!hasPath && !hasContent) {
    return validationError("Supply exactly one of `filePath` or `content` (base64).");
  }
  if (hasPath) {
    return { kind: "path", path: input.filePath as string };
  }
  // base64 branch
  if (input.filename === undefined || input.filename === "") {
    return validationError("`filename` is required when uploading via `content` (base64).");
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.content as string, "base64");
  } catch {
    return validationError("`content` is not valid base64.");
  }
  if (buffer.length === 0) {
    return validationError("`content` decoded to zero bytes.");
  }
  // `contentType` is omitted entirely when not supplied — assigning
  // `undefined` would violate `exactOptionalPropertyTypes`.
  return input.contentType !== undefined
    ? { kind: "buffer", filename: input.filename, content: buffer, contentType: input.contentType }
    : { kind: "buffer", filename: input.filename, content: buffer };
}

function validationError(message: string): ToolErrorResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          `Error: ${message}`,
          "",
          "Recovery: Adjust the tool input and call again.",
          "",
          "(Code: VALIDATION_ERROR)",
        ].join("\n"),
      },
    ],
  };
}

export { validationError };
