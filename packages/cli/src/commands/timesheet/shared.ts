// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, timesheet } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";
import { emitErrorAndExit } from "../../lib/envelopes.js";
import type { EnvelopeError } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Route timesheet service errors through the envelope ABI (#128).
 * Mirrors `handleEngagementsError`:
 *
 * - `TtctlError` subclasses keep their dedicated 3-block pretty
 *   rendering on `pretty`; `json` / `yaml` flow through the envelope.
 * - `TimesheetError` codes always flow through the envelope.
 * - Anything else collapses into `INTERNAL_ERROR`.
 *
 * `commandLabel` is the user-visible prefix (e.g. `"timesheet show"`);
 * the envelope `operation` is derived by replacing spaces with dots
 * (`"timesheet.show"`).
 */
export function handleTimesheetError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
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
  if (err instanceof timesheet.TimesheetError) {
    const envelopeError: EnvelopeError = { code: err.code, message: err.message };
    const hint = hintForTimesheetCode(err.code);
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
 * Per-code recovery hints. Only codes with a clearly actionable next
 * step carry one.
 */
function hintForTimesheetCode(code: timesheet.TimesheetErrorCode): string | undefined {
  switch (code) {
    case "NOT_FOUND":
      return "Verify the id (use `ttctl timesheet list` to discover billing-cycle ids).";
    case "NO_ENGAGEMENT":
      return "The activity item exists but isn't an engagement — only engagement-bearing rows have timesheets.";
    case "NO_CURRENT_CYCLE":
      return "No billing cycle is currently in its submission window. Run `ttctl timesheet list` to see what's pending.";
    case "MULTIPLE_CURRENT_CYCLES":
      return "Multiple cycles are simultaneously in their submission window — specify the cycle id explicitly: `ttctl timesheet submit <id> --confirm`.";
    case "MUTATION_ERROR":
      return "The server rejected the submission (often: missing required hours, deadline passed, or already submitted). Inspect the message above and fix in the web UI.";
    default:
      return undefined;
  }
}
