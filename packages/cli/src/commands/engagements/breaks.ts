// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { engagements } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitAddSuccess, emitDryRunSuccess, emitRemoveSuccess, wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatDate } from "./list.js";
import { handleEngagementsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Notice text emitted on the dry-run envelope for `breaks.add`. The
 * mutation's apply path resolves the underlying `engagement.id` via a
 * separate `EngagementBreaks` query (one extra round-trip) before
 * issuing `CreateEngagementBreak`. The dry-run path SKIPS that
 * prefetch entirely (per the AC's "no GraphQL request is sent"
 * requirement), so the preview's `variables.engagementId` carries the
 * caller-supplied `jobActivityItemId` as a placeholder — the real
 * `engagement.id` would be resolved at apply time.
 *
 * Surfaced as the `notice` field on the dry-run envelope so consumers
 * (CLI users reading `pretty` output AND machine consumers parsing
 * `json` / `yaml`) see the caveat without ambiguity.
 */
const ADD_BREAK_DRY_RUN_NOTICE =
  "engagementId in the preview is a placeholder (the caller's jobActivityItem.id); the apply path resolves the real engagement.id via an EngagementBreaks query before issuing the mutation — this read is skipped on dry-run.";

/**
 * Action handler for `ttctl engagements breaks list <id>`. Lists
 * scheduled breaks on a single engagement (by `jobActivityItem.id` —
 * matches the row id from `engagements list`).
 *
 * Reuses the captured `EngagementBreaks` operation. Returns the
 * breaks array wrapped in the v0.4 list envelope.
 */
export async function runEngagementsBreaksList(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements breaks list", output);

  let items: engagements.EngagementBreak[];
  try {
    items = await engagements.breaks.list(token, id);
  } catch (err) {
    handleEngagementsError("engagements breaks list", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatBreaksTable(data.items),
    table: (data) => formatBreaksTable(data.items),
    empty: { command: "engagements.breaks.list" },
  });
}

/**
 * Action handler for `ttctl engagements breaks add <id> --from <date>
 * --to <date> [--reason-id <id>] [--comment <text>]`. Schedules a new
 * break window. Internal flow:
 *   1. resolve `engagement.id` from `jobActivityItem.id` (one query)
 *   2. issue `CreateEngagementBreak` mutation
 *
 * Returns the new break wrapped in the success-add envelope.
 */
export interface EngagementsBreaksAddOptions {
  from: string;
  to: string;
  reasonId: string;
  comment?: string;
  output: OutputFormat;
}

export async function runEngagementsBreaksAdd(id: string, opts: EngagementsBreaksAddOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements breaks add", opts.output);
  const dryRun = getCliDryRun();

  const addOpts: engagements.AddBreakOptions = {
    startDate: opts.from,
    endDate: opts.to,
    reasonIdentifier: opts.reasonId,
  };
  if (opts.comment !== undefined) addOpts.comment = opts.comment;

  let outcome: engagements.AddBreakOutcome;
  try {
    outcome = await engagements.breaks.add(token, id, addOpts, { dryRun });
  } catch (err) {
    handleEngagementsError("engagements breaks add", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "engagements.breaks.add",
      format: opts.output,
      preview: outcome.preview,
      notice: ADD_BREAK_DRY_RUN_NOTICE,
    });
    return;
  }

  const { result: created } = outcome;
  emitAddSuccess({
    operation: "engagements.breaks.add",
    format: opts.output,
    created,
    prettySummary: `engagement break ${created.id} (${formatDate(created.startDate)} → ${formatDate(created.endDate)})`,
    prettyEntity: (br) => formatBreakEntity(br),
  });
}

/**
 * Action handler for `ttctl engagements breaks remove <break-id>`.
 * Cancels a previously-scheduled break by `engagementBreak.id` (the
 * id returned by `breaks list`).
 *
 * Returns the cancelled break id wrapped in the success-remove
 * envelope.
 */
export async function runEngagementsBreaksRemove(breakId: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements breaks remove", output);
  const dryRun = getCliDryRun();

  let outcome: engagements.RemoveBreakOutcome;
  try {
    outcome = await engagements.breaks.remove(token, breakId, { dryRun });
  } catch (err) {
    handleEngagementsError("engagements breaks remove", err, output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "engagements.breaks.remove",
      format: output,
      preview: outcome.preview,
    });
    return;
  }

  emitRemoveSuccess({
    operation: "engagements.breaks.remove",
    format: output,
    id: breakId,
    prettySummary: `engagement break ${breakId}`,
  });
}

/**
 * Render the breaks list as a `cli-table3` table. Columns: id,
 * starts, ends, comment.
 */
export function formatBreaksTable(
  items: engagements.EngagementBreak[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "starts", "ends", "comment"] });
    return empty.toString();
  }
  const idWidth = 22;
  const dateWidth = 12;
  const remaining = Math.max(20, terminalWidth - idWidth - dateWidth - dateWidth - 12);
  const commentWidth = Math.max(20, remaining);
  const table = new Table({
    head: ["id", "starts", "ends", "comment"],
    colWidths: [idWidth, dateWidth, dateWidth, commentWidth],
    wordWrap: true,
  });
  for (const br of items) {
    table.push([br.id, formatDate(br.startDate), formatDate(br.endDate), br.comment ?? ""]);
  }
  return table.toString();
}

/**
 * Render a single break as a multi-line key:value entity. Used inside
 * the success-add envelope's `prettyEntity` slot.
 */
export function formatBreakEntity(br: engagements.EngagementBreak): string {
  const lines: string[] = [];
  lines.push(`Id: ${br.id}`);
  lines.push(`Starts: ${formatDate(br.startDate)}`);
  lines.push(`Ends: ${formatDate(br.endDate)}`);
  if (br.comment != null && br.comment !== "") {
    lines.push(`Comment: ${br.comment}`);
  }
  return lines.join("\n");
}
