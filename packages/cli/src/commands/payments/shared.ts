// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, payments } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";
import { emitErrorAndExit } from "../../lib/envelopes.js";
import type { EnvelopeError } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Route service errors through the envelope ABI (#128). Mirrors
 * `handleEngagementsError`:
 *
 * - `TtctlError` subclasses keep their dedicated 3-block pretty
 *   rendering on `pretty`; `json` / `yaml` flow through the envelope.
 * - `PaymentsError` codes always flow through the envelope.
 * - Anything else collapses into `INTERNAL_ERROR`.
 *
 * `commandLabel` is the user-visible prefix (e.g. `"payments rate
 * change"`); the envelope `operation` is derived by replacing spaces
 * with dots (`"payments.rate.change"`).
 */
export function handlePaymentsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
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
  if (err instanceof payments.PaymentsError) {
    const envelopeError: EnvelopeError = { code: err.code, message: err.message };
    const hint = hintForPaymentsCode(err.code);
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

function hintForPaymentsCode(code: payments.PaymentsErrorCode): string | undefined {
  switch (code) {
    case "NOT_FOUND":
      return "Verify the id (use `ttctl payments payouts list` / `ttctl payments methods list` to discover ids).";
    case "MISSING_INPUT":
      return "Inspect `--help` for the verb's required flags and re-run.";
    case "MUTATION_ERROR":
      return "The mutation was rejected by the server (often: rate below `minRate`, missing answers, ineligibility). Check the message above and try `ttctl payments rate questions` for the form catalog.";
    default:
      return undefined;
  }
}
