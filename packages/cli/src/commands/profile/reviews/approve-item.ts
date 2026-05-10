// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { formatYaml } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile reviews approve-item";

/**
 * Action handler for `ttctl profile reviews approve-item`.
 *
 * The issue spec listed `approve-item <id>` as a single-positional
 * signature; the actual API requires three fields (`reviewId`, `itemId`,
 * `itemKind`), so this leaf uses named flags. Run `profile reviews list`
 * first to see all three values for each pending item.
 *
 * **Destructive**: approval is final per the platform's review semantics.
 * No `--dry-run` at v0; the dry-run feature lands separately (see
 * issue #52).
 */
export async function runProfileReviewsApproveItem(options: {
  reviewId: string;
  itemId: string;
  kind: string;
  output: OutputFormat;
}): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL);

  let result: profile.reviews.ApproveItemReviewResult;
  try {
    result = await profile.reviews.approveItem(token, {
      reviewId: options.reviewId,
      itemId: options.itemId,
      itemKind: options.kind,
    });
  } catch (err) {
    handleError(err);
    return;
  }

  process.stdout.write(`${formatApproveResult(result, options.output)}\n`);
}

function handleError(err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.reviews.ProfileError) {
    process.stderr.write(`${COMMAND_LABEL} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${COMMAND_LABEL} failed: ${message}\n`);
  process.exit(1);
}

/**
 * Format the approve result. Pure function — directly unit-testable.
 * Shared with `approve-section` since both mutations return the same
 * shape (the post-approval pending-reviews list).
 */
export function formatApproveResult(result: profile.reviews.ApproveItemReviewResult, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (format === "yaml") {
    return formatYaml(result);
  }
  // pretty — show-shape command, curated confirmation + summary line
  const lines: string[] = ["Item approved."];
  lines.push(`  pending-reviews remaining: ${result.sectionReviews.length.toString()}`);
  if (result.notice !== null) lines.push(`  ${result.notice}`);
  return lines.join("\n");
}
