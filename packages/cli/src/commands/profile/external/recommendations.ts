// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile external recommendations";
const OPERATION = "profile.external.recommendations";

/**
 * Action handler for `ttctl profile external recommendations`.
 *
 * Lists the per-section "do this next" recommendations the platform
 * surfaces to nudge the talent towards a complete profile. Each
 * recommendation is a discriminated union over multiple types (e.g.
 * `EmploymentsCountRecommendation`, `PortfolioItemsCountRecommendation`);
 * the CLI surfaces each as `type` + a stringified payload preview.
 */
export async function runProfileExternalRecommendations(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, format);

  let result: profile.external.ProfileRecommendation[];
  try {
    result = await profile.external.recommendations(token);
  } catch (err) {
    handleError(err, format);
    return;
  }

  emitResult(result, format, {
    pretty: formatRecommendationsText,
    table: formatRecommendationsTable,
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

function summarizePayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${formatScalar(v)}`).join(", ");
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  // For nested objects/arrays we just render the JSON shorthand — the user
  // typically uses `--output json` if they need machine-readable detail.
  return JSON.stringify(value);
}

/** Pure formatter — directly unit-testable. */
export function formatRecommendationsText(data: profile.external.ProfileRecommendation[]): string {
  if (data.length === 0) return "No recommendations.";
  const lines: string[] = [`Recommendations (${data.length.toString()}):`];
  for (const rec of data) {
    const summary = summarizePayload(rec.payload);
    lines.push(summary ? `  - ${rec.type}: ${summary}` : `  - ${rec.type}`);
  }
  return lines.join("\n");
}

/** Pure formatter — directly unit-testable. */
export function formatRecommendationsTable(data: profile.external.ProfileRecommendation[]): string {
  if (data.length === 0) return "type\tpayload";
  const rows: [string, string][] = data.map((rec) => [rec.type, summarizePayload(rec.payload)]);
  return [["type", "payload"], ...rows].map(([k, v]) => `${k}\t${v}`).join("\n");
}
