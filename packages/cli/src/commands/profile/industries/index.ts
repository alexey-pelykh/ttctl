// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
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
import { loadAuthTokenOrExit, parseLimitOrExit, presentSubDomainError } from "../shared.js";

/**
 * Build the `ttctl profile industries` command tree.
 *
 * Six leaves:
 *   - `add <name> [--connection <type>]`
 *   - `update <id> [field-flags]`
 *   - `remove <id>`
 *   - `show <id> [-o text|json|table]`
 *   - `list [-o text|json|table]`
 *   - `autocomplete <query>` — looks up known industry names from the
 *     Toptal catalog
 *
 * Each `add` creates an `IndustryProfile` row (the user's authored
 * domain-expertise entry). `<name>` becomes `title`; `--connection`
 * becomes `domainArea` (the user's role within the industry, e.g.
 * "Healthcare" + connection "Backend").
 *
 * `autocomplete` is a separate query against `industriesAutocomplete`
 * — the catalog of known industry names. `add` does NOT consult the
 * catalog; users supply the title directly.
 *
 * `show <id>` is the per-id read companion of `list`, added in #342 to
 * close the Class A surface-shape gap (service exported a `show()` but
 * neither CLI nor MCP exposed it). The wire call resolves the row via
 * the schema's `node()` resolver — see
 * `packages/core/src/services/profile/industries/index.ts:226`.
 */
export function buildProfileIndustriesCommand(): Command {
  const industries = new Command("industries").description("View and update the industries section of your profile");

  industries
    .command("add")
    .description("Add a new industry-profile entry to your profile")
    .argument("<name>", "industry name (mapped to title)")
    .option("--connection <type>", "your connection / role within the industry (mapped to domainArea)")
    .option("--about <text>", "longer-form description (optional)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (name: string, options: AddOptions) => {
      await runAdd(name, options);
    });

  industries
    .command("update")
    .description("Update an existing industry-profile entry by id")
    .argument("<id>", "industry profile id")
    .option("--name <text>", "industry name (mapped to title)")
    .option("--connection <type>", "your connection / role within the industry")
    .option("--about <text>", "longer-form description")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: UpdateOptions) => {
      await runUpdate(id, options);
    });

  industries
    .command("remove")
    .description("Remove an industry-profile entry by id")
    .argument("<id>", "industry profile id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runRemove(id, options.output);
    });

  industries
    .command("show")
    .description("Show a single industry-profile entry by id")
    .argument("<id>", "industry profile id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runShow(id, options.output);
    });

  industries
    .command("list")
    .description("List your industry-profile entries")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runList(options.output);
    });

  industries
    .command("autocomplete")
    .description('Search the known-industries catalog for a name (e.g. "Healthcare")')
    .argument("<query>", "search term")
    .option("--limit <n>", "max results (default 10)", "10")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (query: string, options: { limit: string; output: OutputFormat }) => {
      await runAutocomplete(query, options);
    });

  return industries;
}

interface AddOptions {
  connection?: string;
  about?: string;
  output: OutputFormat;
}

interface UpdateOptions {
  name?: string;
  connection?: string;
  about?: string;
  output: OutputFormat;
}

async function runAdd(name: string, options: AddOptions): Promise<void> {
  const fields: profile.industries.IndustryProfileFields = { title: name };
  if (options.connection !== undefined) fields.domainArea = options.connection;
  if (options.about !== undefined) fields.about = options.about;

  const token = await loadAuthTokenOrExit("profile industries add", options.output);
  let result: profile.industries.IndustryProfile;
  try {
    result = await profile.industries.add(token, fields);
  } catch (err) {
    presentSubDomainError("profile industries add", err, options.output);
  }
  emitAddSuccess({
    operation: "profile.industries.add",
    format: options.output,
    created: result,
    prettySummary: `${result.title} (id ${result.id})`,
    prettyEntity: formatIndustryText,
  });
}

async function runUpdate(id: string, options: UpdateOptions): Promise<void> {
  const fields: profile.industries.IndustryProfileFields = {};
  if (options.name !== undefined) fields.title = options.name;
  if (options.connection !== undefined) fields.domainArea = options.connection;
  if (options.about !== undefined) fields.about = options.about;

  if (Object.keys(fields).length === 0) {
    emitErrorAndExit({
      operation: "profile.industries.update",
      format: options.output,
      errors: [{ code: "VALIDATION_ERROR", message: "at least one field flag is required" }],
      prettySummary: "profile industries update failed (VALIDATION_ERROR): at least one field flag is required",
    });
  }

  const token = await loadAuthTokenOrExit("profile industries update", options.output);
  let result: profile.industries.IndustryProfile;
  try {
    result = await profile.industries.update(token, id, fields);
  } catch (err) {
    presentSubDomainError("profile industries update", err, options.output);
  }
  emitUpdateSuccess({
    operation: "profile.industries.update",
    format: options.output,
    updated: result,
    prettySummary: `${result.title} (id ${result.id})`,
    prettyEntity: formatIndustryText,
  });
}

async function runRemove(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile industries remove", format);
  let removedId: string;
  try {
    removedId = await profile.industries.remove(token, id);
  } catch (err) {
    presentSubDomainError("profile industries remove", err, format);
  }
  emitRemoveSuccess({
    operation: "profile.industries.remove",
    format,
    id: removedId,
  });
}

async function runShow(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile industries show", format);
  let result: profile.industries.IndustryProfile;
  try {
    result = await profile.industries.show(token, id);
  } catch (err) {
    presentSubDomainError("profile industries show", err, format);
  }
  emitResult(result, format, { pretty: formatIndustryText, table: formatIndustryTable });
}

async function runList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile industries list", format);
  let result: profile.industries.IndustryProfile[];
  try {
    result = await profile.industries.list(token);
  } catch (err) {
    presentSubDomainError("profile industries list", err, format);
  }
  emitResult(wrapListEnvelope(result), format, {
    pretty: (data) => formatIndustryListText(data.items),
    table: (data) => formatIndustryListTable(data.items),
    empty: { command: "profile.industries.list" },
  });
}

async function runAutocomplete(query: string, options: { limit: string; output: OutputFormat }): Promise<void> {
  const limit = parseLimitOrExit(options.limit, "profile industries autocomplete", options.output);
  const token = await loadAuthTokenOrExit("profile industries autocomplete", options.output);
  let suggestions: profile.industries.IndustryCatalogEntry[];
  try {
    suggestions = await profile.industries.autocomplete(token, query, { limit });
  } catch (err) {
    presentSubDomainError("profile industries autocomplete", err, options.output);
  }
  emitResult(wrapListEnvelope(suggestions), options.output, {
    pretty: (data) => formatCatalogText(data.items),
    table: (data) => formatCatalogTable(data.items),
  });
}

/**
 * Pretty-print an IndustryProfile row.
 */
export function formatIndustryText(i: profile.industries.IndustryProfile): string {
  const lines: string[] = [i.title];
  if (i.domainArea) lines.push(`  domain: ${i.domainArea}`);
  if (i.about) lines.push(`  ${i.about}`);
  lines.push(`  id: ${i.id}`);
  return lines.join("\n");
}

/**
 * Pretty-print an IndustryProfile row as a key/value table.
 */
export function formatIndustryTable(i: profile.industries.IndustryProfile): string {
  const rows: [string, string][] = [
    ["id", i.id],
    ["title", i.title],
    ["domain", i.domainArea ?? ""],
    ["about", i.about ?? ""],
  ];
  return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
}

export function formatIndustryListText(rows: profile.industries.IndustryProfile[]): string {
  if (rows.length === 0) return "(no industries on this profile)";
  return rows.map(formatIndustryText).join("\n\n");
}

export function formatIndustryListTable(rows: profile.industries.IndustryProfile[]): string {
  if (rows.length === 0) return "(no industries on this profile)";
  return rows.map((i) => `${i.id}\t${i.title}\t${i.domainArea ?? ""}`).join("\n");
}

export function formatCatalogText(rows: profile.industries.IndustryCatalogEntry[]): string {
  if (rows.length === 0) return "(no matches)";
  return rows.map((r) => `${r.name} (${r.id})`).join("\n");
}

export function formatCatalogTable(rows: profile.industries.IndustryCatalogEntry[]): string {
  if (rows.length === 0) return "(no matches)";
  return rows.map((r) => `${r.id}\t${r.name}`).join("\n");
}
