// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile external custom-requirements show";
const OPERATION = "profile.external.custom-requirements.show";

/**
 * Action handler for `ttctl profile external custom-requirements show`.
 *
 * Prints the three onboarding-readiness toggles (background-check,
 * drug-test, time-tracking-tools). The boolean trio is intentionally
 * NOT free-text despite the issue's language — see the module top-comment
 * in `core/services/profile/external/index.ts` for the spec/API reconciliation.
 */
export async function runProfileExternalCustomRequirementsShow(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, format);

  let result: profile.external.CustomRequirements;
  try {
    result = await profile.external.customRequirementsShow(token);
  } catch (err) {
    handleError(err, format);
    return;
  }

  emitResult(result, format, {
    pretty: formatCustomRequirementsText,
    table: formatCustomRequirementsTable,
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

/** Pure formatter — directly unit-testable. */
export function formatCustomRequirementsText(data: profile.external.CustomRequirements): string {
  return [
    "Custom requirements:",
    `  background-check:    ${renderBoolean(data.backgroundCheck)}`,
    `  drug-test:           ${renderBoolean(data.drugTest)}`,
    `  time-tracking-tools: ${renderBoolean(data.timeTrackingTools)}`,
  ].join("\n");
}

/** Pure formatter — directly unit-testable. */
export function formatCustomRequirementsTable(data: profile.external.CustomRequirements): string {
  const rows: [string, string][] = [
    ["background-check", renderBoolean(data.backgroundCheck)],
    ["drug-test", renderBoolean(data.drugTest)],
    ["time-tracking-tools", renderBoolean(data.timeTrackingTools)],
  ];
  return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
}
