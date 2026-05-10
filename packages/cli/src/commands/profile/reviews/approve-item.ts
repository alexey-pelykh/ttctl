// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile reviews approve-item";

/**
 * Action handler for `ttctl profile reviews approve-item`.
 *
 * The issue spec listed `approve-item <id>` as a single-positional
 * signature; the actual API requires three fields (`reviewId`, `itemId`,
 * `itemKind`), so this leaf uses named flags. Run `profile reviews list`
 * first to see all three values for each pending item. Emits the v0.4
 * update envelope (#128) — review approval is conceptually a state
 * transition, mapped to `update`.
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
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, options.output);

  let result: profile.reviews.ApproveItemReviewResult;
  try {
    result = await profile.reviews.approveItem(token, {
      reviewId: options.reviewId,
      itemId: options.itemId,
      itemKind: options.kind,
    });
  } catch (err) {
    handleError(err, options.output);
    return;
  }

  emitUpdateSuccess({
    operation: "profile.reviews.approve-item",
    format: options.output,
    updated: result,
    prettySummary: `item ${options.itemId} approved`,
    prettyEntity: formatApproveEntity,
    notice: result.notice ?? undefined,
  });
}

function handleError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.reviews.approve-item",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.reviews.ProfileError) {
    emitErrorAndExit({
      operation: "profile.reviews.approve-item",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${COMMAND_LABEL} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.reviews.approve-item",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${COMMAND_LABEL} failed: ${message}`,
  });
}

/**
 * Pretty entity preview for the approve envelope. Pure function —
 * directly unit-testable. Shared with `approve-section` since both
 * mutations return the same shape (the post-approval pending-reviews
 * list).
 */
export function formatApproveEntity(result: profile.reviews.ApproveItemReviewResult): string {
  return `pending-reviews remaining: ${result.sectionReviews.length.toString()}`;
}
