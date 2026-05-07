// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command } from "commander";

/**
 * Build the `ttctl profile portfolio` command tree.
 *
 * The canonical sub-domain name is `portfolio`; the CLI registers
 * `projects` as a Commander.js alias so users can type either form. Per
 * project policy (see issue #72), aliases are CLI-only — MCP tool names
 * use ONLY the canonical name (e.g., `ttctl_profile_portfolio_add`, never
 * `ttctl_profile_projects_add`).
 *
 * Operations land in #75. This builder currently registers the bare command
 * with its alias so the alias contract is in place before sub-commands
 * arrive.
 */
export function buildProfilePortfolioCommand(): Command {
  return new Command("portfolio")
    .alias("projects")
    .description("View and update the portfolio section of your profile");
}
