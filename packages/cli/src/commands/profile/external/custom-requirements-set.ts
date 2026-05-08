// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, parseBooleanFlag } from "./_shared.js";

const COMMAND_LABEL = "profile external custom-requirements set";

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
    changes.backgroundCheck = parseBooleanFlag(COMMAND_LABEL, "background-check", options.backgroundCheck);
  }
  if (options.drugTest !== undefined) {
    changes.drugTest = parseBooleanFlag(COMMAND_LABEL, "drug-test", options.drugTest);
  }
  if (options.timeTrackingTools !== undefined) {
    changes.timeTrackingTools = parseBooleanFlag(COMMAND_LABEL, "time-tracking-tools", options.timeTrackingTools);
  }
  if (Object.keys(changes).length === 0) {
    process.stderr.write(
      `${COMMAND_LABEL} requires at least one of --background-check, --drug-test, --time-tracking-tools.\n` +
        `Example: ttctl profile external custom-requirements set --background-check true\n`,
    );
    process.exit(1);
  }

  const token = await loadAuthTokenOrExit(COMMAND_LABEL);

  let result: profile.external.CustomRequirementsSetResult;
  try {
    result = await profile.external.customRequirementsSet(token, changes);
  } catch (err) {
    handleError(err);
    return;
  }

  process.stdout.write(`${formatSetResult(result, options.output)}\n`);
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
export function formatSetResult(result: profile.external.CustomRequirementsSetResult, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const cr = result.profile.customRequirements;
  if (format === "table") {
    const rows: [string, string][] = [
      ["status", "updated"],
      ["background-check", renderBoolean(cr.backgroundCheck)],
      ["drug-test", renderBoolean(cr.drugTest)],
      ["time-tracking-tools", renderBoolean(cr.timeTrackingTools)],
    ];
    if (result.notice !== null) rows.push(["notice", result.notice]);
    return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
  }
  // text
  const lines: string[] = ["Custom requirements updated."];
  lines.push(`  background-check:    ${renderBoolean(cr.backgroundCheck)}`);
  lines.push(`  drug-test:           ${renderBoolean(cr.drugTest)}`);
  lines.push(`  time-tracking-tools: ${renderBoolean(cr.timeTrackingTools)}`);
  if (result.notice !== null) lines.push(`  ${result.notice}`);
  return lines.join("\n");
}
