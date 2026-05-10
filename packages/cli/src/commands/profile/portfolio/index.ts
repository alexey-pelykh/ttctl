// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { OUTPUT_FORMATS } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { runProfilePortfolioAdd } from "./add.js";
import { runProfilePortfolioHighlight } from "./highlight.js";
import { runProfilePortfolioList } from "./list.js";
import { runProfilePortfolioRemove } from "./remove.js";
import { runProfilePortfolioReorder } from "./reorder.js";
import { runProfilePortfolioUpdate } from "./update.js";
import { runProfilePortfolioUpload } from "./upload.js";

/**
 * Build the `ttctl profile portfolio` command tree.
 *
 * The canonical sub-domain name is `portfolio`; the CLI registers
 * `projects` as a Commander.js alias so users can type either form. Per
 * project policy (see issue #72), aliases are CLI-only — MCP tool names
 * use ONLY the canonical name.
 *
 * The seven leaves follow the verb economy from the #68 epic:
 * `add / update / remove / list / reorder / highlight / upload`. The
 * `update` verb name is the user-facing CLI form; the core function is
 * `update()` (no rename — verbs match between CLI and core for portfolio).
 */
export function buildProfilePortfolioCommand(): Command {
  const portfolio = new Command("portfolio")
    .alias("projects")
    .description("View and update the portfolio section of your profile");

  portfolio
    .command("add")
    .description("Create a new portfolio item")
    .requiredOption("--title <text>", "portfolio item title")
    .option("--description <text>", 'item description (inline text, "-" for stdin, or "@path" to read from file)')
    .option("--edit", "open $EDITOR to compose the description interactively")
    .option("--url <url>", "primary URL for the item (alias for --link)")
    .option("--link <url>", "primary URL for the item (canonical flag, equivalent to --url)")
    .option("--cover <file>", "path to a cover-image file to upload alongside the item")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: {
        title: string;
        description?: string;
        edit?: boolean;
        url?: string;
        link?: string;
        cover?: string;
        output: OutputFormat;
      }) => {
        await runProfilePortfolioAdd(options);
      },
    );

  portfolio
    .command("update")
    .description("Update fields on a portfolio item")
    .argument("<id>", "id of the portfolio item to update")
    .option("--title <text>", "portfolio item title")
    .option("--description <text>", 'item description (inline text, "-" for stdin, or "@path" to read from file)')
    .option("--edit", "open $EDITOR to compose the description interactively")
    .option("--url <url>", "primary URL for the item (alias for --link)")
    .option("--link <url>", "primary URL for the item (canonical flag, equivalent to --url)")
    .option("--client <name>", "client/company name")
    .option("--accomplishment <text>", "accomplishment summary")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (
        id: string,
        options: {
          title?: string;
          description?: string;
          edit?: boolean;
          url?: string;
          link?: string;
          client?: string;
          accomplishment?: string;
          output: OutputFormat;
        },
      ) => {
        await runProfilePortfolioUpdate(id, options);
      },
    );

  portfolio
    .command("remove")
    .alias("rm")
    .description("Remove a portfolio item")
    .argument("<id>", "id of the portfolio item to remove")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runProfilePortfolioRemove(id, options.output);
    });

  portfolio
    .command("list")
    .description("List portfolio items")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfilePortfolioList(options.output);
    });

  portfolio
    .command("reorder")
    .description("Reorder a portfolio item")
    .argument("<id>", "id of the portfolio item to move")
    .option("--before <id>", "place the item immediately before this neighbour id")
    .option("--after <id>", "place the item immediately after this neighbour id")
    .option("--to <position>", "place the item at this absolute 0-based position")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { before?: string; after?: string; to?: string; output: OutputFormat }) => {
      await runProfilePortfolioReorder(id, options);
    });

  portfolio
    .command("highlight")
    .description("Toggle the highlight flag on a portfolio item (default: enable)")
    .argument("<id>", "id of the portfolio item to highlight")
    .option("--off", "clear the highlight flag instead of setting it")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { off?: boolean; output: OutputFormat }) => {
      await runProfilePortfolioHighlight(id, options);
    });

  portfolio
    .command("upload")
    .description("Upload a cover image (--cover) or attachment file (--file) for the user's portfolio")
    .argument("[id]", "(unused; reserved for future per-item upload routing)")
    .option("--cover <file>", "path to a cover-image file to upload")
    .option("--file <file>", "path to a portfolio-attachment file to upload")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string | undefined, options: { cover?: string; file?: string; output: OutputFormat }) => {
      await runProfilePortfolioUpload(id, options);
    });

  return portfolio;
}
