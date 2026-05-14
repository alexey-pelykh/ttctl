// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import os from "node:os";
import path from "node:path";

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
 * Per-tool upload category — used to drive the extension allowlist
 * (defense-in-depth gate per issue #221, audit CRIT-007). Each MCP tool
 * that accepts a file upload picks the category matching the wire-level
 * resource it pushes to Toptal.
 *
 * The allowlists are deliberately curated by category:
 *
 *   - `basicPhoto` / `portfolioCover` — images only (jpg/png/gif/webp).
 *     Cover images and profile photos render directly on the public
 *     profile; non-image content has no legitimate use here.
 *   - `resume` — common resume document formats (pdf / docx / doc / txt
 *     / rtf / odt). Excludes images and archives.
 *   - `portfolioFile` — broad attachment allowlist (docs, images, media,
 *     archives) but explicitly excludes extensions correlated with
 *     credential exfiltration (no `.pub`, `.env`, `.db`, `.sqlite`, no
 *     no-extension files like `id_rsa` / `id_ed25519`).
 *
 * The category serves as the defense-in-depth layer that catches the
 * prompt-injection variant described in `SECURITY.md` § Prompt Injection
 * Risk (file-exfiltration variant): an injected prompt that tries to
 * push `~/.ssh/id_rsa`, `~/.aws/credentials`, or a cookie database to
 * Toptal will fail the extension check even if path-sandbox bypass is
 * enabled.
 */
export interface UploadCategory {
  /** Stable identifier used verbatim in error messages. */
  readonly name: string;
  /**
   * Allowlist of accepted extensions, lowercased and including the
   * leading dot (e.g. `.pdf`). Match is case-insensitive against the
   * lowercased {@link path.extname} of the supplied `filePath` or
   * `filename`. Empty extension (no dot in basename) is NEVER allowed —
   * a deliberate refusal of extensionless secret files (`id_rsa`,
   * `credentials`, `config`).
   */
  readonly allowedExtensions: readonly string[];
}

export const UPLOAD_CATEGORIES = {
  basicPhoto: {
    name: "basic-photo",
    allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
  },
  resume: {
    name: "resume",
    allowedExtensions: [".pdf", ".docx", ".doc", ".txt", ".rtf", ".odt"],
  },
  portfolioCover: {
    name: "portfolio-cover",
    allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
  },
  portfolioFile: {
    name: "portfolio-file",
    allowedExtensions: [
      // Documents
      ".pdf",
      ".docx",
      ".doc",
      ".txt",
      ".rtf",
      ".odt",
      ".xlsx",
      ".xls",
      ".pptx",
      ".ppt",
      ".csv",
      ".md",
      // Images
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".svg",
      ".heic",
      // Archives / media
      ".zip",
      ".mp4",
      ".mov",
      ".webm",
      ".mp3",
      ".m4a",
      ".wav",
    ],
  },
} as const satisfies Record<string, UploadCategory>;

/**
 * Directory names (relative to `$HOME`) that the path-prefix sandbox
 * allows. Picked to cover the common locations a user would intentionally
 * stage a file for upload from an MCP client. Sensitive directories
 * (`~/.ssh`, `~/.aws`, `~/Library`, browser profile dirs) are NOT here
 * and therefore refused unless the env override is set.
 */
const SAFE_PATH_PREFIX_DIRS = ["Documents", "Downloads", "Desktop"] as const;

/**
 * Env var that disables the path-prefix sandbox (extension allowlist
 * always remains in force). Set to `"1"` in the MCP server's process
 * environment to allow uploads from arbitrary paths — for users who
 * routinely stage upload candidates outside the default safe
 * directories. Any other value (including empty string, `"0"`, `"true"`)
 * keeps the sandbox enforced.
 */
const SANDBOX_BYPASS_ENV = "TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY";

function isSandboxBypassed(): boolean {
  return process.env[SANDBOX_BYPASS_ENV] === "1";
}

function safePathPrefixes(): string[] {
  const home = os.homedir();
  return SAFE_PATH_PREFIX_DIRS.map((dir) => path.join(home, dir));
}

/**
 * Validate the extension of the supplied filename or path against the
 * category's allowlist. Case-insensitive (`Foo.PDF` matches `.pdf`).
 * Extensionless inputs (`id_rsa`, `credentials`) are NEVER accepted —
 * the empty-extension case is explicit since no allowlist contains the
 * empty string.
 */
function validateExtension(filenameOrPath: string, category: UploadCategory): ToolErrorResponse | null {
  const ext = path.extname(filenameOrPath).toLowerCase();
  if (ext !== "" && category.allowedExtensions.includes(ext)) {
    return null;
  }
  const displayExt = ext === "" ? "<none>" : ext;
  return validationError(
    [
      `File extension "${displayExt}" is not allowed for ${category.name} uploads.`,
      `Allowed: ${category.allowedExtensions.join(", ")}.`,
    ].join(" "),
  );
}

/**
 * Validate `filePath` against the path-prefix sandbox. Resolves the
 * path first (normalises `..`, makes it absolute) so traversal attempts
 * like `~/Documents/../.ssh/id_rsa` collapse before the prefix check.
 *
 * Sibling-name guard: the comparison requires `resolved === prefix` OR
 * `resolved.startsWith(prefix + path.sep)`, so `~/Documents_secret/`
 * does NOT match `~/Documents`.
 *
 * When `TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY=1`, the sandbox is skipped
 * entirely. Extension allowlist remains in force in that mode.
 */
function validateSandbox(filePath: string): ToolErrorResponse | null {
  if (isSandboxBypassed()) {
    return null;
  }
  const resolved = path.resolve(filePath);
  const prefixes = safePathPrefixes();
  const isAllowed = prefixes.some((prefix) => resolved === prefix || resolved.startsWith(prefix + path.sep));
  if (isAllowed) {
    return null;
  }
  return validationError(
    [
      `Refusing to read file outside of the MCP upload sandbox.`,
      `Resolved path: "${resolved}".`,
      `Allowed prefixes: ${prefixes.join(", ")}.`,
      `Set ${SANDBOX_BYPASS_ENV}=1 in the MCP server's environment to override (extension allowlist still applies).`,
    ].join(" "),
  );
}

/**
 * Validate a file-upload path against both gates: extension allowlist +
 * path-prefix sandbox. Returns `null` on accept, {@link ToolErrorResponse}
 * on reject.
 *
 * Exposed so `profile_basic_photo_upload.ts` can call it directly — that
 * tool registers a bare `file` field (not via {@link fileUploadInputSchema})
 * and therefore can't go through {@link decodeFileUploadInput}.
 *
 * Order: extension first (cheap, clearer signal), then sandbox.
 */
export function validateUploadPath(filePath: string, category: UploadCategory): ToolErrorResponse | null {
  const extError = validateExtension(filePath, category);
  if (extError !== null) return extError;
  return validateSandbox(filePath);
}

/**
 * Translate the typed input fragment into the {@link FileSource}
 * variant the service layer expects. Validates the mutual-exclusion
 * constraint and the per-mode requirements.
 *
 * Defense-in-depth (issue #221, audit CRIT-007): the path branch
 * additionally enforces an extension allowlist and a path-prefix
 * sandbox per the supplied {@link UploadCategory}; the buffer branch
 * enforces the extension allowlist against the supplied `filename`.
 *
 * Returns either:
 *   - A resolution object the caller passes to the service function, OR
 *   - A `ToolErrorResponse` carrying a `(VALIDATION_ERROR)` block for the
 *     tool callback to return directly.
 */
export function decodeFileUploadInput(
  input: FileUploadInput,
  category: UploadCategory,
): FileSourceResolution | ToolErrorResponse {
  const hasPath = input.filePath !== undefined && input.filePath !== "";
  const hasContent = input.content !== undefined && input.content !== "";
  if (hasPath && hasContent) {
    return validationError("`filePath` and `content` are mutually exclusive — supply exactly one.");
  }
  if (!hasPath && !hasContent) {
    return validationError("Supply exactly one of `filePath` or `content` (base64).");
  }
  if (hasPath) {
    const pathError = validateUploadPath(input.filePath as string, category);
    if (pathError !== null) return pathError;
    return { kind: "path", path: input.filePath as string };
  }
  // base64 branch
  if (input.filename === undefined || input.filename === "") {
    return validationError("`filename` is required when uploading via `content` (base64).");
  }
  const filenameError = validateExtension(input.filename, category);
  if (filenameError !== null) return filenameError;
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
