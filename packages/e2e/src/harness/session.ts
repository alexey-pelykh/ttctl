// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { unlink } from "node:fs/promises";

import { createCookieJar, resolveConfig, resolveCredentials, saveCookieJar, signIn } from "@ttctl/core";
import { afterAll, beforeAll } from "vitest";

import { printPreflightBanner } from "./banner.js";
import { acquireLock, releaseLock } from "./lockfile.js";
import { findRepoRoot, resolveIsolatedJarPath, resolveLockfilePath } from "./paths.js";

/**
 * Public context returned by `withFreshSession()`. Test authors use this
 * to construct CLI / MCP clients bound to the isolated jar.
 */
export interface FreshSessionContext {
  /**
   * Email of the signed-in account. Read from the resolved credentials —
   * useful for `auth status` assertions ("output should contain my email")
   * without forcing the test to re-resolve config.
   */
  email: string;
  /**
   * Absolute path to the isolated cookie jar. Pass to `getCliClient` /
   * `getMcpClient` as `jarPath`. Test authors should NEVER read this file
   * directly — the harness owns its lifecycle.
   */
  jarPath: string;
  /**
   * Absolute path to the repo root, resolved at suite startup. Useful for
   * locating sibling fixtures (`.tmp/e2e-restore/`, etc.).
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
    const jarPath = resolveIsolatedJarPath(repoRoot);
    const lockPath = resolveLockfilePath(repoRoot);

    acquireLock(lockPath);

    try {
      const { config } = resolveConfig();
      const credentials = resolveCredentials(config.auth);
      const jar = createCookieJar();
      await signIn(credentials, jar);
      await saveCookieJar(jarPath, jar);
      context = { email: credentials.email, jarPath, repoRoot };
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
    const { jarPath, repoRoot } = context;

    // Local "SignOut": destroy the isolated session-of-record. The
    // mobile gateway has no terminal SignOut mutation; deleting the jar
    // is the canonical session-end action (matches `ttctl auth signout`).
    try {
      await unlink(jarPath);
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
 *       5. Sign in via `core.signIn` against an isolated jar (AC E2)
 *       6. Persist jar to `.tmp/e2e/session.cookies` (AC C1)
 *
 *   - `afterAll`:
 *       1. (skip if no session was established)
 *       2. Delete the isolated jar — this is the harness's "SignOut"
 *          (AC E2). The Toptal mobile gateway has no terminal SignOut
 *          mutation; the local jar is the session-of-record.
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
