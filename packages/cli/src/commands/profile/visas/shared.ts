// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import { handleDomainError } from "../../../lib/error-routing.js";
import type { OutputFormat } from "../../../lib/output.js";

export { loadAuthTokenOrExit } from "../shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `profile.visas.VisasError`. The router applies the envelope ABI
 * (#128) branching uniformly across sub-domains. No per-code hint
 * adapter — `VisasError` codes do not carry actionable next-step hints
 * today.
 */
export function handleVisasError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, profile.visas.VisasError, format);
}
