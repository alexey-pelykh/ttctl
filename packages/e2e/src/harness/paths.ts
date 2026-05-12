// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ConfigLoadSchema } from "@ttctl/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
 * Post-#107 single-file model: the sandbox holds ONE file —
 * `<sandbox>/.ttctl.yaml`, a Form C config (token only, no credentials).
 * Spawned CLI / MCP subprocesses get `TTCTL_CONFIG_FILE=<sandbox>/.ttctl.yaml`
 * so they read this fixture and never touch the user's working session at
 * `~/.ttctl.yaml`.
 *
 * The credentials live in the SOURCE config (resolved via standard
 * discovery — typically `~/.ttctl.yaml` for the maintainer) and are
 * consumed only ONCE per run, by globalSetup, to drive the live signin.
 * The captured bearer is what lands in the sandbox; the source credentials
 * never enter `.tmp/e2e/`.
 */
export function resolveSandboxDir(repoRoot: string): string {
  return join(repoRoot, ".tmp", "e2e");
}

/**
 * Path to the sandbox `.ttctl.yaml` (Form C token-only config). Created
 * by `writeSandboxConfig`.
 */
export function resolveSandboxConfigPath(repoRoot: string): string {
  return join(resolveSandboxDir(repoRoot), ".ttctl.yaml");
}

/**
 * Path to the sandbox `.ttctl.yaml` fixture, named for the env-injection
 * use case. Identical to `resolveSandboxConfigPath`; this alias documents
 * the intent at the call site (the value injected as `TTCTL_CONFIG_FILE`
 * into spawned CLI / MCP subprocesses).
 */
export function cliConfigPath(repoRoot: string): string {
  return resolveSandboxConfigPath(repoRoot);
}

/**
 * Path to the run-level lockfile that prevents concurrent E2E invocations
 * on the same machine. Lives next to the sandbox config so a single
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
 * persists `{ email, sandboxDir, sandboxConfigPath, repoRoot }` to this
 * JSON file, and `getSharedSession()` reads it from a worker. The TOKEN
 * itself lives inline in the sandbox `.ttctl.yaml` (post-#107) — the
 * metadata file does NOT carry the bearer.
 */
export function resolveSharedSessionFilePath(repoRoot: string): string {
  return join(resolveSandboxDir(repoRoot), ".session.json");
}

/**
 * Path to the globalTeardown receipt file (post-#171).
 *
 * `runGlobalTeardown` writes this JSON file at the end of every teardown
 * invocation that gets past the `TTCTL_E2E === "1"` env-gate. The file's
 * presence is the post-mortem signal that teardown actually fired (no
 * test can observe its own teardown — the receipt is the only filesystem
 * evidence). Its absence after a run means globalTeardown did NOT execute,
 * which is the regression `pnpm test:e2e:crash-recovery` detects.
 *
 * Lives inside the sandbox dir so a single `rm -rf .tmp/e2e/` cleanly
 * removes it alongside the lock and sandbox config.
 */
export function resolveTeardownReceiptPath(repoRoot: string): string {
  return join(resolveSandboxDir(repoRoot), ".teardown-receipt.json");
}

/**
 * Sandbox subdirectory for a single `withFreshSession()` invocation.
 *
 * globalSetup owns the SHARED session at `<sandbox>/.ttctl.yaml` (consumed
 * by `getSharedSession()`-using tests). Adversarial tests that mutate the
 * on-disk token call `withFreshSession()` to obtain an ISOLATED session
 * under this subdirectory — the corruption never leaks into the shared
 * sandbox config consumed by sibling tests.
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
 * .ttctl.yaml`). The fixture carries the SOURCE credentials only (Form A
 * or B, no token) so the test does its own signin and writes the captured
 * token back into THIS file. Spawned CLI / MCP subprocesses receive
 * `TTCTL_CONFIG_FILE=<this>` and read tokens from / write tokens to the
 * isolated subdirectory, never the shared sandbox.
 */
export function resolveIsolatedSessionConfigPath(repoRoot: string, id: string): string {
  return join(resolveIsolatedSessionDir(repoRoot, id), ".ttctl.yaml");
}

/**
 * Write the SHARED sandbox `.ttctl.yaml` carrying ONLY the captured bearer
 * token (Form C — no credentials in the sandbox).
 *
 * The token is persisted to the same YAML file the spawned CLI / MCP
 * subprocesses load from. No separate `.token` file. The sandbox config
 * is mode 0o600.
 *
 * Source credentials NEVER enter `.tmp/e2e/`. The maintainer's working
 * credentials remain in the SOURCE config (e.g. `~/.ttctl.yaml`); only
 * the run-scoped bearer is replicated into the sandbox.
 */
export async function writeSandboxConfig(repoRoot: string, token: string): Promise<string> {
  const fixture = { auth: { token } };

  const sandbox = resolveSandboxDir(repoRoot);
  await mkdir(sandbox, { recursive: true });

  const fixturePath = resolveSandboxConfigPath(repoRoot);
  await writeFile(fixturePath, stringifyYaml(fixture), { encoding: "utf8", mode: 0o600 });
  await chmod(fixturePath, 0o600);
  return fixturePath;
}

/**
 * Write an ISOLATED sandbox `.ttctl.yaml` for `withFreshSession()`.
 *
 *   - Reads + validates the user's source config at `sourceConfigPath`.
 *   - Composes a credentials-only fixture (Form A or B — no token). The
 *     fresh-session test will call `ttctl auth signin` against this
 *     config; the captured bearer lands back in the SAME isolated config.
 *   - Writes the YAML file to `<sandbox>/isolated-<id>/.ttctl.yaml`,
 *     creating the directory if needed. Mode 0o600.
 *
 * Returns the absolute path to the written fixture.
 */
export async function writeIsolatedSessionConfig(
  repoRoot: string,
  id: string,
  sourceConfigPath: string,
): Promise<string> {
  // Parse + validate via the canonical loader so a malformed source
  // surfaces here rather than as an opaque CLI failure later.
  const sourceRaw = await readFile(sourceConfigPath, "utf8");
  const sourceParsed: unknown = parseYaml(sourceRaw);
  const sourceValidated = ConfigLoadSchema.parse(sourceParsed);

  // Forward credentials only — drop any token from the source so the
  // fresh-session test starts from a clean Form A/B state.
  const credentials = sourceValidated.auth.credentials;
  if (credentials === undefined) {
    throw new Error(
      `writeIsolatedSessionConfig: source config at ${sourceConfigPath} has no auth.credentials. ` +
        `withFreshSession() requires credentials to drive the per-call signin; a Form C ` +
        `(token-only) source can't seed an isolated session.`,
    );
  }

  const fixture = { auth: { credentials } };

  const dir = resolveIsolatedSessionDir(repoRoot, id);
  await mkdir(dir, { recursive: true });

  const fixturePath = resolveIsolatedSessionConfigPath(repoRoot, id);
  await writeFile(fixturePath, stringifyYaml(fixture), { encoding: "utf8", mode: 0o600 });
  await chmod(fixturePath, 0o600);
  return fixturePath;
}
