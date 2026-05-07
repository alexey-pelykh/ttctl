// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, loadAuthToken, profile, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { handleResumeError } from "./upload.js";

/**
 * Action handler for `ttctl profile resume cancel-upload`. The mutation
 * is idempotent — the server returns `success: true` even when no upload
 * is in flight.
 */
export async function runProfileResumeCancelUpload(format: OutputFormat): Promise<void> {
  let tokenPath: string;
  try {
    const { config, path: configPath } = resolveConfig();
    tokenPath = resolveAuthTokenPath({ config, configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`resume cancel-upload failed (${err.code}): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "resume cancel-upload failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  let result: profile.resume.CancelResumeUploadResult;
  try {
    result = await profile.resume.cancelUpload(token);
  } catch (err) {
    handleResumeError("resume cancel-upload", err);
    return;
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === "table") {
    process.stdout.write(`field\tvalue\nsuccess\t${result.success ? "true" : "false"}\n`);
    return;
  }
  process.stdout.write(`Resume upload canceled (success=${result.success ? "true" : "false"}).\n`);
}
