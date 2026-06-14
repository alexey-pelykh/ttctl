// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { timesheet } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitDryRunSuccess, emitUpdateSuccess } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleTimesheetError, loadAuthTokenOrExit } from "./shared.js";
import { formatTimesheetDetail } from "./show.js";

/**
 * Action handler for `ttctl timesheet update <id>` (#458).
 *
 * Edits a draft timesheet's comment and/or per-day records. `UpdateTimesheet`
 * is a full-replacement contract, so the core service does read-modify-write
 * (fetch → merge overrides by date → resend the complete set); the CLI only
 * supplies the partial overrides.
 *
 * `--record <date=minutes>` / `--note <date=text>` are repeatable and merged
 * by date. `--consent-timesheet-billing` is the ADR-009 ceremony (or set
 * `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1`); absence surfaces a
 * `CONSENT_REQUIRED` envelope from the core gate. `--dry-run` previews the
 * mutation without any wire call (see {@link DRY_RUN_MERGE_NOTICE}).
 */
export interface TimesheetUpdateOptions {
  comment?: string;
  /** Raw `--record date=minutes` values (repeatable); parsed in the handler. */
  record: string[];
  /** Raw `--note date=text` values (repeatable); parsed in the handler. */
  note: string[];
  consentTimesheetBilling: boolean;
  output: OutputFormat;
}

/**
 * Surfaced on the dry-run envelope: the preview shows only the caller's
 * explicit overrides, but the apply path merges them into the full record
 * set so unspecified days and the comment are preserved.
 */
const DRY_RUN_MERGE_NOTICE =
  "Apply path performs read-modify-write: it fetches the current timesheet, merges these overrides into the full record set (by date), and resends the complete set + comment — so unspecified days and the comment are preserved. This preview shows only your requested overrides and issues no wire calls.";

export async function runTimesheetUpdate(id: string, opts: TimesheetUpdateOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("timesheet update", opts.output);
  const dryRun = getCliDryRun();

  let records: timesheet.TimesheetRecordInput[];
  try {
    records = mergeRecordFlags(opts.record, opts.note);
  } catch (err) {
    handleTimesheetError("timesheet update", err, opts.output);
  }

  const input: timesheet.UpdateTimesheetInput = {
    timesheetBillingConsentIssued: opts.consentTimesheetBilling,
  };
  if (opts.comment !== undefined) input.comment = opts.comment;
  if (records.length > 0) input.records = records;

  let outcome: timesheet.UpdateOutcome;
  try {
    outcome = await timesheet.update(token, id, input, { dryRun });
  } catch (err) {
    handleTimesheetError("timesheet update", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "timesheet.update",
      format: opts.output,
      preview: outcome.preview,
      notice: DRY_RUN_MERGE_NOTICE,
    });
    return;
  }

  const { result: updated } = outcome;
  emitUpdateSuccess({
    operation: "timesheet.update",
    format: opts.output,
    updated,
    prettySummary: `timesheet ${updated.id} updated (${updated.startDate} → ${updated.endDate}, ${updated.hours}h)`,
    prettyEntity: (entity) => formatTimesheetDetail(entity),
  });
}

/**
 * Merge `--record date=minutes` and `--note date=text` flags into per-day
 * overrides keyed by date. `duration` stays a string (ADR-006). Throws
 * `TimesheetError("VALIDATION_ERROR")` on malformed input so the shared
 * router emits a clean envelope.
 */
function mergeRecordFlags(recordFlags: string[], noteFlags: string[]): timesheet.TimesheetRecordInput[] {
  const byDate = new Map<string, timesheet.TimesheetRecordInput>();

  const ensure = (date: string): timesheet.TimesheetRecordInput => {
    const existing = byDate.get(date);
    if (existing !== undefined) return existing;
    const created: timesheet.TimesheetRecordInput = { date };
    byDate.set(date, created);
    return created;
  };

  for (const raw of recordFlags) {
    const { date, value } = splitDateEq("--record", raw);
    if (!/^\d+(\.\d+)?$/.test(value)) {
      throw new timesheet.TimesheetError(
        "VALIDATION_ERROR",
        `--record ${raw}: duration must be minutes as a decimal number (e.g. 480 or 480.0); got "${value}".`,
      );
    }
    ensure(date).duration = value;
  }

  for (const raw of noteFlags) {
    const { date, value } = splitDateEq("--note", raw);
    // An empty value clears the note (sent as "").
    ensure(date).note = value;
  }

  return [...byDate.values()];
}

/**
 * Split a `<date>=<value>` flag on the FIRST `=`. The date must be an
 * ISO `YYYY-MM-DD`; the value may be empty (only meaningful for `--note`,
 * which treats empty as "clear").
 */
function splitDateEq(flag: string, raw: string): { date: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq === -1) {
    throw new timesheet.TimesheetError(
      "VALIDATION_ERROR",
      `${flag} ${raw}: expected <date>=<value> (e.g. ${flag} 2026-06-01=...).`,
    );
  }
  const date = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new timesheet.TimesheetError(
      "VALIDATION_ERROR",
      `${flag} ${raw}: date must be ISO YYYY-MM-DD; got "${date}".`,
    );
  }
  return { date, value };
}
