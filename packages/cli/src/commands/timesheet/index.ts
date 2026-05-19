// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { markMutation } from "../../lib/dry-run.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { parsePaginationFlag } from "../../lib/pagination.js";
import { runTimesheetList } from "./list.js";
import { runTimesheetPendingList } from "./pending/list.js";
import { runTimesheetShow } from "./show.js";
import { runTimesheetSubmit } from "./submit.js";

/**
 * Build the `ttctl timesheet` command tree (#13). Three leaves plus a
 * `pending` sub-tree (#374):
 *
 * | Leaf                             | Description                                       |
 * |----------------------------------|---------------------------------------------------|
 * | `list [--engagement <id>]`       | List timesheets (default: viewer-wide pending)    |
 * | `pending list [--limit N]`       | Viewer-wide pending timesheets, with --limit      |
 * | `show <id>`                      | One timesheet detail (id = BillingCycle.id)       |
 * | `submit [id] [--confirm]`        | Submit timesheet for billing (destructive)        |
 *
 * **Wire identity model**:
 *   - `BillingCycle.id` — the public "timesheet id" returned by
 *     `list` / `pending list` and consumed by `show` / `submit`.
 *   - `JobActivityItem.id` — the "engagement id" exposed by
 *     `engagements list`. Passed via `--engagement <id>` to scope
 *     `list` / `submit` auto-resolve to one engagement.
 *
 * **`pending list` surface-honest pagination divergence** (#374, per
 * ADR-007 row 3): the viewer-wide `PendingTimesheets` wire op accepts
 * ONLY a `pagination: { limit: Int }` input — no `offset`, no cursor —
 * so the CLI surfaces `--limit N` rather than the offset-style
 * `--page` / `--per-page` used by jobs / applications / engagements /
 * payouts. Documented in `CHANGELOG.md` and ADR-007.
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
    .description("List timesheet billing cycles (default: viewer-wide pending)")
    .option("--engagement <id>", "scope to one engagement (jobActivityItem.id from `engagements list`)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { engagement?: string; output: OutputFormat }) => {
      const listOpts: import("./list.js").TimesheetListOptions = { output: options.output };
      if (options.engagement !== undefined) listOpts.engagement = options.engagement;
      await runTimesheetList(listOpts);
    });

  // `ttctl timesheet pending list [--limit N]` (#374) — viewer-wide pending
  // pagination with the surface-honest `--limit` flag (the wire field is
  // `LimitPagination`, NO `offset`). See ADR-007 row 3 for the grammar.
  const pending = cmd.command("pending").description("Viewer-wide pending timesheets (limit-only pagination)");

  pending
    .command("list")
    .description("List viewer-wide pending timesheet billing cycles (limit-only pagination)")
    .addOption(
      new Option(
        "--limit <number>",
        "max pending cycles to return (default: 50, the historical wire default)",
      ).argParser((raw) => parsePaginationFlag("--limit", raw)),
    )
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { limit?: number; output: OutputFormat }) => {
      const listOpts: import("./pending/list.js").TimesheetPendingListOptions = { output: options.output };
      if (options.limit !== undefined) listOpts.limit = options.limit;
      await runTimesheetPendingList(listOpts);
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
