// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LockfileError, acquireLock, isPidAlive, releaseLock } from "../lockfile.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ttctl-e2e-lock-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("isPidAlive", () => {
  it("returns true for the current process PID", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an obviously dead PID (1 << 30 — unallocated range)", () => {
    // Picking a PID that's almost certainly outside any running process
    // table. PIDs are 32-bit on Linux, but the kernel's pid_max defaults
    // to 4_194_304 (2^22). 1<<30 (1_073_741_824) is past that on every
    // mainstream OS. macOS / BSD use 16-bit PIDs in practice (pid_max ≈
    // 99999). Windows uses small DWORDs but ranges below 2^16 in practice.
    expect(isPidAlive(1 << 30)).toBe(false);
  });
  // PID 0 is platform-dependent (POSIX `kill(0, sig)` targets the calling
  // process group rather than the literal PID), so we don't assert on it.
  // The lockfile only ever stores PIDs returned by `process.pid`, which
  // is never 0 on any supported platform.
});

describe("acquireLock — fresh", () => {
  it("creates the directory and writes a JSON payload with pid + startedAt", () => {
    const path = join(workDir, "subdir", ".lock");
    const fixedNow = new Date("2026-05-06T12:00:00.000Z");
    const state = acquireLock(path, { pid: 12345, now: () => fixedNow, warn: () => undefined });

    expect(state).toEqual({ pid: 12345, startedAt: "2026-05-06T12:00:00.000Z" });
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(onDisk).toEqual({ pid: 12345, startedAt: "2026-05-06T12:00:00.000Z" });
  });

  it("uses process.pid and current time when no overrides are supplied", () => {
    const path = join(workDir, ".lock");
    const before = Date.now();
    const state = acquireLock(path);
    const after = Date.now();

    expect(state.pid).toBe(process.pid);
    const persisted = Date.parse(state.startedAt);
    expect(persisted).toBeGreaterThanOrEqual(before - 1);
    expect(persisted).toBeLessThanOrEqual(after + 1);
  });

  it("writes lockfile with mode 0600 on POSIX", () => {
    if (process.platform === "win32") return;
    const path = join(workDir, ".lock");
    acquireLock(path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("acquireLock — already held by live PID", () => {
  it("throws LockfileError with the recorded state and an actionable message", () => {
    const path = join(workDir, ".lock");
    // First call: succeeds (no prior file)
    const firstWarn: string[] = [];
    acquireLock(path, { pid: process.pid, warn: (m) => firstWarn.push(m) });

    // Second call: should refuse — current process IS alive
    expect(() => acquireLock(path, { pid: 99999 })).toThrow(LockfileError);
    try {
      acquireLock(path, { pid: 99999 });
    } catch (err) {
      expect(err).toBeInstanceOf(LockfileError);
      expect((err as LockfileError).state.pid).toBe(process.pid);
      expect((err as Error).message).toContain(`PID ${process.pid.toString()}`);
      expect((err as Error).message).toContain("Refusing to start a concurrent E2E run");
      expect((err as Error).message).toContain(path);
    }
  });

  it("does NOT modify the existing lockfile when refusing to acquire", () => {
    const path = join(workDir, ".lock");
    acquireLock(path, { pid: process.pid });
    const before = readFileSync(path, "utf8");
    try {
      acquireLock(path, { pid: 12345 });
    } catch {
      /* expected */
    }
    const after = readFileSync(path, "utf8");
    expect(after).toBe(before);
  });
});

describe("acquireLock — stale PID auto-cleanup", () => {
  it("warns and overwrites when the recorded PID is dead", () => {
    const path = join(workDir, ".lock");
    // Manually plant a lockfile referring to a definitely-dead PID
    writeFileSync(path, JSON.stringify({ pid: 1 << 30, startedAt: "2026-01-01T00:00:00.000Z" }));

    const warnings: string[] = [];
    const newState = acquireLock(path, {
      pid: process.pid,
      warn: (m) => warnings.push(m),
    });

    expect(newState.pid).toBe(process.pid);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("clearing stale E2E lockfile");
    expect(warnings[0]).toContain((1 << 30).toString());
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
    expect(onDisk.pid).toBe(process.pid);
  });

  it("warns and overwrites when the lockfile is malformed (not JSON)", () => {
    const path = join(workDir, ".lock");
    writeFileSync(path, "not json\n");

    const warnings: string[] = [];
    acquireLock(path, { pid: process.pid, warn: (m) => warnings.push(m) });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed E2E lockfile");
  });

  it("warns and overwrites when the lockfile JSON is missing required fields", () => {
    const path = join(workDir, ".lock");
    writeFileSync(path, JSON.stringify({ pid: "not a number", startedAt: "" }));

    const warnings: string[] = [];
    acquireLock(path, { pid: process.pid, warn: (m) => warnings.push(m) });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed E2E lockfile");
  });
});

describe("releaseLock", () => {
  it("removes the file when present", () => {
    const path = join(workDir, ".lock");
    acquireLock(path);
    expect(existsSync(path)).toBe(true);
    releaseLock(path);
    expect(existsSync(path)).toBe(false);
  });

  it("is a no-op on a missing file (idempotent)", () => {
    const path = join(workDir, "missing.lock");
    expect(() => releaseLock(path)).not.toThrow();
  });
});
