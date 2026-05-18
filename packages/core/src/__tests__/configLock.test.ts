// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "../config.js";
import { acquireConfigLock } from "../configLock.js";

/**
 * Unit tests for the advisory write-back lock primitive. Exercises the
 * sibling-lockfile pattern, contention timeout, error-class mapping, and
 * cross-platform behavior on a pre-existing config file.
 *
 * Tests run on all 3 OS matrix entries (Linux, macOS, Windows) — locking
 * is portable via `proper-lockfile`'s atomic-mkdir mechanism, NOT
 * conditional on POSIX `flock(2)`.
 */
describe("acquireConfigLock", () => {
  let tmpRoot: string;
  let configPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-configlock-"));
    configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });
  });

  afterEach(() => {
    // Best-effort cleanup. proper-lockfile registers a process-exit hook
    // (via signal-exit) that removes any lingering `.lock` directory; the
    // recursive rmSync below catches the rest.
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns a handle with a release() function on success", async () => {
    const handle = await acquireConfigLock(configPath);
    expect(typeof handle.release).toBe("function");
    await handle.release();
  });

  it("creates the sibling .lock directory at <configPath>.lock during the lock window", async () => {
    const lockPath = `${configPath}.lock`;
    expect(existsSync(lockPath)).toBe(false);

    const handle = await acquireConfigLock(configPath);
    expect(existsSync(lockPath)).toBe(true);

    await handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("permits sequential acquire+release+acquire (lock fully released)", async () => {
    const h1 = await acquireConfigLock(configPath);
    await h1.release();

    // Second acquire must succeed cleanly — no leftover lock state.
    const h2 = await acquireConfigLock(configPath);
    await h2.release();
  });

  it("throws ConfigError(LOCKED) on contention exceeding the retry budget", async () => {
    const h1 = await acquireConfigLock(configPath);
    try {
      // Second acquire while first is still held → contention, retries
      // ≤1s on macOS/Linux (≤3s on Windows — see configLock.ts
      // LOCK_RETRY_OPTIONS), then ELOCKED → ConfigError(LOCKED).
      await expect(acquireConfigLock(configPath)).rejects.toMatchObject({
        name: "ConfigError",
        code: "LOCKED",
        path: configPath,
      });
    } finally {
      await h1.release();
    }
  });

  it("the LOCKED error message names the path AND suggests retry", async () => {
    const h1 = await acquireConfigLock(configPath);
    try {
      await acquireConfigLock(configPath);
      expect.fail("expected ConfigError(LOCKED)");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("LOCKED");
      expect((err as ConfigError).message).toContain(configPath);
      expect((err as ConfigError).message).toMatch(/retry|wait/i);
    } finally {
      await h1.release();
    }
  });

  it("contention timeout fires within wall-clock budget (NFR-LOCK-1)", async () => {
    const h1 = await acquireConfigLock(configPath);
    try {
      const start = Date.now();
      try {
        await acquireConfigLock(configPath);
        expect.fail("expected ConfigError(LOCKED)");
      } catch (err) {
        const elapsed = Date.now() - start;
        // Plan: ≤1.0s on macOS/Linux (5 retries × 100-250ms = 500-1250ms),
        // ≤3.0s on Windows (#362 Windows scheduler-variance carve-out: 15
        // retries × 100-250ms = 1500-3750ms). Allow a small ceiling buffer
        // for vitest scheduler jitter + proper-lockfile's last retry
        // timing. If this fires regularly, the LOCK_RETRY_OPTIONS budget
        // needs review (or test machine is wedged — investigate before
        // relaxing the bound).
        const ceilingMs = process.platform === "win32" ? 4500 : 1500;
        expect(elapsed).toBeLessThan(ceilingMs);
        expect(err).toBeInstanceOf(ConfigError);
      }
    } finally {
      await h1.release();
    }
  });

  it("acquires lock even when the target config file does not exist (auth-init forward-compat)", async () => {
    const missing = join(tmpRoot, "does-not-exist.yaml");
    expect(existsSync(missing)).toBe(false);

    // realpath:false in acquireConfigLock means no pre-flight stat — the
    // sibling .lock directory creates regardless of target presence. This
    // is the contract `auth init` (#107-followup-Item-3) will rely on.
    const handle = await acquireConfigLock(missing);
    expect(existsSync(`${missing}.lock`)).toBe(true);
    await handle.release();
  });
});
