// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { OUTPUT_FORMATS } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { runProfileSpecializationsShow } from "./show.js";

/**
 * Build the `ttctl profile specializations` command tree (#466). One leaf
 * today — read-only `show` over the talent's specialization badges. Apply
 * / withdrawal mutations are out of scope for v1 (the gateway exposes
 * `ApplyForSpecialization` but the apply flow has compliance / training
 * gates better suited to the portal UI).
 */
export function buildProfileSpecializationsCommand(): Command {
  const cmd = new Command("specializations").description(
    "View the talent's specialization badges (Core, Marketplace, Expert Crowd, etc.)",
  );

  cmd
    .command("show")
    .description("List the specialization tracks the talent has accepted, applied to, or is eligible for")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileSpecializationsShow(options.output);
    });

  return cmd;
}
