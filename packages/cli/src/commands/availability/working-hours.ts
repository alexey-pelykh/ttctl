// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { availability } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { emitDryRunSuccess, emitUpdateSuccess } from "../../lib/envelopes.js";
import { handleAvailabilityError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl availability working-hours show`. Reads
 * just the working-hours subset of the availability snapshot — time
 * zone + daily working window + flexible shift range. Drops the
 * `allocatedHours` field (separately surfaced under `allocated-hours`).
 */
export async function runWorkingHoursShow(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("availability working-hours show", output);

  let snap: Awaited<ReturnType<typeof availability.workingHours.show>>;
  try {
    snap = await availability.workingHours.show(token);
  } catch (err) {
    handleAvailabilityError("availability working-hours show", err, output);
  }

  emitResult(snap, output, {
    pretty: (data) => formatWorkingHoursShow(data),
  });
}

type WorkingHoursShow = Awaited<ReturnType<typeof availability.workingHours.show>>;

/**
 * Render the working-hours subset as a sectioned multi-line block.
 * Pure — directly unit-testable.
 */
export function formatWorkingHoursShow(data: WorkingHoursShow): string {
  const lines: string[] = [`Working hours (viewer ${data.viewerId})`];

  if (data.timeZone !== null) {
    const tz = data.timeZone;
    lines.push("");
    lines.push("Time zone");
    lines.push(`  IANA: ${tz.value}`);
    if (tz.name !== null && tz.name !== "") lines.push(`  Name: ${tz.name}`);
    if (tz.utcOffset !== null) lines.push(`  UTC offset: ${tz.utcOffset}`);
  }

  lines.push("");
  lines.push("Daily window");
  lines.push(`  From: ${data.workingTimeFrom ?? "—"}`);
  lines.push(`  To:   ${data.workingTimeTo ?? "—"}`);

  if (data.availableShiftRangeFrom !== null || data.availableShiftRangeTo !== null) {
    lines.push("");
    lines.push("Flexible shift range");
    lines.push(`  From: ${data.availableShiftRangeFrom ?? "—"}`);
    lines.push(`  To:   ${data.availableShiftRangeTo ?? "—"}`);
  }

  return lines.join("\n");
}

/**
 * Options for `ttctl availability working-hours set`. All time fields
 * are `"HH:MM:SS"` strings (the wire format the platform expects);
 * `--time-zone` is an IANA zone identifier. At least one option must
 * be provided — the action handler rejects an empty change set
 * pre-flight.
 */
export interface WorkingHoursSetOptions {
  start?: string;
  end?: string;
  timeZone?: string;
  flexStart?: string;
  flexEnd?: string;
  output: OutputFormat;
}

const HHMMSS_PATTERN = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/**
 * Action handler for `ttctl availability working-hours set`. Updates
 * any subset of (time-zone, daily window, flexible range) via the
 * `UpdateWorkingHours` mutation.
 *
 * Validates each time string against `HH:MM:SS` (the wire format the
 * platform expects). Pre-flight validation throws
 * `AvailabilityError("MUTATION_ERROR")` BEFORE the mutation goes out
 * — fail-fast instead of relying on the server to return
 * `MUTATION_ERROR`.
 */
export async function runWorkingHoursSet(opts: WorkingHoursSetOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("availability working-hours set", opts.output);
  const dryRun = getCliDryRun();

  const input: availability.UpdateWorkingHoursInput = {};
  try {
    if (opts.start !== undefined) {
      assertHHMMSS("--start", opts.start);
      input.workingTimeFrom = opts.start;
    }
    if (opts.end !== undefined) {
      assertHHMMSS("--end", opts.end);
      input.workingTimeTo = opts.end;
    }
    if (opts.timeZone !== undefined) {
      input.timeZone = opts.timeZone;
    }
    if (opts.flexStart !== undefined) {
      assertHHMMSS("--flex-start", opts.flexStart);
      input.availableShiftRangeFrom = opts.flexStart;
    }
    if (opts.flexEnd !== undefined) {
      assertHHMMSS("--flex-end", opts.flexEnd);
      input.availableShiftRangeTo = opts.flexEnd;
    }
  } catch (err) {
    handleAvailabilityError("availability working-hours set", err, opts.output);
  }

  if (Object.keys(input).length === 0) {
    handleAvailabilityError(
      "availability working-hours set",
      new availability.AvailabilityError(
        "MUTATION_ERROR",
        "No change supplied — pass at least one of --start, --end, --time-zone, --flex-start, --flex-end.",
      ),
      opts.output,
    );
  }

  let outcome: availability.WorkingHoursSetOutcome;
  try {
    outcome = await availability.workingHours.set(token, input, { dryRun });
  } catch (err) {
    handleAvailabilityError("availability working-hours set", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "availability.working-hours.set",
      format: opts.output,
      preview: outcome.preview,
    });
    return;
  }

  const updated = outcome.result;
  const summaryParts: string[] = [];
  if (updated.timeZone !== null) summaryParts.push(`tz=${updated.timeZone.value}`);
  if (updated.workingTimeFrom !== null) summaryParts.push(`from=${updated.workingTimeFrom}`);
  if (updated.workingTimeTo !== null) summaryParts.push(`to=${updated.workingTimeTo}`);

  emitUpdateSuccess({
    operation: "availability.working-hours.set",
    format: opts.output,
    updated,
    prettySummary: summaryParts.length > 0 ? `working hours (${summaryParts.join(", ")})` : "working hours",
    prettyEntity: (data) => formatWorkingHoursSet(data),
    notice: updated.notice ?? undefined,
  });
}

type WorkingHoursSetResult = Extract<availability.WorkingHoursSetOutcome, { kind: "applied" }>["result"];

/**
 * Render the post-update working-hours payload as the indented entity
 * preview inside the success-update envelope's pretty block. Pure —
 * directly unit-testable.
 */
export function formatWorkingHoursSet(result: WorkingHoursSetResult): string {
  const lines: string[] = [];
  if (result.timeZone !== null) {
    lines.push(`Time zone: ${result.timeZone.value}`);
  }
  lines.push(`Working: ${result.workingTimeFrom ?? "—"} → ${result.workingTimeTo ?? "—"}`);
  if (result.availableShiftRangeFrom !== null || result.availableShiftRangeTo !== null) {
    lines.push(`Flex:    ${result.availableShiftRangeFrom ?? "—"} → ${result.availableShiftRangeTo ?? "—"}`);
  }
  return lines.join("\n");
}

function assertHHMMSS(flag: string, value: string): void {
  if (!HHMMSS_PATTERN.test(value)) {
    throw new availability.AvailabilityError(
      "MUTATION_ERROR",
      `${flag} expects a time in HH:MM:SS format (got "${value}").`,
    );
  }
}
