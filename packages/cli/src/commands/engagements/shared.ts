// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { engagements } from "@ttctl/core";

import { handleDomainError } from "../../lib/error-routing.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `engagements.EngagementsError` and {@link hintForEngagementsCode}.
 * The router applies the envelope ABI (#128) branching uniformly across
 * sub-domains.
 */
export function handleEngagementsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, engagements.EngagementsError, format, hintForEngagementsCode);
}

/**
 * Per-code recovery hints. Not every code carries one — only the ones
 * where a concrete next step is clearly actionable for the user.
 */
function hintForEngagementsCode(code: engagements.EngagementsErrorCode): string | undefined {
  switch (code) {
    case "NOT_FOUND":
      return "Verify the engagement id (use `ttctl engagements list` to discover it).";
    case "NO_ENGAGEMENT":
      return "This activity item is not an engagement (likely an application or interview). Use `ttctl applications show` instead.";
    case "MUTATION_ERROR":
      return "The mutation was rejected by the server (often: overlapping break dates or validation). Check the message above.";
    default:
      return undefined;
  }
}
