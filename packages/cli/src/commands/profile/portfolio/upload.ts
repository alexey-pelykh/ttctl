// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { loadAuthToken, profile, resolveAuthTokenPath } from "@ttctl/core";

import { resolveConfigForCli } from "../../../lib/config-context.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handlePortfolioError } from "./add.js";
import { handleConfigError } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio upload`. Routes to the
 * cover-image upload (`--cover <file>`) or attachment-file upload
 * (`--file <file>`) depending on which flag is supplied. The two flags
 * are mutually exclusive — exactly one must be passed.
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
    process.stderr.write(
      "portfolio upload failed (VALIDATION_ERROR): supply exactly one of --cover <file> or --file <file>.\n",
    );
    process.exit(1);
  }
  if (modeCount > 1) {
    process.stderr.write("portfolio upload failed (VALIDATION_ERROR): --cover and --file are mutually exclusive.\n");
    process.exit(1);
  }

  const tokenPath = handleConfigError("portfolio upload", () => {
    const { config, path: configPath } = resolveConfigForCli();
    return resolveAuthTokenPath({ config, configPath });
  });
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "portfolio upload failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  if (options.cover !== undefined) {
    let result: profile.portfolio.UploadPortfolioCoverResult;
    try {
      result = await profile.portfolio.uploadCover(token, { kind: "path", path: options.cover });
    } catch (err) {
      handlePortfolioError("portfolio upload", err);
      return;
    }
    emitCoverResult(result, options.output);
    return;
  }

  // --file branch
  const filePath = options.file as string;
  let fileResult: profile.portfolio.UploadPortfolioFileResult;
  try {
    fileResult = await profile.portfolio.uploadFile(token, { kind: "path", path: filePath });
  } catch (err) {
    handlePortfolioError("portfolio upload", err);
    return;
  }
  emitFileResult(fileResult, options.output);
}

function emitCoverResult(result: profile.portfolio.UploadPortfolioCoverResult, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === "table") {
    process.stdout.write(
      `field\tvalue\ncoverImageCacheName\t${result.coverImageCacheName ?? ""}\ncoverImageUrl\t${result.coverImageUrl ?? ""}\n`,
    );
    return;
  }
  const lines: string[] = ["Cover image uploaded."];
  if (result.coverImageCacheName !== null) lines.push(`  cacheName: ${result.coverImageCacheName}`);
  if (result.coverImageUrl !== null) lines.push(`  url: ${result.coverImageUrl}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function emitFileResult(result: profile.portfolio.UploadPortfolioFileResult, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === "table") {
    process.stdout.write(
      `field\tvalue\nfileCacheName\t${result.fileCacheName ?? ""}\nfileUrl\t${result.fileUrl ?? ""}\n`,
    );
    return;
  }
  const lines: string[] = ["Portfolio file uploaded."];
  if (result.fileCacheName !== null) lines.push(`  cacheName: ${result.fileCacheName}`);
  if (result.fileUrl !== null) lines.push(`  url: ${result.fileUrl}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}
