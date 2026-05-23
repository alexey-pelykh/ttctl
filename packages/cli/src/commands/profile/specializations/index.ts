// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, InvalidArgumentError, Option } from "commander";

import { markMutation } from "../../../lib/dry-run.js";
import { OUTPUT_FORMATS } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { runProfileSpecializationsApply } from "./apply.js";
import { runProfileSpecializationsShow } from "./show.js";

/**
 * Build the `ttctl profile specializations` command tree.
 *
 * Two leaves:
 *   - `show`  — list the talent's specialization badges (#466)
 *   - `apply` — DESTRUCTIVE: apply for an additional specialization
 *               track (#467; gated by `--consent-profile-capability` per
 *               ADR-009 (ttctl); supports `--dry-run`)
 */
export function buildProfileSpecializationsCommand(): Command {
  const cmd = new Command("specializations").description(
    "View the talent's specialization badges and apply for new tracks (Core, Marketplace, Expert Crowd, etc.)",
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

  // #467 — DESTRUCTIVE apply for a specialization track. Per ADR-009
  // (ttctl) § Decision Part 1 (`profile-capability` domain): the
  // caller MUST pass `--consent-profile-capability`. The `--dry-run`
  // global flag (#52) routes through to the core service's `dryRun`
  // option via `markMutation`; preview emits the wire payload without
  // issuing the mutation. Specialization IDs come from
  // `profile specializations show` (the `id` field).
  markMutation(
    cmd
      .command("apply")
      .description(
        "Apply for a specialization track (DESTRUCTIVE — submits the talent to Toptal's review queue for the named track; no withdraw via TTCtl). " +
          "`--consent-profile-capability` is REQUIRED. Use `--dry-run` to preview the wire payload without issuing the mutation. " +
          "Get the specialization ID from `profile specializations show`.",
      )
      .argument("<specializationId>", "specialization track id (from `profile specializations show`)", parseSpecIdArg)
      .option(
        "--consent-profile-capability",
        "REQUIRED. Acknowledge this is a destructive profile-capability action — submits the talent's application to the named specialization track (no safe round-trip; no withdraw via TTCtl). See ADR-009 (ttctl) for the per-domain consent vocabulary.",
      )
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(
        async (specializationId: string, options: { consentProfileCapability?: boolean; output: OutputFormat }) => {
          const runOpts: import("./apply.js").ProfileSpecializationsApplyOptions = { output: options.output };
          if (options.consentProfileCapability !== undefined)
            runOpts.consentProfileCapability = options.consentProfileCapability;
          await runProfileSpecializationsApply(specializationId, runOpts);
        },
      ),
  );

  return cmd;
}

function parseSpecIdArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("specializationId must not be empty");
  }
  return trimmed;
}
