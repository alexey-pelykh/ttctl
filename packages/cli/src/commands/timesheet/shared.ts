// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { timesheet } from "@ttctl/core";

import { handleDomainError } from "../../lib/error-routing.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `timesheet.TimesheetError` and {@link hintForTimesheetCode}. The
 * router applies the envelope ABI (#128) branching uniformly across
 * sub-domains.
 */
export function handleTimesheetError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, timesheet.TimesheetError, format, hintForTimesheetCode);
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
