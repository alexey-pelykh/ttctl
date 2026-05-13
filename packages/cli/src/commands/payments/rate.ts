// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { payments } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitAddSuccess, emitDryRunSuccess, wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handlePaymentsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Stderr message emitted when `rate change` is invoked without
 * `--confirm`. Matches the safety pattern of other mutations.
 */
const NO_CONFIRM_NOTE =
  "`rate change` requires `--confirm` (state-changing). Pass `--confirm` explicitly to acknowledge.";

/**
 * Action handler for `ttctl payments rate show`. Shows the current rate
 * + most-recent / ongoing rate-change request + market insight +
 * validation rules as a unified projection.
 */
export async function runPaymentsRateShow(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("payments rate show", output);

  let proj: payments.RateProjection;
  try {
    proj = await payments.rate.show(token);
  } catch (err) {
    handlePaymentsError("payments rate show", err, output);
  }

  emitResult(proj, output, {
    pretty: (data) => formatRateShow(data),
  });
}

/**
 * Action handler for `ttctl payments rate questions`. Lists the form
 * questions the user must answer when submitting `rate change`. Mirrors
 * the `engagements breaks reasons list` discovery pattern.
 */
export async function runPaymentsRateQuestions(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("payments rate questions", output);

  let items: payments.RateQuestion[];
  try {
    items = await payments.rate.questions(token);
  } catch (err) {
    handlePaymentsError("payments rate questions", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatQuestionsBlock(data.items),
    table: (data) => formatQuestionsBlock(data.items),
    empty: { command: "payments.rate.questions" },
  });
}

/**
 * Action handler for `ttctl payments rate change`. Submits a rate
 * change request. Validation (kind/engagement combo) lives in the
 * service; the CLI gates on `--confirm` per the standard mutation
 * safety pattern + non-TTY refusal.
 *
 * `--answer <question-id> <value>` is the two-arg form (NOT
 * `<id>=<value>`) to avoid `=` collisions with TEXT-kind answer values.
 * Commander parses each repeat into a `[id, value]` pair via the
 * variadic-option parser; this handler reshapes the flat array into
 * the structured `answers[]` shape.
 *
 * Optional `--answer-comment <question-id> <text>` allows attaching a
 * comment to a previously-supplied answer when the picked option's
 * `commentRequired` is true (rare but present in the wire shape).
 */
export interface PaymentsRateChangeOptions {
  kind: payments.RateChangeKind;
  rate: string;
  engagement?: string;
  comment?: string;
  // Flat array from Commander: ["q1", "value1", "q2", "value2", ...]
  answer?: string[];
  answerComment?: string[];
  confirm?: boolean;
  output: OutputFormat;
}

export async function runPaymentsRateChange(opts: PaymentsRateChangeOptions): Promise<void> {
  // Confirmation gate — always refuse without `--confirm`, regardless
  // of TTY. The standard mutation safety pattern is "explicit confirm
  // flag, no interactive override"; keeping the surface deterministic
  // across TTY and non-TTY rules out an accidental apply from a stray
  // keystroke at the prompt.
  if (opts.confirm !== true) {
    process.stderr.write(`${NO_CONFIRM_NOTE}\n`);
    process.exit(1);
  }

  const token = await loadAuthTokenOrExit("payments rate change", opts.output);
  const dryRun = getCliDryRun();

  const answers = parseAnswerFlags(opts.answer ?? [], opts.answerComment ?? []);

  const changeOpts: payments.RateChangeOptions = {
    kind: opts.kind,
    desiredRate: opts.rate,
    answers,
  };
  if (opts.engagement !== undefined) changeOpts.engagementId = opts.engagement;
  if (opts.comment !== undefined) changeOpts.talentComment = opts.comment;

  let outcome: payments.RateChangeOutcome;
  try {
    outcome = await payments.rate.change(token, changeOpts, { dryRun });
  } catch (err) {
    handlePaymentsError("payments rate change", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "payments.rate.change",
      format: opts.output,
      preview: outcome.preview,
    });
    return;
  }

  const { result: created, notice } = outcome;
  emitAddSuccess({
    operation: "payments.rate.change",
    format: opts.output,
    created,
    prettySummary: `rate-change request ${created.id} (${created.requestType}, desired ${created.desiredRate})`,
    prettyEntity: (r) => formatRateChangeRequestEntity(r),
    notice: notice ?? undefined,
  });
}

/**
 * Parse the flat `--answer <q> <v>` repeats into structured
 * answers[]. `--answer-comment <q> <text>` repeats attach comments by
 * question id — the comment is matched to the most-recent `--answer`
 * with the same question id.
 *
 * Throws via `process.exit(1)` on malformed input (odd-length arrays).
 */
function parseAnswerFlags(answerFlat: string[], commentFlat: string[]): payments.RateChangeAnswerInput[] {
  if (answerFlat.length % 2 !== 0) {
    process.stderr.write(
      "`--answer` must be passed as `--answer <question-id> <value>` (two args per repeat). Example: `--answer q1 yes`.\n",
    );
    process.exit(1);
  }
  if (commentFlat.length % 2 !== 0) {
    process.stderr.write(
      "`--answer-comment` must be passed as `--answer-comment <question-id> <text>` (two args per repeat).\n",
    );
    process.exit(1);
  }

  const commentsByQ = new Map<string, string>();
  for (let i = 0; i < commentFlat.length; i += 2) {
    const qid = commentFlat[i] ?? "";
    const text = commentFlat[i + 1] ?? "";
    commentsByQ.set(qid, text);
  }

  const answers: payments.RateChangeAnswerInput[] = [];
  for (let i = 0; i < answerFlat.length; i += 2) {
    const questionId = answerFlat[i] ?? "";
    const value = answerFlat[i + 1] ?? "";
    const entry: payments.RateChangeAnswerInput = { questionId, value };
    const cmt = commentsByQ.get(questionId);
    if (cmt !== undefined) entry.comment = cmt;
    answers.push(entry);
  }
  return answers;
}

/**
 * Render `rate show` as a sectioned multi-line block.
 */
export function formatRateShow(p: payments.RateProjection): string {
  const lines: string[] = [];
  lines.push("Current rate");
  if (p.currentRateVerbose !== null) {
    lines.push(`  ${p.currentRateVerbose}`);
  } else if (p.currentRateDecimal !== null) {
    lines.push(`  ${p.currentRateDecimal}/hr`);
  } else {
    lines.push("  (no rate on file)");
  }

  if (p.validation !== null) {
    lines.push("");
    lines.push("Validation");
    if (p.validation.minRate !== null) lines.push(`  Min rate: ${p.validation.minRate}`);
    if (p.validation.rateStep !== null) lines.push(`  Step:     ${p.validation.rateStep}`);
  }

  if (p.marketInsight !== null) {
    lines.push("");
    lines.push("Market insight (hourly)");
    if (p.marketInsight.currentRateCompetitive !== null) {
      lines.push(`  Current rate vs market: ${p.marketInsight.currentRateCompetitive}`);
    }
    if (p.marketInsight.recommendedRate !== null) {
      lines.push(`  Recommended rate:       ${p.marketInsight.recommendedRate}`);
    }
    if (p.marketInsight.recentApplicationRate !== null) {
      lines.push(`  Recent app rate:        ${p.marketInsight.recentApplicationRate}`);
    }
  }

  if (p.ongoingChange !== null) {
    lines.push("");
    lines.push(`Ongoing rate-change request (${p.ongoingChange.statusVerbose})`);
    appendRateChangeRequestLines(lines, p.ongoingChange);
  }

  if (p.lastChange !== null && (p.ongoingChange === null || p.lastChange.id !== p.ongoingChange.id)) {
    lines.push("");
    lines.push(`Last rate-change request (${p.lastChange.statusVerbose})`);
    appendRateChangeRequestLines(lines, p.lastChange);
  }

  if (p.lastChange === null && p.ongoingChange === null) {
    lines.push("");
    lines.push("No rate-change history. Run `ttctl payments rate change --help` for the next step.");
  }

  return lines.join("\n");
}

function appendRateChangeRequestLines(lines: string[], r: payments.RateChangeRequest): void {
  lines.push(`  ID:           ${r.id}`);
  lines.push(`  Created:      ${r.createdAt}`);
  lines.push(`  Type:         ${r.requestType}`);
  lines.push(`  Desired rate: ${r.desiredRate}`);
  if (r.outcomeRate !== "" && r.outcomeRate !== r.desiredRate) {
    lines.push(`  Outcome rate: ${r.outcomeRate}`);
  }
  if (r.engagementId !== null) {
    const job = r.engagementTitle ?? "(untitled)";
    const client = r.clientName ?? "(no client)";
    lines.push(`  Engagement:   ${r.engagementId} — ${client} / ${job}`);
  }
  if (r.talentComment !== "") {
    lines.push(`  Comment:      ${r.talentComment}`);
  }
}

export function formatRateChangeRequestEntity(r: payments.RateChangeRequest): string {
  const lines: string[] = [];
  appendRateChangeRequestLines(lines, r);
  // The shared appender prefixes each line with two spaces (matching
  // the `rate show` sub-section format); `emitAddSuccess` adds its own
  // 2-space `indent()` on top. Strip the leading indent so the final
  // output has the correct nesting (matches `engagements breaks add`).
  return lines.map((l) => l.replace(/^ {2}/, "")).join("\n");
}

export function formatQuestionsBlock(items: payments.RateQuestion[]): string {
  if (items.length === 0) {
    return "(no questions returned by the server)";
  }
  const table = new Table({
    head: ["id", "kind", "label", "options"],
    colAligns: ["left", "left", "left", "left"],
    wordWrap: true,
  });
  for (const q of items) {
    const opts =
      q.options.length === 0
        ? "(free text)"
        : q.options.map((o) => `${o.label}${o.commentRequired ? " (comment required)" : ""}`).join(" / ");
    table.push([q.id, q.kind, q.label, opts]);
  }
  return table.toString();
}
