// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitAddSuccess, emitErrorAndExit } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";

/**
 * Action handler for `ttctl profile resume upload <file>`. Uploads the
 * file at the supplied path. Emits the v0.4 envelope ABI (#128).
 *
 * Errors:
 *   - `(FILE_NOT_FOUND)` if the file doesn't exist
 *   - `(FILE_READ_ERROR)` for other read failures (permissions, etc.)
 *   - `(USER_ERROR)` if the server rejects the resume (e.g., size limit)
 *   - `TtctlError` subclasses route through `presentTtctlError` on
 *     `pretty`, the envelope on `json`/`yaml`
 */
export async function runProfileResumeUpload(file: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("resume upload", format);

  let result: profile.resume.UploadResumeResult;
  try {
    result = await profile.resume.upload(token, { kind: "path", path: file });
  } catch (err) {
    handleResumeError("resume upload", err, format);
    return;
  }

  emitAddSuccess({
    operation: "profile.resume.upload",
    format,
    created: result,
    prettySummary: "Resume uploaded.",
    prettyEntity: () => `file: ${file}`,
  });
}

function handleResumeError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.resume.ResumeError) {
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: commandLabel.replace(/ /g, "."),
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${commandLabel} failed: ${message}`,
  });
}

export { handleResumeError };
