// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Option } from "commander";
import type { Command } from "commander";

import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { exitCodeForInitResult, formatInitOutput, runAuthInit } from "./init.js";
import type { AuthInitOptions } from "./init.js";
import { runAuthSignIn } from "./signin.js";
import type { AuthSignInOptions } from "./signin.js";
import { runAuthSignOut } from "./signout.js";
import type { AuthSignOutOptions } from "./signout.js";
import { runAuthStatus } from "./status.js";
import type { AuthStatusOptions } from "./status.js";

/**
 * Register the `auth` command tree on the parent program.
 *
 * The auth subcommand surface is a noun-verb tree: `auth init`, `auth
 * status`, `auth signin`, `auth signout`. The status / signin / signout
 * trio share the same `-o, --output` option (post-#126: `pretty` default
 * via `OUTPUT_FORMATS`, with `json` and `yaml` available — pre-#126 the
 * auth surface defaulted to `table`, which collapsed into `pretty`);
 * `auth init` is purely interactive and produces a side-effect (file on
 * disk), so its surface is a confirmation line (no `-o` flag).
 *
 * The parent `auth` command itself prints help when invoked without a
 * sub-command (commander default), which is the desired UX.
 */
export function registerAuthCommand(parent: Command): void {
  const auth = parent.command("auth").description("Manage authentication and session state");

  auth
    .command("init")
    .description("Scaffold a fresh ~/.ttctl.yaml interactively (recommended first command)")
    .addOption(new Option("--config <path>", "output path (default: ~/.ttctl.yaml)"))
    .addOption(new Option("--force", "overwrite existing config (default: refuse)"))
    .action(async (options: AuthInitOptions) => {
      const result = await runAuthInit(options);
      // Output is already routed via clack's intro/outro/cancel for the
      // interactive surface. The terminal exit-code contract still needs
      // to fire — and for non-TTY refusal (where clack never ran) we
      // also need to write the message ourselves.
      if (result.status === "refused" && result.reason === "non-tty") {
        process.stderr.write(formatInitOutput(result) + "\n");
      }
      process.exit(exitCodeForInitResult(result));
    });

  auth
    .command("status")
    .description("Report whether the current session is valid")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: AuthStatusOptions) => {
      await runAuthStatus(options);
    });

  auth
    .command("signin")
    .description("Sign in with credentials from .ttctl.yaml and persist the session")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: AuthSignInOptions) => {
      await runAuthSignIn(options);
    });

  auth
    .command("signout")
    .description("Clear the persisted session cookie jar (idempotent)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: AuthSignOutOptions) => {
      await runAuthSignOut(options);
    });
}
