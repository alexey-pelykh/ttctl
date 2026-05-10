// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { OUTPUT_FORMATS } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { runProfileExternalAdvancedWizardShow } from "./advanced-wizard-show.js";
import { runProfileExternalCustomRequirementsSet } from "./custom-requirements-set.js";
import { runProfileExternalCustomRequirementsShow } from "./custom-requirements-show.js";
import { runProfileExternalReadiness } from "./readiness.js";
import { runProfileExternalRecommendations } from "./recommendations.js";
import { runProfileExternalUpdate } from "./update.js";

/**
 * Build the `ttctl profile external` command tree. The "external" sub-domain
 * bundles operations that the operation catalog clusters under the umbrella
 * names `external profile / advanced profile / wizard`. See
 * `core/services/profile/external/index.ts` for the heterogeneity rationale,
 * the deferred-ops list, and the spec/API divergences this PR documents
 * (notably: the `customRequirementsSet` boolean trio that supersedes the
 * issue's free-text-helper-#70 description).
 *
 * Six leaves:
 *   - update
 *   - custom-requirements show
 *   - custom-requirements set
 *   - readiness
 *   - recommendations
 *   - advanced-wizard show
 */
export function buildProfileExternalCommand(): Command {
  const external = new Command("external").description(
    "View and update external profile links, custom requirements, readiness, and the advanced-profile wizard",
  );

  external
    .command("update")
    .description("Update external profile URLs (linkedin, github, website, twitter, behance, dribbble)")
    .option("--linkedin <url>", "LinkedIn profile URL")
    .option("--github <url>", "GitHub profile URL")
    .option("--website <url>", "Personal website URL")
    .option("--twitter <url>", "Twitter / X profile URL")
    .option("--behance <url>", "Behance profile URL")
    .option("--dribbble <url>", "Dribbble profile URL")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: {
        linkedin?: string;
        github?: string;
        website?: string;
        twitter?: string;
        behance?: string;
        dribbble?: string;
        output: OutputFormat;
      }) => {
        await runProfileExternalUpdate(options);
      },
    );

  const customRequirements = external
    .command("custom-requirements")
    .description("View and update onboarding-readiness toggles (background check, drug test, time-tracking tools)");

  customRequirements
    .command("show")
    .description("Print the three onboarding-readiness toggles")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileExternalCustomRequirementsShow(options.output);
    });

  customRequirements
    .command("set")
    .description(
      "Toggle onboarding-readiness booleans. " +
        "Note: the underlying API is a three-boolean form (NOT free-text), so this leaf accepts " +
        "--background-check / --drug-test / --time-tracking-tools <true|false>. " +
        "See PR #76 for the spec/API reconciliation.",
    )
    .option("--background-check <bool>", "willing to undergo background check (true|false)")
    .option("--drug-test <bool>", "willing to undergo drug test (true|false)")
    .option("--time-tracking-tools <bool>", "willing to use time-tracking tools (true|false)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(
      async (options: {
        backgroundCheck?: string;
        drugTest?: string;
        timeTrackingTools?: string;
        output: OutputFormat;
      }) => {
        await runProfileExternalCustomRequirementsSet(options);
      },
    );

  external
    .command("readiness")
    .description("Show the per-section profile-readiness checklist and the rolled-up submit-available flag")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileExternalReadiness(options.output);
    });

  external
    .command("recommendations")
    .description("List the platform's per-section 'do this next' recommendations")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileExternalRecommendations(options.output);
    });

  const advancedWizard = external.command("advanced-wizard").description("View the advanced-profile-wizard status");

  advancedWizard
    .command("show")
    .description("Show the advanced-profile-wizard status (and travel-visa summary)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileExternalAdvancedWizardShow(options.output);
    });

  return external;
}
