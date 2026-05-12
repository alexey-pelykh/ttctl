// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { engagements } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleEngagementsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl engagements contracts list <id>`. Lists
 * contracts for a single engagement (by `jobActivityItem.id` — matches
 * the row id from `engagements list`).
 *
 * **Wire reality**: today returns array-of-one — the engagement's
 * `currentAgreement`. The list shape is preserved for forward
 * compatibility (see `core.engagements.contracts.list` doc).
 *
 * Returns the contracts array wrapped in the v1.0 list envelope.
 */
export async function runEngagementsContractsList(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements contracts list", output);

  let items: engagements.EngagementContract[];
  try {
    items = await engagements.contracts.list(token, id);
  } catch (err) {
    handleEngagementsError("engagements contracts list", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatContractsTable(data.items),
    table: (data) => formatContractsTable(data.items),
    empty: { command: "engagements.contracts.list" },
  });
}

/**
 * Action handler for `ttctl engagements contracts show <id>`. Returns
 * the single contract detail (full `EngagementAgreement` projection).
 *
 * The id is the `jobActivityItem.id` (same id as `engagements show`)
 * — `EngagementAgreement` has no separate identity in the schema.
 *
 * `json` / `yaml` always emit the bare contract payload (matches the
 * `engagements show` shape — bare detail, not the list envelope).
 */
export async function runEngagementsContractsShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements contracts show", output);

  let contract: engagements.EngagementContract;
  try {
    contract = await engagements.contracts.show(token, id);
  } catch (err) {
    handleEngagementsError("engagements contracts show", err, output);
  }

  emitResult(contract, output, {
    pretty: (data) => formatContractEntity(data),
  });
}

/**
 * Render the contracts list as a `cli-table3` table sized to the
 * current terminal width. Columns: engagement id, commitment, hourly
 * rate, talent rate, time period.
 *
 * The `engagementId` is the `TalentEngagement.id` (different from the
 * `jobActivityItem.id` that the user passes in — the table surfaces
 * both for transparency, with the activity-item id in the first
 * column).
 */
export function formatContractsTable(
  items: engagements.EngagementContract[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["engagement", "commitment", "hourly", "talent-rate", "period"] });
    return empty.toString();
  }
  const engagementWidth = 22;
  const commitmentWidth = 14;
  const hourlyWidth = 12;
  const talentRateWidth = 12;
  // 5 columns × 2 padding-char + 6 borders ≈ 16
  const remaining = Math.max(8, terminalWidth - engagementWidth - commitmentWidth - hourlyWidth - talentRateWidth - 16);
  const periodWidth = Math.max(8, remaining);
  const table = new Table({
    head: ["engagement", "commitment", "hourly", "talent-rate", "period"],
    colWidths: [engagementWidth, commitmentWidth, hourlyWidth, talentRateWidth, periodWidth],
    colAligns: ["left", "left", "right", "right", "left"],
    wordWrap: true,
  });
  for (const c of items) {
    table.push([
      c.jobActivityItemId,
      c.commitment?.slug ?? "—",
      c.talentHourlyRate ?? "—",
      c.talentRate ?? "—",
      c.timePeriod ?? "—",
    ]);
  }
  return table.toString();
}

/**
 * Render a single contract as a multi-line key:value entity. Used for
 * `engagements contracts show` pretty output. Lines for nullable
 * fields are emitted only when the underlying field is non-null.
 */
export function formatContractEntity(contract: engagements.EngagementContract): string {
  const lines: string[] = [];
  lines.push(`Contract for engagement ${contract.jobActivityItemId}`);
  lines.push(`  Engagement-ID: ${contract.engagementId}`);

  if (contract.commitment?.slug != null) {
    lines.push(`  Commitment: ${contract.commitment.slug}`);
  }
  if (contract.timePeriod !== null) {
    lines.push(`  Period: ${contract.timePeriod}`);
  }

  lines.push("");
  lines.push("Rates");
  if (contract.applicationRate !== null) {
    lines.push(`  Application rate: ${contract.applicationRate}`);
  }
  if (contract.talentRate !== null) {
    lines.push(`  Talent rate: ${contract.talentRate}`);
  }
  if (contract.talentHourlyRate !== null) {
    lines.push(`  Hourly rate: ${contract.talentHourlyRate}`);
  }
  if (contract.marketplaceMargin !== null) {
    lines.push(`  Marketplace margin: ${contract.marketplaceMargin}`);
  }

  return lines.join("\n");
}
