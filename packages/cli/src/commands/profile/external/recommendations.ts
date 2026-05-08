// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile external recommendations";

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
  const token = await loadAuthTokenOrExit(COMMAND_LABEL);

  let result: profile.external.ProfileRecommendation[];
  try {
    result = await profile.external.recommendations(token);
  } catch (err) {
    handleError(err);
    return;
  }

  emitResult(result, format, {
    text: formatRecommendationsText,
    table: formatRecommendationsTable,
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
