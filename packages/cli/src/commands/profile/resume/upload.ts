// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";

/**
 * Action handler for `ttctl profile resume upload <file>`. Uploads the
 * file at the supplied path. Errors:
 *   - `(FILE_NOT_FOUND)` if the file doesn't exist
 *   - `(FILE_READ_ERROR)` for other read failures (permissions, etc.)
 *   - `(USER_ERROR)` if the server rejects the resume (e.g., size limit)
 *   - `TtctlError` subclasses route through `presentTtctlError`
 */
export async function runProfileResumeUpload(file: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("resume upload");

  let result: profile.resume.UploadResumeResult;
  try {
    result = await profile.resume.upload(token, { kind: "path", path: file });
  } catch (err) {
    handleResumeError("resume upload", err);
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
  process.stdout.write(`Resume uploaded.\n  file: ${file}\n`);
}

function handleResumeError(commandLabel: string, err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.resume.ResumeError) {
    process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${commandLabel} failed: ${message}\n`);
  process.exit(1);
}

export { handleResumeError };
