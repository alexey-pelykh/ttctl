// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Unit tests for `runGlobalTeardown` (post-#171).
 *
 * The function performs real filesystem operations (clearAuthToken on a
 * YAML config, unlink of session/lockfile, write of the receipt). These
 * tests build a tmpdir-rooted fake repo and drive `runGlobalTeardown`
 * against it via the `{ repoRoot }` override. No live Toptal calls are
 * made — `clearAuthToken` is a YAML mutation primitive with no network
 * I/O.
 *
 * The tests do NOT exercise vitest's worker-crash mechanism; that's
 * what `pnpm test:e2e:crash-recovery` does (the live empirical check).
 * Here we verify the building blocks: env-gate, idempotency, receipt
 * schema, error-path semantics.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGlobalTeardown } from "../globalTeardown.js";
import {
  resolveLockfilePath,
  resolveSandboxConfigPath,
  resolveSandboxDir,
  resolveSharedSessionFilePath,
  resolveTeardownReceiptPath,
} from "../paths.js";

interface SeedOptions {
  withToken?: boolean;
  withLock?: boolean;
  withSession?: boolean;
}

async function makeFakeRepo(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ttctl-e2e-teardown-"));
  // `pnpm-workspace.yaml` is the sentinel `findRepoRoot` looks for;
  // these tests always pass `{ repoRoot }` explicitly, but the sentinel
  // is cheap insurance against accidental `findRepoRoot` calls.
  await writeFile(join(base, "pnpm-workspace.yaml"), "packages: []\n");
  await mkdir(resolveSandboxDir(base), { recursive: true });
  return base;
}

async function seedSandbox(repoRoot: string, opts: SeedOptions = {}): Promise<void> {
  const { withToken = true, withLock = true, withSession = true } = opts;
  if (withToken) {
    // Obviously-synthetic fixture string — deliberately NOT matching the
    // canonical `BEARER_PATTERN_SOURCE` regex (`user_<24hex>_<20alnum>`)
    // so `scripts/check-secret-leakage.ts` does NOT flag this file as a
    // bearer leak in tracked source. `clearAuthToken` removes the field
    // by key, not value, so the shape of the value is immaterial to the
    // unit-test contract.
    await writeFile(
      resolveSandboxConfigPath(repoRoot),
      "auth:\n  token: fixture-bearer-globalTeardown-unit-test-only\n",
      { mode: 0o600 },
    );
  } else {
    await writeFile(resolveSandboxConfigPath(repoRoot), "auth: {}\n", { mode: 0o600 });
  }
  if (withLock) {
    await writeFile(
      resolveLockfilePath(repoRoot),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
      { mode: 0o600 },
    );
  }
  if (withSession) {
    await writeFile(
      resolveSharedSessionFilePath(repoRoot),
      JSON.stringify({
        email: "e2e@example.com",
        sandboxDir: resolveSandboxDir(repoRoot),
        sandboxConfigPath: resolveSandboxConfigPath(repoRoot),
        repoRoot,
      }) + "\n",
      { mode: 0o600 },
    );
  }
}

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env["TTCTL_E2E"];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env["TTCTL_E2E"];
  else process.env["TTCTL_E2E"] = savedEnv;
});

describe("runGlobalTeardown — env gate", () => {
  it("is a no-op when TTCTL_E2E is unset (no receipt, no mutations)", async () => {
    delete process.env["TTCTL_E2E"];
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    expect(existsSync(resolveTeardownReceiptPath(repoRoot))).toBe(false);
    expect(existsSync(resolveLockfilePath(repoRoot))).toBe(true);
    expect(existsSync(resolveSharedSessionFilePath(repoRoot))).toBe(true);
    const raw = await readFile(resolveSandboxConfigPath(repoRoot), "utf8");
    expect(raw).toContain("token:");
  });

  it("is a no-op for any TTCTL_E2E value other than '1' (strict env-gate)", async () => {
    for (const value of ["0", "true", "TRUE", "yes", " 1 ", ""]) {
      process.env["TTCTL_E2E"] = value;
      const repoRoot = await makeFakeRepo();
      await seedSandbox(repoRoot);

      await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

      expect(
        existsSync(resolveTeardownReceiptPath(repoRoot)),
        `receipt should be absent for TTCTL_E2E=${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });
});

describe("runGlobalTeardown — happy path", () => {
  it("clears token, releases lock, removes session metadata, writes receipt with succeeded=true", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    // auth.token field is gone from the sandbox config
    const rawConfig = await readFile(resolveSandboxConfigPath(repoRoot), "utf8");
    expect(rawConfig).not.toContain("token:");

    // lockfile and session metadata removed
    expect(existsSync(resolveLockfilePath(repoRoot))).toBe(false);
    expect(existsSync(resolveSharedSessionFilePath(repoRoot))).toBe(false);

    // receipt written with the expected shape
    expect(existsSync(resolveTeardownReceiptPath(repoRoot))).toBe(true);
    const receiptRaw = await readFile(resolveTeardownReceiptPath(repoRoot), "utf8");
    const receipt = JSON.parse(receiptRaw) as Record<string, unknown>;
    expect(receipt["cleared"]).toBe(true);
    expect(receipt["lockReleased"]).toBe(true);
    expect(receipt["succeeded"]).toBe(true);
    expect(receipt["error"]).toBeNull();
    expect(typeof receipt["ranAt"]).toBe("string");
    // ISO-8601 sanity check (Date can re-parse)
    expect(Number.isFinite(new Date(receipt["ranAt"] as string).getTime())).toBe(true);
  });
});

describe("runGlobalTeardown — idempotency", () => {
  it("reports cleared=true when auth.token field is already absent", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot, { withToken: false });

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["cleared"]).toBe(true);
    expect(receipt["succeeded"]).toBe(true);
  });

  it("reports lockReleased=true when lockfile is already absent", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot, { withLock: false });

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["lockReleased"]).toBe(true);
    expect(receipt["succeeded"]).toBe(true);
  });

  it("overwrites a pre-existing receipt from a prior run", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);

    // Seed a stale receipt with deliberately-wrong values
    await writeFile(
      resolveTeardownReceiptPath(repoRoot),
      JSON.stringify({
        ranAt: "1970-01-01T00:00:00.000Z",
        cleared: false,
        lockReleased: false,
        succeeded: false,
        error: "stale",
      }) + "\n",
      { mode: 0o600 },
    );

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["cleared"]).toBe(true);
    expect(receipt["succeeded"]).toBe(true);
    expect(receipt["ranAt"]).not.toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("runGlobalTeardown — error path", () => {
  it("records succeeded=false and surfaces the error when clearAuthToken cannot proceed", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);

    // Remove the sandbox config so clearAuthToken fails (ENOENT on read).
    // This is the typical "setup never completed" shape.
    await unlink(resolveSandboxConfigPath(repoRoot));

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["cleared"]).toBe(false);
    expect(receipt["succeeded"]).toBe(false);
    expect(receipt["error"]).not.toBeNull();
    // Lock release runs regardless of clearAuthToken outcome.
    expect(receipt["lockReleased"]).toBe(true);
    // Lock file is actually gone.
    expect(existsSync(resolveLockfilePath(repoRoot))).toBe(false);
  });
});
