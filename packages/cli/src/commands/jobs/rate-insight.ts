// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { jobs } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleJobsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl jobs rate-insight <id>`. Fetches the platform's
 * per-job rate-intelligence panel for the talent×job pair and emits via the
 * cross-CLI output helper.
 *
 * `json` / `yaml` emit the full `JobRateInsight` projection (or `null` when the
 * platform surfaces no insight). Pretty renders the discriminated band — the
 * estimated revenue plus, for an uncompetitive job, the recommended /
 * recent-application rate band.
 */
export async function runJobsRateInsight(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs rate-insight", output);

  let result: jobs.JobRateInsight | null;
  try {
    result = await jobs.rateInsight(token, id);
  } catch (err) {
    handleJobsError("jobs rate-insight", err, output);
  }

  emitResult(result, output, {
    pretty: (data) => formatRateInsight(id, data),
  });
}

/**
 * Render the rate insight as a short multi-line block. Pure — directly
 * unit-testable. `null` (no insight surfaced for the job) reads as an explicit
 * line rather than an empty render. Rate values are emitted verbatim (they are
 * BigDecimal strings — no locale formatting, no rounding).
 */
export function formatRateInsight(jobId: string, insight: jobs.JobRateInsight | null): string {
  if (insight === null) {
    return `No rate insight available for job ${jobId}.`;
  }
  const lines: string[] = [`Rate insight for job ${jobId} — ${insight.kind ?? "unknown"}`];
  if (insight.estimatedRevenue !== null && insight.estimatedRevenue !== "") {
    lines.push(`  Estimated revenue: ${insight.estimatedRevenue}`);
  }
  if (insight.recommendedRate !== null && insight.recommendedRate !== "") {
    lines.push(`  Recommended rate: ${insight.recommendedRate}`);
  }
  if (insight.recentApplicationRate !== null && insight.recentApplicationRate !== "") {
    lines.push(`  Recent application rate: ${insight.recentApplicationRate}`);
  }
  if (insight.estimatedRevenueExplanation !== null && insight.estimatedRevenueExplanation !== "") {
    lines.push(`  ${insight.estimatedRevenueExplanation}`);
  }
  if (insight.longTermDisclaimer !== null && insight.longTermDisclaimer !== "") {
    lines.push(`  ${insight.longTermDisclaimer}`);
  }
  return lines.join("\n");
}
