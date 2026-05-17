// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError } from "@ttctl/core";

import { exitCodeForTtctlError, presentTtctlError } from "../errors.js";
import { emitErrorAndExit } from "./envelopes.js";
import type { EnvelopeError } from "./envelopes.js";
import type { OutputFormat } from "./output.js";

/**
 * Structural shape every domain error class instance satisfies: a
 * machine-readable `code` token plus a human-readable `message`. All
 * `*Error` classes exported from `@ttctl/core/services` match this shape
 * (`ApplicationsError`, `AvailabilityError`, `ContractsError`,
 * `EngagementsError`, `JobsError`, `PaymentsError`, `TimesheetError`,
 * `profile.basic.ProfileError`, `profile.visas.VisasError`, …).
 */
export interface DomainErrorLike {
  code: string;
  message: string;
}

/**
 * Generic CLI error router (#330). Single source of truth for the
 * branching logic that was previously copied into nine structurally
 * identical handler functions across `packages/cli/src/commands/*\/shared.ts`
 * (one per sub-domain). Each domain re-exports a thin wrapper that
 * closes over its `DomainErrorClass` (and optionally a per-code hint
 * adapter) so the call sites in action handlers stay unchanged.
 *
 * Three branches in priority order:
 *
 * 1. `TtctlError` subclasses (`AuthRevokedError`, `Cf403Error`,
 *    `Cf403PersistentError`, `SchedulerBearerExpired`, …) keep their
 *    dedicated 3-block pretty rendering on `pretty` (Error / Recovery /
 *    Code) via {@link presentTtctlError}; `json` / `yaml` flow through
 *    the envelope so machine consumers see the stable wire shape. Exit
 *    code routes via {@link exitCodeForTtctlError} — Cloudflare-403
 *    codes exit `2`, everything else `1`.
 * 2. Domain errors (i.e. `instanceof DomainErrorClass`) flow through the
 *    envelope. When `hintForCode` is supplied and returns a string for
 *    the given code, the envelope entry carries a `hint:` field;
 *    otherwise the entry is just `{code, message}`.
 *    `exactOptionalPropertyTypes: true` — the entry is built additively
 *    so the omitted-vs-undefined distinction is preserved at the
 *    envelope boundary.
 * 3. Anything else (a plain `Error` thrown from helper code, or a
 *    non-Error throw) collapses into `INTERNAL_ERROR` so the user sees
 *    a structured envelope rather than the bare exception message.
 *
 * `commandLabel` is the user-visible prefix (e.g. `"applications show"`);
 * the envelope `operation` is derived by replacing spaces with dots
 * (`"applications.show"`).
 *
 * Returns `never` — every branch exits the process via `process.exit`.
 */
export function handleDomainError<E extends DomainErrorLike>(
  commandLabel: string,
  err: unknown,
  DomainErrorClass: new (...args: never[]) => E,
  format: OutputFormat = "pretty",
  hintForCode?: (code: E["code"]) => string | undefined,
): never {
  const operation = commandLabel.replace(/ /g, ".");
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    emitErrorAndExit({
      operation,
      format,
      errors: [{ code: err.code, message: err.message, hint: err.recovery }],
      exitCode: exitCodeForTtctlError(err),
    });
  }
  if (err instanceof DomainErrorClass) {
    const envelopeError: EnvelopeError = { code: err.code, message: err.message };
    const hint = hintForCode?.(err.code);
    if (hint !== undefined) envelopeError.hint = hint;
    emitErrorAndExit({
      operation,
      format,
      errors: [envelopeError],
      prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation,
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${commandLabel} failed: ${message}`,
  });
}
