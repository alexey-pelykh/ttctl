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
 * The harness writes a fixture `.ttctl.yaml` here and spawns CLI / MCP
 * subprocesses with `cwd` set to this directory. CLI config discovery
 * (which checks `./.ttctl.yaml` first) picks up the fixture; the
 * fixture's relative `auth-token-path: ./auth.token` resolves to
 * `<sandbox>/auth.token`. The user's everyday session at
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
