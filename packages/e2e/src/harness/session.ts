// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

import { clearAuthToken, persistAuthToken, resolveConfig, resolveCredentials, signIn } from "@ttctl/core";
import { afterAll, beforeAll } from "vitest";

import {
  findRepoRoot,
  resolveIsolatedSessionConfigPath,
  resolveIsolatedSessionDir,
  resolveSharedSessionFilePath,
  writeIsolatedSessionConfig,
} from "./paths.js";

/**
 * Public context returned by `withFreshSession()` and `getSharedSession()`.
 * Test authors use this to construct CLI / MCP clients bound to the
 * relevant sandbox (shared for `getSharedSession`, isolated for
 * `withFreshSession`).
 */
export interface FreshSessionContext {
  /**
   * Email of the signed-in account. Read from the resolved credentials —
   * useful for `auth status` assertions ("output should contain my email")
   * without forcing the test to re-resolve config.
   */
  email: string;
  /**
   * Absolute path to the relevant sandbox directory. For shared sessions,
   * `<repo-root>/.tmp/e2e/`. For isolated sessions,
   * `<repo-root>/.tmp/e2e/isolated-<id>/`.
   */
  sandboxDir: string;
  /**
   * Absolute path to the sandbox `.ttctl.yaml` fixture (Form C for shared,
   * Form D after signin for isolated). Pass this to
   * `getCliClient({ configPath })` / `getMcpClient({ configPath })` so the
   * spawned subprocess receives `TTCTL_CONFIG_FILE=<this>` in its env and
   * resolves config to the (shared or isolated) sandbox.
   *
   * Post-#107: this is the SINGLE file each test variant operates on. The
   * captured bearer lives in `auth.token` inside this YAML. There is NO
   * separate `.token` file.
   */
  sandboxConfigPath: string;
  /**
   * Absolute path to the repo root, resolved at session establishment.
   * Useful for locating sibling fixtures under `<repo-root>/.tmp/`.
   */
  repoRoot: string;
}

export interface WithFreshSessionOptions {
  /**
   * Cool-off duration after isolated-session tearDown, in milliseconds.
   * AC E3 of #21 requires ≥5s. Defaults to 5_000. Tests may extend this
   * when they hit rate limits empirically; values below 5_000 are clamped
   * up.
   */
  coolOffMs?: number;
}

export interface FreshSessionHandle {
  /**
   * Get the active isolated-session context. Throws if the session was not
   * established (e.g. test runs without `TTCTL_E2E=1`, or `beforeAll`
   * threw). Test bodies SHOULD wrap accesses in `it.skipIf(...)` to
   * cooperate with the env-gate cleanly.
   */
  getContext(): FreshSessionContext;
  /**
   * Whether the isolated session is currently established. Useful for
   * guarding test-body code without crashing the assertion runner with a
   * thrown "session not established" error during a skipped run.
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

/**
 * Per-file gate counter. `withFreshSession()` may be called once per file;
 * a second call indicates a test-author error (would register two
 * `beforeAll` / `afterAll` pairs and produce two signins).
 */
let handleCount = 0;

/**
 * Per-process counter for isolation-id generation. With `singleFork: true`
 * + `fileParallelism: false`, vitest runs all files in one Node process
 * sequentially, so this counter is monotonic across the run. Each
 * `withFreshSession()` call gets a distinct id — the resulting paths
 * `<sandbox>/isolated-<id>/` never collide.
 */
let isolationCounter = 0;

function nextIsolationId(): string {
  isolationCounter += 1;
  return String(isolationCounter);
}

/**
 * Build the lifecycle callbacks and a session handle WITHOUT registering
 * vitest hooks. Used internally by `withFreshSession()` (which then calls
 * `beforeAll(setUp)` and `afterAll(tearDown)`), and exported so unit tests
 * can exercise the no-env / not-active branches without coupling to
 * vitest's hook machinery.
 *
 * Production code must NOT call this directly — without hook registration,
 * the session's `setUp` would never run.
 *
 * Lockfile note: this function does NOT acquire the run-level lock. The
 * lock is held for the duration of the test run by `globalSetup`. Per-file
 * `withFreshSession()` calls obtain isolation by writing to a per-call
 * subdirectory under the sandbox.
 */
export function buildSessionRegistration(options: WithFreshSessionOptions = {}): SessionRegistration {
  handleCount += 1;
  if (handleCount > 1) {
    // Vitest's lifecycle hooks accumulate — registering two pairs would
    // cause two signins per file, defeating the per-file isolation contract.
    throw new Error(
      `withFreshSession: called more than once in the same file (call count = ${handleCount.toString()}). ` +
        `Each adversarial test file gets exactly one isolated EmailPasswordSignIn. ` +
        `Call withFreshSession() once per file.`,
    );
  }
  const coolOffMs = Math.max(options.coolOffMs ?? COOL_OFF_FLOOR_MS, COOL_OFF_FLOOR_MS);

  let context: FreshSessionContext | null = null;
  let isolationDir: string | null = null;

  const setUp = async (): Promise<void> => {
    if (!isE2EEnabled()) return;

    // No banner here — globalSetup already printed it once per process.
    // No lockfile acquisition — globalSetup is the run-level lock holder.

    const repoRoot = findRepoRoot();
    const id = nextIsolationId();
    isolationDir = resolveIsolatedSessionDir(repoRoot, id);
    const isolatedConfigPath = resolveIsolatedSessionConfigPath(repoRoot, id);

    // Find the user's source config (the one OUTSIDE the sandbox) via
    // standard discovery, identical to globalSetup's path.
    const { config: sourceConfig, path: sourceConfigPath } = resolveConfig();

    if (sourceConfig.auth.credentials === undefined) {
      throw new Error(
        "withFreshSession: source config has no auth.credentials. " +
          "Adversarial isolated sessions require credentials to drive a per-file signin.",
      );
    }

    // Mirror the source credentials into the per-call isolated subdirectory
    // (Form A or B; no token). Spawned subprocesses get
    // `TTCTL_CONFIG_FILE=<isolated config path>` injected via the CLI
    // client; their token writes (post-signin) land in the SAME isolated
    // YAML file via persistAuthToken — keeping the corruption inside the
    // per-file subtree.
    await writeIsolatedSessionConfig(repoRoot, id, sourceConfigPath);

    // Live signin — this is the ISOLATED signin (the second of the AC's
    // "exactly two signins per run", the first being globalSetup's).
    const credentials = resolveCredentials(sourceConfig.auth.credentials);
    const { token } = await signIn(credentials);

    // Persist the captured bearer into the isolated YAML config (Form D
    // shape). The CLI subprocess will read it from there.
    await persistAuthToken(isolatedConfigPath, token);

    context = {
      email: credentials.email,
      sandboxDir: isolationDir,
      sandboxConfigPath: isolatedConfigPath,
      repoRoot,
    };
  };

  const tearDown = async (): Promise<void> => {
    // Reset the per-file counter unconditionally — even if `setUp` threw
    // before establishing `context`, the counter must clear so the NEXT
    // file's `withFreshSession()` call doesn't incorrectly trip the
    // "called more than once" guard. vitest runs afterAll even after a
    // failing beforeAll, so this branch is the right place for the reset.
    handleCount = 0;
    if (context === null) return;
    const { sandboxConfigPath } = context;

    // Local "SignOut" of the isolated session — remove the auth.token
    // field. The mobile gateway has no terminal SignOut mutation; clearing
    // the token from the YAML is the canonical session-end action.
    try {
      await clearAuthToken(sandboxConfigPath);
    } catch {
      // Ignore: any failure here is teardown noise, would mask the real
      // test failure.
    }

    // Cool-off — AC E3. Even though globalSetup also cools off at run
    // teardown, this per-isolated-session cool-off paces successive
    // signins WITHIN a single run.
    await sleep(coolOffMs);

    // Best-effort cleanup of the isolated subdirectory so the sandbox
    // doesn't accumulate stale `isolated-N/` directories across runs.
    if (isolationDir !== null) {
      try {
        await rm(isolationDir, { recursive: true, force: true });
      } catch {
        // Ignore — non-essential cleanup.
      }
    }

    context = null;
    isolationDir = null;
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
 * Establish a single ISOLATED signed-in session for the calling vitest
 * file.
 *
 * Use this when a test file needs to corrupt or otherwise mutate the
 * on-disk auth token (e.g. `50-auth-error-revoked.e2e.test.ts`). The
 * isolation guarantees that the corruption stays inside this file's
 * subdirectory — sibling tests using `getSharedSession()` keep their
 * shared session intact.
 *
 * Use `getSharedSession()` instead when the test only needs to READ a
 * live session that globalSetup already established.
 *
 * Internally registers `beforeAll` and `afterAll` hooks:
 *
 *   - `beforeAll`:
 *       1. (skip if `TTCTL_E2E !== "1"`)
 *       2. Allocate a fresh isolation id; write credentials-only fixture
 *          to the per-call subdirectory
 *       3. Sign in via `core.signIn`; persist token to the isolated YAML
 *          via `persistAuthToken`
 *
 *   - `afterAll`:
 *       1. (skip if no session was established)
 *       2. Clear the auth.token field from the isolated YAML
 *       3. Cool-off ≥5s (AC E3)
 *       4. Best-effort `rm -rf` the isolated subdirectory
 *
 * Idempotency: `withFreshSession` may be called once per file. Calling it
 * twice in the same file would register two `beforeAll`/`afterAll` pairs
 * — the harness throws on the second call to surface the misuse loudly.
 */
export function withFreshSession(options: WithFreshSessionOptions = {}): FreshSessionHandle {
  const { setUp, tearDown, handle } = buildSessionRegistration(options);
  beforeAll(setUp);
  afterAll(tearDown);
  return handle;
}

/**
 * Read the SHARED session that globalSetup established at run start.
 *
 * Use this in test files that consume the run-level signed-in session
 * (e.g. `01-auth-signin.e2e.test.ts`, `99-auth-signout.e2e.test.ts`).
 * Multiple test files may call `getSharedSession()` in the same run; they
 * all see the same `FreshSessionContext` because they all read the same
 * `<sandbox>/.session.json` file.
 *
 * Throws if the session file is absent — that means either:
 *
 *   - `TTCTL_E2E !== "1"` (globalSetup is a no-op and the suite is gated
 *     off), OR
 *   - `vitest.e2e.config.ts` is missing the `globalSetup:
 *     ['./src/harness/globalSetup.ts']` wiring.
 *
 * Test bodies SHOULD wrap accesses in
 * `it.skipIf(process.env.TTCTL_E2E !== "1")` so the env-gated case skips
 * silently rather than throwing.
 *
 * The `repoRoot` option is for testability only — production callers
 * leave it unset so the harness walks up from `process.cwd()`.
 */
export function getSharedSession(opts: { repoRoot?: string } = {}): FreshSessionContext {
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const sessionFilePath = resolveSharedSessionFilePath(repoRoot);

  if (!existsSync(sessionFilePath)) {
    throw new Error(
      `getSharedSession: shared-session file at ${sessionFilePath} not found. ` +
        `Either TTCTL_E2E !== "1" (the suite is gated off — wrap test bodies in ` +
        `\`it.skipIf(process.env["TTCTL_E2E"] !== "1")\`), or vitest.e2e.config.ts ` +
        `is missing the globalSetup wiring.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(sessionFilePath, "utf8");
  } catch (err) {
    throw new Error(
      `getSharedSession: failed to read shared-session file at ${sessionFilePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `getSharedSession: shared-session file at ${sessionFilePath} is malformed JSON: ${(err as Error).message}`,
    );
  }

  if (!isValidSharedSessionMetadata(parsed)) {
    throw new Error(
      `getSharedSession: shared-session file at ${sessionFilePath} has unexpected shape. ` +
        `Expected object with string fields { email, sandboxDir, sandboxConfigPath, repoRoot }.`,
    );
  }

  return parsed;
}

function isValidSharedSessionMetadata(value: unknown): value is FreshSessionContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["email"] === "string" &&
    typeof v["sandboxDir"] === "string" &&
    typeof v["sandboxConfigPath"] === "string" &&
    typeof v["repoRoot"] === "string"
  );
}

/**
 * Reset the per-process call counter and isolation counter. Tests inject
 * this between simulated vitest runs to verify the "exactly once per file"
 * guard and to obtain deterministic isolation ids. Production code MUST
 * NOT call it.
 */
export function resetSessionForTesting(): void {
  handleCount = 0;
  isolationCounter = 0;
}

function isE2EEnabled(): boolean {
  return process.env["TTCTL_E2E"] === "1";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
