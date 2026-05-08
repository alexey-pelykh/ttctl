// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile external advanced-wizard show";

/**
 * Action handler for `ttctl profile external advanced-wizard show`.
 *
 * Combines `getAdvancedProfileData` and the wizard-status read into one
 * leaf — `getAdvancedProfileData` already exposes
 * `advancedProfileWizardStatus`, so a single query suffices.
 */
export async function runProfileExternalAdvancedWizardShow(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL);

  let result: profile.external.AdvancedProfileSnapshot;
  try {
    result = await profile.external.advancedWizardShow(token);
  } catch (err) {
    handleError(err);
    return;
  }

  emitResult(result, format, {
    text: formatAdvancedWizardText,
    table: formatAdvancedWizardTable,
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

/** Pure formatter — directly unit-testable. */
export function formatAdvancedWizardText(data: profile.external.AdvancedProfileSnapshot): string {
  const lines: string[] = [
    `Advanced profile wizard status: ${data.wizardStatus ?? "(unset)"}`,
    `  travel-visa-count: ${data.travelVisaCount.toString()}`,
  ];
  if (data.travelVisaIds.length > 0) {
    const preview = data.travelVisaIds.slice(0, 5).join(", ");
    const more = data.travelVisaIds.length > 5 ? ` (+${(data.travelVisaIds.length - 5).toString()} more)` : "";
    lines.push(`  travel-visa-ids:   ${preview}${more}`);
  }
  return lines.join("\n");
}

/** Pure formatter — directly unit-testable. */
export function formatAdvancedWizardTable(data: profile.external.AdvancedProfileSnapshot): string {
  const rows: [string, string][] = [
    ["wizard-status", data.wizardStatus ?? ""],
    ["travel-visa-count", data.travelVisaCount.toString()],
    ["travel-visa-ids", data.travelVisaIds.join(",")],
  ];
  return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
}
