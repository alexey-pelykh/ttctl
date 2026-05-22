// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile reviews submit-for-review";

/**
 * Action handler for `ttctl profile reviews submit-for-review`.
 *
 * Re-submits the talent's profile for platform-side re-review (used after
 * profile edits that need re-verification). Emits the v0.4 update
 * envelope (#128) — re-submission is conceptually a state transition,
 * mapped to `update`.
 *
 * The underlying mutation's input shape is INFERRED — UNVERIFIED (see
 * the service module top-comment).
 *
 * **Consent gate** (ADR-009 (ttctl) — `profile-capability` domain): the
 * caller MUST pass `--consent-profile-capability` (or set
 * `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` in the environment for
 * non-interactive contexts). Absence raises
 * `ConsentRequiredError("CONSENT_REQUIRED")` (a `TtctlError`) which the
 * shared handler emits as exit-code 1 with the recovery hint.
 */
export async function runProfileReviewsSubmitForReview(options: {
  consentProfileCapability: boolean;
  output: OutputFormat;
}): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, options.output);

  let result: profile.reviews.SubmitForReviewResult;
  try {
    // Static type only allows `true` literal; the runtime gate at the
    // service entry covers the `false` case (operator omits the flag).
    // The cast widens the static type so the literal `false` path is
    // visible to the type checker.
    const consent = {
      profileCapabilityConsentIssued: options.consentProfileCapability,
    } as unknown as { profileCapabilityConsentIssued: true };
    result = await profile.reviews.submitForReview(token, consent);
  } catch (err) {
    handleError(err, options.output);
    return;
  }

  emitUpdateSuccess({
    operation: "profile.reviews.submit-for-review",
    format: options.output,
    updated: result,
    prettySummary: "Profile submitted for review.",
    notice: result.notice ?? undefined,
  });
}

function handleError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.reviews.submit-for-review",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.reviews.ProfileError) {
    emitErrorAndExit({
      operation: "profile.reviews.submit-for-review",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${COMMAND_LABEL} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.reviews.submit-for-review",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${COMMAND_LABEL} failed: ${message}`,
  });
}
