// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { engagements } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { shortenEngagementStatus } from "./list.js";
import { handleEngagementsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl engagements stats`. Issues 2 calls (one
 * per engagement-status-group) in parallel via the core service,
 * surfaces a `{ total, groups: [{name, count}] }` shape.
 *
 * Each `count` is server-provided (`totalCount`); no client-side
 * synthesis. The `<group> stats` sub-command absorbs the role of the
 * top-level `ttctl stats engagements` (per the project's "stats folds
 * into per-group sub-commands" decision).
 *
 * **JSON shape rationale** (mirrors `applications stats`): emits a
 * BARE `{total, groups}` payload, NOT the v0.4 list envelope. `stats`
 * is an aggregate scalar grouping; the envelope is for collection
 * payloads.
 */
export async function runEngagementsStats(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements stats", output);

  let result: engagements.EngagementsStats;
  try {
    result = await engagements.stats(token);
  } catch (err) {
    handleEngagementsError("engagements stats", err, output);
  }

  emitResult(result, output, {
    pretty: (data) => formatStatsPretty(data),
  });
}

/**
 * Render the stats payload as a small table plus a total line. Pure —
 * directly unit-testable.
 */
export function formatStatsPretty(stats: engagements.EngagementsStats): string {
  const header = `${stats.groups.length.toString()} status groups, ${stats.total.toString()} total engagements:`;
  const table = new Table({
    head: ["group", "count"],
    colAligns: ["left", "right"],
  });
  for (const g of stats.groups) {
    table.push([shortenEngagementStatus(g.name), g.count.toString()]);
  }
  return [header, "", table.toString()].join("\n");
}
