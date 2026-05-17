// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { payments } from "@ttctl/core";

import { handleDomainError } from "../../lib/error-routing.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `payments.PaymentsError` and {@link hintForPaymentsCode}. The router
 * applies the envelope ABI (#128) branching uniformly across
 * sub-domains.
 */
export function handlePaymentsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, payments.PaymentsError, format, hintForPaymentsCode);
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
