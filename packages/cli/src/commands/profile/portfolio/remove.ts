// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { emitListResult, handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio remove <id>` (alias `rm`).
 * Removes the portfolio item by id. Returns the post-removal list to
 * give the user immediate visual confirmation.
 */
export async function runProfilePortfolioRemove(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("portfolio remove");

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.remove(token, id);
  } catch (err) {
    handlePortfolioError("portfolio remove", err);
    return;
  }

  emitListResult(items, format, `Portfolio item ${id} removed.`);
}
