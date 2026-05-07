// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { loadAuthToken, profile, resolveAuthTokenPath } from "@ttctl/core";

import { resolveConfigForCli } from "../../../lib/config-context.js";
import { FreeTextError, resolveFreeText } from "../../../lib/freetext.js";
import type { OutputFormat } from "../../../lib/output.js";
import { emitListResult, handlePortfolioError } from "./add.js";
import { handleConfigError } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio update <id>`. Updates only
 * the fields supplied; if no field flags are provided, the command exits
 * with a `VALIDATION_ERROR` rather than issuing an empty mutation.
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
      process.stderr.write(`portfolio update failed (${err.code}): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (options.url !== undefined && options.link !== undefined && options.url !== options.link) {
    process.stderr.write("portfolio update failed (VALIDATION_ERROR): --url and --link cannot disagree.\n");
    process.exit(1);
  }
  const link = options.link ?? options.url;

  const changes: profile.portfolio.PortfolioItemInput = {};
  if (options.title !== undefined) changes.title = options.title;
  if (description !== undefined) changes.description = description;
  if (link !== undefined) changes.link = link;
  if (options.client !== undefined) changes.clientOrCompanyName = options.client;
  if (options.accomplishment !== undefined) changes.accomplishment = options.accomplishment;

  if (Object.keys(changes).length === 0) {
    process.stderr.write(
      "portfolio update failed (VALIDATION_ERROR): supply at least one field flag (--title, --description, --link, --client, --accomplishment, or --edit).\n",
    );
    process.exit(1);
  }

  const tokenPath = handleConfigError("portfolio update", () => {
    const { config, path: configPath } = resolveConfigForCli();
    return resolveAuthTokenPath({ config, configPath });
  });
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "portfolio update failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.update(token, id, changes);
  } catch (err) {
    handlePortfolioError("portfolio update", err);
    return;
  }

  emitListResult(items, options.output, `Portfolio item ${id} updated.`);
}
