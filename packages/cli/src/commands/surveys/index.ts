// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { Command, Option } from "commander";

import { surveys } from "@ttctl/core";

import { emitUpdateSuccess, wrapListEnvelope } from "../../lib/envelopes.js";
import { handleDomainError } from "../../lib/error-routing.js";
import { emitResult } from "../../lib/output.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Build the `ttctl surveys` command tree:
 *
 * | Leaf     | Description                                          |
 * |----------|------------------------------------------------------|
 * | `list`   | List pending surveys (post-interview feedback, NPS…) |
 * | `submit` | Submit answers to a pending survey (irreversible)    |
 *
 * `submit` consumes `list` to resolve the survey `kind` and per-question
 * answer-option ids; the remaining write leaf (`surveys feedback`,
 * `AddSurveyFeedback`) is a separate capability.
 */
export function buildSurveysCommand(): Command {
  const cmd = new Command("surveys").description(
    "View and answer pending Toptal surveys (post-interview feedback, NPS, etc.)",
  );

  cmd
    .command("list")
    .description("List pending surveys")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runSurveysList(options.output);
    });

  cmd
    .command("submit <surveyId>")
    .description("Submit answers to a pending survey (IRREVERSIBLE — requires --consent-survey-submission)")
    .option(
      "-a, --answer <questionId=value>",
      "an answer as `<questionId>=<value>` (repeatable). For a multiple-choice question, value is the option value from `surveys list`; for a free-text question, value is the text.",
      collectAnswer,
      [],
    )
    .option("--kind <kind>", "survey kind override (resolved from `surveys list` when omitted)")
    .option("--consent-survey-submission", "acknowledge that this irreversibly submits your answers to Toptal", false)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (
        surveyId: string,
        options: { answer: string[]; kind?: string; consentSurveySubmission: boolean; output: OutputFormat },
      ) => {
        await runSurveysSubmit(surveyId, options);
      },
    );

  return cmd;
}

/** Commander reducer for the repeatable `--answer` option. */
function collectAnswer(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

/**
 * Action handler for `ttctl surveys list`. Returns the surveys in the
 * v1.0 list envelope on `--json` / `--yaml`; renders a `cli-table3`
 * table on `--output=pretty`. An empty list is a legitimate result.
 */
export async function runSurveysList(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("surveys list", output);

  let items: surveys.Survey[];
  try {
    items = await surveys.list(token);
  } catch (err) {
    handleSurveysError("surveys list", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatSurveysTable(data.items),
    table: (data) => formatSurveysTable(data.items),
    empty: { command: "surveys.list" },
  });
}

/**
 * Action handler for `ttctl surveys submit`. Parses the repeatable
 * `--answer` pairs, then delegates to `surveys.submit` (which resolves
 * `kind` + answer-option ids from `surveys list` and applies the consent
 * gate). Emits the update envelope — submission is a state transition.
 */
export async function runSurveysSubmit(
  surveyId: string,
  options: { answer: string[]; kind?: string; consentSurveySubmission: boolean; output: OutputFormat },
): Promise<void> {
  const token = await loadAuthTokenOrExit("surveys submit", options.output);

  let result: surveys.SubmitSurveyResult;
  try {
    const answers = parseAnswerPairs(options.answer);
    // Static type only permits the `true` literal; the runtime gate at the
    // service entry covers the `false` case (operator omits the flag). The
    // cast widens the static type so the literal `false` path type-checks.
    const consent = {
      surveySubmissionConsentIssued: options.consentSurveySubmission,
    } as unknown as { surveySubmissionConsentIssued: true };
    const args: surveys.SubmitSurveyArgs =
      options.kind === undefined ? { surveyId, answers } : { surveyId, answers, kind: options.kind };
    result = await surveys.submit(token, args, consent);
  } catch (err) {
    handleSurveysError("surveys submit", err, options.output);
  }

  emitUpdateSuccess({
    operation: "surveys.submit",
    format: options.output,
    updated: result,
    prettySummary: `Survey submitted. ${result.pendingSurveys.length.toString()} pending survey(s) remaining.`,
    notice: result.notice ?? undefined,
  });
}

/**
 * Parse the repeatable `--answer <questionId>=<value>` flags into
 * `RawSurveyAnswer`s. Splits on the first `=` so values may contain `=`.
 * Throws `SurveysError(VALIDATION_ERROR)` on an empty set or a malformed pair.
 */
function parseAnswerPairs(pairs: string[]): surveys.RawSurveyAnswer[] {
  if (pairs.length === 0) {
    throw new surveys.SurveysError("VALIDATION_ERROR", "At least one --answer <questionId>=<value> is required.");
  }
  return pairs.map((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new surveys.SurveysError("VALIDATION_ERROR", `Invalid --answer "${pair}"; expected <questionId>=<value>.`);
    }
    return { questionId: pair.slice(0, eq), value: pair.slice(eq + 1) };
  });
}

/**
 * Render the surveys list as a `cli-table3` table. Columns: id, kind,
 * title, mandatory, answered, question count. The full `questions[]`
 * (with answer options) surfaces only in `--json` / `--yaml`.
 */
export function formatSurveysTable(
  items: surveys.Survey[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  const head = ["id", "kind", "title", "mand.", "answ.", "q#"];
  if (items.length === 0) {
    return new Table({ head }).toString();
  }
  const idWidth = 22;
  const kindWidth = 22;
  const mandWidth = 7;
  const answWidth = 7;
  const qWidth = 5;
  // 6 columns × 2 padding + 7 borders ≈ 19
  const remaining = Math.max(15, terminalWidth - idWidth - kindWidth - mandWidth - answWidth - qWidth - 19);
  const titleWidth = Math.max(15, remaining);
  const table = new Table({
    head,
    colWidths: [idWidth, kindWidth, titleWidth, mandWidth, answWidth, qWidth],
    colAligns: ["left", "left", "left", "center", "center", "right"],
    wordWrap: true,
  });
  for (const s of items) {
    table.push([
      s.id,
      s.kind ?? "—",
      s.title ?? "—",
      boolMarker(s.isMandatory),
      boolMarker(s.alreadyAnswered),
      s.questions.length.toString(),
    ]);
  }
  return table.toString();
}

/**
 * Map a nullable boolean to a compact table-cell marker: `★` for true,
 * empty for false, `?` for null (forward-compat for INFERRED nullability).
 */
export function boolMarker(value: boolean | null): string {
  if (value === null) return "?";
  return value ? "★" : "";
}

/**
 * Thin wrapper around the shared CLI error router closed over
 * `surveys.SurveysError`. No per-code hint adapter — surveys codes carry
 * no actionable next-step beyond the message.
 */
export function handleSurveysError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, surveys.SurveysError, format);
}
