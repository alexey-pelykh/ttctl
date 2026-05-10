// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { DateInputError, parseDateInput, profile } from "@ttctl/core";
import { Command, Option } from "commander";

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
    .action(async (id: string) => {
      await runRemove(id);
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
    .command("highlight")
    .description("Toggle highlight on a certification entry")
    .argument("<id>", "certification id")
    .option("--off", "un-highlight (default is to highlight)", false)
    .action(async (id: string, options: { off: boolean }) => {
      await runHighlight(id, !options.off);
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
  applyDateFlags(fields, options, "profile certifications add");
  if (options.link !== undefined) fields.link = options.link;
  if (options.number !== undefined) fields.number = options.number;

  const token = await loadAuthTokenOrExit("profile certifications add");
  let result: profile.certifications.Certification;
  try {
    result = await profile.certifications.add(token, fields);
  } catch (err) {
    presentSubDomainError("profile certifications add", err);
  }
  emitResult(result, options.output, { pretty: formatCertificationText, table: formatCertificationTable });
}

async function runUpdate(id: string, options: UpdateOptions): Promise<void> {
  const fields: profile.certifications.CertificationFields = {};
  if (options.name !== undefined) fields.certificate = options.name;
  if (options.issuer !== undefined) fields.institution = options.issuer;
  if (options.link !== undefined) fields.link = options.link;
  if (options.number !== undefined) fields.number = options.number;
  if (options.highlight !== undefined) {
    if (options.highlight !== "true" && options.highlight !== "false") {
      process.stderr.write(
        `profile certifications update failed (VALIDATION_ERROR): --highlight expects "true" or "false"\n`,
      );
      process.exit(1);
    }
    fields.highlight = options.highlight === "true";
  }
  applyDateFlags(fields, options, "profile certifications update");

  if (Object.keys(fields).length === 0) {
    process.stderr.write(
      `profile certifications update failed (VALIDATION_ERROR): at least one field flag is required\n`,
    );
    process.exit(1);
  }

  const token = await loadAuthTokenOrExit("profile certifications update");
  let result: profile.certifications.Certification;
  try {
    result = await profile.certifications.update(token, id, fields);
  } catch (err) {
    presentSubDomainError("profile certifications update", err);
  }
  emitResult(result, options.output, { pretty: formatCertificationText, table: formatCertificationTable });
}

async function runRemove(id: string): Promise<void> {
  const token = await loadAuthTokenOrExit("profile certifications remove");
  let removedId: string;
  try {
    removedId = await profile.certifications.remove(token, id);
  } catch (err) {
    presentSubDomainError("profile certifications remove", err);
  }
  process.stdout.write(`Certification ${removedId} removed.\n`);
}

async function runShow(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile certifications show");
  let result: profile.certifications.Certification;
  try {
    result = await profile.certifications.show(token, id);
  } catch (err) {
    presentSubDomainError("profile certifications show", err);
  }
  emitResult(result, format, { pretty: formatCertificationText, table: formatCertificationTable });
}

async function runHighlight(id: string, value: boolean): Promise<void> {
  const token = await loadAuthTokenOrExit("profile certifications highlight");
  let result: { id: string; highlight: boolean };
  try {
    result = await profile.certifications.highlight(token, id, value);
  } catch (err) {
    presentSubDomainError("profile certifications highlight", err);
  }
  process.stdout.write(`Certification ${result.id} highlight set to ${result.highlight.toString()}.\n`);
}

/**
 * Map `--issued` / `--expires` flag strings to `validFromMonth` /
 * `validFromYear` / `validToMonth` / `validToYear` Ints. Year-only inputs
 * default month to `1` per the issue's "January 1st" rule. ISO-8601
 * inputs preserve the parsed month and ignore the day component.
 */
function applyDateFlags(
  fields: profile.certifications.CertificationFields,
  options: { issued?: string; expires?: string },
  commandLabel: string,
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
      process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
      process.exit(1);
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
