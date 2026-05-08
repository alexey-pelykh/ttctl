// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

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
  const token = await loadAuthTokenOrExit("portfolio highlight");

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
