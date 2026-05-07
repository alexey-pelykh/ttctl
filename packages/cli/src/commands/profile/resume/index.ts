// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command } from "commander";

/**
 * Build the `ttctl profile resume` command tree.
 *
 * The canonical sub-domain name is `resume`; the CLI registers `cv` as a
 * Commander.js alias so users can type either form. Per project policy
 * (see issue #72), aliases are CLI-only — MCP tool names use ONLY the
 * canonical name (e.g., `ttctl_profile_resume_upload`, never
 * `ttctl_profile_cv_upload`).
 *
 * Operations land in #75. This builder currently registers the bare command
 * with its alias so the alias contract is in place before sub-commands
 * arrive.
 */
export function buildProfileResumeCommand(): Command {
  return new Command("resume").alias("cv").description("View and update the resume section of your profile");
}
