// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { OUTPUT_FORMATS } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { runProfileVisasAdd } from "./add.js";
import { runProfileVisasList } from "./list.js";
import { runProfileVisasRemove } from "./remove.js";
import { runProfileVisasUpdate } from "./update.js";

/**
 * Build the `ttctl profile visas` command tree.
 *
 * The canonical sub-domain name is `visas`. No alias — per project policy
 * (#72), aliases are CLI-only and only registered for sub-domains where
 * an alternative noun reads more naturally for English-speaking users.
 * `visas` carries no such alias.
 *
 * Operations: `add`, `update`, `remove` (alias `rm`), `list`.
 */
export function buildProfileVisasCommand(): Command {
  const visas = new Command("visas").description("View and update the travel-visa records on your profile");

  visas
    .command("add")
    .description("Create a new travel-visa record")
    .requiredOption("--country <id>", "country id (server-issued; see Toptal travel-visa form)")
    .requiredOption("--type <text>", "visa type (e.g., Schengen, B1/B2)")
    .option("--issued <date>", "(reserved for future server support; not currently sent)")
    .option("--expires <date>", "expiry date in YYYY-MM-DD")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: { country: string; type: string; issued?: string; expires?: string; output: OutputFormat }) => {
        await runProfileVisasAdd(options);
      },
    );

  visas
    .command("update")
    .description("Update fields on a travel-visa record")
    .argument("<id>", "id of the travel-visa record to update")
    .option("--country <id>", "country id")
    .option("--type <text>", "visa type")
    .option("--expires <date>", "expiry date in YYYY-MM-DD")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (id: string, options: { country?: string; type?: string; expires?: string; output: OutputFormat }) => {
        await runProfileVisasUpdate(id, options);
      },
    );

  visas
    .command("remove")
    .alias("rm")
    .description("Remove a travel-visa record")
    .argument("<id>", "id of the travel-visa record to remove")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runProfileVisasRemove(id, options.output);
    });

  visas
    .command("list")
    .description("List travel-visa records")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileVisasList(options.output);
    });

  return visas;
}
