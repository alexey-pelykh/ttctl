// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Option } from "commander";
import type { Command } from "commander";

import { runAuthSignIn } from "./signin.js";
import type { AuthSignInOptions } from "./signin.js";
import { runAuthSignOut } from "./signout.js";
import type { AuthSignOutOptions } from "./signout.js";
import { runAuthStatus } from "./status.js";
import type { AuthStatusOptions } from "./status.js";

/**
 * Register the `auth` command tree on the parent program.
 *
 * The auth subcommand surface is a noun-verb tree: `auth status`, `auth
 * signin`, `auth signout`. Sub-commands all share the same `-o, --output`
 * option (`table` default, `json` for scripting). The parent `auth` command
 * itself prints help when invoked without a sub-command (commander default),
 * which is the desired UX.
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

  auth
    .command("signin")
    .description("Sign in with credentials from .ttctl.yaml and persist the session")
    .addOption(new Option("-o, --output <format>", "output format").choices(["table", "json"]).default("table"))
    .action(async (options: AuthSignInOptions) => {
      await runAuthSignIn(options);
    });

  auth
    .command("signout")
    .description("Clear the persisted session cookie jar (idempotent)")
    .addOption(new Option("-o, --output <format>", "output format").choices(["table", "json"]).default("table"))
    .action(async (options: AuthSignOutOptions) => {
      await runAuthSignOut(options);
    });
}
