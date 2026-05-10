// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import { emitErrorAndExit } from "../../../lib/envelopes.js";
import { FreeTextError, resolveFreeText } from "../../../lib/freetext.js";
import type { OutputFormat } from "../../../lib/output.js";
import { emitMutationResult, handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio update <id>`. Updates only
 * the fields supplied; if no field flags are provided, the command exits
 * with a `VALIDATION_ERROR` (#128 envelope) rather than issuing an empty
 * mutation.
 */
export async function runProfilePortfolioUpdate(
  id: string,
  options: {
    title?: string;
    description?: string;
    edit?: boolean;
    url?: string;
    link?: string;
    client?: string;
    accomplishment?: string;
    output: OutputFormat;
  },
): Promise<void> {
  let description: string | undefined;
  try {
    description = await resolveFreeText(options.description, {
      flagName: "description",
      enableEditor: options.edit ?? false,
    });
  } catch (err) {
    if (err instanceof FreeTextError) {
      emitErrorAndExit({
        operation: "profile.portfolio.update",
        format: options.output,
        errors: [{ code: err.code, message: err.message }],
        prettySummary: `portfolio update failed (${err.code}): ${err.message}`,
      });
    }
    throw err;
  }

  if (options.url !== undefined && options.link !== undefined && options.url !== options.link) {
    emitErrorAndExit({
      operation: "profile.portfolio.update",
      format: options.output,
      errors: [{ code: "VALIDATION_ERROR", message: "--url and --link cannot disagree." }],
      prettySummary: "portfolio update failed (VALIDATION_ERROR): --url and --link cannot disagree.",
    });
  }
  const link = options.link ?? options.url;

  const changes: profile.portfolio.PortfolioItemInput = {};
  if (options.title !== undefined) changes.title = options.title;
  if (description !== undefined) changes.description = description;
  if (link !== undefined) changes.link = link;
  if (options.client !== undefined) changes.clientOrCompanyName = options.client;
  if (options.accomplishment !== undefined) changes.accomplishment = options.accomplishment;

  if (Object.keys(changes).length === 0) {
    emitErrorAndExit({
      operation: "profile.portfolio.update",
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message:
            "supply at least one field flag (--title, --description, --link, --client, --accomplishment, or --edit).",
        },
      ],
      prettySummary:
        "portfolio update failed (VALIDATION_ERROR): supply at least one field flag (--title, --description, --link, --client, --accomplishment, or --edit).",
    });
  }
  const token = await loadAuthTokenOrExit("portfolio update", options.output);

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.update(token, id, changes);
  } catch (err) {
    handlePortfolioError("portfolio update", err, options.output);
    return;
  }

  emitMutationResult(items, options.output, "update", { prettyHeader: `Portfolio item ${id} updated.` });
}
