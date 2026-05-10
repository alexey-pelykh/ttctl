// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { applications } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { shortenStatusGroup } from "./list.js";
import { handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl applications stats`. Issues N+1 calls (one
 * per `JobActivityItemStatusGroupEnum` value) in parallel via the
 * core service, surfaces a `{ total, groups: [{name, count}] }` shape.
 *
 * Each `count` is server-provided (the gateway's `totalCount`); no
 * client-side synthesis. See `.tmp/workitem-15.md` § Open Questions
 * (RESOLVED) for the scoping decision.
 *
 * **JSON shape rationale**: this leaf emits a BARE `{total, groups}`
 * payload, NOT the locked v0.4 list envelope (`{version, items, pageInfo?}`
 * from #128). The envelope is for `list` verbs whose payload IS a
 * collection — it expresses pagination uniformity. `stats` is an
 * aggregate scalar grouping; wrapping it in `{items: [...]}` would
 * misrepresent the shape (consumers would expect to iterate `items` like
 * a list, when each entry is a count, not an entity). The bare shape is
 * the right ABI for an aggregate, and keeping it bare avoids over-
 * extending the envelope's semantics. If a future epic wants to
 * version aggregate payloads, that's an additive `{version, ...}`
 * change at the top level.
 */
export async function runApplicationsStats(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("applications stats", output);

  let result: applications.ApplicationsStats;
  try {
    result = await applications.stats(token);
  } catch (err) {
    handleApplicationsError("applications stats", err, output);
  }

  emitResult(result, output, {
    pretty: (data) => formatStatsPretty(data),
  });
}

/**
 * Render the stats payload as a small table plus a total line.
 * Pure — directly unit-testable.
 *
 *     5 status groups, 124 total activity items:
 *
 *     ┌────────────┬───────┐
 *     │ group      │ count │
 *     ├────────────┼───────┤
 *     │ Active     │     2 │
 *     │ Recruiter  │     5 │
 *     │ Client     │     0 │
 *     │ Closed     │     1 │
 *     │ Archived   │   116 │
 *     └────────────┴───────┘
 */
export function formatStatsPretty(stats: applications.ApplicationsStats): string {
  const header = `${stats.groups.length.toString()} status groups, ${stats.total.toString()} total activity items:`;
  const table = new Table({
    head: ["group", "count"],
    colAligns: ["left", "right"],
  });
  for (const g of stats.groups) {
    table.push([shortenStatusGroup(g.name), g.count.toString()]);
  }
  return [header, "", table.toString()].join("\n");
}
