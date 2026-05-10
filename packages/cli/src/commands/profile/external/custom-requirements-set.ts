// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, parseBooleanFlag } from "./_shared.js";

const COMMAND_LABEL = "profile external custom-requirements set";
const OPERATION = "profile.external.custom-requirements.set";

/**
 * Action handler for `ttctl profile external custom-requirements set`.
 *
 * The issue spec described this as multi-paragraph free-text consuming the
 * #70 helper. Empirically (per
 * `research/captures/web/inputs/UpdateCustomRequirementsInput.json`) the
 * underlying `CustomRequirementsInput` is in fact three booleans
 * (`backgroundCheck`, `drugTest`, `timeTrackingTools`), no free-text field
 * exists on the schema. We follow API ground truth: the leaf takes
 * `--background-check / --drug-test / --time-tracking-tools <true|false>`.
 *
 * Caller-omitted booleans default to the current server state (the
 * underlying mutation has no PATCH semantics — every call resubmits ALL
 * three booleans, so the service module pre-fetches and merges).
 */
export async function runProfileExternalCustomRequirementsSet(options: {
  backgroundCheck?: string;
  drugTest?: string;
  timeTrackingTools?: string;
  output: OutputFormat;
}): Promise<void> {
  const changes: profile.external.CustomRequirementsUpdate = {};
  if (options.backgroundCheck !== undefined) {
    changes.backgroundCheck = parseBooleanFlag(
      COMMAND_LABEL,
      OPERATION,
      "background-check",
      options.backgroundCheck,
      options.output,
    );
  }
  if (options.drugTest !== undefined) {
    changes.drugTest = parseBooleanFlag(COMMAND_LABEL, OPERATION, "drug-test", options.drugTest, options.output);
  }
  if (options.timeTrackingTools !== undefined) {
    changes.timeTrackingTools = parseBooleanFlag(
      COMMAND_LABEL,
      OPERATION,
      "time-tracking-tools",
      options.timeTrackingTools,
      options.output,
    );
  }
  if (Object.keys(changes).length === 0) {
    emitErrorAndExit({
      operation: OPERATION,
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: `${COMMAND_LABEL} requires at least one of --background-check, --drug-test, --time-tracking-tools.`,
          hint: "ttctl profile external custom-requirements set --background-check true",
        },
      ],
      prettySummary:
        `${COMMAND_LABEL} requires at least one of --background-check, --drug-test, --time-tracking-tools.\n` +
        "Example: ttctl profile external custom-requirements set --background-check true",
    });
  }

  const token = await loadAuthTokenOrExit(COMMAND_LABEL, options.output);

  let result: profile.external.CustomRequirementsSetResult;
  try {
    result = await profile.external.customRequirementsSet(token, changes);
  } catch (err) {
    handleError(err, options.output);
    return;
  }

  emitUpdateSuccess({
    operation: OPERATION,
    format: options.output,
    updated: result,
    prettySummary: "Custom requirements updated.",
    prettyEntity: formatSetPrettyEntity,
    notice: result.notice ?? undefined,
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
  if (err instanceof profile.external.ProfileError) {
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

function renderBoolean(value: boolean | null): string {
  if (value === null) return "(unset)";
  return value ? "yes" : "no";
}

/**
 * Pretty entity preview for the custom-requirements-set envelope. Renders
 * the post-update boolean trio. The notice (when present) flows through
 * the envelope's `notice` field, NOT this body.
 *
 * Pure — directly unit-testable.
 */
export function formatSetPrettyEntity(result: profile.external.CustomRequirementsSetResult): string {
  const cr = result.profile.customRequirements;
  return [
    `background-check:    ${renderBoolean(cr.backgroundCheck)}`,
    `drug-test:           ${renderBoolean(cr.drugTest)}`,
    `time-tracking-tools: ${renderBoolean(cr.timeTrackingTools)}`,
  ].join("\n");
}
