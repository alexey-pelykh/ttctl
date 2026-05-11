// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { runAllocatedHoursSet, runAllocatedHoursShow } from "./allocated-hours.js";
import { runAvailabilityShow } from "./show.js";
import type { WorkingHoursSetOptions } from "./working-hours.js";
import { runWorkingHoursSet, runWorkingHoursShow } from "./working-hours.js";

/**
 * Build the `ttctl availability` command tree (#146 amended spec). Five
 * leaves across the top-level group and two nested sub-groups
 * (`working-hours`, `allocated-hours`):
 *
 * | Leaf                                | Description                              |
 * |-------------------------------------|------------------------------------------|
 * | `show`                              | Full availability snapshot               |
 * | `working-hours show`                | Just the time-zone + daily window subset |
 * | `working-hours set [--start/--end/--time-zone/--flex-start/--flex-end]` | Partial-update working hours |
 * | `allocated-hours show`              | Just the allocated-hours value           |
 * | `allocated-hours set --hours <n>`   | Set allocated-hours                      |
 *
 * **Vocabulary note**: per-engagement "time off" is owned by
 * `ttctl engagements breaks {list, add, remove}` — there is no parallel
 * `ttctl availability time-off` surface (the underlying API would be
 * identical to the engagement-break one). Booking-page "lead time" /
 * "minimum scheduling notice" is a different surface and is not
 * surfaced in v1.
 *
 * **Out of scope for v1** (per #146 amended spec from 2026-05-11):
 *   - Time-off list/add/remove (use `engagements breaks` instead)
 *   - Lead-time / minimum-scheduling-notice setting (booking-page
 *     follow-up)
 *   - Setting `meetingTimeFrom` / `meetingTimeTo` (read-only)
 *   - Per-engagement availability overrides (no API support)
 */
export function buildAvailabilityCommand(): Command {
  const cmd = new Command("availability").description(
    "View and manage availability: time zone, working hours, allocated hours",
  );

  cmd
    .command("show")
    .description("Show full availability snapshot")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runAvailabilityShow(options.output);
    });

  // ----- working-hours sub-group ---------------------------------------
  const workingHours = cmd
    .command("working-hours")
    .description("Manage daily working hours, time zone, and flexible shift range");

  workingHours
    .command("show")
    .description("Show the working-hours subset")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runWorkingHoursShow(options.output);
    });

  workingHours
    .command("set")
    .description("Update working hours (at least one of the options below)")
    .option("--start <HH:MM:SS>", "daily working-hours window start")
    .option("--end <HH:MM:SS>", "daily working-hours window end")
    .option("--time-zone <IANA>", "IANA time-zone identifier (e.g., Europe/Berlin)")
    .option("--flex-start <HH:MM:SS>", "flexible shift-range start")
    .option("--flex-end <HH:MM:SS>", "flexible shift-range end")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: {
        start?: string;
        end?: string;
        timeZone?: string;
        flexStart?: string;
        flexEnd?: string;
        output: OutputFormat;
      }) => {
        const setOpts: WorkingHoursSetOptions = { output: options.output };
        if (options.start !== undefined) setOpts.start = options.start;
        if (options.end !== undefined) setOpts.end = options.end;
        if (options.timeZone !== undefined) setOpts.timeZone = options.timeZone;
        if (options.flexStart !== undefined) setOpts.flexStart = options.flexStart;
        if (options.flexEnd !== undefined) setOpts.flexEnd = options.flexEnd;
        await runWorkingHoursSet(setOpts);
      },
    );

  // ----- allocated-hours sub-group -------------------------------------
  const allocatedHours = cmd.command("allocated-hours").description("Manage viewer-scoped allocated hours per week");

  allocatedHours
    .command("show")
    .description("Show the current allocated hours")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runAllocatedHoursShow(options.output);
    });

  allocatedHours
    .command("set")
    .description("Set allocated hours (non-negative integer; portal caps at 80)")
    .requiredOption("--hours <n>", "hours per week (non-negative integer)", parseHoursArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { hours: number; output: OutputFormat }) => {
      await runAllocatedHoursSet({ hours: options.hours, output: options.output });
    });

  return cmd;
}

/**
 * Parse a `--hours` argument as a non-negative integer. Rejects
 * floating-point / negative / non-numeric / empty values at parse time
 * so the handler receives a validated `number`.
 */
function parseHoursArg(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidArgumentError("--hours must be a non-negative integer (no decimals, no sign)");
  }
  return Number.parseInt(trimmed, 10);
}
