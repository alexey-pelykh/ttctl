// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";
import { formatPhotoText } from "./photo-show.js";

/**
 * Action handler for `ttctl profile basic photo upload <file>`. Reads the
 * file path the user supplied (commander.js positional argument), loads
 * the persisted auth token, and dispatches `profile.basic.photoUpload()`.
 * Emits the v0.4 update envelope (#128) — photo upload is conceptually a
 * profile-photo update.
 */
export async function runProfileBasicPhotoUpload(filePath: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile photo upload", format);

  let result: profile.basic.PhotoUrl;
  try {
    result = await profile.basic.photoUpload(token, { file: filePath });
  } catch (err) {
    handlePhotoUploadError(err, format);
    return;
  }

  emitUpdateSuccess({
    operation: "profile.basic.photo-upload",
    format,
    updated: result,
    prettySummary: "Photo updated.",
    prettyEntity: formatPhotoText,
  });
}

function handlePhotoUploadError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.basic.photo-upload",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.basic.ProfileError) {
    emitErrorAndExit({
      operation: "profile.basic.photo-upload",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `profile photo upload failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.basic.photo-upload",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `profile photo upload failed: ${message}`,
  });
}
