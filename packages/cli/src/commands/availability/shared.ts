// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, availability } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";
import { emitErrorAndExit } from "../../lib/envelopes.js";
import type { EnvelopeError } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Route service errors through the envelope ABI (#128). Mirrors
 * `handleEngagementsError` and the other sub-domain handlers:
 *
 * - `TtctlError` subclasses keep their dedicated 3-block pretty
 *   rendering on `pretty`; `json` / `yaml` flow through the envelope.
 * - `AvailabilityError` codes always flow through the envelope.
 * - Anything else collapses into `INTERNAL_ERROR`.
 *
 * `commandLabel` is the user-visible prefix (e.g.
 * `"availability show"`); the envelope `operation` is derived by
 * replacing spaces with dots (`"availability.show"`).
 */
export function handleAvailabilityError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof availability.AvailabilityError) {
    const envelopeError: EnvelopeError = { code: err.code, message: err.message };
    const hint = hintForAvailabilityCode(err.code);
    if (hint !== undefined) envelopeError.hint = hint;
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors: [envelopeError],
      prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: commandLabel.replace(/ /g, "."),
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${commandLabel} failed: ${message}`,
  });
}

/**
 * Per-code recovery hints. Not every code carries one — only the ones
 * where a concrete next step is clearly actionable for the user.
 */
function hintForAvailabilityCode(code: availability.AvailabilityErrorCode): string | undefined {
  switch (code) {
    case "NO_VIEWER_ROLE":
      return "Sign in as a Toptal Talent (the availability surface is talent-side).";
    case "MUTATION_ERROR":
      return "The mutation was rejected by the server (often: malformed time string, unknown time-zone identifier, or out-of-range allocated hours). Check the message above.";
    default:
      return undefined;
  }
}
