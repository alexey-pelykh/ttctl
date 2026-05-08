// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";
import { handleResumeError } from "./upload.js";

/**
 * Action handler for `ttctl profile resume cancel-upload`. The mutation
 * is idempotent — the server returns `success: true` even when no upload
 * is in flight.
 */
export async function runProfileResumeCancelUpload(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("resume cancel-upload");

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
