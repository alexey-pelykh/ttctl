// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { engagements } from "@ttctl/core";

import { markMutation } from "../../lib/dry-run.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { parsePaginationFlag } from "../../lib/pagination.js";
import {
  runEngagementsBreaksAdd,
  runEngagementsBreaksList,
  runEngagementsBreaksRemove,
  runEngagementsBreaksReschedule,
  runEngagementsBreaksReasonsList,
} from "./breaks.js";
import { runEngagementsList } from "./list.js";
import { runEngagementsShow } from "./show.js";
import { runEngagementsStats } from "./stats.js";

/**
 * Page-number / page-size option factories (#375, following the #183
 * per-leaf pattern). The `list` leaf declares its own copy of
 * `--page` / `--per-page`; the parser (`parsePaginationFlag`) and
 * descriptions are shared via these factories so the engagements
 * surface stays byte-identical with the jobs surface in `--help`
 * output.
 */
function pageOption(): Option {
  return new Option("--page <number>", "page number (1-indexed)").argParser((raw) =>
    parsePaginationFlag("--page", raw),
  );
}

function perPageOption(): Option {
  return new Option("--per-page <number>", "items per page").argParser((raw) => parsePaginationFlag("--per-page", raw));
}

/**
 * Build the `ttctl engagements` command tree (#147, extended by #155).
 * Seven leaves across the top-level group and one nested sub-group
 * (`breaks`):
 *
 * | Leaf                                              | Description                              |
 * |---------------------------------------------------|------------------------------------------|
 * | `list [--status active|past|all]`                 | List engagements (active by default)     |
 * | `show <id>`                                       | Engagement detail                        |
 * | `stats`                                           | Per-engagement-status counts             |
 * | `breaks list <id>`                                | List breaks on an engagement             |
 * | `breaks add <id> --from <date> --to <date>`       | Schedule a break                         |
 * | `breaks remove <break-id>`                        | Cancel a break                           |
 * | `breaks reschedule <break-id> --from <date> --to <date>` | Move an existing break to a new window |
 *
 * `<id>` is always the `jobActivityItem.id` (the row id from
 * `engagements list`); `<break-id>` is the `engagementBreak.id` (from
 * `breaks list`).
 *
 * **Out of scope for v1** (per #147 spec):
 *   - Engagement creation / acceptance / rejection (lives in
 *     `applications` group).
 *   - Allocated-hours management — moved to `availability` (#146)
 *     after the #147 scope amendment (2026-05-10), since the wire
 *     mutation operates on `viewerRole`, not per-engagement.
 */
export function buildEngagementsCommand(): Command {
  const cmd = new Command("engagements").description("View current and past engagements; manage engagement breaks");

  cmd
    .command("list")
    .description("List engagements (active by default)")
    .addOption(
      new Option("--status <status>", "filter by engagement status")
        .choices([...engagements.ENGAGEMENT_LIST_STATUSES])
        .default("active" satisfies engagements.EngagementListStatus),
    )
    .option("--keywords <keyword...>", "free-text keyword filter (repeatable; AND across keywords)")
    .addOption(pageOption())
    .addOption(perPageOption())
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: {
        status: engagements.EngagementListStatus;
        keywords?: string[];
        page?: number;
        perPage?: number;
        output: OutputFormat;
      }) => {
        const listOpts: import("./list.js").EngagementsListOptions = {
          status: options.status,
          output: options.output,
        };
        if (options.keywords !== undefined) listOpts.keywords = options.keywords;
        if (options.page !== undefined) listOpts.page = options.page;
        if (options.perPage !== undefined) listOpts.perPage = options.perPage;
        await runEngagementsList(listOpts);
      },
    );

  cmd
    .command("show")
    .description("Show one engagement by id (jobActivityItem.id)")
    .argument("<id>", "engagement id (the row id from `engagements list`)", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runEngagementsShow(id, options.output);
    });

  cmd
    .command("stats")
    .description("Per-engagement-status counts (issues 2 server calls in parallel)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runEngagementsStats(options.output);
    });

  // ----- Breaks sub-group ------------------------------------------------
  const breaks = cmd.command("breaks").description("Manage engagement breaks (scheduled time-off windows)");

  breaks
    .command("list")
    .description("List breaks on an engagement")
    .argument("<id>", "engagement id (the row id from `engagements list`)", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runEngagementsBreaksList(id, options.output);
    });

  // Marked as a mutation (issue #163) so the global `--dry-run` flag
  // routes through to `engagements.breaks.add()`'s `dryRun` option.
  markMutation(
    breaks
      .command("add")
      .description("Schedule a new break on an engagement")
      .argument("<id>", "engagement id (the row id from `engagements list`)", parseIdArg)
      .requiredOption("--from <date>", "start date (YYYY-MM-DD)")
      .requiredOption("--to <date>", "end date (YYYY-MM-DD)")
      .requiredOption(
        "--reason-id <id>",
        "server-side reason identifier (run `ttctl engagements breaks reasons list` for the live catalog; examples: `talent_on_vacation`, `client_needs_preparation`, `client_on_vacation`, `other`)",
      )
      .option("--comment <text>", "optional free-text comment")
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(
        async (
          id: string,
          options: {
            from: string;
            to: string;
            reasonId: string;
            comment?: string;
            output: OutputFormat;
          },
        ) => {
          const addOpts: import("./breaks.js").EngagementsBreaksAddOptions = {
            from: options.from,
            to: options.to,
            reasonId: options.reasonId,
            output: options.output,
          };
          if (options.comment !== undefined) addOpts.comment = options.comment;
          await runEngagementsBreaksAdd(id, addOpts);
        },
      ),
  );

  // Marked as a mutation (issue #163) so the global `--dry-run` flag
  // routes through to `engagements.breaks.remove()`'s `dryRun` option.
  markMutation(
    breaks
      .command("remove")
      .description("Cancel a scheduled break by id")
      .argument("<break-id>", "engagementBreak id (from `breaks list`)", parseIdArg)
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (breakId: string, options: { output: OutputFormat }) => {
        await runEngagementsBreaksRemove(breakId, options.output);
      }),
  );

  // Marked as a mutation (#155 inherits the #163 dry-run wiring) so the
  // global `--dry-run` flag routes through to
  // `engagements.breaks.reschedule()`'s `dryRun` option.
  markMutation(
    breaks
      .command("reschedule")
      .description("Move an existing break to a new date window (in-place; preserves reason and comment)")
      .argument("<break-id>", "engagementBreak id (from `breaks list`)", parseIdArg)
      .requiredOption("--from <date>", "new start date (YYYY-MM-DD)")
      .requiredOption("--to <date>", "new end date (YYYY-MM-DD)")
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (breakId: string, options: { from: string; to: string; output: OutputFormat }) => {
        await runEngagementsBreaksReschedule(breakId, {
          from: options.from,
          to: options.to,
          output: options.output,
        });
      }),
  );

  // ----- Reasons sub-group (issue #156) ----------------------------------
  // Discovery surface for valid `--reason-id` values. Only read-only,
  // so no mutation marking needed.
  const reasons = breaks
    .command("reasons")
    .description("Discovery: list the valid `--reason-id` values for `breaks add`");

  reasons
    .command("list")
    .description("List the server-side catalog of valid `breaks add --reason-id` values, sorted by id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runEngagementsBreaksReasonsList(options.output);
    });

  return cmd;
}

/**
 * Reject empty or whitespace-only id arguments at parse time. Mirrors
 * the applications group's `parseIdArg`.
 */
function parseIdArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("id must not be empty");
  }
  return trimmed;
}
