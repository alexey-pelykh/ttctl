// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { markMutation } from "../../lib/dry-run.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { parsePaginationFlag } from "../../lib/pagination.js";
import { runTimesheetList } from "./list.js";
import { runTimesheetShow } from "./show.js";
import { runTimesheetSubmit } from "./submit.js";

/**
 * Page / per-page option factories (#374). Mirrors the `jobs` command
 * group (#183) — the `list` leaf is the only timesheet paginating
 * surface, so the factories live here and the parser is shared via
 * `parsePaginationFlag` (positive-integer constraint, 1-indexed page).
 * Declared on the leaf per #183 ("pagination flags declared PER
 * paginating leaf"); `show` / `submit` deliberately do NOT carry them.
 */
function pageOption(): Option {
  return new Option("--page <number>", "page number (1-indexed)").argParser((raw) =>
    parsePaginationFlag("--page", raw),
  );
}

function perPageOption(): Option {
  return new Option("--per-page <number>", "items per page (default 50)").argParser((raw) =>
    parsePaginationFlag("--per-page", raw),
  );
}

/**
 * Build the `ttctl timesheet` command tree (#13). Three leaves:
 *
 * | Leaf                                          | Description                                       |
 * |-----------------------------------------------|---------------------------------------------------|
 * | `list [--engagement <id>] [--page] [--per-page]` | List timesheets (default: viewer-wide pending) |
 * | `show <id>`                                   | One timesheet detail (id = BillingCycle.id)       |
 * | `submit [id] [--confirm]`                     | Submit timesheet for billing (destructive)        |
 *
 * **Wire identity model**:
 *   - `BillingCycle.id` — the public "timesheet id" returned by
 *     `list` and consumed by `show` / `submit`.
 *   - `JobActivityItem.id` — the "engagement id" exposed by
 *     `engagements list`. Passed via `--engagement <id>` to scope
 *     `list` / `submit` auto-resolve to one engagement.
 *
 * **Out of scope for v1** (per #13 spec): editing timesheet records,
 * uploading attachments, reminder settings, rejection/approval
 * workflow. The web UI handles record entry; this CLI surfaces the
 * read paths and the submit verb.
 */
export function buildTimesheetCommand(): Command {
  const cmd = new Command("timesheet").description("View timesheet billing cycles and submit them for billing");

  cmd
    .command("list")
    .description("List timesheet billing cycles (default: viewer-wide pending; paginated via --page / --per-page)")
    .option("--engagement <id>", "scope to one engagement (jobActivityItem.id from `engagements list`)")
    .addOption(pageOption())
    .addOption(perPageOption())
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { engagement?: string; page?: number; perPage?: number; output: OutputFormat }) => {
      const listOpts: import("./list.js").TimesheetListOptions = { output: options.output };
      if (options.engagement !== undefined) listOpts.engagement = options.engagement;
      if (options.page !== undefined) listOpts.page = options.page;
      if (options.perPage !== undefined) listOpts.perPage = options.perPage;
      await runTimesheetList(listOpts);
    });

  cmd
    .command("show")
    .description("Show one timesheet by id (BillingCycle.id from `timesheet list`)")
    .argument("<id>", "timesheet id (BillingCycle.id)", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runTimesheetShow(id, options.output);
    });

  const submitCmd = cmd
    .command("submit")
    .description("Submit a timesheet for billing (DESTRUCTIVE — one-way)")
    .argument(
      "[id]",
      "timesheet id (BillingCycle.id); when omitted, the current pending cycle is auto-resolved",
      parseIdArgOptional,
    )
    .option("--engagement <id>", "scope auto-resolve to one engagement (jobActivityItem.id)")
    .option("--confirm", "skip the interactive confirmation prompt (required for non-TTY stdin)", false)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (id: string | undefined, options: { engagement?: string; confirm: boolean; output: OutputFormat }) => {
        const submitOpts: import("./submit.js").TimesheetSubmitOptions = {
          confirm: options.confirm,
          output: options.output,
        };
        if (options.engagement !== undefined) submitOpts.engagement = options.engagement;
        await runTimesheetSubmit(id, submitOpts);
      },
    );
  markMutation(submitCmd);

  return cmd;
}

/**
 * Parse the positional `<id>` argument for `show`. Rejects empty /
 * whitespace-only strings — Commander would otherwise pass them
 * through. Mirrors the engagements group's `parseIdArg`.
 */
function parseIdArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new InvalidArgumentError("id must not be empty");
  }
  return trimmed;
}

/**
 * Optional-positional variant for `submit`. `undefined` flows through
 * (Commander hands us `undefined` when the positional was omitted);
 * a present-but-blank id is rejected so we don't silently use `""`.
 */
function parseIdArgOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return parseIdArg(value);
}
