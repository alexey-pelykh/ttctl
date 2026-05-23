// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { getCliDryRun } from "../../../lib/dry-run.js";
import { emitDryRunSuccess, emitErrorAndExit, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";

const COMMAND_LABEL = "profile specializations apply";
const OPERATION = "profile.specializations.apply";

/**
 * Options for `ttctl profile specializations apply <specializationId>` (#467).
 *
 * `--consent-profile-capability` is the user-side consent ceremony per
 * ADR-009 (ttctl) § Decision Part 1 — absence raises
 * `ConsentRequiredError("CONSENT_REQUIRED")` at the service layer
 * (defense-in-depth: the CLI threads the value through verbatim; the
 * service is the authoritative gate).
 */
export interface ProfileSpecializationsApplyOptions {
  /**
   * REQUIRED — your explicit acknowledgement that applying to a
   * specialization is destructive (commits the maintainer to a Toptal
   * review track; no withdraw via TTCtl). Auto-filling is forbidden
   * per ADR-009 (ttctl) § Decision Part 1.
   */
  consentProfileCapability?: boolean;
  output: OutputFormat;
}

/**
 * Action handler for `ttctl profile specializations apply <specializationId>` (#467).
 *
 * Wraps `profile.specializations.apply()` — the DESTRUCTIVE
 * `ApplyForSpecialization` mutation against the mobile-gateway portal
 * surface. The handler threads the global `--dry-run` flag (issue #52)
 * through to the core service's `dryRun` option so the wire payload
 * can be previewed without issuing the mutation.
 *
 * **Consent gate** (ADR-009 (ttctl) — `profile-capability` domain):
 * the caller MUST pass `--consent-profile-capability` (or set
 * `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` in the environment for
 * non-interactive contexts). Absence raises
 * `ConsentRequiredError("CONSENT_REQUIRED")` (a `TtctlError`) which
 * the shared handler emits as exit-code 1 with the recovery hint.
 *
 * **DESTRUCTIVE — no undo via TTCtl**: no withdraw mutation on the
 * wire. Once the application is submitted, the specialization track's
 * compliance / training workflow takes over. The
 * `--dry-run` short-circuit (#52) is the safe-preview path.
 */
export async function runProfileSpecializationsApply(
  specializationId: string,
  options: ProfileSpecializationsApplyOptions,
): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, options.output);
  const dryRun = getCliDryRun();

  let outcome: profile.specializations.SpecializationApplyOutcome;
  try {
    // Static type only allows `true` literal; the runtime gate at the
    // service entry covers the `false` case (operator omits the flag).
    // The cast widens the static type so the literal `false` path is
    // visible to the type checker.
    const consent = {
      profileCapabilityConsentIssued: options.consentProfileCapability ?? false,
    } as unknown as profile.specializations.SpecializationApplyConsent;
    outcome = await profile.specializations.apply(token, specializationId, consent, { dryRun });
  } catch (err) {
    handleError(err, options.output);
    return;
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: OPERATION,
      format: options.output,
      preview: outcome.preview,
    });
    return;
  }

  emitUpdateSuccess({
    operation: OPERATION,
    format: options.output,
    updated: outcome.result,
    prettySummary: `Applied to specialization ${outcome.result.specializationId}.`,
    notice: outcome.result.notice ?? undefined,
  });
}

function handleError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: OPERATION,
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.specializations.ProfileError) {
    emitErrorAndExit({
      operation: OPERATION,
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${COMMAND_LABEL} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: OPERATION,
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${COMMAND_LABEL} failed: ${message}`,
  });
}
