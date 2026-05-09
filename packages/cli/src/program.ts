// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync } from "node:fs";

import { Command, Option } from "commander";
import type { Command as CommanderCommand } from "commander";

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
 *   `--config <path>` — explicit path to the YAML config, takes precedence
 *   over `TTCTL_CONFIG_FILE` and the home dotfile. Validated at invocation
 *   time (before any sub-command's action runs) — a missing file surfaces
 *   as `ConfigError(code: NO_CREDS)` rather than failing later inside
 *   `loadConfigFile`. Honors `aws --profile` / `kubectl --kubeconfig` UX
 *   expectations.
 *
 *   Resolution precedence (highest → lowest, post-#107):
 *
 *     1. `--config <path>`         — this flag (per-invocation)
 *     2. `TTCTL_CONFIG_FILE` env   — process-scoped (CI, direnv)
 *     3. `~/.ttctl.yaml`           — POSIX home dotfile (only fallback)
 *
 *   The CWD `./.ttctl.yaml` is NOT auto-discovered (closed in #92).
 *   XDG paths (`$XDG_CONFIG_HOME/ttctl/config.yaml`,
 *   `~/.config/ttctl/config.yaml`) are NOT consulted (closed in #107 — the
 *   single-file model places the captured bearer in the same YAML, so
 *   `~/.ttctl.yaml` is the canonical home location).
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ttctl")
    .description("Unofficial CLI for the Toptal Talent platform — personal-productivity tool")
    .version("0.0.0")
    .addOption(new Option("--config <path>", "path to YAML config (overrides TTCTL_CONFIG_FILE and ~/.ttctl.yaml)"))
    .hook("preAction", (thisCommand, actionCommand) => {
      // `thisCommand` is the root program where the hook is registered;
      // global options are read off it directly. The hook fires before
      // every sub-command's action, so the path is captured exactly once
      // per invocation. `actionCommand` is the deepest command being
      // executed (e.g., the `init` leaf under `auth init`).
      const opts = thisCommand.opts<{ config?: string }>();
      const configPath = opts.config;

      // `auth init` is a BOOTSTRAP command — its own `--config <path>`
      // flag is the OUTPUT destination, which by definition must not
      // exist (or `--force` is required). Both Commander's parser AND
      // the user's `program.opts()` see the same flag value, so the
      // global existence check would fire incorrectly here. Skip the
      // gate for `auth init` and let its own action handler govern the
      // path semantics. Other sub-commands (status / signin / signout /
      // profile / …) all read existing configs and benefit from the
      // gate.
      const isAuthInit = isAuthInitCommand(actionCommand);
      if (configPath !== undefined && !isAuthInit) {
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
      // For `auth init`: do NOT propagate the global `--config` value as
      // the CLI-context's "input config path" — the init handler's own
      // `options.config` carries the OUTPUT destination, semantically
      // different from a file-must-exist input config. Setting the
      // context to undefined keeps the read-side resolver unaware that
      // the output path was supplied (it would be the wrong target
      // anyway: init is creating, not reading).
      setCliConfigPath(isAuthInit ? undefined : configPath);
    });

  registerAuthCommand(program);

  program.addCommand(buildProfileCommand());

  return program;
}

/**
 * Detect whether the leaf command being executed is `auth init`. The
 * Commander parent chain is `auth init` ← parent `auth` ← parent root —
 * we walk the chain by name. Used by the global `preAction` hook to
 * suppress the existence check on the global `--config` flag when the
 * BOOTSTRAP command is the target. The `auth init` command's own
 * `--config <path>` flag is the OUTPUT destination, NOT an input config;
 * the global pre-flight gate would fire incorrectly in that case.
 */
function isAuthInitCommand(actionCommand: CommanderCommand): boolean {
  if (actionCommand.name() !== "init") return false;
  const parent = actionCommand.parent;
  return parent !== null && parent.name() === "auth";
}
