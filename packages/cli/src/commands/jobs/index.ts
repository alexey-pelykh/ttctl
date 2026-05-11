// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { markMutation } from "../../lib/dry-run.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import {
  runJobsClearInterest,
  runJobsMarkViewed,
  runJobsNotInterested,
  runJobsSave,
  runJobsUnsave,
} from "./interest.js";
import { runJobsList, runJobsNotInterestedList, runJobsSaved, runJobsViewed } from "./list.js";
import { runJobsSearchList, runJobsSearchRemove, runJobsSearchSave } from "./search.js";
import { runJobsShow } from "./show.js";

/**
 * Build the `ttctl jobs` command tree (#148). Surfaces ten verbs
 * across the top-level group and one nested sub-group (`search`):
 *
 * | Leaf                                                  | Description                                |
 * |-------------------------------------------------------|--------------------------------------------|
 * | `list [filters]`                                      | Browse current job opportunities           |
 * | `show <id>`                                           | Job detail view                            |
 * | `save <id>`                                           | Mark a job as saved (bookmark)             |
 * | `unsave <id>`                                         | Clear interest flags (the wire's only unsave path; also clears not-interested) |
 * | `saved`                                               | List saved jobs                            |
 * | `viewed`                                              | List jobs marked as viewed (first page, see R1) |
 * | `mark-viewed <id>`                                    | Explicitly mark a job as viewed            |
 * | `not-interested <id> --reason <text>`                 | Mark a job as not-interested with reason   |
 * | `not-interested-list`                                 | List jobs marked as not-interested         |
 * | `clear-interest <id>`                                 | Clear interest flags (alias of `unsave`)   |
 * | `search list`                                         | Show current job-search subscription       |
 * | `search save [--name <name>] [filters]`               | Start (or replace) the subscription        |
 * | `search remove [<id>]`                                | Terminate the subscription (id ignored)    |
 *
 * **Alias**: `opportunities` is registered as a top-level alias for
 * `jobs` (`ttctl opportunities list` works identically). The canonical
 * name is `jobs`. MCP tools do NOT alias — they use `ttctl_jobs_*`
 * prefix only per the AC.
 *
 * **Wire-shape notes**:
 *
 * - **R1**: `jobs viewed` is scoped to the first page (≤20 jobs) and
 *   filtered client-side. The wire has no `viewed: BooleanFilter`.
 * - **R2**: `jobs search` operates on a single subscription per user.
 *   `--name` and remove-`<id>` are advisory/ignored.
 *
 * **Out of scope for v1** (per #148):
 *   - Application funnel (`jobs apply` etc.) — lives in `applications`.
 *   - Bulk-save / bulk-dismiss (single-id only).
 *   - Pagination — wire supports it but v1 keeps default page.
 */
export function buildJobsCommand(): Command {
  const cmd = new Command("jobs")
    .alias("opportunities")
    .description("Browse job opportunities; manage saved/viewed/not-interested signals; manage search subscription");

  cmd
    .command("list")
    .description("List current job opportunities (page 0, default sort)")
    .option("--skill <skill...>", "filter by skill name (repeatable; AND across)")
    .option("--keyword <keyword...>", "free-text keyword filter (repeatable; AND across)")
    .option("--exclude-skill <skill...>", "exclude jobs requiring these skills (repeatable)")
    .option("--exclude-keyword <keyword...>", "exclude jobs matching these keywords (repeatable)")
    .option("--commitment <commitment...>", "filter by JobCommitmentFilterEnum (e.g. FULL_TIME, PART_TIME, repeatable)")
    .option("--work-type <type...>", "filter by JobWorkTypeSlug (e.g. REMOTE, ONSITE, repeatable)")
    .option(
      "--estimated-length <length...>",
      "filter by EstimatedLengthFilterEnum (e.g. SHORT_TERM, LONG_TERM, repeatable)",
    )
    .option("--sort <target>", 'sort target (e.g. "visible_at", "posted_at")')
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: {
        skill?: string[];
        keyword?: string[];
        excludeSkill?: string[];
        excludeKeyword?: string[];
        commitment?: string[];
        workType?: string[];
        estimatedLength?: string[];
        sort?: string;
        output: OutputFormat;
      }) => {
        const listOpts: import("./list.js").JobsListOptions = { output: options.output };
        if (options.skill !== undefined) listOpts.skills = options.skill;
        if (options.keyword !== undefined) listOpts.keywords = options.keyword;
        if (options.excludeSkill !== undefined) listOpts.excludeSkills = options.excludeSkill;
        if (options.excludeKeyword !== undefined) listOpts.excludeKeywords = options.excludeKeyword;
        if (options.commitment !== undefined) listOpts.commitments = options.commitment;
        if (options.workType !== undefined) listOpts.workTypes = options.workType;
        if (options.estimatedLength !== undefined) listOpts.estimatedLengths = options.estimatedLength;
        if (options.sort !== undefined) listOpts.sortTarget = options.sort;
        await runJobsList(listOpts);
      },
    );

  cmd
    .command("show")
    .description("Show one job by id")
    .argument("<id>", "job id (from `jobs list`)", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runJobsShow(id, options.output);
    });

  // Marked as a mutation (issue #162) so the global `--dry-run` flag
  // routes through to `jobs.save()`'s `dryRun` option.
  markMutation(
    cmd
      .command("save")
      .description("Save a job (bookmark)")
      .argument("<id>", "job id (from `jobs list`)", parseIdArg)
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (id: string, options: { output: OutputFormat }) => {
        await runJobsSave(id, options.output);
      }),
  );

  // Marked as a mutation (issue #162) — routes `--dry-run` through
  // `jobs.unsave()` → `jobs.clearInterest()` (wire op `JobClearInterest`).
  markMutation(
    cmd
      .command("unsave")
      .description("Remove a job from saved (clears all interest flags — see R1 note in `--help`)")
      .argument("<id>", "job id (from `jobs saved`)", parseIdArg)
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (id: string, options: { output: OutputFormat }) => {
        await runJobsUnsave(id, options.output);
      }),
  );

  cmd
    .command("saved")
    .description("List saved jobs")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runJobsSaved(options.output);
    });

  cmd
    .command("viewed")
    .description("List jobs marked as viewed (scoped to first page ≤20 — see R1)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runJobsViewed(options.output);
    });

  // Marked as a mutation (issue #162) so the global `--dry-run` flag
  // routes through to `jobs.markViewed()`'s `dryRun` option.
  markMutation(
    cmd
      .command("mark-viewed")
      .description("Explicitly mark a job as viewed (UI normally auto-marks on detail-page open)")
      .argument("<id>", "job id", parseIdArg)
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (id: string, options: { output: OutputFormat }) => {
        await runJobsMarkViewed(id, options.output);
      }),
  );

  // Marked as a mutation (issue #162) so the global `--dry-run` flag
  // routes through to `jobs.notInterested()`'s `dryRun` option.
  markMutation(
    cmd
      .command("not-interested")
      .description("Mark a job as not-interested with a reason")
      .argument("<id>", "job id (from `jobs list`)", parseIdArg)
      .requiredOption("--reason <text>", "reason for dismissing (free-text; server requires non-empty)")
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (id: string, options: { reason: string; output: OutputFormat }) => {
        await runJobsNotInterested(id, { reason: options.reason, output: options.output });
      }),
  );

  cmd
    .command("not-interested-list")
    .description("List jobs marked as not-interested")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runJobsNotInterestedList(options.output);
    });

  // Marked as a mutation (issue #162) so the global `--dry-run` flag
  // routes through to `jobs.clearInterest()`'s `dryRun` option.
  markMutation(
    cmd
      .command("clear-interest")
      .description("Clear interest flags on a job (alias of `unsave` — explicit name for un-not-interested)")
      .argument("<id>", "job id", parseIdArg)
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (id: string, options: { output: OutputFormat }) => {
        await runJobsClearInterest(id, options.output);
      }),
  );

  // ----- Search sub-group ------------------------------------------------
  const search = cmd.command("search").description("Manage the job-search subscription (single per user — see R2)");

  search
    .command("list")
    .description("Show the current job-search subscription (returns 0-or-1 envelope)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runJobsSearchList(options.output);
    });

  // Marked as a mutation (issue #162) so the global `--dry-run` flag
  // routes through to `jobs.searchSubscriptionSave()`'s `dryRun` option.
  markMutation(
    search
      .command("save")
      .description("Start (or replace) the job-search subscription with the given filters")
      .option("--name <name>", "advisory name (cosmetic — not stored server-side, see R2)")
      .option("--skill <skill...>", "filter by skill name (repeatable)")
      .option("--keyword <keyword...>", "filter by keyword (repeatable)")
      .option("--exclude-skill <skill...>", "exclude skills (repeatable)")
      .option("--exclude-keyword <keyword...>", "exclude keywords (repeatable)")
      .option("--commitment <commitment...>", "commitment values (repeatable)")
      .option("--work-type <type...>", "work-type values (repeatable)")
      .option("--estimated-length <length...>", "estimated-length values (repeatable)")
      .option("--exclude-unspecified-budget", "exclude jobs with no budget")
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(
        async (options: {
          name?: string;
          skill?: string[];
          keyword?: string[];
          excludeSkill?: string[];
          excludeKeyword?: string[];
          commitment?: string[];
          workType?: string[];
          estimatedLength?: string[];
          excludeUnspecifiedBudget?: boolean;
          output: OutputFormat;
        }) => {
          const saveOpts: import("./search.js").JobsSearchSaveOptions = { output: options.output };
          if (options.name !== undefined) saveOpts.name = options.name;
          if (options.skill !== undefined) saveOpts.skills = options.skill;
          if (options.keyword !== undefined) saveOpts.keywords = options.keyword;
          if (options.excludeSkill !== undefined) saveOpts.excludeSkills = options.excludeSkill;
          if (options.excludeKeyword !== undefined) saveOpts.excludeKeywords = options.excludeKeyword;
          if (options.commitment !== undefined) saveOpts.commitments = options.commitment;
          if (options.workType !== undefined) saveOpts.workTypes = options.workType;
          if (options.estimatedLength !== undefined) saveOpts.estimatedLengths = options.estimatedLength;
          if (options.excludeUnspecifiedBudget !== undefined) {
            saveOpts.excludeUnspecifiedBudget = options.excludeUnspecifiedBudget;
          }
          await runJobsSearchSave(saveOpts);
        },
      ),
  );

  // Marked as a mutation (issue #162) so the global `--dry-run` flag
  // routes through to `jobs.searchSubscriptionRemove()`'s `dryRun` option.
  markMutation(
    search
      .command("remove")
      .description("Terminate the active job-search subscription (id ignored — only one exists)")
      .argument("[id]", "ignored (kept for API symmetry — see R2)")
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (id: string | undefined, options: { output: OutputFormat }) => {
        await runJobsSearchRemove(id, options.output);
      }),
  );

  return cmd;
}

function parseIdArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("id must not be empty");
  }
  return trimmed;
}
