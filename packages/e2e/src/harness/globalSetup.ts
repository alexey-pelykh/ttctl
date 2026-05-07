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
 * function that vitest invokes after all tests finish.
 *
 * Audited `packages/core/src/transport.ts` 2026-05-07 — no module-level
 * mutable state that adversarial tests could corrupt across files. The
 * only module-level values (`IMPERSONATE_PROFILE`, `USER_AGENT`,
 * `COMMON_HEADERS`) are immutable consts; `stockTransport` /
 * `impersonatedTransport` / `impersonatedMultipartTransport` spread
 * `COMMON_HEADERS` into request-local objects rather than mutating the
 * source. No TLS-client identity cache, no cookie-jar handle, no agent
 * instance memoized at module scope.
 *
 * Filesystem-mediated handoff: vitest's globalSetup runs in a separate
 * process from test workers (forks with `singleFork: true`). Variables
 * cannot be passed in-memory; the handoff is the JSON file at
 * `<sandbox>/.session.json`.
 *
 * Env gate: `TTCTL_E2E !== "1"` short-circuits to a no-op (allows the
 * `pnpm test:e2e` "skip silently in CI" mode to apply uniformly with the
 * `vitest.e2e.config.ts` `include: []` short-circuit).
 *
 * Lockfile ownership: globalSetup is THE lock holder for the entire test
 * run. `withFreshSession()` no longer acquires the lock — it relies on
 * globalSetup having already done so. This collapses N-file lockfile
 * acquire/release cycles into one.
 */

import { writeFile, mkdir, unlink } from "node:fs/promises";

import { resolveConfig, resolveCredentials, saveAuthToken, signIn } from "@ttctl/core";

import { printPreflightBanner } from "./banner.js";
import { acquireLock, releaseLock } from "./lockfile.js";
import {
  findRepoRoot,
  resolveIsolatedAuthTokenPath,
  resolveLockfilePath,
  resolveSandboxConfigPath,
  resolveSandboxDir,
  resolveSharedSessionFilePath,
  writeSandboxConfig,
} from "./paths.js";

/**
 * Cool-off duration after the run, in milliseconds. AC E3 of #21 requires
 * ≥5s — preserved here so back-to-back `pnpm test:e2e` invocations are
 * spaced against Toptal's rate-limit / abuse heuristics.
 */
const COOL_OFF_MS = 5_000;

/**
 * Shared-session metadata persisted to `<sandbox>/.session.json`. Mirrors
 * the public `FreshSessionContext` shape — `getSharedSession()` reads this
 * file and returns the same shape so the consumer-side type is unified.
 */
export interface SharedSessionMetadata {
  email: string;
  tokenPath: string;
  sandboxDir: string;
  sandboxConfigPath: string;
  repoRoot: string;
}

export default async function setup(): Promise<() => Promise<void>> {
  if (process.env["TTCTL_E2E"] !== "1") {
    // No-op teardown — symmetric with the no-op setup so vitest's
    // globalSetup contract holds (the returned function is always
    // callable).
    return async (): Promise<void> => {
      /* no-op */
    };
  }

  printPreflightBanner();

  const repoRoot = findRepoRoot();
  const sandboxDir = resolveSandboxDir(repoRoot);
  const sandboxConfigPath = resolveSandboxConfigPath(repoRoot);
  const tokenPath = resolveIsolatedAuthTokenPath(repoRoot);
  const lockPath = resolveLockfilePath(repoRoot);
  const sessionFilePath = resolveSharedSessionFilePath(repoRoot);

  // The lockfile lives inside the sandbox dir — make sure that dir exists
  // before acquireLock writes the .lock file. `writeSandboxConfig` also
  // mkdir-p's the same dir, but lock acquisition must succeed BEFORE any
  // other harness state is created.
  await mkdir(sandboxDir, { recursive: true });
  acquireLock(lockPath);

  try {
    // Find the user's source config (the one OUTSIDE the sandbox) via
    // standard discovery: TTCTL_CONFIG_FILE → $XDG_CONFIG_HOME/ttctl/
    // config.yaml → ~/.config/ttctl/config.yaml. The maintainer's legacy
    // `<repo-root>/.ttctl.yaml` is honored only when `TTCTL_CONFIG_FILE`
    // points at it.
    const { config: sourceConfig, path: sourceConfigPath } = resolveConfig();

    // Mirror it into the sandbox with `auth-token-path: ./auth.token`.
    // Spawned CLI / MCP subprocesses get `TTCTL_CONFIG_FILE=<sandbox>/
    // .ttctl.yaml` injected, so they read this fixture and write tokens
    // to <sandbox>/auth.token, never touching the user's working session.
    await writeSandboxConfig(repoRoot, sourceConfigPath);

    // Sign in directly via core's signIn — the harness handles token
    // capture itself. Credentials come from the SOURCE config; secret
    // resolution (1Password CLI, literal) is identical to a non-E2E run.
    const credentials = resolveCredentials(sourceConfig.auth);
    const { token } = await signIn(credentials);
    await saveAuthToken(tokenPath, token);

    const sessionMeta: SharedSessionMetadata = {
      email: credentials.email,
      tokenPath,
      sandboxDir,
      sandboxConfigPath,
      repoRoot,
    };
    // 0o600 — same posture as the persisted token. The metadata itself
    // contains paths but no secrets; the mode is defensive belt-and-braces.
    await writeFile(sessionFilePath, JSON.stringify(sessionMeta) + "\n", { mode: 0o600 });
  } catch (err) {
    // Setup failed — release lock so subsequent runs aren't stuck behind
    // a held lock from a never-completed setup. Mirror the original
    // `withFreshSession` setUp behavior.
    releaseLock(lockPath);
    throw err;
  }

  return async (): Promise<void> => {
    // Defensive token unlink — the `99-auth-signout` test deletes the
    // token as its assertion. If that test was skipped or failed before
    // the deletion, this branch cleans up.
    try {
      await unlink(tokenPath);
    } catch {
      // ENOENT is fine (already gone); other errors swallowed because
      // a teardown throw would mask the real test failure.
    }
    try {
      await unlink(sessionFilePath);
    } catch {
      // Same posture.
    }

    // Cool-off — AC E3. Spaces back-to-back `pnpm test:e2e` invocations
    // so Toptal's abuse heuristics don't flag the maintainer's account.
    await new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, COOL_OFF_MS);
    });

    releaseLock(lockPath);
  };
}
