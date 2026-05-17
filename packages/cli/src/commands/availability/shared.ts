// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { availability } from "@ttctl/core";

import { handleDomainError } from "../../lib/error-routing.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `availability.AvailabilityError` and {@link hintForAvailabilityCode}.
 * The router applies the envelope ABI (#128) branching uniformly across
 * sub-domains; the hint adapter is invoked on the domain-error branch
 * to surface a per-code recovery suggestion when one is available.
 */
export function handleAvailabilityError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, availability.AvailabilityError, format, hintForAvailabilityCode);
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
