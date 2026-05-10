// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { formatApproveEntity } from "./approve-item.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile reviews approve-section";

/**
 * Action handler for `ttctl profile reviews approve-section`.
 *
 * Approves all pending items within a section review. Same destructive
 * semantics as `approve-item` — see that file's comment for the rationale
 * on named flags vs. the issue's single-positional shorthand. Emits the
 * v0.4 update envelope (#128).
 */
export async function runProfileReviewsApproveSection(options: {
  reviewId: string;
  section: string;
  output: OutputFormat;
}): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, options.output);

  let result: profile.reviews.ApproveSectionReviewResult;
  try {
    result = await profile.reviews.approveSection(token, {
      reviewId: options.reviewId,
      section: options.section,
    });
  } catch (err) {
    handleError(err, options.output);
    return;
  }

  emitUpdateSuccess({
    operation: "profile.reviews.approve-section",
    format: options.output,
    updated: result,
    prettySummary: `section ${options.section} approved`,
    prettyEntity: formatApproveEntity,
    notice: result.notice ?? undefined,
  });
}

function handleError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.reviews.approve-section",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.reviews.ProfileError) {
    emitErrorAndExit({
      operation: "profile.reviews.approve-section",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${COMMAND_LABEL} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.reviews.approve-section",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${COMMAND_LABEL} failed: ${message}`,
  });
}
