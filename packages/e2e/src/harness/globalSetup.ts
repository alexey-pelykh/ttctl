// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Vitest globalSetup for the @ttctl/e2e harness — wired by
 * `vitest.e2e.config.ts`.
 *
 * Runs in vitest's parent process EXACTLY ONCE per `pnpm test:e2e`
 * invocation, BEFORE any test file is loaded by a worker. Performs the
 * single live signin that shared-session test files (e.g. `01-auth-signin`,
 * `99-auth-signout`) consume via `getSharedSession()`. Returns a teardown
 * function that vitest invokes after all tests finish — including after a
 * worker exits abnormally (segfault, OOM, `process.exit()`, sync throw).
 * The teardown function delegates to `runGlobalTeardown` (post-#171) so
 * the asserted cleanup action lives outside any worker fork and can't be
 * skipped by a worker crash; see `globalTeardown.ts`.
 *
 * Audited `packages/core/src/transport.ts` 2026-05-07 — no module-level
 * mutable state that adversarial tests could corrupt across files.
 *
 * Filesystem-mediated handoff: vitest's globalSetup runs in a separate
 * process from test workers (forks with `singleFork: true`). Variables
 * cannot be passed in-memory; the handoff is the JSON file at
 * `<sandbox>/.session.json` plus the YAML config at `<sandbox>/.ttctl.yaml`
 * (the captured bearer lives inline in the YAML — post-#107 single-file
 * model).
 *
 * Env gate: `TTCTL_E2E !== "1"` short-circuits to a no-op (allows the
 * `pnpm test:e2e` "skip silently in CI" mode to apply uniformly with the
 * `vitest.e2e.config.ts` `include: []` short-circuit).
 *
 * Lockfile ownership: globalSetup is THE lock holder for the entire test
 * run. `withFreshSession()` no longer acquires the lock — it relies on
 * globalSetup having already done so. This collapses N-file lockfile
 * acquire/release cycles into one. The lock is released by
 * `runGlobalTeardown` in the returned teardown function.
 */

import { mkdir, writeFile } from "node:fs/promises";

import { resolveConfig, resolveCredentials, signIn } from "@ttctl/core";

import { printPreflightBanner } from "./banner.js";
import { runGlobalTeardown } from "./globalTeardown.js";
import { acquireLock, releaseLock } from "./lockfile.js";
import {
  findRepoRoot,
  resolveLockfilePath,
  resolveSandboxConfigPath,
  resolveSandboxDir,
  resolveSharedSessionFilePath,
  writeSandboxConfig,
} from "./paths.js";

/**
 * Shared-session metadata persisted to `<sandbox>/.session.json`.
 *
 * Post-#107: the bearer TOKEN itself is NOT in this file — it lives inline
 * in `<sandbox>/.ttctl.yaml`. The metadata file carries paths and the
 * email so test workers can read both without re-resolving them.
 */
export interface SharedSessionMetadata {
  email: string;
  sandboxDir: string;
  sandboxConfigPath: string;
  repoRoot: string;
}

export default async function setup(): Promise<() => Promise<void>> {
  if (process.env["TTCTL_E2E"] !== "1") {
    // No-op teardown — symmetric with the no-op setup so vitest's
    // globalSetup contract holds (the returned function is always
    // callable). `runGlobalTeardown` env-gates internally on the same
    // condition, but returning a fresh no-op closure here avoids any
    // path-resolution work when the suite isn't opted in.
    return async (): Promise<void> => {
      /* no-op */
    };
  }

  printPreflightBanner();

  const repoRoot = findRepoRoot();
  const sandboxDir = resolveSandboxDir(repoRoot);
  const sandboxConfigPath = resolveSandboxConfigPath(repoRoot);
  const lockPath = resolveLockfilePath(repoRoot);
  const sessionFilePath = resolveSharedSessionFilePath(repoRoot);

  // The lockfile lives inside the sandbox dir — make sure that dir exists
  // before acquireLock writes the .lock file.
  await mkdir(sandboxDir, { recursive: true });
  acquireLock(lockPath);

  try {
    // Find the user's source config (the one OUTSIDE the sandbox) via
    // standard discovery: TTCTL_CONFIG_FILE → ~/.ttctl.yaml. The
    // maintainer's legacy `<repo-root>/.ttctl.yaml` is honored only when
    // `TTCTL_CONFIG_FILE` points at it.
    const { config: sourceConfig } = resolveConfig();

    if (sourceConfig.auth.credentials === undefined) {
      throw new Error(
        "globalSetup: source config has no auth.credentials. " +
          "The E2E harness requires credentials in the source config to drive the live signin. " +
          "A Form C (token-only) source config can't seed the harness.",
      );
    }

    // Sign in directly via core's signIn — the harness handles token
    // capture itself. Credentials come from the SOURCE config; secret
    // resolution (1Password CLI, literal) is identical to a non-E2E run.
    const credentials = resolveCredentials(sourceConfig.auth.credentials);
    const { token } = await signIn(credentials);

    // Write the SANDBOX config — Form C shape, token only. Source
    // credentials never enter `.tmp/e2e/`.
    await writeSandboxConfig(repoRoot, token);

    const sessionMeta: SharedSessionMetadata = {
      email: credentials.email,
      sandboxDir,
      sandboxConfigPath,
      repoRoot,
    };
    // 0o600 — same posture as the persisted token. The metadata itself
    // contains paths but no secrets; the mode is defensive belt-and-braces.
    await writeFile(sessionFilePath, JSON.stringify(sessionMeta) + "\n", { mode: 0o600 });
  } catch (err) {
    // Setup failed — release lock so subsequent runs aren't stuck behind
    // a held lock from a never-completed setup.
    releaseLock(lockPath);
    throw err;
  }

  // Delegate the asserted cleanup action to `runGlobalTeardown` so the
  // exact same path runs whether vitest terminated normally or after a
  // worker abnormal exit. The function env-gates internally and re-
  // resolves paths from `findRepoRoot()` — symmetric with this setup.
  return async (): Promise<void> => {
    await runGlobalTeardown();
  };
}
