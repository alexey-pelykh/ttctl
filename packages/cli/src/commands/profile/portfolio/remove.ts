// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { emitMutationResult, handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio remove <id>` (alias `rm`).
 * Removes the portfolio item by id; emits the v0.4 envelope (#128) with
 * `removed: {id}` and renders the post-removal list under the success
 * line in pretty mode.
 */
export async function runProfilePortfolioRemove(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("portfolio remove", format);

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.remove(token, id);
  } catch (err) {
    handlePortfolioError("portfolio remove", err, format);
    return;
  }

  emitMutationResult(items, format, "remove", { id, prettyHeader: id });
}
