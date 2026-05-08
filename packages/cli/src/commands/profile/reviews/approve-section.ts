// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import type { OutputFormat } from "../../../lib/output.js";
import { formatApproveResult } from "./approve-item.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile reviews approve-section";

/**
 * Action handler for `ttctl profile reviews approve-section`.
 *
 * Approves all pending items within a section review. Same destructive
 * semantics as `approve-item` — see that file's comment for the rationale
 * on named flags vs. the issue's single-positional shorthand.
 */
export async function runProfileReviewsApproveSection(options: {
  reviewId: string;
  section: string;
  output: OutputFormat;
}): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL);

  let result: profile.reviews.ApproveSectionReviewResult;
  try {
    result = await profile.reviews.approveSection(token, {
      reviewId: options.reviewId,
      section: options.section,
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
