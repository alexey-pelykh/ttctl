// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command } from "commander";

/**
 * Build the `ttctl profile employment` command tree.
 *
 * The canonical sub-domain name is `employment`; the CLI registers
 * `experience` as a Commander.js alias so users can type either form. Per
 * project policy (see issue #72), aliases are CLI-only — MCP tool names
 * use ONLY the canonical name (e.g., `ttctl_profile_employment_add`, never
 * `ttctl_profile_experience_add`).
 *
 * Operations land in #74. This builder currently registers the bare command
 * with its alias so the alias contract is in place before sub-commands
 * arrive.
 */
export function buildProfileEmploymentCommand(): Command {
  return new Command("employment")
    .alias("experience")
    .description("View and update the employment history section of your profile");
}
