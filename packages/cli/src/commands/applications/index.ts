// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { applications } from "@ttctl/core";

import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { parsePaginationFlag } from "../../lib/pagination.js";
import { runApplicationsConfirm } from "./confirm.js";
import { runApplicationsList } from "./list.js";
import { runApplicationsReject } from "./reject.js";
import { runApplicationsRejectReasons } from "./reject-reasons.js";
import { runApplicationsShow } from "./show.js";
import { runApplicationsStats } from "./stats.js";

/**
 * Page-number option factory (#377, per-command flags per #183). The
 * `list` leaf declares its own `--page` / `--per-page`; the parser and
 * description are shared via these factories so the surface stays
 * byte-identical with the four jobs paginating leaves in `--help`
 * output (same `parsePaginationFlag` positive-integer enforcement).
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
 * Write operations on the application funnel are in scope per ADR-008
 * (ttctl) — `hq/engineering/adr/ADR-008-application-funnel-write-side.md`.
 * ADR-008 § Decision relaxes the #15 read-only non-goal and bounds the
 * write surface: Interest Request confirm / reject (shipped in #411)
 * and direct job application are in scope; `withdraw` / `edit`, bulk
 * apply, and interview accept / reject remain explicitly out of scope.
 *
 * **Pagination (#377)**: the `list` leaf declares `--page` /
 * `--per-page` (1-indexed positive integers; same `parsePaginationFlag`
 * enforcement as the jobs leaves per #183). `#377` added the
 * `$page` / `$pageSize` wire args to the hand-authored
 * `JobActivityItems` document.
 *
 * **Still out of scope** (see `.tmp/workitem-15.md` § Open Questions):
 * `--from` / `--to` date filters — captured operation accepts no date
 * args.
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
    .addOption(pageOption())
    .addOption(perPageOption())
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: {
        keywords?: string[];
        statusGroup?: applications.StatusGroup[];
        page?: number;
        perPage?: number;
        output: OutputFormat;
      }) => {
        // `exactOptionalPropertyTypes: true` — build additively to keep
        // omitted-vs-undefined semantics straight at the API boundary.
        const listOpts: import("./list.js").ApplicationsListOptions = {
          output: options.output,
        };
        if (options.keywords !== undefined) listOpts.keywords = options.keywords;
        if (options.statusGroup !== undefined) listOpts.statusGroups = options.statusGroup;
        if (options.page !== undefined) listOpts.page = options.page;
        if (options.perPage !== undefined) listOpts.perPage = options.perPage;
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

  // #411 — Interest Request write surface. Three leaves: confirm,
  // reject, reject-reasons. The `<id>` argument on confirm / reject is
  // the AvailabilityRequest id (NOT the activity-item id) — discover
  // it via `applications show <activityId>` (look for the "Availability
  // request: <id>" line).
  // #428 — answers-file / pitch-file help text. ADR-008 § Decision
  // Part 2 locks the JSON-file grammar; per the issue's AC the help
  // must document the JSON shape (5-line example), the question-id
  // discovery hint, and the stdin escape.
  const ANSWERS_FILE_HELP =
    "JSON file (or `-` for stdin) containing matcher/expertise answers. Shape:\n" +
    "  {\n" +
    '    "matcherAnswers": [{"questionId": "<id>", "answer": "<value>"}],\n' +
    '    "expertiseAnswers": [{"questionId": "<id>", "answer": "<value>"}]\n' +
    "  }\n" +
    "Question identifiers come from `applications show <activityId>` output. Stdin escape: `--answers-file -`.";
  const PITCH_FILE_HELP =
    "JSON file (or `-` for stdin) containing the PitchInput payload (single JSON object). Stdin escape: `--pitch-file -`.";

  cmd
    .command("confirm")
    .description("Confirm an Interest Request (DESTRUCTIVE — creates a JobApplication; no undo)")
    .argument("<id>", "AvailabilityRequest id (NOT the activity-item id)", parseIdArg)
    .option("-m, --message <text>", "optional talent free-text accompanying the confirmation")
    .option(
      "--rate <decimal>",
      "requested hourly rate (decimal string, e.g. 80.00). Auto-filled from the AR's Fixed rate when omitted; required for FLEXIBLE / MARKETPLACE_FLEXIBLE ARs",
    )
    .addOption(
      new Option("--kind <kind>", "AR kind (auto-detected from metadata when omitted)").choices([
        ...applications.AVAILABILITY_REQUEST_KINDS,
      ]),
    )
    .option("--answers-file <path>", ANSWERS_FILE_HELP)
    .option("--pitch-file <path>", PITCH_FILE_HELP)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (
        id: string,
        options: {
          message?: string;
          rate?: string;
          kind?: applications.AvailabilityRequestKind;
          answersFile?: string;
          pitchFile?: string;
          output: OutputFormat;
        },
      ) => {
        const runOpts: import("./confirm.js").ApplicationsConfirmOptions = { output: options.output };
        if (options.message !== undefined) runOpts.message = options.message;
        if (options.rate !== undefined) runOpts.rate = options.rate;
        if (options.kind !== undefined) runOpts.kind = options.kind;
        if (options.answersFile !== undefined) runOpts.answersFile = options.answersFile;
        if (options.pitchFile !== undefined) runOpts.pitchFile = options.pitchFile;
        await runApplicationsConfirm(id, runOpts);
      },
    );

  cmd
    .command("reject")
    .description("Reject an Interest Request (DESTRUCTIVE — terminal ARCHIVED state; no undo)")
    .argument("<id>", "AvailabilityRequest id (NOT the activity-item id)", parseIdArg)
    .requiredOption("--reason <key>", "decline reason key (see `applications reject-reasons` for the inventory)")
    .option("-c, --comment <text>", "optional accompanying free-text (required for mandatory reasons)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { reason: string; comment?: string; output: OutputFormat }) => {
      const runOpts: import("./reject.js").ApplicationsRejectOptions = {
        reason: options.reason,
        output: options.output,
      };
      if (options.comment !== undefined) runOpts.comment = options.comment;
      await runApplicationsReject(id, runOpts);
    });

  cmd
    .command("reject-reasons")
    .description("List the Interest Request decline-reason inventory (server-localised; read-only)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runApplicationsRejectReasons(options.output);
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
