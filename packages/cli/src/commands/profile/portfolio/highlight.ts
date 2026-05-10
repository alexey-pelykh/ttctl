// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import { emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio highlight <id>`. Sets the
 * `highlight` flag on the named item. Pass `--off` to clear instead of
 * set. Emits the v0.4 update envelope (#128).
 */
export async function runProfilePortfolioHighlight(
  id: string,
  options: { off?: boolean; output: OutputFormat },
): Promise<void> {
  const flag = !(options.off ?? false);
  const token = await loadAuthTokenOrExit("portfolio highlight", options.output);

  let result: { id: string; highlight: boolean };
  try {
    result = await profile.portfolio.highlight(token, id, flag);
  } catch (err) {
    handlePortfolioError("portfolio highlight", err, options.output);
    return;
  }

  emitUpdateSuccess({
    operation: "profile.portfolio.highlight",
    format: options.output,
    updated: result,
    prettySummary: `${result.id} highlight ${result.highlight ? "enabled" : "cleared"}`,
    prettyEntity: (entity: { id: string; highlight: boolean }) => `highlight: ${entity.highlight.toString()}`,
  });
}
