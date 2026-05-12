// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Parent-process teardown action invoked by vitest's globalSetup (via the
 * returned function) after all workers have terminated. Runs in vitest's
 * PARENT process (NOT in a worker fork). This is the load-bearing
 * invariant from #171: a worker that crashes (segfault, OOM,
 * `process.exit()`, uncaught synchronous throw, hang past timeout) cannot
 * block teardown — vitest's runner detects the abnormal exit and still
 * invokes the registered teardown function. Filesystem state mutated here
 * (sandbox token, shared-session metadata, lockfile) is therefore
 * unconditionally cleaned up regardless of worker exit reason.
 *
 * Before #171 the asserted "signout" action lived inside a worker-fork
 * test (`99-auth-signout.e2e.test.ts`); when a prior file crashed the
 * worker, file 99 never ran and the bearer leaked. The fix promotes the
 * action to this parent-scope teardown; file 99 becomes assertion-only
 * (smoke test of the live shared session) and the crash-injection test
 * (`98-crash-injection.e2e.test.ts` + `scripts/run-crash-recovery.mjs`)
 * verifies that this teardown fires after a deliberate worker crash.
 *
 * Receipt: every run writes `<sandbox>/.teardown-receipt.json` recording
 * what happened. The receipt's PRESENCE is the post-mortem signal that
 * teardown actually fired — no test can observe its own teardown, so the
 * file is the only filesystem evidence. Callers (notably
 * `scripts/run-crash-recovery.mjs`) read the receipt to verify cleanup.
 *
 * Env-gate: `TTCTL_E2E !== "1"` short-circuits to a no-op (the suite is
 * not opted-in; no sandbox state to clean). Symmetric with the env-gate
 * in `globalSetup.ts` and `vitest.e2e.config.ts`.
 */

import { unlink, writeFile } from "node:fs/promises";

import { ConfigError, clearAuthToken, resolveConfig, signOut } from "@ttctl/core";
import type { SignOutResult } from "@ttctl/core";

import { releaseLock } from "./lockfile.js";
import {
  findRepoRoot,
  resolveLockfilePath,
  resolveSandboxConfigPath,
  resolveSharedSessionFilePath,
  resolveTeardownReceiptPath,
} from "./paths.js";

/**
 * Cool-off duration after the run, in milliseconds. AC E3 of #21 requires
 * ≥5s — preserved here so back-to-back `pnpm test:e2e` invocations are
 * spaced against Toptal's rate-limit / abuse heuristics. Moved from
 * `globalSetup.ts` post-#171 (the teardown action lives in this module
 * now; the cool-off belongs with it).
 */
export const TEARDOWN_COOL_OFF_MS = 5_000;

/**
 * Receipt schema. Written to `<sandbox>/.teardown-receipt.json` by
 * `runGlobalTeardown` as the LAST step of every invocation that gets past
 * the env-gate. The file's PRESENCE is the load-bearing signal: it proves
 * the teardown function fired in the parent process. Fields record the
 * per-step outcome so callers can distinguish "ran but a cleanup step
 * failed" from "didn't run at all".
 *
 * `succeeded: false` does NOT mean teardown is broken — it means one of
 * the cleanup steps threw. The receipt still gets written; an exception
 * inside teardown BEFORE the write would leave the receipt absent, which
 * is its own (stronger) failure signal that the crash-recovery wrapper
 * reports separately.
 */
export interface TeardownReceipt {
  /** ISO-8601 timestamp recorded right before the receipt is written. */
  ranAt: string;
  /**
   * True when `auth.token` is absent from the sandbox config after
   * teardown completes. Idempotent semantics: also true when the field
   * was already absent (e.g. a prior abort cleared it).
   */
  cleared: boolean;
  /**
   * True when the sandbox lockfile is absent after teardown completes.
   * `releaseLock` swallows ENOENT, so "lockfile already gone" also
   * yields `true` (the post-state matches the intent).
   */
  lockReleased: boolean;
  /**
   * Server-side LogOut outcome (post-#180). Three values:
   *
   *   - `true`  — talent_profile/graphql acknowledged the LogOut mutation
   *               (`signOut` returned `logged-out` OR `invalid` — the
   *               latter means the bearer was already invalid server-side,
   *               which satisfies the cleanup intent transitively).
   *               **Does NOT imply** the bearer was revoked for downstream
   *               mobile-gateway calls — see CLAUDE.md § Auth Model. The
   *               24-72h aging-out is the load-bearing revocation defense;
   *               this field records the defense-in-depth signal.
   *   - `false` — could not deliver the LogOut signal (network failure,
   *               HTTP non-2xx, wire-shape divergence). `serverLogOutError`
   *               carries the specific reason. Local clear still ran
   *               regardless; the bearer ages out in 24-72h either way.
   *   - `null`  — no token was present in the sandbox config; nothing to
   *               call with. Distinct from `false` so the crash-recovery
   *               wrapper can tell "we tried and failed" from "we never
   *               had a token to call with".
   *
   * AC #2 of issue #180 — schema/contract rule TRIGGERED. The wire format
   * is verified by `packages/e2e/src/97-auth-signout-server-side.e2e.test.ts`
   * (live integration with `withFreshSession`); this receipt field is the
   * filesystem-recorded outcome for the cleanup teardown path.
   */
  serverLogOut: boolean | null;
  /**
   * Serialized failure reason when `serverLogOut === false`; otherwise
   * `null`. Sourced from `core.signOut()`'s `unreachable.reason` discriminator.
   * Never carries the bearer token (verified by the unit-test substring
   * assertion in `harness/__tests__/globalTeardown.test.ts`).
   */
  serverLogOutError: string | null;
  /** True iff every cleanup step ran without throwing. */
  succeeded: boolean;
  /**
   * Serialized exception message if any cleanup step threw; `null`
   * otherwise. Records the FIRST exception only — subsequent steps still
   * run for partial cleanup, but their errors are silently swallowed so
   * the original failure is what surfaces.
   */
  error: string | null;
}

export interface RunGlobalTeardownOptions {
  /**
   * Override the repo-root resolution. Tests inject a tmpdir-rooted
   * fixture; production paths leave this unset (resolution flows through
   * `findRepoRoot()`).
   */
  repoRoot?: string;
  /**
   * Override the cool-off duration in milliseconds. Tests pass `0` to
   * skip the 5-second wait. Production paths should leave this unset.
   */
  coolOffMs?: number;
}

/**
 * Run the teardown action: clear the sandbox bearer, drop the shared-
 * session metadata, cool off, release the run-level lock, and write a
 * receipt. Idempotent — re-running yields the same post-state and a
 * fresh receipt.
 *
 * Each cleanup step is wrapped in try/catch so a failing step does NOT
 * block the next step. The first thrown exception is captured into the
 * receipt's `error` field; subsequent throws are silently swallowed so
 * the originating failure remains the surfacing signal.
 */
export async function runGlobalTeardown(options: RunGlobalTeardownOptions = {}): Promise<void> {
  if (process.env["TTCTL_E2E"] !== "1") {
    return;
  }

  const repoRoot = options.repoRoot ?? findRepoRoot();
  const sandboxConfigPath = resolveSandboxConfigPath(repoRoot);
  const sessionFilePath = resolveSharedSessionFilePath(repoRoot);
  const lockPath = resolveLockfilePath(repoRoot);
  const receiptPath = resolveTeardownReceiptPath(repoRoot);
  const coolOffMs = options.coolOffMs ?? TEARDOWN_COOL_OFF_MS;

  let cleared = false;
  let lockReleased = false;
  let serverLogOut: boolean | null = null;
  let serverLogOutError: string | null = null;
  let error: string | null = null;

  // Step 1: server-side LogOut (post-#180). Best-effort — failure
  // never blocks the local clear. We read the sandbox bearer first, then
  // call `core.signOut(token)` which classifies every failure into a
  // discriminated `SignOutResult` (never throws). If the sandbox config
  // is malformed or missing entirely, fall through with `serverLogOut:
  // null` — the local clear path (idempotent `clearAuthToken`) will
  // handle that case below without surfacing an error.
  let sandboxToken: string | undefined;
  try {
    const { config } = resolveConfig({ path: sandboxConfigPath });
    sandboxToken = config.auth.token;
  } catch (err) {
    // ConfigError(NO_CREDS) is the expected shape when the sandbox config
    // doesn't exist (e.g. globalSetup short-circuited before writing it,
    // or a prior teardown wiped it). Treat as "no token to call with" —
    // serverLogOut stays null. Other ConfigError codes (PARSE,
    // VALIDATION) indicate a corrupted sandbox; record but don't fail.
    if (!(err instanceof ConfigError)) {
      error = err instanceof Error ? err.message : String(err);
    }
    sandboxToken = undefined;
  }

  if (sandboxToken !== undefined && sandboxToken !== "") {
    const result: SignOutResult = await signOut(sandboxToken);
    if (result.status === "logged-out" || result.status === "invalid") {
      // `invalid` means the bearer was already invalid server-side, which
      // satisfies the cleanup intent transitively — record as true.
      serverLogOut = true;
    } else {
      serverLogOut = false;
      // Build a redacted, human-readable reason from the discriminated
      // unreachable.reason. The bearer is NEVER mentioned in any branch
      // (verified by the unit-test substring assertion).
      const reason = result.reason;
      switch (reason.kind) {
        case "transport":
          serverLogOutError = `transport: ${reason.reason}`;
          break;
        case "http-status":
          serverLogOutError = `http-status: ${reason.status.toString()}`;
          break;
        case "graphql-error":
          serverLogOutError = `graphql-error: ${reason.message}`;
          break;
        case "payload-missing":
          serverLogOutError = "payload-missing";
          break;
        case "success-false":
          serverLogOutError = "success-false";
          break;
      }
    }
  }

  // Step 2: local clear. Always runs regardless of server-side outcome —
  // local state must end in the "no token" condition. `clearAuthToken`
  // is idempotent (no-op when the token field is already absent) — under
  // that path we still want `cleared: true` because the post-state
  // matches the intent.
  try {
    await clearAuthToken(sandboxConfigPath);
    cleared = true;
  } catch (err) {
    if (error === null) error = err instanceof Error ? err.message : String(err);
  }

  try {
    await unlink(sessionFilePath);
  } catch {
    // ENOENT (already gone) is fine; other errors are swallowed — the
    // session metadata is not load-bearing for safety.
  }

  // Cool-off — AC E3 of #21. Spaces back-to-back `pnpm test:e2e`
  // invocations so Toptal's abuse heuristics don't flag the maintainer's
  // account. Skipped in tests (coolOffMs: 0).
  if (coolOffMs > 0) {
    await new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, coolOffMs);
    });
  }

  try {
    releaseLock(lockPath);
    lockReleased = true;
  } catch (err) {
    if (error === null) error = err instanceof Error ? err.message : String(err);
  }

  const succeeded = error === null;
  const receipt: TeardownReceipt = {
    ranAt: new Date().toISOString(),
    cleared,
    lockReleased,
    serverLogOut,
    serverLogOutError,
    succeeded,
    error,
  };

  // Receipt write is the LAST step. A failure here yields receipt
  // absence, which the crash-recovery wrapper reports as a separate
  // (stronger) failure signal — there's nothing else useful to do
  // beyond not throwing (a throw would mask the test-run failure that
  // brought us to teardown).
  try {
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // Silent — see comment above.
  }
}
