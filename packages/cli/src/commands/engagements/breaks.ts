// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { engagements } from "@ttctl/core";

import { emitAddSuccess, emitRemoveSuccess, wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatDate } from "./list.js";
import { handleEngagementsError, loadAuthTokenOrExit } from "./shared.js";

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

  const addOpts: engagements.AddBreakOptions = {
    startDate: opts.from,
    endDate: opts.to,
    reasonIdentifier: opts.reasonId,
  };
  if (opts.comment !== undefined) addOpts.comment = opts.comment;

  let created: engagements.EngagementBreak;
  try {
    created = await engagements.breaks.add(token, id, addOpts);
  } catch (err) {
    handleEngagementsError("engagements breaks add", err, opts.output);
  }

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

  try {
    await engagements.breaks.remove(token, breakId);
  } catch (err) {
    handleEngagementsError("engagements breaks remove", err, output);
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
