// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { handleDomainError } from "../../lib/error-routing.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Thin wrapper around the shared CLI error router (#330) closed over
 * `applications.ApplicationsError`. The router applies the envelope ABI
 * (#128) branching uniformly across sub-domains.
 *
 * `commandLabel` is the user-visible prefix (e.g. `"applications show"`);
 * the envelope `operation` is derived by replacing spaces with dots
 * (`"applications.show"`). No per-code hint adapter — `ApplicationsError`
 * codes do not carry actionable next-step hints today.
 */
export function handleApplicationsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, applications.ApplicationsError, format);
}
