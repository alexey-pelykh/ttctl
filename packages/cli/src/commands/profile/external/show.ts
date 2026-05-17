// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, truncate } from "./_shared.js";

const COMMAND_LABEL = "profile external show";
const OPERATION = "profile.external.show";

/**
 * Action handler for `ttctl profile external show`.
 *
 * The primary read for the stored external-URL state (linkedin / github /
 * website / twitter / behance / dribbble). Closes the read-side asymmetry
 * documented in issue #343 — prior to this leaf the only ways to inspect
 * current URL values were a no-op `update` (write-disguised-as-read) or
 * `advanced-wizard show` (which trims URLs from its selection set).
 */
export async function runProfileExternalShow(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, format);

  let result: profile.external.ExternalProfiles;
  try {
    result = await profile.external.show(token);
  } catch (err) {
    handleError(err, format);
    return;
  }

  emitResult(result, format, {
    pretty: formatExternalShowText,
    table: formatExternalShowTable,
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

/** The six external-URL fields in stable display order. */
const URL_FIELDS = ["linkedin", "github", "website", "twitter", "behance", "dribbble"] as const;

/**
 * Pretty formatter — directly unit-testable. Renders each URL on its own
 * line (unset links render as `(unset)`) plus the last-edit timestamp.
 * Each URL line is truncated at 80 columns to match the `update` leaf's
 * pretty entity.
 */
export function formatExternalShowText(data: profile.external.ExternalProfiles): string {
  const lines: string[] = URL_FIELDS.map((f) => truncate(`${f}: ${data[f] ?? "(unset)"}`, 80));
  lines.push(`updated-by-talent-at: ${data.updatedByTalentAt ?? "(unset)"}`);
  return lines.join("\n");
}

/** Pure formatter — directly unit-testable. Tab-separated key/value rows. */
export function formatExternalShowTable(data: profile.external.ExternalProfiles): string {
  const rows: [string, string][] = [
    ...URL_FIELDS.map((f): [string, string] => [f, data[f] ?? ""]),
    ["updated-by-talent-at", data.updatedByTalentAt ?? ""],
  ];
  return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
}
