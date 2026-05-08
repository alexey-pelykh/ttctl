// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile external readiness";

/**
 * Action handler for `ttctl profile external readiness`.
 *
 * Surfaces the per-section profile-readiness booleans plus the rolled-up
 * `submit-available` flag. The user reads this to know which sections still
 * need work before they can click "Submit profile for review".
 */
export async function runProfileExternalReadiness(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL);

  let result: profile.external.ProfileReadiness;
  try {
    result = await profile.external.readiness(token);
  } catch (err) {
    handleError(err);
    return;
  }

  emitResult(result, format, {
    text: formatReadinessText,
    table: formatReadinessTable,
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

function renderReadinessBoolean(value: boolean | null): string {
  if (value === null) return "(unset)";
  return value ? "✓" : "✗";
}

const READINESS_FIELDS: { key: keyof profile.external.ProfileReadiness; label: string }[] = [
  { key: "isPhotoResolutionSatisfied", label: "photo-resolution" },
  { key: "isBasicInfoSatisfied", label: "basic-info" },
  { key: "isCertificationsSatisfied", label: "certifications" },
  { key: "isEmploymentsCountSatisfied", label: "employments-count" },
  { key: "isEmploymentConnectionsSatisfied", label: "employment-connections" },
  { key: "isSkillValidationsSatisfied", label: "skill-validations" },
  { key: "isPortfolioItemsCountSatisfied", label: "portfolio-items-count" },
  { key: "isPortfolioItemConnectionsSatisfied", label: "portfolio-item-connections" },
  { key: "isWorkingHoursSatisfied", label: "working-hours" },
];

/** Pure formatter — directly unit-testable. */
export function formatReadinessText(data: profile.external.ProfileReadiness): string {
  const lines: string[] = [`Profile readiness — submit-available: ${renderReadinessBoolean(data.submitAvailable)}`];
  for (const { key, label } of READINESS_FIELDS) {
    const v = data[key];
    if (typeof v === "boolean" || v === null) {
      lines.push(`  ${label.padEnd(28)} ${renderReadinessBoolean(v)}`);
    }
  }
  if (data.updatedByTalentAt !== null) {
    lines.push(`  ${"updated-by-talent-at".padEnd(28)} ${data.updatedByTalentAt}`);
  }
  return lines.join("\n");
}

/** Pure formatter — directly unit-testable. */
export function formatReadinessTable(data: profile.external.ProfileReadiness): string {
  const rows: [string, string][] = [["submit-available", renderReadinessBoolean(data.submitAvailable)]];
  for (const { key, label } of READINESS_FIELDS) {
    const v = data[key];
    if (typeof v === "boolean" || v === null) {
      rows.push([label, renderReadinessBoolean(v)]);
    }
  }
  if (data.updatedByTalentAt !== null) {
    rows.push(["updated-by-talent-at", data.updatedByTalentAt]);
  }
  return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
}
