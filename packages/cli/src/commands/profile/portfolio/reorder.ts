// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { loadAuthToken, profile, resolveAuthTokenPath } from "@ttctl/core";

import { resolveConfigForCli } from "../../../lib/config-context.js";
import type { OutputFormat } from "../../../lib/output.js";
import { emitListResult, handlePortfolioError } from "./add.js";
import { handleConfigError } from "./shared.js";

/**
 * Action handler for `ttctl profile portfolio reorder <id>`. The user
 * supplies exactly one of `--before <id>` / `--after <id>` / `--to <pos>`;
 * the helper translates `--before`/`--after` to an absolute position by
 * fetching the current list, then issues `changePortfolioItemPosition`.
 *
 * Mutually-exclusive enforcement is at the CLI layer — the service-side
 * `reorder()` only accepts an absolute integer position.
 */
export async function runProfilePortfolioReorder(
  id: string,
  options: { before?: string; after?: string; to?: string; output: OutputFormat },
): Promise<void> {
  const modes = [options.before !== undefined, options.after !== undefined, options.to !== undefined];
  const modeCount = modes.filter(Boolean).length;
  if (modeCount === 0) {
    process.stderr.write(
      "portfolio reorder failed (VALIDATION_ERROR): supply exactly one of --before <id>, --after <id>, or --to <position>.\n",
    );
    process.exit(1);
  }
  if (modeCount > 1) {
    process.stderr.write(
      "portfolio reorder failed (VALIDATION_ERROR): --before, --after, and --to are mutually exclusive.\n",
    );
    process.exit(1);
  }

  const tokenPath = handleConfigError("portfolio reorder", () => {
    const { config, path: configPath } = resolveConfigForCli();
    return resolveAuthTokenPath({ config, configPath });
  });
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "portfolio reorder failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  let position: number;
  if (options.to !== undefined) {
    const parsed = Number.parseInt(options.to, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      process.stderr.write(
        "portfolio reorder failed (VALIDATION_ERROR): --to must be a non-negative integer position.\n",
      );
      process.exit(1);
    }
    position = parsed;
  } else {
    // Need the current list to translate neighbour-anchored flags into
    // an absolute index. The read is a separate round-trip; the cost
    // is acceptable because reorder is a low-frequency operation.
    let current: profile.portfolio.PortfolioItem[];
    try {
      current = await profile.portfolio.list(token);
    } catch (err) {
      handlePortfolioError("portfolio reorder", err);
      return;
    }
    if (options.before !== undefined) {
      const result = profile.portfolio.positionBefore(current, options.before);
      if (result === null) {
        process.stderr.write(
          `portfolio reorder failed (VALIDATION_ERROR): --before id '${options.before}' is not in the portfolio.\n`,
        );
        process.exit(1);
      }
      position = result;
    } else {
      const after = options.after as string;
      const result = profile.portfolio.positionAfter(current, after);
      if (result === null) {
        process.stderr.write(
          `portfolio reorder failed (VALIDATION_ERROR): --after id '${after}' is not in the portfolio.\n`,
        );
        process.exit(1);
      }
      position = result;
    }
  }

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.reorder(token, id, position);
  } catch (err) {
    handlePortfolioError("portfolio reorder", err);
    return;
  }

  emitListResult(items, options.output, `Portfolio item ${id} moved to position ${position.toString()}.`);
}
