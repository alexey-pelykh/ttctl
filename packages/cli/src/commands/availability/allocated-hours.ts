// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { availability } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { emitDryRunSuccess, emitUpdateSuccess } from "../../lib/envelopes.js";
import { handleAvailabilityError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl availability allocated-hours show`. Reads
 * just the viewer-scoped `allocatedHours` value.
 *
 * Throws `AvailabilityError("UNKNOWN")` (via the service) when the
 * viewer-role payload is missing the field — defensive only.
 */
export async function runAllocatedHoursShow(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("availability allocated-hours show", output);

  let data: Awaited<ReturnType<typeof availability.allocatedHours.show>>;
  try {
    data = await availability.allocatedHours.show(token);
  } catch (err) {
    handleAvailabilityError("availability allocated-hours show", err, output);
  }

  emitResult(data, output, {
    pretty: (d) => `Allocated hours: ${d.allocatedHours.toString()} h/week`,
  });
}

/**
 * Action handler for `ttctl availability allocated-hours set --hours <n>`.
 * Updates the viewer-scoped allocated-hours value via
 * `UpdateAllocatedHours`.
 *
 * The CLI surface is required-arg (`--hours`); commander applies the
 * `--hours` parser before this handler runs, so the value is already a
 * validated non-negative integer.
 *
 * Returns the post-update `{ allocatedHours, hiredHours }` payload in
 * the success-update envelope.
 */
export interface AllocatedHoursSetOptions {
  hours: number;
  output: OutputFormat;
}

export async function runAllocatedHoursSet(opts: AllocatedHoursSetOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("availability allocated-hours set", opts.output);
  const dryRun = getCliDryRun();

  let outcome: availability.AllocatedHoursSetOutcome;
  try {
    outcome = await availability.allocatedHours.set(token, opts.hours, { dryRun });
  } catch (err) {
    handleAvailabilityError("availability allocated-hours set", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "availability.allocated-hours.set",
      format: opts.output,
      preview: outcome.preview,
    });
    return;
  }

  const updated = outcome.result;
  emitUpdateSuccess({
    operation: "availability.allocated-hours.set",
    format: opts.output,
    updated,
    prettySummary: `allocated hours = ${updated.allocatedHours.toString()} h/week`,
    prettyEntity: (data) => {
      const lines: string[] = [`Allocated: ${data.allocatedHours.toString()} h/week`];
      if (data.hiredHours !== null) lines.push(`Hired:     ${data.hiredHours.toString()} h/week`);
      return lines.join("\n");
    },
    notice: updated.notice ?? undefined,
  });
}
