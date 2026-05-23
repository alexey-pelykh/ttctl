// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";
import { Command, Option } from "commander";

import { presentTtctlError } from "../../../errors.js";
import {
  emitAddSuccess,
  emitErrorAndExit,
  emitRemoveSuccess,
  emitUpdateSuccess,
  wrapListEnvelope,
} from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
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

  industries
    .command("add-connections")
    .description(
      "Link a catalog industry to one or more employment and/or portfolio rows (Pattern-6 connection helper). " +
        "Resolve --industry-id via `profile industries autocomplete`; resolve --employment-id via " +
        "`profile employment list` and --portfolio-item-id via `profile portfolio list`. Repeat the flags " +
        "to link multiple profile items in a single call.",
    )
    .requiredOption(
      "--industry-id <id>",
      "catalog industry id (V1-Industry-<n>) — resolve via `profile industries autocomplete`",
    )
    .option(
      "--employment-id <id>",
      "employment row id (V1-Employment-<n>) to link to this industry. Repeatable.",
      collectRepeated,
      [] as string[],
    )
    .option(
      "--portfolio-item-id <id>",
      "portfolio item id (V1-PortfolioItem-<n>) to link to this industry. Repeatable.",
      collectRepeated,
      [] as string[],
    )
    .option(
      "--consent-profile-capability",
      "REQUIRED. Acknowledge this is a destructive profile-capability action — writes recruiter-visible industry tags onto profile rows. See ADR-009 (ttctl) for the per-domain consent vocabulary.",
    )
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: {
        industryId: string;
        employmentId: string[];
        portfolioItemId: string[];
        consentProfileCapability?: boolean;
        output: OutputFormat;
      }) => {
        await runAddConnections(options);
      },
    );

  return industries;
}

/**
 * commander.js option-collector — accumulates each `--employment-id <id>`
 * / `--portfolio-item-id <id>` invocation into an array so the caller
 * can link N profile rows to a single industry in one CLI call. Default
 * is `[] as string[]` (see option registrations above).
 */
function collectRepeated(value: string, previous: string[]): string[] {
  return previous.concat([value]);
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

async function runAddConnections(options: {
  industryId: string;
  employmentId: string[];
  portfolioItemId: string[];
  consentProfileCapability?: boolean;
  output: OutputFormat;
}): Promise<void> {
  const profileItems = [...options.employmentId, ...options.portfolioItemId];
  if (profileItems.length === 0) {
    emitErrorAndExit({
      operation: "profile.industries.add-connections",
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "at least one --employment-id or --portfolio-item-id is required",
        },
      ],
      prettySummary:
        "profile industries add-connections failed (VALIDATION_ERROR): at least one --employment-id or --portfolio-item-id is required",
    });
  }

  const token = await loadAuthTokenOrExit("profile industries add-connections", options.output);

  // Static type narrows to literal-true; the widening cast lets the
  // `false` (= operator omits the flag) case reach the runtime gate at
  // the service entry, which raises ConsentRequiredError. Mirrors the
  // submit-for-review CLI handler.
  const consent = {
    profileCapabilityConsentIssued: options.consentProfileCapability ?? false,
  } as unknown as { profileCapabilityConsentIssued: true };

  let result: profile.industries.AddIndustryConnectionsResult;
  try {
    result = await profile.industries.addConnections(
      token,
      [{ industryId: options.industryId, profileItems }],
      consent,
    );
  } catch (err) {
    handleAddConnectionsError(err, options.output);
    return;
  }

  emitUpdateSuccess({
    operation: "profile.industries.add-connections",
    format: options.output,
    updated: result,
    prettySummary: `Linked industry ${options.industryId} to ${profileItems.length.toString()} profile item(s).`,
    prettyEntity: formatAddConnectionsResultText,
    notice: result.notice ?? undefined,
  });
}

function handleAddConnectionsError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.industries.add-connections",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.basic.ProfileError) {
    emitErrorAndExit({
      operation: "profile.industries.add-connections",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `profile industries add-connections failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.industries.add-connections",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `profile industries add-connections failed: ${message}`,
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
 * Pretty-print an IndustryProfile row. The five curation cross-
 * reference arrays (`employments` / `educations` / `certifications` /
 * `portfolioItems` / `highlights`) are rendered when populated — each
 * line lists the count then the IDs (one per curation kind) so the
 * operator can chase any of them via the matching per-resource
 * `show` (e.g. `ttctl profile employment show <id>`). Empty curation
 * suppresses the section entirely (no noise on industries with no
 * curated rows).
 */
export function formatIndustryText(i: profile.industries.IndustryProfile): string {
  const lines: string[] = [i.title];
  if (i.domainArea) lines.push(`  domain: ${i.domainArea}`);
  if (i.about) lines.push(`  ${i.about}`);
  lines.push(`  id: ${i.id}`);
  lines.push(...formatCurationLines(i));
  return lines.join("\n");
}

/**
 * Pretty-print an IndustryProfile row as a key/value table. Curation
 * arrays are rendered as count-then-ids strings (e.g. "2: V1-Employment-E1,
 * V1-Employment-E2") so the table stays one-line-per-key while still
 * surfacing the cross-reference targets. Empty curation renders as
 * "0" so column alignment stays stable across rows.
 */
export function formatIndustryTable(i: profile.industries.IndustryProfile): string {
  const rows: [string, string][] = [
    ["id", i.id],
    ["title", i.title],
    ["domain", i.domainArea ?? ""],
    ["about", i.about ?? ""],
    ["employments", formatRefsCell(i.employments)],
    ["educations", formatRefsCell(i.educations)],
    ["certifications", formatRefsCell(i.certifications)],
    ["portfolioItems", formatRefsCell(i.portfolioItems)],
    ["highlights", formatRefsCell(i.highlights)],
  ];
  return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
}

export function formatIndustryListText(rows: profile.industries.IndustryProfile[]): string {
  if (rows.length === 0) return "(no industries on this profile)";
  return rows.map(formatIndustryText).join("\n\n");
}

/**
 * Pretty-print the list-output table. Adds a `curation` column that
 * summarises the five cross-reference counts as `Nemp/Nedu/Ncert/Npf/Nhl`
 * so a quick scan of `ttctl profile industries list -o table` shows
 * which industries have curated rows behind them.
 */
export function formatIndustryListTable(rows: profile.industries.IndustryProfile[]): string {
  if (rows.length === 0) return "(no industries on this profile)";
  return rows
    .map(
      (i) =>
        `${i.id}\t${i.title}\t${i.domainArea ?? ""}\t${i.employments.length.toString()}/${i.educations.length.toString()}/${i.certifications.length.toString()}/${i.portfolioItems.length.toString()}/${i.highlights.length.toString()}`,
    )
    .join("\n");
}

/**
 * Pretty-text helper: emit the curation block as indented lines under
 * an `industry`. Only includes kinds with at least one entry — an
 * industry with no curated rows produces no curation lines at all
 * (rather than rendering five empty `(0)` lines).
 */
function formatCurationLines(i: profile.industries.IndustryProfile): string[] {
  const sections: { label: string; refs: readonly { id: string }[] }[] = [
    { label: "employments", refs: i.employments },
    { label: "educations", refs: i.educations },
    { label: "certifications", refs: i.certifications },
    { label: "portfolioItems", refs: i.portfolioItems },
    { label: "highlights", refs: i.highlights },
  ];
  const out: string[] = [];
  for (const { label, refs } of sections) {
    if (refs.length === 0) continue;
    out.push(`  ${label} (${refs.length.toString()}): ${refs.map((r) => r.id).join(", ")}`);
  }
  return out;
}

/**
 * Table-cell helper: render a curation-ref array as `N: id1, id2`
 * (or just `0` when empty). Keeps the table single-line-per-field
 * even for industries with many cross-references.
 */
function formatRefsCell(refs: readonly { id: string }[]): string {
  if (refs.length === 0) return "0";
  return `${refs.length.toString()}: ${refs.map((r) => r.id).join(", ")}`;
}

export function formatCatalogText(rows: profile.industries.IndustryCatalogEntry[]): string {
  if (rows.length === 0) return "(no matches)";
  return rows.map((r) => `${r.name} (${r.id})`).join("\n");
}

export function formatCatalogTable(rows: profile.industries.IndustryCatalogEntry[]): string {
  if (rows.length === 0) return "(no matches)";
  return rows.map((r) => `${r.id}\t${r.name}`).join("\n");
}

/**
 * Pretty-print an `addConnections` result. Lists each linked employment
 * and portfolio row with its post-link industry tags so the operator can
 * verify the link materialized.
 */
export function formatAddConnectionsResultText(result: profile.industries.AddIndustryConnectionsResult): string {
  const lines: string[] = [];
  if (result.employments.length > 0) {
    lines.push("Employments:");
    for (const e of result.employments) {
      const tags = e.industries.map((i) => i.name).join(", ");
      lines.push(`  - ${e.company ?? "(no company)"} (${e.id})`);
      if (tags) lines.push(`      industries: ${tags}`);
    }
  }
  if (result.portfolioItems.length > 0) {
    lines.push("Portfolio items:");
    for (const p of result.portfolioItems) {
      const tags = p.industries.map((i) => i.name).join(", ");
      lines.push(`  - ${p.title ?? "(no title)"} (${p.id})`);
      if (tags) lines.push(`      industries: ${tags}`);
    }
  }
  if (lines.length === 0) lines.push("(no items returned)");
  return lines.join("\n");
}
