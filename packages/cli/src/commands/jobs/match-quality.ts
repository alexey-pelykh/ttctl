// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { jobs } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleJobsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl jobs match-quality <id>`. Fetches the
 * platform's per-criterion match-quality breakdown for the talent×job pair
 * and emits via the cross-CLI output helper.
 *
 * `json` / `yaml` emit the full `{ metrics }` projection. Pretty renders one
 * line per criterion with its `statusV2` status, required / availability-
 * request flags, and the human-facing description / explanation.
 */
export async function runJobsMatchQuality(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs match-quality", output);

  let result: jobs.JobMatchQuality;
  try {
    result = await jobs.matchQuality(token, id);
  } catch (err) {
    handleJobsError("jobs match-quality", err, output);
  }

  emitResult(result, output, {
    pretty: (data) => formatMatchQuality(id, data),
  });
}

/**
 * Render the match-quality breakdown as a sectioned multi-line block. Pure —
 * directly unit-testable. The header surfaces the criterion count so an empty
 * breakdown reads as "Toptal returned no criteria" rather than a dropped
 * section.
 */
export function formatMatchQuality(jobId: string, quality: jobs.JobMatchQuality): string {
  const count = quality.metrics.length;
  const lines: string[] = [
    `Match quality for job ${jobId} (${count.toString()} ${count === 1 ? "criterion" : "criteria"})`,
  ];
  for (const m of quality.metrics) {
    lines.push(...formatMetric(m));
  }
  return lines.join("\n");
}

function formatMetric(m: jobs.JobMatchQualityMetric): string[] {
  const label = m.name ?? m.slug ?? "(unnamed)";
  const status = m.statusV2 !== null && m.statusV2 !== "" ? ` [${m.statusV2}]` : "";
  const flagParts: string[] = [];
  if (m.isRequired === true) flagParts.push("required");
  if (m.forAvailabilityRequest === true) flagParts.push("availability-request");
  const flags = flagParts.length > 0 ? ` (${flagParts.join(", ")})` : "";
  const lines: string[] = [`  • ${label}${status}${flags}`];
  if (m.description !== null && m.description !== "") lines.push(`    ${m.description}`);
  if (m.explanation !== null && m.explanation !== "") lines.push(`    ${m.explanation}`);
  return lines;
}
