// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile external custom-requirements show";

/**
 * Action handler for `ttctl profile external custom-requirements show`.
 *
 * Prints the three onboarding-readiness toggles (background-check,
 * drug-test, time-tracking-tools). The boolean trio is intentionally
 * NOT free-text despite the issue's language — see the module top-comment
 * in `core/services/profile/external/index.ts` for the spec/API reconciliation.
 */
export async function runProfileExternalCustomRequirementsShow(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL);

  let result: profile.external.CustomRequirements;
  try {
    result = await profile.external.customRequirementsShow(token);
  } catch (err) {
    handleError(err);
    return;
  }

  emitResult(result, format, {
    text: formatCustomRequirementsText,
    table: formatCustomRequirementsTable,
  });
}

function handleError(err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.external.ProfileError) {
    process.stderr.write(`${COMMAND_LABEL} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${COMMAND_LABEL} failed: ${message}\n`);
  process.exit(1);
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
