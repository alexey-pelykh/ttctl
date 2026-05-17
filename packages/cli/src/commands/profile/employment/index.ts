// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { DateInputError, parseDateInput, profile, splitParagraphs } from "@ttctl/core";
import { Command, Option } from "commander";

import {
  emitAddSuccess,
  emitErrorAndExit,
  emitRemoveSuccess,
  emitUpdateSuccess,
  wrapListEnvelope,
} from "../../../lib/envelopes.js";
import { FreeTextError, resolveFreeText } from "../../../lib/freetext.js";
import { OUTPUT_FORMATS, emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, parseLimitOrExit, presentSubDomainError } from "../shared.js";

/**
 * Build the `ttctl profile employment` command tree.
 *
 * The canonical sub-domain name is `employment`; the CLI registers
 * `experience` as a Commander.js alias so users can type either form. Per
 * project policy (see issue #72), aliases are CLI-only — MCP tool names
 * use ONLY the canonical name.
 *
 * Six leaves:
 *   - `add --company --role [--from --to --current]`
 *   - `update <id> [field-flags] [--description --edit]`
 *   - `remove <id>`
 *   - `show <id> [-o text|json|table]`
 *   - `highlight <id>`
 *   - `employer-autocomplete <query>` — looks up known employer names
 *
 * Date input flags accept ISO-8601 (`2023-01-15`) or year-only (`2023`).
 * Employment stores year only (Int field), so the helper drops month/day.
 *
 * `update --description` is multi-paragraph free-text via the four-mode
 * helper from `lib/freetext.ts` (#70): inline, stdin (`-`), file (`@path`),
 * editor (`--edit`).
 */
export function buildProfileEmploymentCommand(): Command {
  const employment = new Command("employment")
    .alias("experience")
    .description("View and update the employment history section of your profile");

  employment
    .command("add")
    .description("Add a new employment entry to your profile")
    .requiredOption("--company <name>", "company / employer name")
    .requiredOption("--role <title>", "job title (mapped to position)")
    .option("--from <date>", "start date — ISO-8601 (YYYY-MM-DD) or year (YYYY)")
    .option("--to <date>", "end date — ISO-8601 or year")
    .option("--current", "current position (no end date)", false)
    .option("--website <url>", "company website (optional)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: AddOptions) => {
      await runAdd(options);
    });

  employment
    .command("update")
    .description("Update an existing employment entry by id")
    .argument("<id>", "employment id (V1-Employment-NNN)")
    .option("--company <name>", "company name")
    .option("--role <title>", "job title")
    .option("--from <date>", "start date — ISO-8601 or year")
    .option("--to <date>", "end date — ISO-8601 or year")
    .option("--current", "mark as current position (clears end date)", false)
    .option("--website <url>", "company website")
    .option(
      "--description <text>",
      'multi-paragraph description (inline text, "-" for stdin, or "@path" to read from file)',
    )
    .option("--edit", "open $EDITOR to compose the description (cannot be combined with --description)", false)
    .option("--highlight <bool>", "set highlight flag (true|false)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: UpdateOptions) => {
      await runUpdate(id, options);
    });

  employment
    .command("remove")
    .description("Remove an employment entry by id")
    .argument("<id>", "employment id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runRemove(id, options.output);
    });

  employment
    .command("show")
    .description("Show a single employment entry by id")
    .argument("<id>", "employment id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runShow(id, options.output);
    });

  employment
    .command("highlight")
    .description("Toggle highlight on an employment entry")
    .argument("<id>", "employment id")
    .option("--off", "un-highlight (default is to highlight)", false)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { off: boolean; output: OutputFormat }) => {
      await runHighlight(id, !options.off, options.output);
    });

  employment
    .command("employer-autocomplete")
    .description('Search the known-employer catalog for a name (e.g. "Google")')
    .argument("<query>", "search term")
    .option("--limit <n>", "max results (default 10)", "10")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (query: string, options: { limit: string; output: OutputFormat }) => {
      await runEmployerAutocomplete(query, options);
    });

  return employment;
}

interface AddOptions {
  company: string;
  role: string;
  from?: string;
  to?: string;
  current: boolean;
  website?: string;
  output: OutputFormat;
}

interface UpdateOptions {
  company?: string;
  role?: string;
  from?: string;
  to?: string;
  current: boolean;
  website?: string;
  description?: string;
  edit: boolean;
  highlight?: string;
  output: OutputFormat;
}

async function runAdd(options: AddOptions): Promise<void> {
  const fields: profile.employment.EmploymentFields = {
    company: options.company,
    position: options.role,
  };
  if (options.website !== undefined) {
    fields.companyWebsite = options.website;
    fields.noWebsite = false;
  }
  applyDateFlags(fields, options, "profile employment add", options.output);
  if (options.current) fields.endDate = null;

  const token = await loadAuthTokenOrExit("profile employment add", options.output);
  let result: profile.employment.Employment;
  try {
    result = await profile.employment.add(token, fields);
  } catch (err) {
    presentSubDomainError("profile employment add", err, options.output);
  }
  emitAddSuccess({
    operation: "profile.employment.add",
    format: options.output,
    created: result,
    prettySummary: `${result.position} — ${result.company} (id ${result.id})`,
    prettyEntity: formatEmploymentText,
  });
}

async function runUpdate(id: string, options: UpdateOptions): Promise<void> {
  const fields: profile.employment.EmploymentFields = {};
  if (options.company !== undefined) fields.company = options.company;
  if (options.role !== undefined) fields.position = options.role;
  if (options.website !== undefined) {
    fields.companyWebsite = options.website;
    fields.noWebsite = false;
  }
  if (options.highlight !== undefined) {
    if (options.highlight !== "true" && options.highlight !== "false") {
      emitErrorAndExit({
        operation: "profile.employment.update",
        format: options.output,
        errors: [
          {
            code: "VALIDATION_ERROR",
            field: "highlight",
            message: '--highlight expects "true" or "false"',
          },
        ],
        prettySummary: 'profile employment update failed (VALIDATION_ERROR): --highlight expects "true" or "false"',
      });
    }
    fields.highlight = options.highlight === "true";
  }
  applyDateFlags(fields, options, "profile employment update", options.output);
  if (options.current) fields.endDate = null;

  // Resolve --description / --edit through the four-mode free-text helper
  // (inline, stdin "-", "@path", $EDITOR). The helper rejects mode
  // combinations (e.g. --description with --edit) before any network I/O.
  let description: string | undefined;
  try {
    description = await resolveFreeText(options.description, {
      flagName: "description",
      enableEditor: options.edit,
    });
  } catch (err) {
    if (err instanceof FreeTextError) {
      emitErrorAndExit({
        operation: "profile.employment.update",
        format: options.output,
        errors: [{ code: err.code, message: err.message }],
        prettySummary: `profile employment update failed (${err.code}): ${err.message}`,
      });
    }
    throw err;
  }
  if (description !== undefined) {
    // Multi-paragraph descriptions split on blank lines into experienceItems
    // (the API stores each paragraph as a separate row, per the
    // UpdateEmploymentInput capture's `experienceItems: 3-10 items`).
    fields.experienceItems = splitParagraphs(description);
  }

  if (Object.keys(fields).length === 0) {
    emitErrorAndExit({
      operation: "profile.employment.update",
      format: options.output,
      errors: [{ code: "VALIDATION_ERROR", message: "at least one field flag is required" }],
      prettySummary: "profile employment update failed (VALIDATION_ERROR): at least one field flag is required",
    });
  }

  const token = await loadAuthTokenOrExit("profile employment update", options.output);
  let result: profile.employment.Employment;
  try {
    result = await profile.employment.update(token, id, fields);
  } catch (err) {
    presentSubDomainError("profile employment update", err, options.output);
  }
  emitUpdateSuccess({
    operation: "profile.employment.update",
    format: options.output,
    updated: result,
    prettySummary: `${result.position} — ${result.company} (id ${result.id})`,
    prettyEntity: formatEmploymentText,
  });
}

async function runRemove(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile employment remove", format);
  let removedId: string;
  try {
    removedId = await profile.employment.remove(token, id);
  } catch (err) {
    presentSubDomainError("profile employment remove", err, format);
  }
  emitRemoveSuccess({
    operation: "profile.employment.remove",
    format,
    id: removedId,
  });
}

async function runShow(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile employment show", format);
  let result: profile.employment.Employment;
  try {
    result = await profile.employment.show(token, id);
  } catch (err) {
    presentSubDomainError("profile employment show", err, format);
  }
  emitResult(result, format, { pretty: formatEmploymentText, table: formatEmploymentTable });
}

async function runHighlight(id: string, value: boolean, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile employment highlight", format);
  let result: { id: string; highlight: boolean };
  try {
    result = await profile.employment.highlight(token, id, value);
  } catch (err) {
    presentSubDomainError("profile employment highlight", err, format);
  }
  emitUpdateSuccess({
    operation: "profile.employment.highlight",
    format,
    updated: result,
    prettySummary: `${result.id} highlight set to ${result.highlight.toString()}`,
    prettyEntity: (entity: { id: string; highlight: boolean }) => `highlight: ${entity.highlight.toString()}`,
  });
}

async function runEmployerAutocomplete(query: string, options: { limit: string; output: OutputFormat }): Promise<void> {
  const limit = parseLimitOrExit(options.limit, "profile employment employer-autocomplete", options.output);
  const token = await loadAuthTokenOrExit("profile employment employer-autocomplete", options.output);
  let suggestions: profile.employment.EmployerSuggestion[];
  try {
    suggestions = await profile.employment.employerAutocomplete(token, query, limit);
  } catch (err) {
    presentSubDomainError("profile employment employer-autocomplete", err, options.output);
  }
  emitResult(wrapListEnvelope(suggestions), options.output, {
    pretty: (data) => formatEmployersText(data.items),
    table: (data) => formatEmployersTable(data.items),
  });
}

function applyDateFlags(
  fields: profile.employment.EmploymentFields,
  options: { from?: string; to?: string },
  commandLabel: string,
  format: OutputFormat,
): void {
  try {
    if (options.from !== undefined) fields.startDate = parseDateInput(options.from, "from").year;
    if (options.to !== undefined) fields.endDate = parseDateInput(options.to, "to").year;
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

/**
 * Pretty-print an Employment row.
 */
export function formatEmploymentText(e: profile.employment.Employment): string {
  const lines: string[] = [`${e.position} — ${e.company}`];
  if (e.companyWebsite && !e.noWebsite) lines.push(`  ${e.companyWebsite}`);
  lines.push(`  ${formatYearRange(e.startDate, e.endDate)}`);
  if (e.experienceItems && e.experienceItems.length > 0) {
    for (const item of e.experienceItems) {
      lines.push(`  • ${item}`);
    }
  }
  if (e.highlight) lines.push(`  highlighted`);
  if (e.reportingTo !== null && e.reportingTo !== "") lines.push(`  reports to: ${e.reportingTo}`);
  if (e.industries.length > 0) {
    lines.push(`  industries: ${e.industries.map((i) => i.name).join(", ")}`);
  }
  if (e.primaryGeography !== null) {
    const geo = e.primaryGeography.name ?? e.primaryGeography.code ?? e.primaryGeography.id;
    lines.push(`  geography: ${geo}`);
  }
  if (e.publicationPermit !== null) {
    lines.push(`  public: ${e.publicationPermit ? "yes" : "no"}`);
  }
  lines.push(`  id: ${e.id}`);
  return lines.join("\n");
}

/**
 * Pretty-print an Employment row as a key/value table.
 */
export function formatEmploymentTable(e: profile.employment.Employment): string {
  const geo =
    e.primaryGeography === null ? "" : (e.primaryGeography.name ?? e.primaryGeography.code ?? e.primaryGeography.id);
  const rows: [string, string][] = [
    ["id", e.id],
    ["company", e.company],
    ["position", e.position],
    ["website", e.companyWebsite ?? ""],
    ["years", formatYearRange(e.startDate, e.endDate)],
    ["highlight", e.highlight.toString()],
    ["paragraphs", (e.experienceItems?.length ?? 0).toString()],
    ["publicationPermit", e.publicationPermit === null ? "" : e.publicationPermit.toString()],
    ["reportingTo", e.reportingTo ?? ""],
    ["industries", e.industries.map((i) => i.name).join(", ")],
    ["primaryGeography", geo],
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
 * Pretty-print employer-autocomplete suggestions.
 */
export function formatEmployersText(suggestions: profile.employment.EmployerSuggestion[]): string {
  if (suggestions.length === 0) return "(no matches)";
  return suggestions
    .map((e) => {
      const loc = [e.city, e.country].filter((v): v is string => v !== null && v !== "").join(", ");
      return [`${e.name}${loc ? ` (${loc})` : ""}`, `  id: ${e.id}`, e.website ? `  ${e.website}` : null]
        .filter((line): line is string => line !== null)
        .join("\n");
    })
    .join("\n\n");
}

export function formatEmployersTable(suggestions: profile.employment.EmployerSuggestion[]): string {
  if (suggestions.length === 0) return "(no matches)";
  return suggestions
    .map((e) => `${e.id}\t${e.name}\t${e.city ?? ""}\t${e.country ?? ""}\t${e.website ?? ""}`)
    .join("\n");
}
