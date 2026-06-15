// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { payments } from "@ttctl/core";

import { markMutation } from "../../lib/dry-run.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { parsePaginationFlag } from "../../lib/pagination.js";
import { runPaymentsMethodsList, runPaymentsMethodsShow } from "./methods.js";
import { runPaymentsPayoutsList, runPaymentsPayoutsShow } from "./payouts.js";
import {
  runPaymentsRateChange,
  runPaymentsRateCurrent,
  runPaymentsRateQuestions,
  runPaymentsRateShow,
} from "./rate.js";
import { runPaymentsShowMany } from "./show-many.js";
import { runPaymentsSummary } from "./summary.js";

/**
 * Page-number option factory (#373, mirroring jobs/index.ts #183).
 * `payouts list` declares its own `--page` / `--per-page`; the parser
 * (`parsePaginationFlag`) and description are shared with the jobs
 * leaves so the surfaces stay byte-identical in `--help` output.
 * Leaves whose wire op does not paginate simply do not declare the
 * flags (Commander then emits `error: unknown option '--page'`).
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
 * Build the `ttctl payments` command tree (#149, #447, #448). Nine
 * leaves — `summary` at the top level plus eight across three
 * sub-namespaces:
 *
 * | Leaf                                                       | Description                       |
 * |------------------------------------------------------------|-----------------------------------|
 * | `summary`                                                  | Aggregate payment totals (#448)    |
 * | `payouts list [--from <d>] [--to <d>]`                     | List historical payouts            |
 * | `payouts show <id>`                                        | Single payout detail               |
 * | `methods list`                                             | List configured payment methods    |
 * | `methods show <id>`                                        | Single payment method detail       |
 * | `rate current`                                             | Current hourly rate (lightweight, one query) (#447) |
 * | `rate show`                                                | Current rate + change-request status |
 * | `rate questions`                                           | Discovery: form questions for `rate change` |
 * | `rate change --kind=... --rate=... [...] --confirm`        | Submit rate-change request         |
 *
 * `<id>` is the entity id from the corresponding `list` leaf.
 *
 * **Per-issue scope refinements** (issue #149 comment 4441685270 —
 * post-investigation, ux-architect consultation):
 *   - Original `rate-change list` (no list endpoint exists) → replaced
 *     with `rate show` (unified projection) + `rate questions` (form
 *     discovery).
 *   - Original `rate-change request --engagement --new-rate` (missing
 *     3 of 5 mutation inputs) → replaced with `rate change --kind=...
 *     --rate=... [--engagement] [--comment] [--answer <q> <v>...]`.
 *
 * **Out of scope for v1** (per #149 spec):
 *   - Payment-method mutations (create / update / mark-as-preferred /
 *     remove).
 *   - Withdrawal request initiation.
 *   - Tax document generation / download.
 */
export function buildPaymentsCommand(): Command {
  const cmd = new Command("payments").description(
    "View payouts and aggregate totals, configured payment methods, and rate-change history; submit a rate-change request",
  );

  // ----- summary (top-level aggregate) ---------------------------------
  cmd
    .command("summary")
    .description("Show aggregate payment totals (paid / due / outstanding / overdue / on-hold / disputed)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runPaymentsSummary(options.output);
    });

  // ----- show-many (top-level batch fetch) -----------------------------
  // Batch sibling of `payouts show <id>` (the singular `Payment` fetch);
  // top-level rather than under `payouts` so the leaf maps cleanly to the
  // `ttctl_payments_show_many` MCP tool (#456).
  cmd
    .command("show-many")
    .description("Show several payments by id in one batch fetch (≤20 ids; results in input order)")
    .argument("<id...>", "payment ids (TalentPayment.id from `payments payouts list`)", parseIdsArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (ids: string[], options: { output: OutputFormat }) => {
      await runPaymentsShowMany(ids, options.output);
    });

  // ----- payouts sub-group ---------------------------------------------
  const payouts = cmd.command("payouts").description("Historical payouts (read-only)");

  payouts
    .command("list")
    .description(
      "List historical payouts (paginated via --page / --per-page; default: server order, most-recent first)",
    )
    .option("--from <date>", "filter by createdOn lower bound (inclusive YYYY-MM-DD)")
    .option("--to <date>", "filter by createdOn upper bound (inclusive YYYY-MM-DD)")
    .addOption(pageOption())
    .addOption(perPageOption())
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { from?: string; to?: string; page?: number; perPage?: number; output: OutputFormat }) => {
      const listOpts: import("./payouts.js").PaymentsPayoutsListOptions = { output: options.output };
      if (options.from !== undefined) listOpts.from = options.from;
      if (options.to !== undefined) listOpts.to = options.to;
      if (options.page !== undefined) listOpts.page = options.page;
      if (options.perPage !== undefined) listOpts.perPage = options.perPage;
      await runPaymentsPayoutsList(listOpts);
    });

  payouts
    .command("show")
    .description("Show one payout by id")
    .argument("<id>", "payout id (the row id from `payouts list`)", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runPaymentsPayoutsShow(id, options.output);
    });

  // ----- methods sub-group ---------------------------------------------
  const methods = cmd.command("methods").description("Configured payment methods (read-only)");

  methods
    .command("list")
    .description("List configured payment methods")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runPaymentsMethodsList(options.output);
    });

  methods
    .command("show")
    .description("Show one payment method by id")
    .argument("<id>", "payment method id (from `methods list`)", parseIdArg)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runPaymentsMethodsShow(id, options.output);
    });

  // ----- rate sub-group ------------------------------------------------
  const rate = cmd.command("rate").description("Current rate + rate-change requests");

  rate
    .command("current")
    .description("Show the talent's current hourly rate (lightweight; one query) (#447)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runPaymentsRateCurrent(options.output);
    });

  rate
    .command("show")
    .description("Show current rate, last/ongoing rate-change request, market insight, and validation rules")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runPaymentsRateShow(options.output);
    });

  rate
    .command("questions")
    .description("List the form questions required by `rate change` (discovery)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runPaymentsRateQuestions(options.output);
    });

  // Marked as a mutation (issue #163) so the global `--dry-run` flag
  // routes through to `payments.rate.change()`'s `dryRun` option.
  markMutation(
    rate
      .command("change")
      .description("Submit a rate-change request (requires `--confirm`)")
      .addOption(
        new Option("--kind <kind>", "rate-change kind")
          .choices([...payments.RATE_CHANGE_KINDS])
          .makeOptionMandatory(true),
      )
      .requiredOption("--rate <decimal>", "desired hourly rate (decimal, e.g. `95.0`)")
      .option("--engagement <id>", "engagement id (required for --kind=current-engagement; rejected for other kinds)")
      .option("--comment <text>", "optional free-text comment attached to the request")
      .option(
        "--answer <args...>",
        "answer to a form question, two args per repeat: `--answer <question-id> <value>` (repeatable; discover ids via `payments rate questions`)",
      )
      .option(
        "--answer-comment <args...>",
        "comment for a previously-supplied answer (when `commentRequired: true` on the picked option): `--answer-comment <question-id> <text>` (repeatable)",
      )
      .option("--confirm", "explicit confirmation (required — refuses without)")
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(
        async (options: {
          kind: payments.RateChangeKind;
          rate: string;
          engagement?: string;
          comment?: string;
          answer?: string[];
          answerComment?: string[];
          confirm?: boolean;
          output: OutputFormat;
        }) => {
          const changeOpts: import("./rate.js").PaymentsRateChangeOptions = {
            kind: options.kind,
            rate: options.rate,
            output: options.output,
          };
          if (options.engagement !== undefined) changeOpts.engagement = options.engagement;
          if (options.comment !== undefined) changeOpts.comment = options.comment;
          if (options.answer !== undefined) changeOpts.answer = options.answer;
          if (options.answerComment !== undefined) changeOpts.answerComment = options.answerComment;
          if (options.confirm !== undefined) changeOpts.confirm = options.confirm;
          await runPaymentsRateChange(changeOpts);
        },
      ),
  );

  return cmd;
}

/**
 * Reject empty or whitespace-only id arguments at parse time. Mirrors
 * the engagements/jobs groups' `parseIdArg`.
 */
function parseIdArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("id must not be empty");
  }
  return trimmed;
}

// Variadic `<id...>`: Commander invokes a custom parser once per value with
// the accumulator threaded as `previous`, so it must accumulate (a single-value
// parser would keep only the last id). Trims + rejects empties per element.
function parseIdsArg(value: string, previous: string[] = []): string[] {
  return [...previous, parseIdArg(value)];
}
