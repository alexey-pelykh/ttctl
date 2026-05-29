// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { Command, Option } from "commander";

import { surveys } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { handleDomainError } from "../../lib/error-routing.js";
import { emitResult } from "../../lib/output.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Build the `ttctl surveys` command tree. One read-only leaf:
 *
 * | Leaf   | Description                                          |
 * |--------|------------------------------------------------------|
 * | `list` | List pending surveys (post-interview feedback, NPS…) |
 *
 * The write side — answering a survey — is a separate capability
 * (`surveys submit` / `surveys feedback`); `list` surfaces the survey
 * `id` / `kind` / `questions[]` those will consume.
 */
export function buildSurveysCommand(): Command {
  const cmd = new Command("surveys").description("View pending Toptal surveys (post-interview feedback, NPS, etc.)");

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

  return cmd;
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
