// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import { Command, Option } from "commander";

import { wrapListEnvelope } from "../../../lib/envelopes.js";
import { OUTPUT_FORMATS, emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, presentSubDomainError } from "../shared.js";

export function buildProfileCountriesCommand(): Command {
  const countries = new Command("countries").description(
    "Look up the Toptal Country/geography catalog (id discovery for --primary-geography-id)",
  );

  countries
    .command("list")
    .description("List the Toptal Country catalog (id, ISO code, name) to resolve a --primary-geography-id value")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runList(options.output);
    });

  return countries;
}

async function runList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile countries list", format);
  let result: profile.countries.Country[];
  try {
    result = await profile.countries.list(token);
  } catch (err) {
    presentSubDomainError("profile countries list", err, format);
  }
  emitResult(wrapListEnvelope(result), format, {
    pretty: (data) => formatCountriesText(data.items),
    table: (data) => formatCountriesTable(data.items),
    empty: { command: "profile.countries.list" },
  });
}

export function formatCountriesText(rows: profile.countries.Country[]): string {
  if (rows.length === 0) return "(no countries returned)";
  return rows.map((c) => `${c.name ?? "(unnamed)"}${c.code ? ` [${c.code}]` : ""} (${c.id})`).join("\n");
}

export function formatCountriesTable(rows: profile.countries.Country[]): string {
  if (rows.length === 0) return "(no countries returned)";
  return rows.map((c) => `${c.id}\t${c.code ?? ""}\t${c.name ?? ""}`).join("\n");
}
