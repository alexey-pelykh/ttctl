// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { loadAuthToken, profile, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { handlePortfolioError } from "./add.js";
import { handleConfigError } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio highlight <id>`. Sets the
 * `highlight` flag on the named item. Pass `--off` to clear instead of
 * set.
 */
export async function runProfilePortfolioHighlight(
  id: string,
  options: { off?: boolean; output: OutputFormat },
): Promise<void> {
  const flag = !(options.off ?? false);
  const tokenPath = handleConfigError("portfolio highlight", () => {
    const { config, path: configPath } = resolveConfig();
    return resolveAuthTokenPath({ config, configPath });
  });
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "portfolio highlight failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  let result: { id: string; highlight: boolean };
  try {
    result = await profile.portfolio.highlight(token, id, flag);
  } catch (err) {
    handlePortfolioError("portfolio highlight", err);
    return;
  }

  if (options.output === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (options.output === "table") {
    process.stdout.write(`id\thighlight\n${result.id}\t${result.highlight ? "true" : "false"}\n`);
    return;
  }
  process.stdout.write(`Portfolio item ${result.id} highlight ${result.highlight ? "enabled" : "cleared"}.\n`);
}
