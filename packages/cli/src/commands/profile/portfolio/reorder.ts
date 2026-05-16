// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import { emitErrorAndExit } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { emitMutationResult, handlePortfolioError } from "./add.js";
import { loadAuthTokenOrExit } from "./shared.js";

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
    emitErrorAndExit({
      operation: "profile.portfolio.reorder",
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "supply exactly one of --before <id>, --after <id>, or --to <position>.",
        },
      ],
      prettySummary:
        "portfolio reorder failed (VALIDATION_ERROR): supply exactly one of --before <id>, --after <id>, or --to <position>.",
    });
  }
  if (modeCount > 1) {
    emitErrorAndExit({
      operation: "profile.portfolio.reorder",
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "--before, --after, and --to are mutually exclusive.",
        },
      ],
      prettySummary: "portfolio reorder failed (VALIDATION_ERROR): --before, --after, and --to are mutually exclusive.",
    });
  }
  const token = await loadAuthTokenOrExit("portfolio reorder", options.output);

  let position: number;
  if (options.to !== undefined) {
    const parsed = Number.parseInt(options.to, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      emitErrorAndExit({
        operation: "profile.portfolio.reorder",
        format: options.output,
        errors: [
          {
            code: "VALIDATION_ERROR",
            field: "to",
            message: "--to must be a non-negative integer position.",
          },
        ],
        prettySummary: "portfolio reorder failed (VALIDATION_ERROR): --to must be a non-negative integer position.",
      });
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
      handlePortfolioError("portfolio reorder", err, options.output);
      return;
    }
    if (options.before !== undefined) {
      // Pass `id` (the moving item) so the helper filters it out before
      // computing the target's index. Without it, the helper would
      // return a position that's one off in the common "A before B (A
      // is before B in the list)" case and the server would either
      // reject or move the item to the wrong slot. See service-layer
      // doc comment on `positionBefore` for the post-removal semantics.
      const result = profile.portfolio.positionBefore(current, options.before, id);
      if (result === null) {
        emitErrorAndExit({
          operation: "profile.portfolio.reorder",
          format: options.output,
          errors: [
            {
              code: "VALIDATION_ERROR",
              field: "before",
              message: `--before id '${options.before}' is not in the portfolio.`,
            },
          ],
          prettySummary: `portfolio reorder failed (VALIDATION_ERROR): --before id '${options.before}' is not in the portfolio.`,
        });
      }
      position = result;
    } else {
      const after = options.after as string;
      // See positionBefore comment above — `id` (moving item) is
      // filtered out before computing the target's index.
      const result = profile.portfolio.positionAfter(current, after, id);
      if (result === null) {
        emitErrorAndExit({
          operation: "profile.portfolio.reorder",
          format: options.output,
          errors: [
            {
              code: "VALIDATION_ERROR",
              field: "after",
              message: `--after id '${after}' is not in the portfolio.`,
            },
          ],
          prettySummary: `portfolio reorder failed (VALIDATION_ERROR): --after id '${after}' is not in the portfolio.`,
        });
      }
      position = result;
    }
  }

  let items: profile.portfolio.PortfolioItem[];
  try {
    items = await profile.portfolio.reorder(token, id, position);
  } catch (err) {
    handlePortfolioError("portfolio reorder", err, options.output);
    return;
  }

  emitMutationResult(items, options.output, "update", {
    prettyHeader: `Portfolio item ${id} moved to position ${position.toString()}.`,
  });
}
