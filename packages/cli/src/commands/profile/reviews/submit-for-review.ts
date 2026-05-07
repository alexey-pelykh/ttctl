// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, resolveAuthTokenPathOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile reviews submit-for-review";

/**
 * Action handler for `ttctl profile reviews submit-for-review`.
 *
 * Re-submits the talent's profile for platform-side re-review (used after
 * profile edits that need re-verification). The underlying mutation's input
 * shape is INFERRED — UNVERIFIED (see the service module top-comment).
 */
export async function runProfileReviewsSubmitForReview(options: { output: OutputFormat }): Promise<void> {
  const tokenPath = resolveAuthTokenPathOrExit(COMMAND_LABEL);
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, tokenPath);

  let result: profile.reviews.SubmitForReviewResult;
  try {
    result = await profile.reviews.submitForReview(token);
  } catch (err) {
    handleError(err);
    return;
  }

  process.stdout.write(`${formatSubmitResult(result, options.output)}\n`);
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

/** Pure formatter — directly unit-testable. */
export function formatSubmitResult(result: profile.reviews.SubmitForReviewResult, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (format === "table") {
    const rows: [string, string][] = [["status", "submitted"]];
    if (result.notice !== null) rows.push(["notice", result.notice]);
    return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
  }
  // text
  const lines: string[] = ["Profile submitted for review."];
  if (result.notice !== null) lines.push(`  ${result.notice}`);
  return lines.join("\n");
}
