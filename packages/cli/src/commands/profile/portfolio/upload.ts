// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import { emitAddSuccess, emitErrorAndExit } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio upload`. Routes to the
 * cover-image upload (`--cover <file>`) or attachment-file upload
 * (`--file <file>`) depending on which flag is supplied. The two flags
 * are mutually exclusive — exactly one must be passed. Emits the v0.4
 * envelope ABI (#128).
 *
 * The optional positional `[id]` is reserved for future per-item routing
 * (a follow-up if the server gains item-scoped upload mutations); for
 * now it is accepted but unused so the public surface stays stable when
 * the binding lands.
 */
export async function runProfilePortfolioUpload(
  _id: string | undefined,
  options: { cover?: string; file?: string; output: OutputFormat },
): Promise<void> {
  const modes = [options.cover !== undefined, options.file !== undefined];
  const modeCount = modes.filter(Boolean).length;
  if (modeCount === 0) {
    emitErrorAndExit({
      operation: "profile.portfolio.upload",
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "supply exactly one of --cover <file> or --file <file>.",
        },
      ],
      prettySummary:
        "portfolio upload failed (VALIDATION_ERROR): supply exactly one of --cover <file> or --file <file>.",
    });
  }
  if (modeCount > 1) {
    emitErrorAndExit({
      operation: "profile.portfolio.upload",
      format: options.output,
      errors: [{ code: "VALIDATION_ERROR", message: "--cover and --file are mutually exclusive." }],
      prettySummary: "portfolio upload failed (VALIDATION_ERROR): --cover and --file are mutually exclusive.",
    });
  }
  const token = await loadAuthTokenOrExit("portfolio upload", options.output);

  if (options.cover !== undefined) {
    let result: profile.portfolio.UploadPortfolioCoverResult;
    try {
      result = await profile.portfolio.uploadCover(token, { kind: "path", path: options.cover });
    } catch (err) {
      handlePortfolioError("portfolio upload", err, options.output);
      return;
    }
    emitAddSuccess({
      operation: "profile.portfolio.upload",
      format: options.output,
      created: result,
      prettySummary: "Cover image uploaded.",
      prettyEntity: (entity: profile.portfolio.UploadPortfolioCoverResult) => {
        const lines: string[] = [];
        if (entity.coverImageCacheName !== null) lines.push(`cacheName: ${entity.coverImageCacheName}`);
        if (entity.coverImageUrl !== null) lines.push(`url: ${entity.coverImageUrl}`);
        return lines.join("\n");
      },
    });
    return;
  }

  // --file branch
  const filePath = options.file as string;
  let fileResult: profile.portfolio.UploadPortfolioFileResult;
  try {
    fileResult = await profile.portfolio.uploadFile(token, { kind: "path", path: filePath });
  } catch (err) {
    handlePortfolioError("portfolio upload", err, options.output);
    return;
  }
  emitAddSuccess({
    operation: "profile.portfolio.upload",
    format: options.output,
    created: fileResult,
    prettySummary: "Portfolio file uploaded.",
    prettyEntity: (entity: profile.portfolio.UploadPortfolioFileResult) => {
      const lines: string[] = [];
      if (entity.fileCacheName !== null) lines.push(`cacheName: ${entity.fileCacheName}`);
      if (entity.fileUrl !== null) lines.push(`url: ${entity.fileUrl}`);
      return lines.join("\n");
    },
  });
}
