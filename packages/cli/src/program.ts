// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync } from "node:fs";

import { Command, Option } from "commander";

import { ConfigError } from "@ttctl/core";

import { registerAuthCommand } from "./commands/auth/index.js";
import { buildProfileCommand } from "./commands/profile/index.js";
import { setCliConfigPath } from "./lib/config-context.js";

/**
 * Build the root TTCtl Commander program. Sub-commands are registered as they
 * land in milestones; the program is shaped as a noun-verb tree (e.g.,
 * `ttctl profile show`, `ttctl timesheet list`).
 *
 * Global options:
 *
 *   `--config <path>` — explicit path to `.ttctl.yaml`, takes precedence
 *   over `TTCTL_CONFIG_FILE` and the XDG/home defaults. Validated at
 *   invocation time (before any sub-command's action runs) — a missing
 *   file surfaces as `ConfigError(code: NO_CREDS)` rather than failing
 *   later inside `loadConfigFile`. Honors `aws --profile` /
 *   `kubectl --kubeconfig` UX expectations.
 *
 *   Resolution precedence (highest → lowest):
 *
 *     1. `--config <path>`         — this flag (per-invocation)
 *     2. `TTCTL_CONFIG_FILE` env   — process-scoped (CI, direnv)
 *     3. `$XDG_CONFIG_HOME/ttctl/config.yaml` — when set + file exists
 *     4. `~/.config/ttctl/config.yaml`         — POSIX home default
 *
 *   The CWD `./.ttctl.yaml` is NOT auto-discovered; that was removed in
 *   #92 alongside the `TTCTL_CONFIG_FILE` env var rollout.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ttctl")
    .description("Unofficial CLI for the Toptal Talent platform — personal-productivity tool")
    .version("0.0.0")
    .addOption(new Option("--config <path>", "path to .ttctl.yaml (overrides TTCTL_CONFIG_FILE and XDG/home defaults)"))
    .hook("preAction", (thisCommand) => {
      // `thisCommand` is the root program where the hook is registered;
      // global options are read off it directly. The hook fires before
      // every sub-command's action, so the path is captured exactly once
      // per invocation.
      const opts = thisCommand.opts<{ config?: string }>();
      const configPath = opts.config;
      if (configPath !== undefined) {
        if (!existsSync(configPath)) {
          // AC: validate at invocation time, don't wait for the first
          // command that loads it. Surface as `ConfigError(NO_CREDS)`
          // with the same uniform shape `loadConfigFile` produces, so
          // script consumers see one code regardless of where the
          // missing-file check fired.
          const err = new ConfigError(`Config file not found: ${configPath}`, "NO_CREDS", configPath);
          process.stderr.write(`Error (${err.code}): ${err.message}\n`);
          process.exit(1);
        }
      }
      setCliConfigPath(configPath);
    });

  registerAuthCommand(program);

  program.addCommand(buildProfileCommand());

  return program;
}
