// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { applications } from "@ttctl/core";

import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { runApplicationsList } from "./list.js";
import { runApplicationsShow } from "./show.js";
import { runApplicationsStats } from "./stats.js";

/**
 * Build the `ttctl applications` command tree. Read-only access to the
 * user's Toptal Talent **Activity** view (which Toptal colloquially
 * calls "applications"). Three leaves:
 *
 * | Leaf      | Description                                                |
 * |-----------|------------------------------------------------------------|
 * | `list`    | List recent activity rows (filterable by status group)     |
 * | `show <id>` | Detail view for one row                                  |
 * | `stats`   | Per-status-group counts (5 server calls in parallel)       |
 *
 * Per project non-goals (#15): no apply / withdraw / edit operations
 * are exposed. The CLI is read-only by design.
 *
 * **Out of scope for v1** (see `.tmp/workitem-15.md` § Open Questions):
 * `--from` / `--to` date filters and `--page` / `--per-page` pagination
 * — captured operation accepts neither. Pagination will land via #138.
 */
export function buildApplicationsCommand(): Command {
  const cmd = new Command("applications").description(
    "View your Toptal Talent activity (applications, availability requests, interviews, engagements)",
  );

  cmd
    .command("list")
    .description("List recent activity rows")
    .option("--keywords <keyword...>", "free-text keyword filter (repeatable; AND across keywords)")
    .addOption(
      new Option("--status-group <group...>", "filter by status group (repeatable; OR across groups)").choices([
        ...applications.STATUS_GROUPS,
      ]),
    )
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: { keywords?: string[]; statusGroup?: applications.StatusGroup[]; output: OutputFormat }) => {
        // `exactOptionalPropertyTypes: true` — build additively to keep
        // omitted-vs-undefined semantics straight at the API boundary.
        const listOpts: import("./list.js").ApplicationsListOptions = {
          output: options.output,
        };
        if (options.keywords !== undefined) listOpts.keywords = options.keywords;
        if (options.statusGroup !== undefined) listOpts.statusGroups = options.statusGroup;
        await runApplicationsList(listOpts);
      },
    );

  cmd
    .command("show")
    .description("Show one activity row by id")
    .argument("<id>", "id of the activity row to show", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runApplicationsShow(id, options.output);
    });

  cmd
    .command("stats")
    .description("Per-status-group activity counts (issues 5 server calls in parallel)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runApplicationsStats(options.output);
    });

  return cmd;
}

/**
 * Reject empty or whitespace-only id arguments at parse time so the
 * service layer doesn't have to handle them defensively. Commander
 * surfaces `InvalidArgumentError` as a clean `error: invalid argument
 * <id>: <message>` line and a non-zero exit, NOT the structured
 * envelope — argument-validation errors are pre-action and don't carry
 * an operation context.
 */
function parseIdArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("id must not be empty");
  }
  return trimmed;
}
