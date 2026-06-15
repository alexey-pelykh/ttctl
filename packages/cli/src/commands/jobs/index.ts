// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { markMutation } from "../../lib/dry-run.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { parsePaginationFlag } from "../../lib/pagination.js";
import { runJobsApply } from "./apply.js";
import {
  runJobsClearInterest,
  runJobsMarkViewed,
  runJobsNotInterested,
  runJobsSave,
  runJobsUnsave,
} from "./interest.js";
import { runJobsList, runJobsNotInterestedList, runJobsRecommended, runJobsSaved, runJobsViewed } from "./list.js";
import { runJobsMatchQuality } from "./match-quality.js";
import { runJobsSearchList, runJobsSearchRemove, runJobsSearchSave } from "./search.js";
import { runJobsShow, runJobsShowMany } from "./show.js";

/**
 * Page-number option factory (#183). Each paginating leaf declares its
 * own copy of `--page` / `--per-page`; the parser and description are
 * shared via these factories so the four surfaces stay byte-identical
 * in `--help` output.
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
 * Build the `ttctl jobs` command tree (#148; `apply` added in #430).
 * Surfaces eleven verbs across the top-level group and one nested
 * sub-group (`search`):
 *
 * | Leaf                                                  | Description                                |
 * |-------------------------------------------------------|--------------------------------------------|
 * | `list [filters]`                                      | Browse current job opportunities           |
 * | `show <id>`                                           | Job detail view                            |
 * | `match-quality <id>`                                  | Per-criterion match-quality breakdown      |
 * | `apply <id> --consent [...]`                          | Direct-apply to a job (DESTRUCTIVE — see ADR-008) |
 * | `save <id>`                                           | Mark a job as saved (bookmark)             |
 * | `unsave <id>`                                         | Clear interest flags (the wire's only unsave path; also clears not-interested) |
 * | `saved`                                               | List saved jobs                            |
 * | `viewed`                                              | List jobs marked as viewed (full-pool aggregation, see R1) |
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
 * - **R1**: `jobs viewed` iterates the FULL eligibleJobs pool and
 *   applies a client-side filter on `viewed` (the wire has no
 *   `viewed: BooleanFilter`; empirical from Toptal mobile-app
 *   decompile, see #372). `--page` / `--per-page` slice the
 *   POST-FILTER list; `pageInfo.totalCount` is the real count of
 *   viewed jobs. Cost: O(N/20) wire calls (capped at 50 internal
 *   pages); acceptable as a stop-gap until Toptal exposes a wire-
 *   level filter.
 * - **R2**: `jobs search` operates on a single subscription per user.
 *   `--name` and remove-`<id>` are advisory/ignored. `search list` is
 *   NOT a paginated leaf (returns 0-or-1 envelope).
 *
 * **Paginated leaves (#138, refactored per-command in #183)**: `list`,
 * `saved`, `viewed`, `not-interested-list` each declare their own
 * `--page <number>` / `--per-page <number>` (1-indexed positive
 * integers). All four share `JobsListResponse` and the
 * `eligibleJobs(page, pageSize)` wire path.
 *
 * **Application funnel write-side** (ADR-008, #430): `jobs apply <id>`
 * is the user-facing direct-apply verb; the underlying service module
 * is `applications.apply()` per ADR-008 § Decision Part 5 (the verb
 * lives on `jobs` for readability while the funnel-crossing
 * implementation lives on `applications`). The relaxation of the #15
 * read-only stance is tracked in
 * `hq/engineering/adr/ADR-008-application-funnel-write-side.md`.
 *
 * **Still out of scope** (per #148 + ADR-008 § What We're NOT Solving):
 *   - `JobApplication.withdraw` / `JobApplication.edit` — separate
 *     scope; Toptal support is uncertain.
 *   - Bulk-apply / bulk-save / bulk-dismiss (single-id only; matches
 *     the safety boundary established by #411 for IR ops).
 *   - Interview accept / reject — separate scope, separate catalog
 *     (`InterviewRejectReason`).
 */
export function buildJobsCommand(): Command {
  const cmd = new Command("jobs")
    .alias("opportunities")
    .description("Browse job opportunities; manage saved/viewed/not-interested signals; manage search subscription");

  cmd
    .command("list")
    .description("List current job opportunities (paginated via --page / --per-page; default sort)")
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
    .addOption(pageOption())
    .addOption(perPageOption())
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
        page?: number;
        perPage?: number;
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
        if (options.page !== undefined) listOpts.page = options.page;
        if (options.perPage !== undefined) listOpts.perPage = options.perPage;
        await runJobsList(listOpts);
      },
    );

  cmd
    .command("show")
    .description("Show one job by id")
    .argument("<id>", "job id (from `jobs list`)", parseIdArg)
    .option(
      "--with-questions",
      "additionally fetch and inline the job's matcher + expertise application questions (issue #437). See `Applying to jobs` in the README for the apply workflow.",
    )
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat; withQuestions?: boolean }) => {
      await runJobsShow(id, options.output, { withQuestions: options.withQuestions === true });
    });

  cmd
    .command("show-many")
    .description("Show several jobs by id in one batch fetch (≤20 ids; results in input order)")
    .argument("<id...>", "job ids (from `jobs list`)", parseIdsArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (ids: string[], options: { output: OutputFormat }) => {
      await runJobsShowMany(ids, options.output);
    });

  cmd
    .command("match-quality")
    .description("Show the platform's per-criterion match-quality breakdown for a job")
    .argument("<id>", "job id (from `jobs list`)", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runJobsMatchQuality(id, options.output);
    });

  cmd
    .command("recommended")
    .description("List algorithmically-recommended job opportunities (paginated via --page / --per-page)")
    .addOption(pageOption())
    .addOption(perPageOption())
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { page?: number; perPage?: number; output: OutputFormat }) => {
      const listOpts: import("./list.js").JobsRecommendedOptions = { output: options.output };
      if (options.page !== undefined) listOpts.page = options.page;
      if (options.perPage !== undefined) listOpts.perPage = options.perPage;
      await runJobsRecommended(listOpts);
    });

  // #430 — Direct-apply to a job. Per ADR-008 § Decision Part 5: the
  // CLI verb lives on `jobs` (reads naturally: "apply to a job") while
  // the underlying service module is `applications.apply()` — the
  // funnel-crossing implementation lives alongside the other apply-flow
  // write verbs (`applications confirm`, `applications reject` from
  // #411). `--consent` is REQUIRED (no default) per ADR-008 § Decision
  // Part 4 — the legal-compliance attestation cannot be auto-filled.
  //
  // Help text for the JSON-file flags mirrors `applications confirm`
  // (#428) since the ADR-008-locked grammar is identical across the
  // funnel's write surface. Per the recovered SDL (#438), matcher
  // answers carry the question id at `id` and expertise answers carry
  // it at `questionId` (with nullable `other` / `subjectId`) — both
  // shapes verbatim across confirm + apply.
  const APPLY_ANSWERS_FILE_HELP =
    "JSON file (or `-` for stdin) containing matcher/expertise answers. Shape:\n" +
    "  {\n" +
    '    "matcherAnswers": [{"id": "<questionIdentifier>", "answer": "<value>"}],\n' +
    '    "expertiseAnswers": [{"questionId": "<questionIdentifier>", "other": null, "subjectId": null}]\n' +
    "  }\n" +
    "Per the recovered SDL (#438): matcher answers carry the id at `id`; expertise answers carry it at `questionId`. " +
    "Question identifiers come from `jobs show <id> --with-questions` (or `jobs apply <id> --show-questions`). Stdin escape: `--answers-file -`.";
  const APPLY_PITCH_FILE_HELP =
    "JSON file (or `-` for stdin) containing the PitchInput payload (single JSON object). Stdin escape: `--pitch-file -`.";

  markMutation(
    cmd
      .command("apply")
      .description(
        "Apply to a job (DESTRUCTIVE — creates a JobApplication; no undo via TTCtl). `--consent` is REQUIRED and represents your acceptance of Toptal's apply terms (a legal-compliance attestation; auto-filling is forbidden). See `Applying to jobs` in the README for the full workflow.",
      )
      .argument("<id>", "job id (from `jobs list` / `jobs show`)", parseIdArg)
      .option(
        "--consent",
        "REQUIRED — your explicit acceptance of Toptal's apply terms (a legal-compliance attestation). Auto-filling on your behalf is forbidden per ADR-008. Absence raises CONSENT_REQUIRED with no wire call.",
      )
      .option(
        "--rate <decimal>",
        "requested hourly rate (decimal string, e.g. 80.00). Defaults from the rate-insight / suggested-rate context when omitted.",
      )
      .option("-m, --message <text>", "optional talent-side free-text accompanying the application")
      .option("--answers-file <path>", APPLY_ANSWERS_FILE_HELP)
      .option("--pitch-file <path>", APPLY_PITCH_FILE_HELP)
      .option(
        "--show-questions",
        "preview-only: fetch pre-apply data (canApply, suggestedRate) and the matcher/expertise question inventory WITHOUT issuing the apply mutation. Does not require --consent.",
      )
      .option(
        "--suggest-answers",
        "opt-in (#452): fetch the talent's historical answers to similar prior questions as advisory autocomplete suggestions. Off the critical path — does NOT auto-fill --answers-file; failures surface as a stderr warning and do not block apply. Works in --dry-run (suggestion fetch is suppressed alongside the apply call). Works with --show-questions (suggestion fetch runs against the question inventory).",
      )
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(
        async (
          id: string,
          options: {
            consent?: boolean;
            rate?: string;
            message?: string;
            answersFile?: string;
            pitchFile?: string;
            showQuestions?: boolean;
            suggestAnswers?: boolean;
            output: OutputFormat;
          },
        ) => {
          // exactOptionalPropertyTypes — build additively so omitted-vs-
          // undefined semantics stay clean at the API boundary.
          const runOpts: import("./apply.js").JobsApplyOptions = { output: options.output };
          if (options.consent !== undefined) runOpts.consent = options.consent;
          if (options.rate !== undefined) runOpts.rate = options.rate;
          if (options.message !== undefined) runOpts.message = options.message;
          if (options.answersFile !== undefined) runOpts.answersFile = options.answersFile;
          if (options.pitchFile !== undefined) runOpts.pitchFile = options.pitchFile;
          if (options.showQuestions !== undefined) runOpts.showQuestions = options.showQuestions;
          if (options.suggestAnswers !== undefined) runOpts.suggestAnswers = options.suggestAnswers;
          await runJobsApply(id, runOpts);
        },
      ),
  );

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
    .description("List saved jobs (paginated via --page / --per-page)")
    .addOption(pageOption())
    .addOption(perPageOption())
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { page?: number; perPage?: number; output: OutputFormat }) => {
      const listOpts: import("./list.js").JobsSavedOptions = { output: options.output };
      if (options.page !== undefined) listOpts.page = options.page;
      if (options.perPage !== undefined) listOpts.perPage = options.perPage;
      await runJobsSaved(listOpts);
    });

  cmd
    .command("viewed")
    .description("List jobs marked as viewed (full-pool aggregation + client-side filter — see R1)")
    .addOption(pageOption())
    .addOption(perPageOption())
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { page?: number; perPage?: number; output: OutputFormat }) => {
      const listOpts: import("./list.js").JobsViewedOptions = { output: options.output };
      if (options.page !== undefined) listOpts.page = options.page;
      if (options.perPage !== undefined) listOpts.perPage = options.perPage;
      await runJobsViewed(listOpts);
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
    .description("List jobs marked as not-interested (paginated via --page / --per-page)")
    .addOption(pageOption())
    .addOption(perPageOption())
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { page?: number; perPage?: number; output: OutputFormat }) => {
      const listOpts: import("./list.js").JobsNotInterestedListOptions = { output: options.output };
      if (options.page !== undefined) listOpts.page = options.page;
      if (options.perPage !== undefined) listOpts.perPage = options.perPage;
      await runJobsNotInterestedList(listOpts);
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

// Variadic accumulator for `<id...>`. Commander threads `previous` per
// value when a custom parser is supplied to a variadic argument, so the
// parser must accumulate (a single-value parser would yield only the
// last id). Trims + rejects empty ids per element, like `parseIdArg`.
function parseIdsArg(value: string, previous: string[] = []): string[] {
  return [...previous, parseIdArg(value)];
}
