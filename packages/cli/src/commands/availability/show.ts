// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { availability } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleAvailabilityError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl availability show`. Reads the full
 * availability snapshot — time zone, working hours, flexible shift
 * range, and allocated hours.
 *
 * Pretty rendering groups the snapshot into a sectioned multi-line
 * block. `json` / `yaml` emit the full server payload.
 *
 * **What this does NOT show** (out of scope per #146 amended spec):
 *   - Per-engagement time-off / engagement breaks (see
 *     `ttctl engagements breaks list <id>`).
 *   - Booking-page lead-time / "minimum scheduling notice" (different
 *     surface; follow-up issue).
 */
export async function runAvailabilityShow(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("availability show", output);

  let snap: availability.AvailabilitySnapshot;
  try {
    snap = await availability.show(token);
  } catch (err) {
    handleAvailabilityError("availability show", err, output);
  }

  emitResult(snap, output, {
    pretty: (data) => formatAvailabilitySnapshot(data),
  });
}

/**
 * Render the full availability snapshot as a sectioned multi-line
 * block. Pure — directly unit-testable.
 *
 * Sections:
 *   1. Identity (viewer id)
 *   2. Time zone (name / IANA value / offsets)
 *   3. Working hours (workingTimeFrom/To)
 *   4. Flexible shift range (availableShiftRangeFrom/To)
 *   5. Allocated hours
 *
 * Sections whose fields are all null/empty are omitted.
 */
export function formatAvailabilitySnapshot(snap: availability.AvailabilitySnapshot): string {
  const lines: string[] = [];

  lines.push(`Availability (viewer ${snap.viewerId})`);

  if (snap.timeZone !== null) {
    lines.push("");
    lines.push("Time zone");
    const tz = snap.timeZone;
    lines.push(`  IANA: ${tz.value}`);
    if (tz.name !== null && tz.name !== "") lines.push(`  Name: ${tz.name}`);
    if (tz.location !== null && tz.location !== "") lines.push(`  Location: ${tz.location}`);
    if (tz.utcOffset !== null) lines.push(`  UTC offset: ${tz.utcOffset}`);
    if (tz.stdOffset !== null && tz.stdOffset !== tz.utcOffset) {
      lines.push(`  Standard offset: ${tz.stdOffset}`);
    }
  }

  if (snap.workingTimeFrom !== null || snap.workingTimeTo !== null) {
    lines.push("");
    lines.push("Working hours");
    lines.push(`  From: ${snap.workingTimeFrom ?? "—"}`);
    lines.push(`  To:   ${snap.workingTimeTo ?? "—"}`);
  }

  if (snap.availableShiftRangeFrom !== null || snap.availableShiftRangeTo !== null) {
    lines.push("");
    lines.push("Flexible shift range");
    lines.push(`  From: ${snap.availableShiftRangeFrom ?? "—"}`);
    lines.push(`  To:   ${snap.availableShiftRangeTo ?? "—"}`);
  }

  lines.push("");
  lines.push("Allocated hours");
  if (snap.allocatedHours === null) {
    lines.push("  (unset)");
  } else {
    lines.push(`  ${snap.allocatedHours.toString()} h/week`);
  }

  return lines.join("\n");
}
