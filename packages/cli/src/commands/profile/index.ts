// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { buildProfileBasicCommand } from "./basic/index.js";
import { runProfileBasicShow } from "./basic/show.js";
import { runProfileBasicUpdate } from "./basic/set.js";
import { buildProfileCertificationsCommand } from "./certifications/index.js";
import { buildProfileEducationCommand } from "./education/index.js";
import { buildProfileEmploymentCommand } from "./employment/index.js";
import { buildProfileExternalCommand } from "./external/index.js";
import { buildProfileIndustriesCommand } from "./industries/index.js";
import { buildProfilePortfolioCommand } from "./portfolio/index.js";
import { buildProfileResumeCommand } from "./resume/index.js";
import { buildProfileReviewsCommand } from "./reviews/index.js";
import { buildProfileSkillsCommand } from "./skills/index.js";
import { buildProfileVisasCommand } from "./visas/index.js";

/**
 * Build the `ttctl profile` command tree. Hosts the 11 profile sub-domains
 * landing across #69 → #76. Today `basic`, `skills` (#73), `industries`,
 * `education`, `certifications`, `employment` (#74), `portfolio`, `visas`,
 * `resume` (#75), `external`, and `reviews` (#76) carry full operations.
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
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileBasicShow(options.output);
    });

  profile
    .command("update")
    .description("Update editable fields on the signed-in user's profile (alias for `profile basic update`)")
    .option("--bio <text>", 'long-form bio (inline text, "-" for stdin, or "@path" to read from file)')
    .option("--headline <text>", 'short tagline (inline text, "-" for stdin, or "@path" to read from file)')
    .option("--edit", "open $EDITOR to compose the bio interactively (cannot be combined with --bio)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { bio?: string; headline?: string; edit?: boolean; output: OutputFormat }) => {
      await runProfileBasicUpdate(options);
    });

  // Canonical sub-domain tree. All 11 sub-domains carry full operations:
  // `basic` and `skills` (#73), `industries`, `education`, `certifications`,
  // `employment` (#74), `portfolio`, `visas`, `resume` (#75), and
  // `external`, `reviews` (#76).
  profile.addCommand(buildProfileBasicCommand());
  profile.addCommand(buildProfileIndustriesCommand());
  profile.addCommand(buildProfileEducationCommand());
  profile.addCommand(buildProfileCertificationsCommand());
  profile.addCommand(buildProfileEmploymentCommand());
  profile.addCommand(buildProfileExternalCommand());
  profile.addCommand(buildProfilePortfolioCommand());
  profile.addCommand(buildProfileResumeCommand());
  profile.addCommand(buildProfileReviewsCommand());
  profile.addCommand(buildProfileSkillsCommand());
  profile.addCommand(buildProfileVisasCommand());

  return profile;
}
