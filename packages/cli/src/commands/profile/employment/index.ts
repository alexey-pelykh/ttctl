// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { DateInputError, parseDateInput, profile, splitParagraphs } from "@ttctl/core";
import { Command, Option } from "commander";

import Table from "cli-table3";

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
    .requiredOption(
      "--company <name>",
      "company / employer name (resolved to employerId via autocomplete unless --no-employer)",
    )
    .requiredOption("--role <title>", "job title (mapped to position)")
    .option("--from <date>", "start date — ISO-8601 (YYYY-MM-DD) or year (YYYY)")
    .option("--to <date>", "end date — ISO-8601 or year")
    .option("--current", "current position (no end date)", false)
    .option("--website <url>", "company website (optional)")
    .option(
      "--no-website",
      "explicit no-website signal — required with --no-employer when --website is not supplied (the server rejects custom workplaces with neither anchor; see #484)",
    )
    .option(
      "--employer-id <id>",
      "explicit employerId (bypasses autocomplete; use `ttctl profile employment employer-autocomplete <query>` to discover)",
    )
    .option(
      "--industry-id <id>",
      'catalog Industry id (repeatable; required — at least one). Discover via `ttctl profile industries autocomplete "<query>"`.',
      (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
    )
    .option(
      "--skill-id <id>",
      "catalog Skill id (repeatable; optional). Discover via `ttctl profile skills list`. Required on the live wire when --no-employer is set; the catalog-employer path may inherit skills from the resolved Employer.",
      (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
    )
    .option(
      "--no-employer",
      "custom (non-catalog) workplace: send the free-text --company with employerId:null and skip the employer-autocomplete catalog (cannot be combined with --employer-id; requires either --website or --no-website per the #484 CREATE-side anchor contract)",
    )
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
      'multi-paragraph description (inline text, "-" for stdin, or "@path" to read from file). ' +
        "Each paragraph (split on blank lines) must be 50-250 characters; the Toptal server rejects out-of-range items (#492).",
    )
    .option("--edit", "open $EDITOR to compose the description (cannot be combined with --description)", false)
    .option("--highlight <bool>", "set highlight flag (true|false)")
    .option(
      "--industry-id <id>",
      'catalog Industry id (repeatable; when supplied, replaces the entry\'s industry set — omit to preserve). Discover via `ttctl profile industries autocomplete "<query>"`.',
      (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
    )
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
    .command("list")
    .description("List every employment entry on your profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runList(options.output);
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
  // Commander's `--website <url>` + `--no-website` produces this union:
  // - `string` when `--website https://...` is supplied
  // - `false` when `--no-website` is supplied (explicit no-website signal, #484)
  // - `undefined` when neither flag is present
  // See `runAdd` for the discriminator.
  website?: string | false;
  employerId?: string;
  industryId?: string[];
  // Commander maps `--no-employer` to `employer: false` (default true
  // when the flag is absent) — the custom-workplace signal (#401).
  employer: boolean;
  // Catalog skill ids supplied via `--skill-id` (repeatable, #484).
  skillId?: string[];
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
  industryId?: string[];
  output: OutputFormat;
}

async function runAdd(options: AddOptions): Promise<void> {
  const fields: profile.employment.EmploymentFields = {
    company: options.company,
    position: options.role,
  };
  if (options.employerId !== undefined) {
    fields.employerId = options.employerId;
  }
  // `--no-employer` → Commander sets `options.employer` false (default
  // true). Maps to the custom-workplace signal; orthogonal to --website
  // (#401). The --no-employer + --employer-id contradiction is validated
  // in core (single source of truth, shared by the MCP surface). The
  // --no-employer + (no --website AND no --no-website) anchor-missing
  // case is also validated in core (#484).
  if (!options.employer) {
    fields.noEmployer = true;
  }
  // Commander's `--website <url>` / `--no-website` discriminator (#484):
  // - `options.website === false` → `--no-website` was passed → explicit
  //   no-website signal (the alternative anchor for noEmployer:true).
  // - `typeof options.website === "string"` → `--website <url>` was passed.
  // - `undefined` → neither flag.
  if (options.website === false) {
    fields.noWebsite = true;
  } else if (typeof options.website === "string") {
    fields.companyWebsite = options.website;
    fields.noWebsite = false;
  }
  applyDateFlags(fields, options, "profile employment add", options.output);
  if (options.current) fields.endDate = null;

  // industryIds is required on the live `CreateEmployment` wire (#395
  // cascade: the server rejects a blank industry set). Surface it as a
  // required flag — mirrors `ttctl profile portfolio add --industry-id`
  // — so the failure is an upfront VALIDATION_ERROR, not a confusing
  // late wire USER_ERROR.
  if (options.industryId === undefined || options.industryId.length === 0) {
    emitErrorAndExit({
      operation: "profile.employment.add",
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message:
            "--industry-id is required (at least one). " +
            'Discover catalog IDs via `ttctl profile industries autocomplete "<query>"`.',
        },
      ],
      prettySummary: "profile employment add failed (VALIDATION_ERROR): --industry-id is required.",
    });
  }
  fields.industryIds = options.industryId;

  // #484: surface `--skill-id` (optional, repeatable) so the noEmployer
  // path can satisfy the live wire's `skills: [≥1 SkillRefInput]`
  // requirement (cascade-of-required-fields per the #395 file header).
  // The catalog-employer path may inherit skills from the resolved
  // Employer record — passing skills there is optional.
  if (options.skillId !== undefined && options.skillId.length > 0) {
    fields.skills = options.skillId.map((id) => ({ id, name: "" }));
  }

  const token = await loadAuthTokenOrExit("profile employment add", options.output);
  let result: profile.employment.Employment;
  try {
    const outcome = await profile.employment.add(token, fields);
    // CLI does not currently surface dryRun for employment add (#395 — MCP-only),
    // so the apply path always returns `kind: "created"`.
    if (outcome.kind !== "created") {
      throw new Error(`Unexpected non-created outcome from profile.employment.add: ${outcome.kind}`);
    }
    result = outcome.result;
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
  // Replace-on-supply: when --industry-id is given (repeatable), the
  // supplied catalog set replaces the entry's entire industry set; when
  // omitted, the core read-current+merge preserves the existing set
  // (#394 `buildUpdateEmploymentInput`). Setting it here also makes
  // `--industry-id` count toward the "at least one field flag" check.
  if (options.industryId !== undefined && options.industryId.length > 0) {
    fields.industryIds = options.industryId;
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

async function runList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile employment list", format);
  let rows: profile.employment.Employment[];
  try {
    rows = await profile.employment.list(token);
  } catch (err) {
    presentSubDomainError("profile employment list", err, format);
  }
  emitResult(wrapListEnvelope(rows), format, {
    pretty: (data) => formatEmploymentListText(data.items),
    table: (data) => formatEmploymentListTable(data.items),
    empty: { command: "profile.employment.list" },
  });
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
 * Pretty-print a list of Employment rows. One row per line, tab-separated:
 * position, company, years, id. Mirrors `formatSkillsListText` shape.
 */
export function formatEmploymentListText(rows: profile.employment.Employment[]): string {
  if (rows.length === 0) return "(no employment entries on profile)";
  return rows.map((e) => `${e.position}\t${e.company}\t${formatYearRange(e.startDate, e.endDate)}\t${e.id}`).join("\n");
}

/**
 * Pretty-print a list of Employment rows as a cli-table3 table.
 */
export function formatEmploymentListTable(rows: profile.employment.Employment[]): string {
  const table = new Table({ head: ["Position", "Company", "Years", "Highlight", "Id"], wordWrap: true });
  for (const e of rows) {
    table.push([e.position, e.company, formatYearRange(e.startDate, e.endDate), e.highlight ? "yes" : "no", e.id]);
  }
  return table.toString();
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
