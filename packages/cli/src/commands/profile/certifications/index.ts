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
 * Build the `ttctl profile certifications` command tree.
 *
 * The canonical sub-domain name is `certifications`; the CLI registers
 * `certs` as a Commander.js alias so users can type either form. Per
 * project policy (see issue #72), aliases are CLI-only — MCP tool names
 * use ONLY the canonical name.
 *
 * Five leaves:
 *   - `add --name --issuer [--issued --expires]`
 *   - `update <id> [field-flags]`
 *   - `remove <id>`
 *   - `show <id> [-o text|json|table]`
 *   - `highlight <id>`
 *
 * Date input flags accept ISO-8601 (`2023-01-15`) or year-only (`2023`).
 * Certifications store month + year (separate Int fields) so the helper
 * preserves the month component and ignores any provided day.
 */
export function buildProfileCertificationsCommand(): Command {
  const certs = new Command("certifications")
    .alias("certs")
    .description("View and update the certifications section of your profile");

  certs
    .command("add")
    .description("Add a new certification entry to your profile")
    .requiredOption("--name <text>", "certification name (mapped to certificate)")
    .requiredOption("--issuer <text>", "issuing organization (mapped to institution)")
    .option("--issued <date>", "issue date — ISO-8601 (YYYY-MM-DD) or year (YYYY)")
    .option("--expires <date>", "expiration date — ISO-8601 or year")
    .option("--link <url>", "credential URL (optional)")
    .option("--number <text>", "credential ID / certificate number (optional)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: AddOptions) => {
      await runAdd(options);
    });

  certs
    .command("update")
    .description("Update an existing certification entry by id")
    .argument("<id>", "certification id (V1-Certification-NNN)")
    .option("--name <text>", "certification name")
    .option("--issuer <text>", "issuing organization")
    .option("--issued <date>", "issue date — ISO-8601 or year")
    .option("--expires <date>", "expiration date — ISO-8601 or year")
    .option("--link <url>", "credential URL")
    .option("--number <text>", "credential ID / certificate number")
    .option("--highlight <bool>", "set highlight flag (true|false)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: UpdateOptions) => {
      await runUpdate(id, options);
    });

  certs
    .command("remove")
    .description("Remove a certification entry by id")
    .argument("<id>", "certification id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runRemove(id, options.output);
    });

  certs
    .command("show")
    .description("Show a single certification entry by id")
    .argument("<id>", "certification id")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runShow(id, options.output);
    });

  certs
    .command("list")
    .description("List every certification entry on your profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runList(options.output);
    });

  certs
    .command("highlight")
    .description("Toggle highlight on a certification entry")
    .argument("<id>", "certification id")
    .option("--off", "un-highlight (default is to highlight)", false)
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { off: boolean; output: OutputFormat }) => {
      await runHighlight(id, !options.off, options.output);
    });

  return certs;
}

interface AddOptions {
  name: string;
  issuer: string;
  issued?: string;
  expires?: string;
  link?: string;
  number?: string;
  output: OutputFormat;
}

interface UpdateOptions {
  name?: string;
  issuer?: string;
  issued?: string;
  expires?: string;
  link?: string;
  number?: string;
  highlight?: string;
  output: OutputFormat;
}

async function runAdd(options: AddOptions): Promise<void> {
  const fields: profile.certifications.CertificationFields = {
    certificate: options.name,
    institution: options.issuer,
  };
  applyDateFlags(fields, options, "profile certifications add", options.output);
  if (options.link !== undefined) fields.link = options.link;
  if (options.number !== undefined) fields.number = options.number;

  const token = await loadAuthTokenOrExit("profile certifications add", options.output);
  let result: profile.certifications.Certification;
  try {
    result = await profile.certifications.add(token, fields);
  } catch (err) {
    presentSubDomainError("profile certifications add", err, options.output);
  }
  emitAddSuccess({
    operation: "profile.certifications.add",
    format: options.output,
    created: result,
    prettySummary: `${result.certificate} — ${result.institution} (id ${result.id})`,
    prettyEntity: formatCertificationText,
  });
}

async function runUpdate(id: string, options: UpdateOptions): Promise<void> {
  const fields: profile.certifications.CertificationFields = {};
  if (options.name !== undefined) fields.certificate = options.name;
  if (options.issuer !== undefined) fields.institution = options.issuer;
  if (options.link !== undefined) fields.link = options.link;
  if (options.number !== undefined) fields.number = options.number;
  if (options.highlight !== undefined) {
    if (options.highlight !== "true" && options.highlight !== "false") {
      emitErrorAndExit({
        operation: "profile.certifications.update",
        format: options.output,
        errors: [
          {
            code: "VALIDATION_ERROR",
            field: "highlight",
            message: '--highlight expects "true" or "false"',
          },
        ],
        prettySummary: 'profile certifications update failed (VALIDATION_ERROR): --highlight expects "true" or "false"',
      });
    }
    fields.highlight = options.highlight === "true";
  }
  applyDateFlags(fields, options, "profile certifications update", options.output);

  if (Object.keys(fields).length === 0) {
    emitErrorAndExit({
      operation: "profile.certifications.update",
      format: options.output,
      errors: [{ code: "VALIDATION_ERROR", message: "at least one field flag is required" }],
      prettySummary: "profile certifications update failed (VALIDATION_ERROR): at least one field flag is required",
    });
  }

  const token = await loadAuthTokenOrExit("profile certifications update", options.output);
  let result: profile.certifications.Certification;
  try {
    result = await profile.certifications.update(token, id, fields);
  } catch (err) {
    presentSubDomainError("profile certifications update", err, options.output);
  }
  emitUpdateSuccess({
    operation: "profile.certifications.update",
    format: options.output,
    updated: result,
    prettySummary: `${result.certificate} — ${result.institution} (id ${result.id})`,
    prettyEntity: formatCertificationText,
  });
}

async function runRemove(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile certifications remove", format);
  let removedId: string;
  try {
    removedId = await profile.certifications.remove(token, id);
  } catch (err) {
    presentSubDomainError("profile certifications remove", err, format);
  }
  emitRemoveSuccess({
    operation: "profile.certifications.remove",
    format,
    id: removedId,
  });
}

async function runShow(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile certifications show", format);
  let result: profile.certifications.Certification;
  try {
    result = await profile.certifications.show(token, id);
  } catch (err) {
    presentSubDomainError("profile certifications show", err, format);
  }
  emitResult(result, format, { pretty: formatCertificationText, table: formatCertificationTable });
}

async function runList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile certifications list", format);
  let rows: profile.certifications.Certification[];
  try {
    rows = await profile.certifications.list(token);
  } catch (err) {
    presentSubDomainError("profile certifications list", err, format);
  }
  emitResult(wrapListEnvelope(rows), format, {
    pretty: (data) => formatCertificationListText(data.items),
    table: (data) => formatCertificationListTable(data.items),
    empty: { command: "profile.certifications.list" },
  });
}

async function runHighlight(id: string, value: boolean, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile certifications highlight", format);
  let result: { id: string; highlight: boolean };
  try {
    result = await profile.certifications.highlight(token, id, value);
  } catch (err) {
    presentSubDomainError("profile certifications highlight", err, format);
  }
  emitUpdateSuccess({
    operation: "profile.certifications.highlight",
    format,
    updated: result,
    prettySummary: `${result.id} highlight set to ${result.highlight.toString()}`,
    prettyEntity: (entity: { id: string; highlight: boolean }) => `highlight: ${entity.highlight.toString()}`,
  });
}

/**
 * Map `--issued` / `--expires` flag strings to `validFromMonth` /
 * `validFromYear` / `validToMonth` / `validToYear` Ints. Year-only inputs
 * default month to `1` per the issue's "January 1st" rule. ISO-8601
 * inputs preserve the parsed month and ignore the day component.
 *
 * Routes errors through the envelope ABI (#128).
 */
function applyDateFlags(
  fields: profile.certifications.CertificationFields,
  options: { issued?: string; expires?: string },
  commandLabel: string,
  format: OutputFormat,
): void {
  try {
    if (options.issued !== undefined) {
      const parsed = parseDateInput(options.issued, "issued");
      fields.validFromMonth = parsed.month;
      fields.validFromYear = parsed.year;
    }
    if (options.expires !== undefined) {
      const parsed = parseDateInput(options.expires, "expires");
      fields.validToMonth = parsed.month;
      fields.validToYear = parsed.year;
    }
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
 * Pretty-print a Certification row. Pure — no I/O.
 */
export function formatCertificationText(c: profile.certifications.Certification): string {
  const lines: string[] = [`${c.certificate} — ${c.institution}`];
  lines.push(`  ${formatValidityRange(c.validFromMonth, c.validFromYear, c.validToMonth, c.validToYear)}`);
  if (c.status) lines.push(`  status: ${c.status}`);
  if (c.number) lines.push(`  cred-id: ${c.number}`);
  if (c.link) lines.push(`  ${c.link}`);
  if (c.highlight) lines.push(`  highlighted`);
  lines.push(`  id: ${c.id}`);
  return lines.join("\n");
}

/**
 * Pretty-print a Certification row as a key/value table.
 */
export function formatCertificationTable(c: profile.certifications.Certification): string {
  const rows: [string, string][] = [
    ["id", c.id],
    ["certificate", c.certificate],
    ["institution", c.institution],
    ["valid", formatValidityRange(c.validFromMonth, c.validFromYear, c.validToMonth, c.validToYear)],
    ["status", c.status ?? ""],
    ["number", c.number ?? ""],
    ["link", c.link ?? ""],
    ["highlight", c.highlight.toString()],
  ];
  return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
}

function formatValidityRange(
  fromMonth: number | null,
  fromYear: number | null,
  toMonth: number | null,
  toYear: number | null,
): string {
  const fromStr = formatMonthYear(fromMonth, fromYear);
  const toStr = formatMonthYear(toMonth, toYear);
  if (fromStr === "—" && toStr === "—") return "—";
  if (toStr === "—") return `${fromStr}–no expiry`;
  if (fromStr === "—") return `?–${toStr}`;
  return `${fromStr}–${toStr}`;
}

function formatMonthYear(month: number | null, year: number | null): string {
  if (year === null) return "—";
  if (month === null) return year.toString();
  return `${month.toString().padStart(2, "0")}/${year.toString()}`;
}

/**
 * Pretty-print a list of Certification rows. One row per line, tab-separated:
 * certificate, institution, validity range, status, id.
 */
export function formatCertificationListText(rows: profile.certifications.Certification[]): string {
  if (rows.length === 0) return "(no certifications on profile)";
  return rows
    .map(
      (c) =>
        `${c.certificate}\t${c.institution}\t${formatValidityRange(c.validFromMonth, c.validFromYear, c.validToMonth, c.validToYear)}\t${c.status ?? "—"}\t${c.id}`,
    )
    .join("\n");
}

/**
 * Pretty-print a list of Certification rows as a cli-table3 table.
 */
export function formatCertificationListTable(rows: profile.certifications.Certification[]): string {
  const table = new Table({ head: ["Certificate", "Issuer", "Valid", "Status", "Highlight", "Id"], wordWrap: true });
  for (const c of rows) {
    table.push([
      c.certificate,
      c.institution,
      formatValidityRange(c.validFromMonth, c.validFromYear, c.validToMonth, c.validToYear),
      c.status ?? "—",
      c.highlight ? "yes" : "no",
      c.id,
    ]);
  }
  return table.toString();
}
