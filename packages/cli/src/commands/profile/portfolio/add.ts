// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitAddSuccess, emitErrorAndExit, emitRemoveSuccess, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { FreeTextError, resolveFreeText } from "../../../lib/freetext.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./shared.js";

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
      emitErrorAndExit({
        operation: "profile.portfolio.add",
        format: options.output,
        errors: [{ code: err.code, message: err.message }],
        prettySummary: `portfolio add failed (${err.code}): ${err.message}`,
      });
    }
    throw err;
  }

  if (options.url !== undefined && options.link !== undefined && options.url !== options.link) {
    emitErrorAndExit({
      operation: "profile.portfolio.add",
      format: options.output,
      errors: [{ code: "VALIDATION_ERROR", message: "--url and --link cannot disagree." }],
      prettySummary: "portfolio add failed (VALIDATION_ERROR): --url and --link cannot disagree.",
    });
  }
  const link = options.link ?? options.url;
  const token = await loadAuthTokenOrExit("portfolio add", options.output);

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
      handlePortfolioError("portfolio add", err, options.output);
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
    handlePortfolioError("portfolio add", err, options.output);
    return;
  }

  emitMutationResult(items, options.output, "add", { prettyHeader: "Portfolio item created." });
}

/**
 * Route service errors through the envelope ABI (#128). `TtctlError`
 * subclasses keep their dedicated 3-block pretty rendering on `pretty`;
 * `json`/`yaml` flow through the envelope so machine consumers see the
 * stable wire shape. Domain `PortfolioError` codes always flow through
 * the envelope.
 */
function handlePortfolioError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
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
  if (err instanceof profile.portfolio.PortfolioError) {
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

/**
 * Emit the post-mutation portfolio list, wrapped in the v0.4 envelope
 * ABI (#128). The portfolio core API returns the FULL post-mutation
 * list rather than the single mutated entity, so the envelope's
 * `created` / `updated` field carries the list (`PortfolioItem[]`)
 * rather than a single `PortfolioItem`. The pretty rendering keeps the
 * existing "success header + table" UX so users continue to see the
 * post-state at a glance.
 */
export function emitMutationResult(
  items: profile.portfolio.PortfolioItem[],
  format: OutputFormat,
  verb: "add" | "update" | "remove",
  options: { id?: string; prettyHeader: string },
): void {
  const rows = items.map((it) => `${it.id}\t${it.title ?? ""}\t${it.highlight ? "★" : ""}\t${it.link ?? ""}`);
  const tableText = ["id\ttitle\thighlight\tlink", ...rows].join("\n");
  if (verb === "remove") {
    const id = options.id;
    if (id === undefined) {
      throw new Error("emitMutationResult: `id` is required for the `remove` verb");
    }
    emitRemoveSuccess({
      operation: "profile.portfolio.remove",
      format,
      id,
      prettySummary: options.prettyHeader,
    });
    if (format === "pretty" && items.length > 0) {
      process.stdout.write(`${tableText}\n`);
    }
    return;
  }
  if (verb === "add") {
    emitAddSuccess({
      operation: "profile.portfolio.add",
      format,
      created: items,
      prettySummary: options.prettyHeader,
      prettyEntity: () => tableText,
    });
    return;
  }
  emitUpdateSuccess({
    operation: "profile.portfolio.update",
    format,
    updated: items,
    prettySummary: options.prettyHeader,
    prettyEntity: () => tableText,
  });
}

/** Backward-compatible alias; new call sites use `emitMutationResult`. */
export function emitListResult(
  items: profile.portfolio.PortfolioItem[],
  format: OutputFormat,
  successMessage: string,
): void {
  emitMutationResult(items, format, "update", { prettyHeader: successMessage });
}

export { handlePortfolioError };
