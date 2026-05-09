// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireConfigLock } from "../configLock.js";
import { AuthTokenPersistError, persistAuthToken } from "../configWriter.js";

/**
 * Lock-interaction tests for `persistAuthToken`. Exercises the lock
 * acquire / release contract from the perspective of the public API — does
 * the lock release on every error path, does serialization actually happen,
 * does the LOCKED error code propagate?
 *
 * In-process integration only; cross-process serialization is covered in
 * `packages/e2e/src/configLock-cross-process.test.ts` via `child_process.fork`.
 */
describe("persistAuthToken — advisory lock interaction", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-persist-lock-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("releases the lock after a successful persist (no leftover .lock dir)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    await persistAuthToken(configPath, "user_release_test_aaa");

    // Sibling lockfile must be gone — a leaked lock would block the next
    // ttctl invocation until the stale-detection threshold (10s) fires.
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it("releases the lock after a non-existent-config error (read-fail path)", async () => {
    const missing = join(tmpRoot, "does-not-exist.yaml");

    await expect(persistAuthToken(missing, "user_xxx")).rejects.toBeInstanceOf(AuthTokenPersistError);

    // Even though the read failed, the lock acquire happened FIRST (lock
    // wraps the read). Release must have fired in the `finally`.
    expect(existsSync(`${missing}.lock`)).toBe(false);
  });

  it("releases the lock after a malformed YAML error (parse-fail path)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, ":::\nthis is\n  not valid yaml :::\n", { mode: 0o600 });

    await expect(persistAuthToken(configPath, "user_yyy")).rejects.toBeInstanceOf(AuthTokenPersistError);

    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it("releases the lock when persist refuses an empty token (caller-bug path)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    // Empty-token check fires BEFORE any lock acquire (it's a synchronous
    // pre-condition in the public API). Asserting no lockfile is the
    // contract: a caller-bug must not strand a lock.
    await expect(persistAuthToken(configPath, "")).rejects.toBeInstanceOf(AuthTokenPersistError);

    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it("two concurrent persistAuthToken calls in the same process serialize via the lock", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    const T1 = "user_concurrent_aaa_111";
    const T2 = "user_concurrent_bbb_222";

    // Both promises start; one acquires lock first, the other retries
    // until the first releases. With ≤250ms per retry × 5 retries, the
    // second acquire is well within budget for a typical persist (<100ms).
    const [r1, r2] = await Promise.allSettled([persistAuthToken(configPath, T1), persistAuthToken(configPath, T2)]);

    // Both succeed — the lock serialized them, neither saw LOCKED.
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");

    // Final file state contains exactly ONE of the two tokens (last writer
    // wins post-lock; the OTHER token is overwritten cleanly).
    const final = readFileSync(configPath, "utf8");
    const hasT1 = final.includes(T1);
    const hasT2 = final.includes(T2);
    expect(hasT1 !== hasT2).toBe(true);

    // File is well-formed YAML — no truncation, no half-written content.
    expect(final).toMatch(/auth:/);
    expect(final).toMatch(/credentials:\s*op:\/\/Personal\/ttctl/);

    // Lock released after both persists complete.
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });

  it("throws ConfigError(LOCKED) when a held lock blocks persist past the retry budget", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    // Hold the lock manually for longer than the retry budget (≤1.25s).
    const externalLock = await acquireConfigLock(configPath);
    try {
      await expect(persistAuthToken(configPath, "user_blocked_xxx")).rejects.toMatchObject({
        name: "ConfigError",
        code: "LOCKED",
      });
    } finally {
      await externalLock.release();
    }

    // After we release the external lock, persist works again — proves the
    // contention path didn't leave residual state.
    await persistAuthToken(configPath, "user_after_unblocked_yyy");
    const final = readFileSync(configPath, "utf8");
    expect(final).toMatch(/token:\s*user_after_unblocked_yyy/);
  });
});
