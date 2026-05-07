// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, loadAuthToken, profile, resolveAuthTokenPath } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { resolveConfigForCli } from "../../../lib/config-context.js";
import { FreeTextError, resolveFreeText } from "../../../lib/freetext.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handleConfigError } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio add`. Creates a new
 * portfolio item; if `--cover` is supplied, the cover image is uploaded
 * first and its server-issued `coverImageCacheName` is forwarded into
 * the create call so the new item carries the cover from creation.
 */
export async function runProfilePortfolioAdd(options: {
  title: string;
  description?: string;
  edit?: boolean;
  url?: string;
  link?: string;
  cover?: string;
  output: OutputFormat;
}): Promise<void> {
  let description: string | undefined;
  try {
    description = await resolveFreeText(options.description, {
      flagName: "description",
      enableEditor: options.edit ?? false,
    });
  } catch (err) {
    if (err instanceof FreeTextError) {
      process.stderr.write(`portfolio add failed (${err.code}): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (options.url !== undefined && options.link !== undefined && options.url !== options.link) {
    process.stderr.write("portfolio add failed (VALIDATION_ERROR): --url and --link cannot disagree.\n");
    process.exit(1);
  }
  const link = options.link ?? options.url;

  const tokenPath = handleConfigError("portfolio add", () => {
    const { config, path: configPath } = resolveConfigForCli();
    return resolveAuthTokenPath({ config, configPath });
  });
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "portfolio add failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  // Optional cover-image upload BEFORE create. The two calls are sequenced
  // because `createPortfolioItem` needs the server-issued cache name to
  // bind the cover to the new item; uploading is idempotent so a retry on
  // a transient create failure is safe.
  let coverImageCacheName: string | null = null;
  if (options.cover !== undefined) {
    try {
      const result = await profile.portfolio.uploadCover(token, { kind: "path", path: options.cover });
      coverImageCacheName = result.coverImageCacheName;
    } catch (err) {
      handlePortfolioError("portfolio add", err);
      return;
    }
  }

  const input: profile.portfolio.PortfolioItemInput = {
    title: options.title,
  };
  if (description !== undefined) input.description = description;
  if (link !== undefined) input.link = link;
  if (coverImageCacheName !== null) input.coverImage = coverImageCacheName;

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.add(token, input);
  } catch (err) {
    handlePortfolioError("portfolio add", err);
    return;
  }

  emitListResult(items, options.output, "Portfolio item created.");
}

/**
 * Map service errors to actionable stderr messages and exit code 1.
 * `TtctlError` subclasses (`Cf403Error`, `AuthRevokedError`, …) render
 * via `presentTtctlError` per #77; domain `PortfolioError` codes keep
 * the CLI's `(CODE): message` rendering.
 */
function handlePortfolioError(commandLabel: string, err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.portfolio.PortfolioError) {
    process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${commandLabel} failed: ${message}\n`);
  process.exit(1);
}

/** Emit the post-mutation portfolio list with a success header. */
export function emitListResult(
  items: profile.portfolio.PortfolioItem[],
  format: OutputFormat,
  successMessage: string,
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(items)}\n`);
    return;
  }
  if (format === "table") {
    const rows = items.map((it) => `${it.id}\t${it.title ?? ""}\t${it.highlight ? "★" : ""}\t${it.link ?? ""}`);
    process.stdout.write(`${successMessage}\n${["id\ttitle\thighlight\tlink", ...rows].join("\n")}\n`);
    return;
  }
  // text — readable summary
  const lines: string[] = [successMessage];
  for (const it of items) {
    const star = it.highlight ? " ★" : "";
    lines.push(`  ${it.id}${star} ${it.title ?? "(untitled)"}`);
    if (it.link !== null) lines.push(`    ${it.link}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

export { handlePortfolioError };
