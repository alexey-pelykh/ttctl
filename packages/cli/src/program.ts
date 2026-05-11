// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync } from "node:fs";

import { Command, Option } from "commander";
import type { Command as CommanderCommand } from "commander";

import { ConfigError } from "@ttctl/core";

import { buildApplicationsCommand } from "./commands/applications/index.js";
import { registerAuthCommand } from "./commands/auth/index.js";
import { buildAvailabilityCommand } from "./commands/availability/index.js";
import { buildEngagementsCommand } from "./commands/engagements/index.js";
import { buildProfileCommand } from "./commands/profile/index.js";
import { setCliConfigPath } from "./lib/config-context.js";
import { DRY_RUN_NO_OP_STDERR_NOTE, isMutationCommand, setCliDryRun } from "./lib/dry-run.js";
import type { OutputFormat } from "./lib/output.js";

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
 *
 *   `--json` / `--yaml` — boolean shortcuts for `--output=json` /
 *   `--output=yaml` (post-#126). Mutual exclusion with `--output`/`-o` is
 *   enforced in the preAction hook: any two of `{--output, -o, --json,
 *   --yaml}` present together raise a parse-time error before the
 *   sub-command's action runs.
 *
 *   `--dry-run` (issue #52) — preview a mutation without sending it.
 *   Captured into the module-scoped `cliDryRun` holder via
 *   `setCliDryRun` in the preAction hook so mutation handlers can read
 *   it through `getCliDryRun()`. Leaf commands tagged via
 *   `markMutation()` (in their `build*Command` factories) route the
 *   value through to the core layer's `dryRun` option; non-mutation
 *   leaves get a one-line stderr no-op note from the preAction hook
 *   (`DRY_RUN_NO_OP_STDERR_NOTE`) and proceed normally.
 *
 *   MCP tool integration is conditional on issue #10 having landed —
 *   when MCP tools that wrap mutations ship, they accept the same
 *   `dryRun?: boolean` input parameter and route through the same core
 *   `dryRun` option. Until then, no MCP-side wiring is required.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ttctl")
    .description("Unofficial CLI for the Toptal Talent platform — personal-productivity tool")
    .version("0.0.0")
    .addOption(new Option("--config <path>", "path to YAML config (overrides TTCTL_CONFIG_FILE and ~/.ttctl.yaml)"))
    .addOption(new Option("--json", "shortcut for --output=json (mutually exclusive with --output, -o, --yaml)"))
    .addOption(new Option("--yaml", "shortcut for --output=yaml (mutually exclusive with --output, -o, --json)"))
    .addOption(
      new Option("--dry-run", "preview a mutation request without sending it (no-op for read commands)").default(false),
    )
    .hook("preAction", (thisCommand, actionCommand) => {
      // `thisCommand` is the root program where the hook is registered;
      // global options are read off it directly. The hook fires before
      // every sub-command's action, so the path is captured exactly once
      // per invocation. `actionCommand` is the deepest command being
      // executed (e.g., the `init` leaf under `auth init`).
      const opts = thisCommand.opts<{ config?: string; json?: boolean; yaml?: boolean; dryRun?: boolean }>();
      const configPath = opts.config;

      // Mutual exclusion across format flags (post-#126). The user-visible
      // surface is `--output={pretty,yaml,json}` plus boolean shortcuts
      // `--json` / `--yaml`. Any two flags from the set
      // `{--output, -o, --json, --yaml}` present together is a parse-time
      // error — fired BEFORE the sub-command's action runs so the error
      // message is uniform regardless of which leaf the user invoked.
      //
      // `getOptionValueSource("output")` distinguishes "user passed it"
      // (source === `"cli"`) from "Commander filled the default"
      // (source === `"default"`). Without this check the default value
      // would always fire and every `--json` / `--yaml` use would be
      // (incorrectly) flagged as a conflict.
      const outputExplicit = actionCommand.getOptionValueSource("output") === "cli";
      const explicitFlags: string[] = [];
      if (outputExplicit) {
        const out = actionCommand.opts<{ output?: string }>().output;
        explicitFlags.push(`--output=${out ?? ""}`);
      }
      if (opts.json === true) explicitFlags.push("--json");
      if (opts.yaml === true) explicitFlags.push("--yaml");
      if (explicitFlags.length > 1) {
        const head = explicitFlags.slice(0, -1).join(", ");
        const tail = explicitFlags[explicitFlags.length - 1] ?? "";
        process.stderr.write(`Error: Conflicting output flags: ${head} and ${tail}\n`);
        process.exit(1);
      }

      // Propagate `--json` / `--yaml` to the action command's `output`
      // option. Sub-commands that don't carry an `--output` option simply
      // ignore the propagation (Commander tolerates `setOptionValue` on
      // an unknown key — the action handler never reads it).
      const hasOutputOption = actionCommand.options.some((o) => o.long === "--output");
      if (hasOutputOption) {
        if (opts.json === true) {
          actionCommand.setOptionValue("output", "json" satisfies OutputFormat);
        } else if (opts.yaml === true) {
          actionCommand.setOptionValue("output", "yaml" satisfies OutputFormat);
        }
      }

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

      // Capture the global `--dry-run` flag (issue #52). Commander's
      // `Option.default(false)` means `opts.dryRun` is `false` when the
      // flag is omitted, `true` when present — no need to coerce
      // `undefined`. Mutation handlers read the captured value through
      // `getCliDryRun()` and route through the core's `dryRun` option.
      const dryRun = opts.dryRun === true;
      setCliDryRun(dryRun);

      // No-op note for non-mutation leaves: when `--dry-run` is set on a
      // leaf that has NOT been tagged via `markMutation()` (today: every
      // command except the basic-update leaf and its top-level alias),
      // emit the AC-mandated stderr note and proceed normally. The
      // exact text is locked by the AC for issue #52 — see
      // `DRY_RUN_NO_OP_STDERR_NOTE` for the constant.
      //
      // The note is informational, not blocking — the action handler
      // runs immediately after this hook returns. Read commands and
      // unsupported mutations both fall into this branch today; future
      // mutation-bearing PRs (timesheet submit per #13, additional
      // profile sub-domain updates per #74-76) MUST call
      // `markMutation()` on their leaves to opt out of the note.
      if (dryRun && !isMutationCommand(actionCommand)) {
        process.stderr.write(DRY_RUN_NO_OP_STDERR_NOTE);
      }
    });

  registerAuthCommand(program);

  program.addCommand(buildProfileCommand());
  program.addCommand(buildApplicationsCommand());
  program.addCommand(buildEngagementsCommand());
  program.addCommand(buildAvailabilityCommand());

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
