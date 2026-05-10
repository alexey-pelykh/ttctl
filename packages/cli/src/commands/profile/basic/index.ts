// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { markMutation } from "../../../lib/dry-run.js";
import { OUTPUT_FORMATS } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { runProfileBasicPhotoShow } from "./photo-show.js";
import { runProfileBasicPhotoUpload } from "./photo-upload.js";
import { runProfileBasicShow } from "./show.js";
import { runProfileBasicUpdate } from "./set.js";

/**
 * Build the `ttctl profile basic` command tree. Exposes four leaves:
 *
 *   - `show`         — print the user's profile summary
 *   - `update`       — update bio / headline (dispatches to `profile.basic.set()`;
 *                      CLI verb is `update` per #68 epic verb economy, core
 *                      function is `set` per #69's `updateProfile` → `set` rename)
 *   - `photo show`   — print URLs of the user's profile photo variants
 *   - `photo upload` — upload a new profile photo from a local file
 *
 * The `photo` group is itself a Commander.js sub-command tree so users
 * type `ttctl profile basic photo show` rather than the flatter
 * `ttctl profile basic photo-show`. MCP tool names use the joined form
 * (`ttctl_profile_basic_photo_show`) per project policy.
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
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileBasicShow(options.output);
    });

  // Marked as a mutation (issue #52) so the global `--dry-run` flag
  // routes through to `profile.basic.set()`'s `dryRun` option. The
  // top-level alias `ttctl profile update` (registered in
  // `commands/profile/index.ts`) is also marked. Photo upload (a
  // mutation) is NOT marked yet — until #10 lands the MCP tools and
  // the dry-run path is wired into multipart mutations, the global
  // flag is a no-op there and the read-command stderr note (slightly
  // inaccurate text) fires. Tracked in the same #52 § Out of Scope
  // text and addressable in a follow-up.
  markMutation(
    basic
      .command("update")
      .description("Update editable fields on the signed-in user's profile (currently bio + headline)")
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
      }),
  );

  const photo = new Command("photo").description("View or upload the photo on your profile");

  photo
    .command("show")
    .description("Print the URLs of the signed-in user's profile photo variants")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileBasicPhotoShow(options.output);
    });

  photo
    .command("upload <file>")
    .description("Upload a new profile photo from a local image file (jpg / png / gif / webp)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (file: string, options: { output: OutputFormat }) => {
      await runProfileBasicPhotoUpload(file, options.output);
    });

  basic.addCommand(photo);

  return basic;
}
