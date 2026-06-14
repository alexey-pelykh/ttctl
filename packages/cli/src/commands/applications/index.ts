// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { applications } from "@ttctl/core";

import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { parsePaginationFlag } from "../../lib/pagination.js";
import { runApplicationsAvailabilityRequestShow } from "./availability-request.js";
import { runApplicationsConfirm } from "./confirm.js";
import {
  runApplicationsInterviewGuideShow,
  runApplicationsInterviewNotesShow,
  runApplicationsInterviewShow,
} from "./interview.js";
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
 * Build the `ttctl applications` command tree — the user's Toptal Talent
 * **Activity** view (which Toptal colloquially calls "applications").
 * Read is primary; writes on the application funnel are in scope per
 * ADR-008 (`hq/engineering/adr/ADR-008-application-funnel-write-side.md`):
 * Interest Request confirm / reject and direct job application are in
 * scope; `withdraw` / `edit`, bulk apply, and interview accept / reject
 * remain out of scope. The command tree below is the authoritative leaf
 * inventory.
 *
 * Date filters (`--from` / `--to`) on `list` remain out of scope — the
 * captured `JobActivityItems` operation accepts no date args.
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
    '    "matcherAnswers": [{"id": "<questionIdentifier>", "answer": "<value>"}],\n' +
    '    "expertiseAnswers": [{"questionId": "<questionIdentifier>", "other": null, "subjectId": null}]\n' +
    "  }\n" +
    "Per the recovered SDL (#438): matcher answers carry the id at `id`; expertise answers carry it at `questionId`. " +
    "Question identifiers come from `applications show <activityId>` output. Stdin escape: `--answers-file -`.";
  const PITCH_FILE_HELP =
    "JSON file (or `-` for stdin) containing the PitchInput payload (single JSON object matching the recovered SDL shape). Stdin escape: `--pitch-file -`.";

  cmd
    .command("confirm")
    .description(
      "Confirm an Interest Request (DESTRUCTIVE — creates a JobApplication; no undo). See `Interest Requests` in the README for the full workflow.",
    )
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

  // #439 — Interview detail. Sibling sub-namespace `interview show <id>`
  // for the rich `TalentInterview` projection (interviewer, scheduled
  // slot, agenda link, prep-guide ref). The id comes from
  // `applications show <activityId>` output (the `Interview: <id>`
  // line). Read-only — no confirm / reject verbs (those remain
  // out-of-scope per ADR-008 § Decision).
  const interviewCmd = cmd
    .command("interview")
    .description("Interview detail (read-only). See `applications show <activityId>` for the id.");

  interviewCmd
    .command("show")
    .description("Show one interview by id")
    .argument("<id>", "id of the interview to show", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runApplicationsInterviewShow(id, options.output);
    });

  // #440 — Interview notes (portal-side `GetInterviewNotes`). Sub-sub-
  // namespace `interview notes show <jobId>` for the talent's prep
  // notes attached to an interview. Read-only.
  //
  // **Input is the JOB id, not the interview id** — the wire op takes
  // `$jobId: ID!` and traverses
  // `viewer.job(id).activityItem.interview.{id, kind, talentNotes}`.
  // Discover the job id via `applications interview show <interviewId>`
  // (the `Job → Job id` line) or `applications show <activityId>`.
  const notesCmd = interviewCmd
    .command("notes")
    .description("Interview prep notes (read-only). Sub-sub-namespace of `interview`.");

  notesCmd
    .command("show")
    .description(
      "Read the talent's prep notes for the interview attached to a job (input is the JOB id, NOT the interview id)",
    )
    .argument(
      "<jobId>",
      "TalentJob id (discover via `applications interview show <interviewId>` → `Job → Job id`)",
      parseIdArg,
    )
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (jobId: string, options: { output: OutputFormat }) => {
      await runApplicationsInterviewNotesShow(jobId, options.output);
    });

  // #470 — Interview prep guide (mobile-gateway `InterviewGuide`).
  // Sub-sub-namespace `interview guide show <interviewId>` for the
  // interview-prep guide content (sections + tips) attached to one
  // interview. Read-only.
  //
  // Sibling of `notes` — both deepen the `interview` namespace. Input
  // is the INTERVIEW id (the wire op takes `$interviewId: ID!`).
  // The `Prep guide → ID: <guideId>` line surfaced by
  // `applications interview show` is the back-pointer; the guide
  // CONTENT lives behind this leaf.
  const guideCmd = interviewCmd
    .command("guide")
    .description("Interview prep guide (sections + tips). Sub-sub-namespace of `interview`.");

  guideCmd
    .command("show")
    .description("Read the interview-prep guide content (sections + tips) for one interview")
    .argument(
      "<interviewId>",
      "Interview id (discover via `applications interview show <interviewId>` or `applications show <activityId>`)",
      parseIdArg,
    )
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (interviewId: string, options: { output: OutputFormat }) => {
      await runApplicationsInterviewGuideShow(interviewId, options.output);
    });

  // #442 — Availability-request detail. Sibling read-only sub-namespace
  // `availability-request show <id>` for the rich `AvailabilityRequest`
  // projection (status, kind, recruiter-pinned Fixed rate, recruiter
  // comment, lifecycle timestamps, job). The `<id>` is the
  // `AvailabilityRequest.id` from `applications show <activityId>`
  // output (the `Availability request: <id>` line) — the SAME id the
  // `confirm` / `reject` write-side leaves accept, NOT the activity-item
  // id. Read-only — the confirm / reject verbs are the write surface.
  const availabilityRequestCmd = cmd
    .command("availability-request")
    .description("Availability-request detail (read-only). See `applications show <activityId>` for the id.");

  availabilityRequestCmd
    .command("show")
    .description("Show one availability request by id")
    .argument("<id>", "AvailabilityRequest id (NOT the activity-item id)", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runApplicationsAvailabilityRequestShow(id, options.output);
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
