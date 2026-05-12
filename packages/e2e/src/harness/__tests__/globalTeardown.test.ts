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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only `signOut` from @ttctl/core (and re-export everything else
// untouched) so the teardown's real `clearAuthToken` / `resolveConfig`
// keep working against the tmpdir-rooted fake repo, but the LogOut
// mutation is never actually fired against talent_profile/graphql.
// `importOriginal` is the canonical vitest pattern for partial mocks
// (preserves the real ConfigError class, error codes, etc.).
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    signOut: vi.fn(),
  };
});

import { signOut } from "@ttctl/core";
import type { SignOutResult } from "@ttctl/core";

import { runGlobalTeardown } from "../globalTeardown.js";
import {
  resolveLockfilePath,
  resolveSandboxConfigPath,
  resolveSandboxDir,
  resolveSharedSessionFilePath,
  resolveTeardownReceiptPath,
} from "../paths.js";

const mockedSignOut = vi.mocked(signOut);

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
  mockedSignOut.mockReset();
  // Default to "logged-out" so happy-path tests don't have to wire it up.
  // Tests that care about the failure / no-token paths override per-case.
  mockedSignOut.mockResolvedValue({ status: "logged-out" } satisfies SignOutResult);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env["TTCTL_E2E"];
  else process.env["TTCTL_E2E"] = savedEnv;
});

describe("runGlobalTeardown — env gate", () => {
  it("is a no-op when TTCTL_E2E is unset (no receipt, no mutations, no signOut call)", async () => {
    delete process.env["TTCTL_E2E"];
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    expect(existsSync(resolveTeardownReceiptPath(repoRoot))).toBe(false);
    expect(existsSync(resolveLockfilePath(repoRoot))).toBe(true);
    expect(existsSync(resolveSharedSessionFilePath(repoRoot))).toBe(true);
    const raw = await readFile(resolveSandboxConfigPath(repoRoot), "utf8");
    expect(raw).toContain("token:");
    expect(mockedSignOut).not.toHaveBeenCalled();
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
    expect(mockedSignOut).not.toHaveBeenCalled();
  });
});

describe("runGlobalTeardown — happy path", () => {
  it("clears token, releases lock, removes session metadata, writes receipt with succeeded=true + serverLogOut=true", async () => {
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

    // server-side signOut was called with the seeded bearer
    expect(mockedSignOut).toHaveBeenCalledTimes(1);
    expect(mockedSignOut).toHaveBeenCalledWith("fixture-bearer-globalTeardown-unit-test-only");

    // receipt written with the expected shape — INCLUDING the post-#180
    // serverLogOut + serverLogOutError fields.
    expect(existsSync(resolveTeardownReceiptPath(repoRoot))).toBe(true);
    const receiptRaw = await readFile(resolveTeardownReceiptPath(repoRoot), "utf8");
    const receipt = JSON.parse(receiptRaw) as Record<string, unknown>;
    expect(receipt["cleared"]).toBe(true);
    expect(receipt["lockReleased"]).toBe(true);
    expect(receipt["serverLogOut"]).toBe(true);
    expect(receipt["serverLogOutError"]).toBeNull();
    expect(receipt["succeeded"]).toBe(true);
    expect(receipt["error"]).toBeNull();
    expect(typeof receipt["ranAt"]).toBe("string");
    // ISO-8601 sanity check (Date can re-parse)
    expect(Number.isFinite(new Date(receipt["ranAt"] as string).getTime())).toBe(true);
  });
});

describe("runGlobalTeardown — server-side LogOut", () => {
  it("records serverLogOut=true and serverLogOutError=null when signOut returns logged-out", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);
    mockedSignOut.mockResolvedValue({ status: "logged-out" } satisfies SignOutResult);

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["serverLogOut"]).toBe(true);
    expect(receipt["serverLogOutError"]).toBeNull();
    expect(receipt["cleared"]).toBe(true);
    expect(receipt["succeeded"]).toBe(true);
  });

  it("records serverLogOut=true when signOut returns invalid (bearer was already invalid server-side)", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);
    mockedSignOut.mockResolvedValue({ status: "invalid", reason: "session-expired" } satisfies SignOutResult);

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    // Already-invalid bearer also satisfies the cleanup intent — record as serverLogOut=true.
    expect(receipt["serverLogOut"]).toBe(true);
    expect(receipt["serverLogOutError"]).toBeNull();
  });

  it("records serverLogOut=false + transport reason on unreachable/transport", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);
    mockedSignOut.mockResolvedValue({
      status: "unreachable",
      reason: { kind: "transport", reason: "ECONNREFUSED 1.2.3.4:443" },
    } satisfies SignOutResult);

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["serverLogOut"]).toBe(false);
    expect(typeof receipt["serverLogOutError"]).toBe("string");
    expect(receipt["serverLogOutError"]).toContain("transport");
    expect(receipt["serverLogOutError"]).toContain("ECONNREFUSED");
    // Local clear still ran — local state is unconditional.
    expect(receipt["cleared"]).toBe(true);
    // `succeeded` reflects whether any try/catch fired — server-side
    // failure is captured in serverLogOutError, NOT in `succeeded`,
    // because server-side is best-effort. Local cleanup succeeded so
    // succeeded stays true.
    expect(receipt["succeeded"]).toBe(true);
  });

  it("records serverLogOut=false + http-status reason on unreachable/http-status", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);
    mockedSignOut.mockResolvedValue({
      status: "unreachable",
      reason: { kind: "http-status", status: 503 },
    } satisfies SignOutResult);

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["serverLogOut"]).toBe(false);
    expect(receipt["serverLogOutError"]).toContain("http-status");
    expect(receipt["serverLogOutError"]).toContain("503");
  });

  it("records serverLogOut=false + success-false reason on unreachable/success-false", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);
    mockedSignOut.mockResolvedValue({
      status: "unreachable",
      reason: { kind: "success-false" },
    } satisfies SignOutResult);

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["serverLogOut"]).toBe(false);
    expect(receipt["serverLogOutError"]).toBe("success-false");
  });

  it("never serializes the bearer token into serverLogOutError (security invariant)", async () => {
    // R-7 mitigation parallel to persistAuthToken-debug.test.ts —
    // assert the bearer literal never leaks into the receipt error field
    // across every unreachable branch.
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);
    const bearer = "fixture-bearer-globalTeardown-unit-test-only";

    const cases: SignOutResult[] = [
      { status: "unreachable", reason: { kind: "transport", reason: "ECONNREFUSED" } },
      { status: "unreachable", reason: { kind: "http-status", status: 503 } },
      { status: "unreachable", reason: { kind: "graphql-error", message: "Rate limited" } },
      { status: "unreachable", reason: { kind: "payload-missing" } },
      { status: "unreachable", reason: { kind: "success-false" } },
    ];

    for (const result of cases) {
      mockedSignOut.mockResolvedValue(result);
      await seedSandbox(repoRoot); // re-seed because each run drops the lock/session
      await runGlobalTeardown({ repoRoot, coolOffMs: 0 });
      const raw = await readFile(resolveTeardownReceiptPath(repoRoot), "utf8");
      expect(raw, `bearer leaked into receipt for ${JSON.stringify(result)}`).not.toContain(bearer);
    }
  });

  it("records serverLogOut=null when no token is present in the sandbox config", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    // Seed config WITHOUT a token field — resolveConfig will either
    // reject (auth: {} is strict-invalid) or succeed with token undefined.
    // Either way, the no-token branch fires and serverLogOut stays null.
    await seedSandbox(repoRoot, { withToken: false });

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["serverLogOut"]).toBeNull();
    expect(receipt["serverLogOutError"]).toBeNull();
    // Local clear still ran (idempotent), so cleared=true.
    expect(receipt["cleared"]).toBe(true);
    // signOut was NEVER called — no bearer to send the LogOut with.
    expect(mockedSignOut).not.toHaveBeenCalled();
  });
});

describe("runGlobalTeardown — idempotency", () => {
  it("reports cleared=true when auth.token field is already absent (serverLogOut=null)", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot, { withToken: false });

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["cleared"]).toBe(true);
    expect(receipt["succeeded"]).toBe(true);
    // No token to call with — serverLogOut must be null, NOT false.
    expect(receipt["serverLogOut"]).toBeNull();
    expect(receipt["serverLogOutError"]).toBeNull();
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

  it("overwrites a pre-existing receipt from a prior run (including post-#180 fields)", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);

    // Seed a stale receipt with deliberately-wrong values for EVERY
    // field — including post-#180 fields — to verify the rewrite picks
    // up the current shape.
    await writeFile(
      resolveTeardownReceiptPath(repoRoot),
      JSON.stringify({
        ranAt: "1970-01-01T00:00:00.000Z",
        cleared: false,
        lockReleased: false,
        serverLogOut: false,
        serverLogOutError: "stale-error",
        succeeded: false,
        error: "stale",
      }) + "\n",
      { mode: 0o600 },
    );

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["cleared"]).toBe(true);
    expect(receipt["succeeded"]).toBe(true);
    expect(receipt["serverLogOut"]).toBe(true); // default mock returns logged-out
    expect(receipt["serverLogOutError"]).toBeNull();
    expect(receipt["ranAt"]).not.toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("runGlobalTeardown — error path", () => {
  it("records succeeded=false and surfaces the error when clearAuthToken cannot proceed", async () => {
    process.env["TTCTL_E2E"] = "1";
    const repoRoot = await makeFakeRepo();
    await seedSandbox(repoRoot);

    // Remove the sandbox config so clearAuthToken fails (ENOENT on read).
    // This is the typical "setup never completed" shape. Server-side
    // signOut is also skipped because resolveConfig fails to find a token.
    await unlink(resolveSandboxConfigPath(repoRoot));

    await runGlobalTeardown({ repoRoot, coolOffMs: 0 });

    const receipt = JSON.parse(await readFile(resolveTeardownReceiptPath(repoRoot), "utf8")) as Record<string, unknown>;
    expect(receipt["cleared"]).toBe(false);
    expect(receipt["succeeded"]).toBe(false);
    expect(receipt["error"]).not.toBeNull();
    // No token to call with — serverLogOut stays null (post-#180).
    expect(receipt["serverLogOut"]).toBeNull();
    expect(receipt["serverLogOutError"]).toBeNull();
    // signOut was not called when the config can't be parsed.
    expect(mockedSignOut).not.toHaveBeenCalled();
    // Lock release runs regardless of clearAuthToken outcome.
    expect(receipt["lockReleased"]).toBe(true);
    // Lock file is actually gone.
    expect(existsSync(resolveLockfilePath(repoRoot))).toBe(false);
  });
});
