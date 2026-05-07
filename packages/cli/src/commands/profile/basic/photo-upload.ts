// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, loadAuthToken, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import type { OutputFormat } from "../../../lib/output.js";
import { formatPhotoText, formatPhotoTable } from "./photo-show.js";
import { resolveAuthTokenPathOrExit } from "./show.js";

/**
 * Action handler for `ttctl profile basic photo upload <file>`. Reads the
 * file path the user supplied (commander.js positional argument), loads
 * the persisted auth token, and dispatches `profile.basic.photoUpload()`.
 *
 * The core function reads the file from disk itself (so the multipart
 * envelope can stream the binary directly to `node-wreq` without staging
 * the content through a Node `Buffer` — though current implementation
 * does Buffer the file; future refactor can move to a stream). The CLI
 * just hands over the path, the auth token, and the requested output
 * format.
 *
 * Domain errors are surfaced via `handlePhotoUploadError`. The most likely
 * input error (`VALIDATION_ERROR` for missing/empty file) is rendered with
 * its prefix, so users see e.g.:
 *
 *     profile photo upload failed (VALIDATION_ERROR): Photo file not readable: ENOENT ...
 */
export async function runProfileBasicPhotoUpload(filePath: string, format: OutputFormat): Promise<void> {
  const tokenPath = resolveAuthTokenPathOrExit("profile show");
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "profile photo upload failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  let result: profile.basic.PhotoUrl;
  try {
    result = await profile.basic.photoUpload(token, { file: filePath });
  } catch (err) {
    handlePhotoUploadError(err);
    return;
  }

  const output = formatUploadResult(result, format);
  process.stdout.write(`${output}\n`);
}

function handlePhotoUploadError(err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.basic.ProfileError) {
    process.stderr.write(`profile photo upload failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`profile photo upload failed: ${message}\n`);
  process.exit(1);
}

/**
 * Format the typed photo-upload result for the chosen output mode.
 * Reuses the same renderers as `photo show` (consistent column layout,
 * same JSON shape) and prepends a confirmation line on the text branch.
 */
export function formatUploadResult(result: profile.basic.PhotoUrl, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (format === "table") {
    return formatPhotoTable(result);
  }
  return ["Photo updated.", formatPhotoText(result)].join("\n");
}
