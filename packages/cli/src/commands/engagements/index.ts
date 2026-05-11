// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { engagements } from "@ttctl/core";

import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { runEngagementsBreaksAdd, runEngagementsBreaksList, runEngagementsBreaksRemove } from "./breaks.js";
import { runEngagementsList } from "./list.js";
import { runEngagementsShow } from "./show.js";
import { runEngagementsStats } from "./stats.js";

/**
 * Build the `ttctl engagements` command tree (#147). Six leaves across
 * the top-level group and one nested sub-group (`breaks`):
 *
 * | Leaf                                         | Description                                 |
 * |----------------------------------------------|---------------------------------------------|
 * | `list [--status active|past|all]`            | List engagements (active by default)        |
 * | `show <id>`                                  | Engagement detail                           |
 * | `stats`                                      | Per-engagement-status counts                |
 * | `breaks list <id>`                           | List breaks on an engagement                |
 * | `breaks add <id> --from <date> --to <date>`  | Schedule a break                            |
 * | `breaks remove <break-id>`                   | Cancel a break                              |
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
 *   - Reschedule break (operation exists but isn't surfaced in v1;
 *     `remove` + `add` covers the same use case).
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
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: { status: engagements.EngagementListStatus; keywords?: string[]; output: OutputFormat }) => {
        const listOpts: import("./list.js").EngagementsListOptions = {
          status: options.status,
          output: options.output,
        };
        if (options.keywords !== undefined) listOpts.keywords = options.keywords;
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

  breaks
    .command("add")
    .description("Schedule a new break on an engagement")
    .argument("<id>", "engagement id (the row id from `engagements list`)", parseIdArg)
    .requiredOption("--from <date>", "start date (YYYY-MM-DD)")
    .requiredOption("--to <date>", "end date (YYYY-MM-DD)")
    .requiredOption(
      "--reason-id <id>",
      "server-side reason identifier (e.g. `talent_on_vacation`, `client_needs_preparation`, `client_on_vacation`, `other`)",
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
    );

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
