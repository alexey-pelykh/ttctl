// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command } from "commander";

import { registerAuthCommand } from "./commands/auth/index.js";

/**
 * Build the root TTCtl Commander program. Sub-commands are registered as they
 * land in milestones; the program is shaped as a noun-verb tree (e.g.,
 * `ttctl profile show`, `ttctl timesheet list`).
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ttctl")
    .description("Unofficial CLI for the Toptal Talent platform — personal-productivity tool")
    .version("0.0.0");

  registerAuthCommand(program);

  program
    .command("profile")
    .description("View and update your Toptal Talent profile")
    .action(() => {
      // TODO(milestone-1): profile show / update
      console.log("profile: not yet implemented");
    });

  return program;
}
