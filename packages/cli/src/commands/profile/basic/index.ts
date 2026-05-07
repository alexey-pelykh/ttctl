// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { OUTPUT_FORMATS, runProfileBasicShow } from "./show.js";
import type { ProfileOutputFormat } from "./show.js";
import { runProfileBasicUpdate } from "./set.js";

/**
 * Build the `ttctl profile basic` command tree. Currently exposes two
 * sub-commands: `show` (read-side) and `update` (write-side; dispatches to
 * the core `profile.basic.set()` function — the user-facing CLI verb is
 * `update` per the #68 epic verb economy, the core function name is `set`
 * per #69's verb-rename of `updateProfile` → `set`).
 *
 * The `photo-show` and `photo-upload` placeholders sit alongside as
 * implementation stubs for #73; this command tree does not register them
 * yet — they appear when their implementations land.
 */
export function buildProfileBasicCommand(): Command {
  const basic = new Command("basic").description(
    "View and update the basic-info section of your profile (bio, headline, photo)",
  );

  basic
    .command("show")
    .description("Print a summary of the signed-in user's Toptal Talent profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies ProfileOutputFormat),
    )
    .action(async (options: { output: ProfileOutputFormat }) => {
      await runProfileBasicShow(options.output);
    });

  basic
    .command("update")
    .description("Update editable fields on the signed-in user's profile (currently bio + headline)")
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

  return basic;
}
