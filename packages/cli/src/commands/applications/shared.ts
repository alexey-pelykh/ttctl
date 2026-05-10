// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, applications } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";
import { emitErrorAndExit } from "../../lib/envelopes.js";
import type { EnvelopeError } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";

export { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Route service errors through the envelope ABI (#128). Mirrors
 * `handleVisasError` and the other sub-domain handlers in
 * `packages/cli/src/commands/profile/*\/shared.ts`:
 *
 * - `TtctlError` subclasses keep their dedicated 3-block pretty
 *   rendering on `pretty` (Recovery / Code / message); `json` / `yaml`
 *   flow through the envelope so machine consumers see the stable wire
 *   shape.
 * - `ApplicationsError` codes (NO_VIEWER, NOT_FOUND, GRAPHQL_ERROR,
 *   NETWORK_ERROR, UNKNOWN) always flow through the envelope.
 * - Anything else (an `Error` thrown from helper code) collapses into
 *   `INTERNAL_ERROR` so the user sees a structured envelope rather
 *   than the bare exception message.
 *
 * `commandLabel` is the user-visible prefix (e.g.
 * `"applications show"`); the envelope `operation` is derived by
 * replacing spaces with dots (`"applications.show"`).
 */
export function handleApplicationsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
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
  if (err instanceof applications.ApplicationsError) {
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors: [{ code: err.code, message: err.message }],
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
