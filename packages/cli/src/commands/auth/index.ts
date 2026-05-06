// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Option } from "commander";
import type { Command } from "commander";

import { runAuthStatus } from "./status.js";
import type { AuthStatusOptions } from "./status.js";

/**
 * Register the `auth` command tree on the parent program.
 *
 * Currently only `auth status` is wired up (issue #6 — wave-0 MVP).
 * `auth signin` and `auth signout` ship in their own issues and will be
 * added here when they land. The parent `auth` command itself prints help
 * (commander's default behavior when no sub-command is invoked), which is
 * the desired UX for a noun-verb CLI.
 */
export function registerAuthCommand(parent: Command): void {
  const auth = parent.command("auth").description("Manage authentication and session state");

  auth
    .command("status")
    .description("Report whether the current session is valid")
    .addOption(new Option("-o, --output <format>", "output format").choices(["table", "json"]).default("table"))
    .action(async (options: AuthStatusOptions) => {
      await runAuthStatus(options);
    });
}
