// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { resolveConfig } from "@ttctl/core";
import type { TtctlConfig } from "@ttctl/core";

/**
 * Process-scoped holder for the explicit config path supplied via the
 * root program's `--config <path>` global option.
 *
 * Set once by the root program's `preAction` hook (see `program.ts`) before
 * any sub-command's action handler runs; read by every CLI call site that
 * loads `.ttctl.yaml`. Holding the path in a module-level variable lets
 * action handlers stay focused on their domain logic without each having to
 * walk Commander's parent chain via `cmd.optsWithGlobals()` — every leaf
 * already accepts a `commandLabel` string for error prefixing, and adding a
 * `cmd: Command` parameter to ~25 handlers would be invasive.
 *
 * When undefined (i.e., `--config` was not passed), `resolveConfigForCli`
 * falls back to the core resolution chain (`TTCTL_CONFIG_FILE` env var →
 * `$XDG_CONFIG_HOME/ttctl/config.yaml` → `~/.config/ttctl/config.yaml`).
 *
 * Tests must call `resetCliConfigPath()` in `beforeEach` to avoid bleeding
 * state across cases. The CLI surface invokes `setCliConfigPath` once per
 * process via the program's `preAction` hook, so production code never sees
 * stale values.
 */
let cliConfigPath: string | undefined;

/**
 * Capture the explicit config path from the root program's `--config`
 * global option. Called by the program's `preAction` hook before any
 * sub-command runs. Pass `undefined` when `--config` was omitted.
 */
export function setCliConfigPath(path: string | undefined): void {
  cliConfigPath = path;
}

/**
 * Read the captured `--config` value. Returns `undefined` when `--config`
 * was not passed; in that case `resolveConfigForCli` falls back to the
 * core resolution chain.
 *
 * Exported primarily for tests and rare callers that need the raw value
 * (e.g., to forward it to a subprocess via `TTCTL_CONFIG_FILE`).
 */
export function getCliConfigPath(): string | undefined {
  return cliConfigPath;
}

/**
 * Reset the captured path. Tests call this in `beforeEach` to avoid
 * bleeding state across cases. Not used in production.
 */
export function resetCliConfigPath(): void {
  cliConfigPath = undefined;
}

/**
 * The CLI surface's single entry point into the core's config resolver.
 *
 * Honors the explicit `--config` value captured by the root program's
 * `preAction` hook; falls back to the core resolution chain
 * (`TTCTL_CONFIG_FILE` → `$XDG_CONFIG_HOME/ttctl/config.yaml` →
 * `~/.config/ttctl/config.yaml`) when `--config` was not passed.
 *
 * AC contract (#93): every CLI command that touches config MUST call
 * `resolveConfigForCli()` rather than the bare `resolveConfig()` from
 * `@ttctl/core`. The bare form re-triggers the env→default chain and
 * silently ignores `--config` — that's the bug this wrapper exists to
 * prevent. A grep over `packages/cli/src/` for `resolveConfig\(\)`
 * (no args) should surface only this file.
 */
export function resolveConfigForCli(): { config: TtctlConfig; path: string } {
  // Conditionally include `path` so the `ResolveConfigOptions.path?: string`
  // contract is honored under `exactOptionalPropertyTypes: true` — passing
  // `{ path: undefined }` would be a type error even though the runtime
  // semantics are identical to omitting the field.
  return cliConfigPath !== undefined ? resolveConfig({ path: cliConfigPath }) : resolveConfig();
}
