// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { engagements } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import {
  emitAddSuccess,
  emitDryRunSuccess,
  emitRemoveSuccess,
  emitUpdateSuccess,
  wrapListEnvelope,
} from "../../lib/envelopes.js";
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
 * Action handler for `ttctl engagements breaks reschedule <break-id>
 * --from <date> --to <date>` (#155). Moves an existing break to a new
 * date window. The break's `comment` and `reasonIdentifier` are
 * preserved server-side — the wire mutation
 * (`RescheduleEngagementBreak`) only carries `startDate` + `endDate`.
 *
 * Uses `emitUpdateSuccess` (envelope `updated: ...`) because the
 * reschedule modifies an existing record; neither `created` nor
 * `removed` would carry the right semantics.
 */
export interface EngagementsBreaksRescheduleOptions {
  from: string;
  to: string;
  output: OutputFormat;
}

export async function runEngagementsBreaksReschedule(
  breakId: string,
  opts: EngagementsBreaksRescheduleOptions,
): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements breaks reschedule", opts.output);
  const dryRun = getCliDryRun();

  let outcome: engagements.RescheduleBreakOutcome;
  try {
    outcome = await engagements.breaks.reschedule(
      token,
      breakId,
      { startDate: opts.from, endDate: opts.to },
      { dryRun },
    );
  } catch (err) {
    handleEngagementsError("engagements breaks reschedule", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "engagements.breaks.reschedule",
      format: opts.output,
      preview: outcome.preview,
    });
    return;
  }

  const { result: updated } = outcome;
  emitUpdateSuccess({
    operation: "engagements.breaks.reschedule",
    format: opts.output,
    updated,
    prettySummary: `engagement break ${updated.id} (${formatDate(updated.startDate)} → ${formatDate(updated.endDate)})`,
    prettyEntity: (br) => formatBreakEntity(br),
  });
}

/**
 * Action handler for `ttctl engagements breaks reasons list`. Lists
 * the server-side catalog of valid `--reason-id` values for
 * `breaks add` (issue #156).
 *
 * Reads `platformConfiguration.engagementBreakReasons` via a hand-
 * authored `PlatformConfiguration` query (NOT in `codegen.config.ts`
 * — see core service for the trigger note). Output goes through the
 * v0.4 list envelope on json/yaml.
 */
export async function runEngagementsBreaksReasonsList(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements breaks reasons list", output);

  let items: engagements.EngagementBreakReason[];
  try {
    items = await engagements.breaks.reasonsList(token);
  } catch (err) {
    handleEngagementsError("engagements breaks reasons list", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatReasonsTable(data.items),
    table: (data) => formatReasonsTable(data.items),
    empty: { command: "engagements.breaks.reasons.list" },
  });
}

/**
 * Render the breaks-reasons catalog as a `cli-table3` table. Columns:
 * id, label. Pure — directly unit-testable.
 */
export function formatReasonsTable(
  items: engagements.EngagementBreakReason[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "label"] });
    return empty.toString();
  }
  // Find longest identifier to size the id column; cap so the label
  // column always has at least 20 visible columns to render.
  const widestId = items.reduce((max, r) => Math.max(max, r.identifier.length), "id".length);
  const idWidth = Math.min(Math.max(widestId + 2, 12), 40);
  const labelWidth = Math.max(20, terminalWidth - idWidth - 8);
  const table = new Table({
    head: ["id", "label"],
    colWidths: [idWidth, labelWidth],
    wordWrap: true,
  });
  for (const r of items) {
    table.push([r.identifier, r.nameForRole]);
  }
  return table.toString();
}

/**
 * Render the breaks list as a `cli-table3` table. Columns: id,
 * starts, ends, reason, comment.
 *
 * The `reason` column surfaces the human-readable `nameForRole` (per
 * #346); the underlying `identifier` round-trips on the JSON/YAML
 * envelope for machine consumers. Empty string when the wire returned
 * no reason (defensive — see `EngagementBreak.reason` shape notes).
 */
export function formatBreaksTable(
  items: engagements.EngagementBreak[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "starts", "ends", "reason", "comment"] });
    return empty.toString();
  }
  const idWidth = 22;
  const dateWidth = 12;
  const reasonWidth = 18;
  const remaining = Math.max(20, terminalWidth - idWidth - dateWidth - dateWidth - reasonWidth - 14);
  const commentWidth = Math.max(20, remaining);
  const table = new Table({
    head: ["id", "starts", "ends", "reason", "comment"],
    colWidths: [idWidth, dateWidth, dateWidth, reasonWidth, commentWidth],
    wordWrap: true,
  });
  for (const br of items) {
    table.push([
      br.id,
      formatDate(br.startDate),
      formatDate(br.endDate),
      br.reason?.nameForRole ?? "",
      br.comment ?? "",
    ]);
  }
  return table.toString();
}

/**
 * Render a single break as a multi-line key:value entity. Used inside
 * the success-add envelope's `prettyEntity` slot.
 *
 * Reason renders as `Reason: <nameForRole> (<identifier>)` when present,
 * so the user sees both the human-readable label and the round-tripped
 * identifier they could supply to a future `breaks add --reason-id`.
 */
export function formatBreakEntity(br: engagements.EngagementBreak): string {
  const lines: string[] = [];
  lines.push(`Id: ${br.id}`);
  lines.push(`Starts: ${formatDate(br.startDate)}`);
  lines.push(`Ends: ${formatDate(br.endDate)}`);
  if (br.reason != null) {
    lines.push(`Reason: ${br.reason.nameForRole} (${br.reason.identifier})`);
  }
  if (br.comment != null && br.comment !== "") {
    lines.push(`Comment: ${br.comment}`);
  }
  return lines.join("\n");
}
