// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { buildProfileBasicCommand } from "./basic/index.js";
import { OUTPUT_FORMATS, runProfileBasicShow } from "./basic/show.js";
import type { ProfileOutputFormat } from "./basic/show.js";
import { runProfileBasicUpdate } from "./basic/set.js";

/**
 * Build the `ttctl profile` command tree. Hosts the 11 profile sub-domains
 * landing across #69 → #76. Today only `basic` carries operations
 * (`profile basic show`, `profile basic update`); the other 10 sub-domains
 * are placeholder modules that wire in their commands when their
 * implementations land.
 *
 * The tree also preserves the wave-0 short-form CLI surface: `ttctl profile
 * show` and `ttctl profile update --bio --headline` continue to work as
 * direct aliases for `ttctl profile basic show` and `ttctl profile basic
 * update`. This is the AC-permitted "backwards-compatible" branch — the
 * alternative was a hard rename to the deeper `basic` sub-tree (see
 * CHANGELOG entry for the v0 surface refactor for the rationale).
 */
export function buildProfileCommand(): Command {
  const profile = new Command("profile").description("View and update your Toptal Talent profile");

  // Short-form aliases at the top level. These dispatch to the same handlers
  // as the canonical `basic` sub-tree below — the duplication keeps the
  // user-visible behavior of the wave-0 commands unchanged while the v0
  // tree shape is rolled out underneath.
  profile
    .command("show")
    .description("Print a summary of the signed-in user's Toptal Talent profile (alias for `profile basic show`)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies ProfileOutputFormat),
    )
    .action(async (options: { output: ProfileOutputFormat }) => {
      await runProfileBasicShow(options.output);
    });

  profile
    .command("update")
    .description("Update editable fields on the signed-in user's profile (alias for `profile basic update`)")
    .option(
      "--bio <text>",
      'long-form bio (inline text, "-" for stdin, or "@path" to read from file)',
    )
    .option(
      "--headline <text>",
      'short tagline (inline text, "-" for stdin, or "@path" to read from file)',
    )
    .option("--edit", "open $EDITOR to compose the bio interactively (cannot be combined with --bio)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies ProfileOutputFormat),
    )
    .action(
      async (options: {
        bio?: string;
        headline?: string;
        edit?: boolean;
        output: ProfileOutputFormat;
      }) => {
        await runProfileBasicUpdate(options);
      },
    );

  // Canonical sub-domain tree. Only `basic` is wired today; the other 10
  // sub-domains are placeholder modules that register their command trees
  // when their respective issues (#73-#76) land.
  profile.addCommand(buildProfileBasicCommand());

  return profile;
}
