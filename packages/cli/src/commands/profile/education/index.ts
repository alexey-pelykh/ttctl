// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { DateInputError, parseDateInput, profile } from "@ttctl/core";
import { Command, Option } from "commander";

import {
  emitAddSuccess,
  emitErrorAndExit,
  emitRemoveSuccess,
  emitUpdateSuccess,
  wrapListEnvelope,
} from "../../../lib/envelopes.js";
import { OUTPUT_FORMATS, emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, presentSubDomainError } from "../shared.js";

/**
 * Build the `ttctl profile education` command tree.
 *
 * Five leaves:
 *   - `add --institution --degree [--from --to]`
 *   - `update <id> [field-flags]`
 *   - `remove <id>`
 *   - `show <id> [-o text|json|table]`
 *   - `highlight <id>`
 *
 * Date input flags (`--from`, `--to`) accept ISO-8601 (`2023-01-15`) or
 * year-only (`2023`); the date helper at `core/src/lib/date.ts` enforces
 * format and rejects impossible calendar dates. Education stores year
 * only, so the month/day are dropped before sending to the API.
 */
export function buildProfileEducationCommand(): Command {
  const education = new Command("education").description("View and update the education section of your profile");

  education
    .command("add")
    .description("Add a new education entry to your profile")
    .requiredOption("--institution <name>", "school / university name")
    .requiredOption("--degree <type>", "degree (e.g. BSc, MSc, PhD)")
    .option("--from <date>", "start date — ISO-8601 (YYYY-MM-DD) or year (YYYY)")
    .option("--to <date>", "end date — ISO-8601 (YYYY-MM-DD) or year (YYYY)")
    .option("--field-of-study <text>", "field of study (optional)")
    .option("--location <text>", "city / country (optional)")
    .option("--title <text>", "thesis or program title (optional)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: AddOptions) => {
      await runAdd(options);
    });

  education
    .command("update")
    .description("Update an existing education entry by id")
    .argument("<id>", "education id (V1-Education-NNN)")
    .option("--institution <name>", "school / university name")
    .option("--degree <type>", "degree")
    .option("--from <date>", "start date — ISO-8601 or YYYY")
    .option("--to <date>", "end date — ISO-8601 or YYYY")
    .option("--field-of-study <text>", "field of study")
    .option("--location <text>", "city / country")
    .option("--title <text>", "thesis or program title")
    .option("--highlight <bool>", "set highlight flag (true|false)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: UpdateOptions) => {
      await runUpdate(id, options);
    });

  education
    .command("remove")
    .description("Remove an education entry by id")
    .argument("<id>", "education id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runRemove(id, options.output);
    });

  education
    .command("show")
    .description("Show a single education entry by id")
    .argument("<id>", "education id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runShow(id, options.output);
    });

  education
    .command("list")
    .description("List every education entry on your profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runList(options.output);
    });

  education
    .command("highlight")
    .description("Toggle highlight on an education entry")
    .argument("<id>", "education id")
    .option("--off", "un-highlight (default is to highlight)", false)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { off: boolean; output: OutputFormat }) => {
      await runHighlight(id, !options.off, options.output);
    });

  return education;
}

interface AddOptions {
  institution: string;
  degree: string;
  from?: string;
  to?: string;
  fieldOfStudy?: string;
  location?: string;
  title?: string;
  output: OutputFormat;
}

interface UpdateOptions {
  institution?: string;
  degree?: string;
  from?: string;
  to?: string;
  fieldOfStudy?: string;
  location?: string;
  title?: string;
  highlight?: string;
  output: OutputFormat;
}

async function runAdd(options: AddOptions): Promise<void> {
  const fields: profile.education.EducationFields = {
    institution: options.institution,
    degree: options.degree,
  };
  applyDateFlags(fields, options, "profile education add", options.output);
  applyOptionalStrings(fields, options);

  const token = await loadAuthTokenOrExit("profile education add", options.output);
  let result: profile.education.Education;
  try {
    result = await profile.education.add(token, fields);
  } catch (err) {
    presentSubDomainError("profile education add", err, options.output);
  }
  emitAddSuccess({
    operation: "profile.education.add",
    format: options.output,
    created: result,
    prettySummary: `${result.degree} — ${result.institution} (id ${result.id})`,
    prettyEntity: formatEducationText,
  });
}

async function runUpdate(id: string, options: UpdateOptions): Promise<void> {
  const fields: profile.education.EducationFields = {};
  if (options.institution !== undefined) fields.institution = options.institution;
  if (options.degree !== undefined) fields.degree = options.degree;
  if (options.fieldOfStudy !== undefined) fields.fieldOfStudy = options.fieldOfStudy;
  if (options.location !== undefined) fields.location = options.location;
  if (options.title !== undefined) fields.title = options.title;
  if (options.highlight !== undefined) {
    if (options.highlight !== "true" && options.highlight !== "false") {
      emitErrorAndExit({
        operation: "profile.education.update",
        format: options.output,
        errors: [
          {
            code: "VALIDATION_ERROR",
            field: "highlight",
            message: '--highlight expects "true" or "false"',
          },
        ],
        prettySummary: 'profile education update failed (VALIDATION_ERROR): --highlight expects "true" or "false"',
      });
    }
    fields.highlight = options.highlight === "true";
  }
  applyDateFlags(fields, options, "profile education update", options.output);

  if (Object.keys(fields).length === 0) {
    emitErrorAndExit({
      operation: "profile.education.update",
      format: options.output,
      errors: [{ code: "VALIDATION_ERROR", message: "at least one field flag is required" }],
      prettySummary: "profile education update failed (VALIDATION_ERROR): at least one field flag is required",
    });
  }

  const token = await loadAuthTokenOrExit("profile education update", options.output);
  let result: profile.education.Education;
  try {
    result = await profile.education.update(token, id, fields);
  } catch (err) {
    presentSubDomainError("profile education update", err, options.output);
  }
  emitUpdateSuccess({
    operation: "profile.education.update",
    format: options.output,
    updated: result,
    prettySummary: `${result.degree} — ${result.institution} (id ${result.id})`,
    prettyEntity: formatEducationText,
  });
}

async function runRemove(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile education remove", format);
  let removedId: string;
  try {
    removedId = await profile.education.remove(token, id);
  } catch (err) {
    presentSubDomainError("profile education remove", err, format);
  }
  emitRemoveSuccess({
    operation: "profile.education.remove",
    format,
    id: removedId,
  });
}

async function runShow(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile education show", format);
  let result: profile.education.Education;
  try {
    result = await profile.education.show(token, id);
  } catch (err) {
    presentSubDomainError("profile education show", err, format);
  }
  emitResult(result, format, { pretty: formatEducationText, table: formatEducationTable });
}

async function runList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile education list", format);
  let rows: profile.education.Education[];
  try {
    rows = await profile.education.list(token);
  } catch (err) {
    presentSubDomainError("profile education list", err, format);
  }
  emitResult(wrapListEnvelope(rows), format, {
    pretty: (data) => formatEducationListText(data.items),
    table: (data) => formatEducationListTable(data.items),
    empty: { command: "profile.education.list" },
  });
}

async function runHighlight(id: string, value: boolean, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile education highlight", format);
  let result: { id: string; highlight: boolean };
  try {
    result = await profile.education.highlight(token, id, value);
  } catch (err) {
    presentSubDomainError("profile education highlight", err, format);
  }
  emitUpdateSuccess({
    operation: "profile.education.highlight",
    format,
    updated: result,
    prettySummary: `${result.id} highlight set to ${result.highlight.toString()}`,
    prettyEntity: (entity: { id: string; highlight: boolean }) => `highlight: ${entity.highlight.toString()}`,
  });
}

/**
 * Map `--from` / `--to` flag strings to `yearFrom` / `yearTo` Ints (year
 * only, dropping any provided month/day per Education's GraphQL field
 * shape). The date helper validates ISO-8601 and year-only formats and
 * surfaces malformed input as `DateInputError` — routed through the
 * envelope ABI (#128).
 */
function applyDateFlags(
  fields: profile.education.EducationFields,
  options: { from?: string; to?: string },
  commandLabel: string,
  format: OutputFormat,
): void {
  try {
    if (options.from !== undefined) fields.yearFrom = parseDateInput(options.from, "from").year;
    if (options.to !== undefined) fields.yearTo = parseDateInput(options.to, "to").year;
  } catch (err) {
    if (err instanceof DateInputError) {
      emitErrorAndExit({
        operation: commandLabel.replace(/ /g, "."),
        format,
        errors: [{ code: err.code, message: err.message }],
        prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
      });
    }
    throw err;
  }
}

function applyOptionalStrings(
  fields: profile.education.EducationFields,
  options: { fieldOfStudy?: string; location?: string; title?: string },
): void {
  if (options.fieldOfStudy !== undefined) fields.fieldOfStudy = options.fieldOfStudy;
  if (options.location !== undefined) fields.location = options.location;
  if (options.title !== undefined) fields.title = options.title;
}

/**
 * Pretty-print an Education row. Pure — no I/O. Years render as "YYYY"
 * or "YYYY–YYYY" or "YYYY–present"; missing years collapse to a hyphen.
 */
export function formatEducationText(e: profile.education.Education): string {
  const lines: string[] = [`${e.degree}${e.fieldOfStudy ? `, ${e.fieldOfStudy}` : ""} — ${e.institution}`];
  if (e.location) lines.push(`  ${e.location}`);
  lines.push(`  ${formatYearRange(e.yearFrom, e.yearTo)}`);
  if (e.title) lines.push(`  ${e.title}`);
  if (e.highlight) lines.push(`  highlighted`);
  lines.push(`  id: ${e.id}`);
  return lines.join("\n");
}

/**
 * Pretty-print an Education row as a key/value table.
 */
export function formatEducationTable(e: profile.education.Education): string {
  const rows: [string, string][] = [
    ["id", e.id],
    ["institution", e.institution],
    ["degree", e.degree],
    ["field_of_study", e.fieldOfStudy ?? ""],
    ["location", e.location ?? ""],
    ["title", e.title ?? ""],
    ["years", formatYearRange(e.yearFrom, e.yearTo)],
    ["highlight", e.highlight.toString()],
  ];
  return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
}

function formatYearRange(from: number | null, to: number | null): string {
  if (from === null && to === null) return "—";
  if (from !== null && to === null) return `${from.toString()}–present`;
  if (from === null && to !== null) return `?–${to.toString()}`;
  return `${(from ?? 0).toString()}–${(to ?? 0).toString()}`;
}

/**
 * Pretty-print a list of Education rows. One row per line, tab-separated:
 * degree, institution, years, id.
 */
export function formatEducationListText(rows: profile.education.Education[]): string {
  if (rows.length === 0) return "(no education entries on profile)";
  return rows.map((e) => `${e.degree}\t${e.institution}\t${formatYearRange(e.yearFrom, e.yearTo)}\t${e.id}`).join("\n");
}

/**
 * Pretty-print a list of Education rows as a cli-table3 table.
 */
export function formatEducationListTable(rows: profile.education.Education[]): string {
  const table = new Table({ head: ["Degree", "Institution", "Years", "Highlight", "Id"], wordWrap: true });
  for (const e of rows) {
    table.push([e.degree, e.institution, formatYearRange(e.yearFrom, e.yearTo), e.highlight ? "yes" : "no", e.id]);
  }
  return table.toString();
}
