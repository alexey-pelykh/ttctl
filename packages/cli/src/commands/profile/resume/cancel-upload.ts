// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import { emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";
import { handleResumeError } from "./upload.js";

/**
 * Action handler for `ttctl profile resume cancel-upload`. The mutation
 * is idempotent — the server returns `success: true` even when no upload
 * is in flight. Emits the v0.4 update envelope (#128) — cancellation is
 * a state transition on the in-flight upload (semantically an update).
 */
export async function runProfileResumeCancelUpload(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("resume cancel-upload", format);

  let result: profile.resume.CancelResumeUploadResult;
  try {
    result = await profile.resume.cancelUpload(token);
  } catch (err) {
    handleResumeError("resume cancel-upload", err, format);
    return;
  }

  emitUpdateSuccess({
    operation: "profile.resume.cancel-upload",
    format,
    updated: result,
    prettySummary: `Resume upload canceled (success=${result.success ? "true" : "false"}).`,
  });
}
