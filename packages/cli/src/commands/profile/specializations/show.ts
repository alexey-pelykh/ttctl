// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";

const COMMAND_LABEL = "profile specializations show";
const OPERATION = "profile.specializations.show";

/**
 * Action handler for `ttctl profile specializations show` (#466). Reads
 * the talent's accepted specialization tracks via the lightweight
 * `GetTalentSpecializations` query — wraps `profile.specializations.show()`.
 * Viewer-scoped (no input). Returns the list of specializations the
 * talent has interacted with (accepted, pending, rejected, prospective).
 */
export async function runProfileSpecializationsShow(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, format);

  let result: profile.specializations.Specialization[];
  try {
    result = await profile.specializations.show(token);
  } catch (err) {
    handleError(err, format);
    return;
  }

  emitResult(result, format, {
    pretty: formatSpecializationsText,
    table: formatSpecializationsTable,
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

/**
 * Pretty formatter — directly unit-testable. Renders each specialization
 * as a labelled block. Empty list renders a single explanatory line so
 * the user gets immediate feedback (rather than empty stdout).
 */
export function formatSpecializationsText(rows: profile.specializations.Specialization[]): string {
  if (rows.length === 0) {
    return "No specializations recorded on this profile.";
  }
  return rows
    .map((s) => {
      const lines: string[] = [
        `${s.title} (${s.slug})`,
        `  id:                       ${s.id}`,
        `  status:                   ${s.applicationStatus || "(unset)"}`,
        `  applicationCompletedAt:   ${s.applicationCompletedAt ?? "(unset)"}`,
        `  eligibleJobsCount:        ${s.eligibleJobsCount === null ? "(unset)" : s.eligibleJobsCount.toString()}`,
        `  logoUrl:                  ${s.logoUrl ?? "(unset)"}`,
        `  apply.callable:           ${s.operations.apply.callable.toString()}`,
      ];
      if (s.operations.apply.messages.length > 0) {
        lines.push(`  apply.messages:`);
        for (const m of s.operations.apply.messages) {
          lines.push(`    - ${m}`);
        }
      }
      if (s.description !== null && s.description !== "") {
        lines.push(`  description:              ${s.description}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Table formatter — directly unit-testable. Tab-separated rows; one
 * specialization per row with the headline-relevant columns. The full
 * description / apply.messages payload is JSON-only.
 */
export function formatSpecializationsTable(rows: profile.specializations.Specialization[]): string {
  const header = ["slug", "title", "status", "applicationCompletedAt", "eligibleJobsCount", "apply.callable"].join(
    "\t",
  );
  const lines = rows.map((s) =>
    [
      s.slug,
      s.title,
      s.applicationStatus,
      s.applicationCompletedAt ?? "",
      s.eligibleJobsCount === null ? "" : s.eligibleJobsCount.toString(),
      s.operations.apply.callable.toString(),
    ].join("\t"),
  );
  return [header, ...lines].join("\n");
}
