// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadConfigFile } from "@ttctl/core";
import { stringify as stringifyYaml } from "yaml";

/**
 * Walk upward from `start` until a directory containing one of the
 * repo-root sentinels is found (`pnpm-workspace.yaml` first, then `.git`).
 * Throws if none is found before hitting the filesystem root — this would
 * mean the harness was invoked outside the ttctl monorepo, which is a
 * user-error condition.
 *
 * Sentinel order matters: `pnpm-workspace.yaml` is the authoritative
 * monorepo root. `.git` is a fallback for shallow clones / git worktrees
 * where the workspace file might be at a sibling location, but in this
 * project the two coincide.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let current = resolve(start);
  // `for (;;)` rather than `while (true)` — the latter trips eslint's
  // `no-unnecessary-condition` because the static type of `true` makes the
  // condition trivially constant. The loop is deliberately infinite; exit
  // is via the `return` or `throw` below.
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `findRepoRoot: walked from ${start} up to filesystem root without finding pnpm-workspace.yaml or .git. ` +
          `The E2E harness must run inside the ttctl monorepo.`,
      );
    }
    current = parent;
  }
}

/**
 * Sandbox directory for an E2E run — `<repo-root>/.tmp/e2e/`.
 *
 * The harness writes a fixture `.ttctl.yaml` here and exposes its absolute
 * path as `cliConfigPath()` for injection into spawned CLI / MCP
 * subprocesses as `TTCTL_CONFIG_FILE`. The fixture's relative
 * `auth-token-path: ./auth.token` resolves against the config file's
 * directory → `<sandbox>/auth.token`. The user's everyday session at
 * `~/.ttctl/auth.token` (or `$XDG_DATA_HOME/ttctl/auth.token`) is never
 * touched.
 */
export function resolveSandboxDir(repoRoot: string): string {
  return join(repoRoot, ".tmp", "e2e");
}

/**
 * Path to the fixture `.ttctl.yaml` that lives inside the sandbox.
 * Created by `writeSandboxConfig`.
 */
export function resolveSandboxConfigPath(repoRoot: string): string {
  return join(resolveSandboxDir(repoRoot), ".ttctl.yaml");
}

/**
 * Path to the sandbox `.ttctl.yaml` fixture, named for the env-injection
 * use case. Identical to `resolveSandboxConfigPath`; this alias documents
 * the intent at the call site (the value injected as `TTCTL_CONFIG_FILE`
 * into spawned CLI / MCP subprocesses, per #94).
 */
export function cliConfigPath(repoRoot: string): string {
  return resolveSandboxConfigPath(repoRoot);
}

/**
 * Path to the isolated auth token used by the E2E harness.
 *
 * Always under `<repo-root>/.tmp/e2e/auth.token`. NEVER touches the user's
 * working session at `~/.ttctl/auth.token` — see `packages/e2e/README.md`
 * for the live-account-safety rationale.
 *
 * The CLI subprocess discovers this same path by reading the sandbox
 * fixture `.ttctl.yaml` (whose `auth-token-path: ./auth.token` resolves
 * relative to the sandbox dir). No environment variable is involved.
 */
export function resolveIsolatedAuthTokenPath(repoRoot: string): string {
  return join(resolveSandboxDir(repoRoot), "auth.token");
}

/**
 * Path to the run-level lockfile that prevents concurrent E2E invocations
 * on the same machine. Lives next to the isolated token so a single
 * `rm -rf .tmp/e2e/` cleanly removes both.
 */
export function resolveLockfilePath(repoRoot: string): string {
  return join(resolveSandboxDir(repoRoot), ".lock");
}

/**
 * Path to the shared-session metadata file written by vitest's globalSetup.
 *
 * globalSetup runs in vitest's parent process; test workers run in separate
 * forks. The handoff between them is filesystem-mediated — globalSetup
 * persists `{ email, tokenPath, sandboxDir, sandboxConfigPath, repoRoot }`
 * to this JSON file, and `getSharedSession()` reads it from a worker.
 *
 * Lives next to the lockfile and the isolated token so one `rm -rf
 * .tmp/e2e/` cleans all run state.
 */
export function resolveSharedSessionFilePath(repoRoot: string): string {
  return join(resolveSandboxDir(repoRoot), ".session.json");
}

/**
 * Sandbox subdirectory for a single `withFreshSession()` invocation.
 *
 * globalSetup owns the SHARED session at `<sandbox>/auth.token` (consumed
 * by `getSharedSession()`-using tests). Adversarial tests that corrupt the
 * on-disk token call `withFreshSession()` to obtain an ISOLATED session
 * under this subdirectory — so the corruption never leaks into the shared
 * token consumed by sibling tests.
 *
 * `id` is a per-process counter (see `session.ts`) so multiple
 * `withFreshSession()` calls in the same vitest run get distinct
 * subdirectories. With `singleFork: true` + `fileParallelism: false`, the
 * counter is monotonic within the run.
 */
export function resolveIsolatedSessionDir(repoRoot: string, id: string): string {
  return join(resolveSandboxDir(repoRoot), `isolated-${id}`);
}

/**
 * Path to the isolated-session config file (`<sandbox>/isolated-<id>/
 * .ttctl.yaml`). The fixture's relative `auth-token-path: ./auth.token`
 * resolves against this file's directory → `<sandbox>/isolated-<id>/
 * auth.token`. Spawned CLI / MCP subprocesses receive
 * `TTCTL_CONFIG_FILE=<this>` and read tokens from / write tokens to the
 * isolated subdirectory, never the shared token.
 */
export function resolveIsolatedSessionConfigPath(repoRoot: string, id: string): string {
  return join(resolveIsolatedSessionDir(repoRoot, id), ".ttctl.yaml");
}

/**
 * Path to the isolated-session token (`<sandbox>/isolated-<id>/auth.token`).
 * `withFreshSession()` writes the captured bearer here in setUp and
 * unlinks it in tearDown.
 */
export function resolveIsolatedSessionTokenPath(repoRoot: string, id: string): string {
  return join(resolveIsolatedSessionDir(repoRoot, id), "auth.token");
}

/**
 * Like `writeSandboxConfig` but writes to an isolated subdirectory under
 * the sandbox.
 *
 *   - Reads + validates the user's source config at `sourceConfigPath`.
 *   - Composes a fixture object: `{ auth: <copied>, "auth-token-path":
 *     "./auth.token" }`. The relative path resolves at CLI startup time
 *     against `dirname(<sandbox>/isolated-<id>/.ttctl.yaml)` →
 *     `<sandbox>/isolated-<id>/auth.token`.
 *   - Writes the YAML file to `<sandbox>/isolated-<id>/.ttctl.yaml`,
 *     creating the directory if needed.
 *
 * Returns the absolute path to the written fixture.
 */
export async function writeIsolatedSessionConfig(
  repoRoot: string,
  id: string,
  sourceConfigPath: string,
): Promise<string> {
  const sourceConfig = loadConfigFile(sourceConfigPath);

  const fixture: Record<string, unknown> = {
    auth: sourceConfig.auth,
    "auth-token-path": "./auth.token",
  };

  const dir = resolveIsolatedSessionDir(repoRoot, id);
  await mkdir(dir, { recursive: true });

  const fixturePath = resolveIsolatedSessionConfigPath(repoRoot, id);
  await writeFile(fixturePath, stringifyYaml(fixture), "utf8");
  return fixturePath;
}

/**
 * Write the fixture `.ttctl.yaml` that isolates the harness from the user's
 * working session.
 *
 *   - Reads + validates the user's source config at `sourceConfigPath`
 *     (extracts the `auth` field verbatim — keeps secret-resolution behavior
 *     identical to a non-E2E run).
 *   - Composes a fixture object: `{ auth: <copied>, "auth-token-path":
 *     "./auth.token" }`. The relative path resolves at CLI startup time
 *     against `dirname(<sandbox>/.ttctl.yaml)` → `<sandbox>/auth.token`.
 *   - Writes the YAML file to `<sandbox>/.ttctl.yaml`, creating the sandbox
 *     directory if needed.
 *
 * Any field other than `auth` in the source config is intentionally NOT
 * mirrored — the harness must own `auth-token-path` exactly, and importing
 * unknown future fields would risk silent isolation breakage.
 *
 * Returns the absolute path to the written fixture.
 */
export async function writeSandboxConfig(repoRoot: string, sourceConfigPath: string): Promise<string> {
  // Parse + validate via the canonical loader so a malformed source surfaces
  // here (during setUp) rather than as an opaque CLI failure later.
  const sourceConfig = loadConfigFile(sourceConfigPath);

  const fixture: Record<string, unknown> = {
    auth: sourceConfig.auth,
    "auth-token-path": "./auth.token",
  };

  const sandbox = resolveSandboxDir(repoRoot);
  await mkdir(sandbox, { recursive: true });

  const fixturePath = resolveSandboxConfigPath(repoRoot);
  await writeFile(fixturePath, stringifyYaml(fixture), "utf8");
  return fixturePath;
}
