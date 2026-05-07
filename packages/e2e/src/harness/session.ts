// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdir, unlink } from "node:fs/promises";

import { resolveConfig, resolveCredentials, saveAuthToken, signIn } from "@ttctl/core";
import { afterAll, beforeAll } from "vitest";

import { printPreflightBanner } from "./banner.js";
import { acquireLock, releaseLock } from "./lockfile.js";
import {
  findRepoRoot,
  resolveIsolatedAuthTokenPath,
  resolveLockfilePath,
  resolveSandboxConfigPath,
  resolveSandboxDir,
  writeSandboxConfig,
} from "./paths.js";

/**
 * Public context returned by `withFreshSession()`. Test authors use this
 * to construct CLI / MCP clients bound to the sandbox.
 */
export interface FreshSessionContext {
  /**
   * Email of the signed-in account. Read from the resolved credentials —
   * useful for `auth status` assertions ("output should contain my email")
   * without forcing the test to re-resolve config.
   */
  email: string;
  /**
   * Absolute path to the isolated auth token (`<sandbox>/auth.token`).
   * Test authors use this for existence / non-empty assertions; they
   * should NEVER read or write the file's contents — the harness owns
   * its lifecycle.
   */
  tokenPath: string;
  /**
   * Absolute path to the sandbox directory (`<repo-root>/.tmp/e2e/`).
   * Useful for tests that need a stable working directory or for sibling-
   * fixture lookups (lockfile, isolated token). The harness no longer
   * spawns subprocesses with `cwd: sandboxDir` — isolation flows through
   * `TTCTL_CONFIG_FILE` env injection (#94), not CWD.
   */
  sandboxDir: string;
  /**
   * Absolute path to the sandbox `.ttctl.yaml` fixture. Pass this to
   * `getCliClient({ configPath })` / `getMcpClient({ configPath })` so the
   * spawned subprocess receives `TTCTL_CONFIG_FILE=<this>` in its env and
   * resolves config to the sandbox (with the redirected `auth-token-path`)
   * instead of the user's everyday session.
   */
  sandboxConfigPath: string;
  /**
   * Absolute path to the repo root, resolved at suite startup. Useful for
   * locating sibling fixtures under `<repo-root>/.tmp/`.
   */
  repoRoot: string;
}

export interface WithFreshSessionOptions {
  /**
   * Cool-off duration after sign-out, in milliseconds. AC E3 requires
   * ≥5s. Defaults to 5_000. Tests may extend this when they hit rate
   * limits empirically; values below 5_000 are clamped up.
   */
  coolOffMs?: number;
}

export interface FreshSessionHandle {
  /**
   * Get the active session context. Throws if the session was not
   * established (e.g. test runs without `TTCTL_E2E=1`, or `beforeAll`
   * threw). Test bodies SHOULD wrap accesses in `it.skipIf(...)` to
   * cooperate with the env-gate cleanly.
   */
  getContext(): FreshSessionContext;
  /**
   * Whether the session is currently established. Useful for guarding
   * test-body code without crashing the assertion runner with a thrown
   * "session not established" error during a skipped run.
   */
  isActive(): boolean;
}

/**
 * Internal registration shape — the lifecycle callbacks plus the public
 * handle they manipulate. Exposed for unit tests; production code should
 * use `withFreshSession()` which wires this into vitest's hooks.
 */
export interface SessionRegistration {
  setUp: () => Promise<void>;
  tearDown: () => Promise<void>;
  handle: FreshSessionHandle;
}

const COOL_OFF_FLOOR_MS = 5_000;

let handleCount = 0;

/**
 * Build the lifecycle callbacks and a session handle WITHOUT registering
 * vitest hooks. Used internally by `withFreshSession()` (which then calls
 * `beforeAll(setUp)` and `afterAll(tearDown)`), and exported so unit tests
 * can exercise the no-env / not-active branches without coupling to
 * vitest's hook machinery.
 *
 * Production code must NOT call this directly — without hook registration,
 * the session's `setUp` would never run.
 */
export function buildSessionRegistration(options: WithFreshSessionOptions = {}): SessionRegistration {
  handleCount += 1;
  if (handleCount > 1) {
    // Vitest's lifecycle hooks accumulate — registering two pairs would
    // cause two signins per suite, violating AC E2. Surface this loudly.
    throw new Error(
      `withFreshSession: called more than once in the same file (call count = ${handleCount.toString()}). ` +
        `AC E2 requires exactly one EmailPasswordSignIn per suite. Call withFreshSession() once per file.`,
    );
  }
  const coolOffMs = Math.max(options.coolOffMs ?? COOL_OFF_FLOOR_MS, COOL_OFF_FLOOR_MS);

  let context: FreshSessionContext | null = null;

  const setUp = async (): Promise<void> => {
    if (!isE2EEnabled()) return;

    printPreflightBanner();

    const repoRoot = findRepoRoot();
    const sandboxDir = resolveSandboxDir(repoRoot);
    const sandboxConfigPath = resolveSandboxConfigPath(repoRoot);
    const tokenPath = resolveIsolatedAuthTokenPath(repoRoot);
    const lockPath = resolveLockfilePath(repoRoot);

    // The lockfile lives inside the sandbox dir — make sure that dir
    // exists before acquireLock writes the .lock file. `writeSandboxConfig`
    // also mkdir-p's the same dir, but lock acquisition must succeed BEFORE
    // any other harness state is created.
    await mkdir(sandboxDir, { recursive: true });
    acquireLock(lockPath);

    try {
      // Find the user's source config (the one OUTSIDE the sandbox) via
      // standard discovery: TTCTL_CONFIG_FILE → $XDG_CONFIG_HOME/ttctl/
      // config.yaml → ~/.config/ttctl/config.yaml. No CWD walking, no
      // repo-root fallback. The maintainer's legacy `<repo-root>/.ttctl.yaml`
      // is honored only when `TTCTL_CONFIG_FILE` points at it.
      const { config: sourceConfig, path: sourceConfigPath } = resolveConfig();

      // Mirror it into the sandbox with `auth-token-path: ./auth.token`.
      // Spawned CLI / MCP subprocesses get `TTCTL_CONFIG_FILE=<sandbox>/
      // .ttctl.yaml` injected (#94), so they read this fixture and write
      // tokens to <sandbox>/auth.token, never touching the user's working
      // session.
      await writeSandboxConfig(repoRoot, sourceConfigPath);

      // Sign in directly via core's signIn (the harness handles token
      // capture itself; spawning `ttctl auth signin` would work too but
      // is slower and indirect). The credentials come from the SOURCE
      // config — secret resolution (1Password CLI, literal) is identical
      // to a non-E2E run.
      const credentials = resolveCredentials(sourceConfig.auth);
      const { token } = await signIn(credentials);
      await saveAuthToken(tokenPath, token);
      context = {
        email: credentials.email,
        tokenPath,
        sandboxDir,
        sandboxConfigPath,
        repoRoot,
      };
    } catch (err) {
      // Sign-in failed — release lock so subsequent runs aren't stuck
      // behind a held lock from a never-completed setup.
      releaseLock(lockPath);
      throw err;
    }
  };

  const tearDown = async (): Promise<void> => {
    // Reset the per-file counter unconditionally — even if `setUp` threw
    // before establishing `context`, the counter must clear so the NEXT
    // file's `withFreshSession()` call doesn't incorrectly trip the
    // "called more than once" guard. vitest runs afterAll even after a
    // failing beforeAll, so this branch is the right place for the reset.
    handleCount = 0;
    if (context === null) return;
    const { tokenPath, repoRoot } = context;

    // Local "SignOut": destroy the isolated session-of-record. The
    // mobile gateway has no terminal SignOut mutation; deleting the
    // token is the canonical session-end action (matches `ttctl auth
    // signout`).
    try {
      await unlink(tokenPath);
    } catch {
      // ENOENT is fine (already gone); other errors swallowed because
      // afterAll throws would mask the real test failure.
    }

    // Cool-off — AC E3.
    await sleep(coolOffMs);

    releaseLock(resolveLockfilePath(repoRoot));
    context = null;
  };

  const handle: FreshSessionHandle = {
    getContext: () => {
      if (context === null) {
        throw new Error(
          "withFreshSession: session is not established. " +
            'Either TTCTL_E2E !== "1" (the suite is gated off) or beforeAll has not run yet. ' +
            'Wrap the test body in `it.skipIf(process.env["TTCTL_E2E"] !== "1")`.',
        );
      }
      return context;
    },
    isActive: () => context !== null,
  };
  return { setUp, tearDown, handle };
}

/**
 * Establish a single signed-in session for the calling vitest suite.
 *
 * Call this at the top of a test file (outside or inside a `describe`).
 * The returned handle exposes `getContext()` for use within `it(...)`
 * bodies. Internally registers `beforeAll` and `afterAll` hooks:
 *
 *   - `beforeAll`:
 *       1. (skip if `TTCTL_E2E !== "1"`)
 *       2. Print pre-flight banner (once per process — AC E4)
 *       3. Acquire run-level lockfile (AC E1)
 *       4. Read & resolve credentials from .ttctl.yaml
 *       5. Sign in via `core.signIn` (AC E2), capturing the bearer token
 *       6. Persist token to `.tmp/e2e/auth.token` (AC C1)
 *
 *   - `afterAll`:
 *       1. (skip if no session was established)
 *       2. Delete the isolated token — this is the harness's "SignOut"
 *          (AC E2). The Toptal mobile gateway has no terminal SignOut
 *          mutation; the local token is the session-of-record.
 *       3. Cool-off ≥5s (AC E3) — spaces successive runs to avoid
 *          rate-limit / abuse heuristics.
 *       4. Release lockfile.
 *
 * Idempotency: `withFreshSession` may be called once per file. Calling it
 * twice in the same file would register two `beforeAll`/`afterAll` pairs,
 * causing two signins per suite — the harness throws on the second call
 * to surface the misuse loudly.
 */
export function withFreshSession(options: WithFreshSessionOptions = {}): FreshSessionHandle {
  const { setUp, tearDown, handle } = buildSessionRegistration(options);
  beforeAll(setUp);
  afterAll(tearDown);
  return handle;
}

/**
 * Reset the per-process call counter. Tests inject this between simulated
 * vitest runs to verify the "exactly once per file" guard. Production
 * code MUST NOT call it.
 */
export function resetSessionForTesting(): void {
  handleCount = 0;
}

function isE2EEnabled(): boolean {
  return process.env["TTCTL_E2E"] === "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
