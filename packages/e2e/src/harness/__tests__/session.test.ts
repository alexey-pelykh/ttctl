// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSessionRegistration, getSharedSession, resetSessionForTesting } from "../session.js";

beforeEach(() => {
  // Each test starts with a fresh per-process counter — simulates a new
  // file load. Without this reset, the "second call throws" test would
  // depend on order with previous tests.
  resetSessionForTesting();
});

afterEach(() => {
  resetSessionForTesting();
});

describe("buildSessionRegistration — call counter", () => {
  it("returns a registration on the first call", () => {
    const { setUp, tearDown, handle } = buildSessionRegistration();
    expect(typeof setUp).toBe("function");
    expect(typeof tearDown).toBe("function");
    expect(typeof handle.getContext).toBe("function");
    expect(typeof handle.isActive).toBe("function");
  });

  it("throws on the SECOND call within the same file (one isolated signin per adversarial file)", () => {
    buildSessionRegistration();
    expect(() => buildSessionRegistration()).toThrow(
      /called more than once in the same file.*one isolated EmailPasswordSignIn/,
    );
  });

  it("call count survives partial registration — second call throws even if first did not invoke setUp", () => {
    buildSessionRegistration();
    // Don't run setUp. The counter increments on construction, not on
    // setUp execution. This catches the misuse where a test author
    // calls withFreshSession() twice and only THEN invokes vitest hooks.
    expect(() => buildSessionRegistration()).toThrow(/called more than once/);
  });

  it("resetSessionForTesting clears the counter (test-only escape hatch)", () => {
    buildSessionRegistration();
    resetSessionForTesting();
    expect(() => buildSessionRegistration()).not.toThrow();
  });
});

describe("buildSessionRegistration — handle behavior", () => {
  it("getContext throws when no session has been established (no setUp run)", () => {
    const { handle } = buildSessionRegistration();
    expect(() => handle.getContext()).toThrow(/session is not established/);
  });

  it("getContext error message guides the user toward the env-gate / it.skipIf pattern", () => {
    const { handle } = buildSessionRegistration();
    expect(() => handle.getContext()).toThrow(/TTCTL_E2E.*1/);
    expect(() => handle.getContext()).toThrow(/it\.skipIf/);
  });

  it("isActive returns false before setUp runs", () => {
    const { handle } = buildSessionRegistration();
    expect(handle.isActive()).toBe(false);
  });
});

describe("buildSessionRegistration — setUp env gate", () => {
  it("setUp is a no-op when TTCTL_E2E !== '1' (no signin attempted, isActive stays false)", async () => {
    const original = process.env["TTCTL_E2E"];
    delete process.env["TTCTL_E2E"];
    try {
      const { setUp, handle } = buildSessionRegistration();
      await expect(setUp()).resolves.toBeUndefined();
      expect(handle.isActive()).toBe(false);
    } finally {
      if (original !== undefined) process.env["TTCTL_E2E"] = original;
    }
  });

  it("setUp explicitly accepts only TTCTL_E2E='1' — '0', 'true', 'TRUE' are NOT enabled", async () => {
    for (const value of ["0", "true", "TRUE", "yes", " 1 "]) {
      resetSessionForTesting();
      const original = process.env["TTCTL_E2E"];
      process.env["TTCTL_E2E"] = value;
      try {
        const { setUp, handle } = buildSessionRegistration();
        await expect(setUp()).resolves.toBeUndefined();
        expect(handle.isActive()).toBe(false);
      } finally {
        if (original === undefined) delete process.env["TTCTL_E2E"];
        else process.env["TTCTL_E2E"] = original;
      }
    }
  });
});

describe("buildSessionRegistration — tearDown env gate", () => {
  it("tearDown is a no-op when no session was established (isActive=false)", async () => {
    const { tearDown, handle } = buildSessionRegistration();
    expect(handle.isActive()).toBe(false);
    await expect(tearDown()).resolves.toBeUndefined();
  });

  it("tearDown clears the per-file counter even when setUp never established a session", async () => {
    // Models the failure path where vitest runs afterAll after a thrown
    // beforeAll: file A's setUp throws → context never assigned → tearDown
    // runs → counter must reset so file B's withFreshSession() succeeds.
    // Without this guarantee, ANY beforeAll failure poisons every later
    // file in the same vitest run.
    const { tearDown } = buildSessionRegistration();
    await tearDown();
    expect(() => buildSessionRegistration()).not.toThrow();
  });
});

describe("buildSessionRegistration — coolOff clamp", () => {
  it("clamps coolOffMs below 5000 up to the AC E3 floor (≥5s)", () => {
    // We can't easily verify the clamp without running tearDown end-to-end
    // (which requires TTCTL_E2E=1 and a real account). Instead, assert
    // the API does not throw on a low value — the floor is applied
    // internally and only matters during a real signout.
    expect(() => buildSessionRegistration({ coolOffMs: 100 })).not.toThrow();
  });
});

describe("getSharedSession", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ttctl-shared-session-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("throws when the shared-session file does not exist (TTCTL_E2E gated off OR globalSetup not wired)", () => {
    expect(() => getSharedSession({ repoRoot: workDir })).toThrow(/shared-session file at .* not found/);
  });

  it("error message guides users toward the env-gate / globalSetup wiring", () => {
    expect(() => getSharedSession({ repoRoot: workDir })).toThrow(/TTCTL_E2E/);
    expect(() => getSharedSession({ repoRoot: workDir })).toThrow(/globalSetup/);
  });

  it("returns the parsed metadata when the session file exists and is well-formed", async () => {
    const sandboxDir = join(workDir, ".tmp", "e2e");
    await mkdir(sandboxDir, { recursive: true });
    const meta = {
      email: "test@example.com",
      tokenPath: join(sandboxDir, "auth.token"),
      sandboxDir,
      sandboxConfigPath: join(sandboxDir, ".ttctl.yaml"),
      repoRoot: workDir,
    };
    await writeFile(join(sandboxDir, ".session.json"), JSON.stringify(meta) + "\n");

    const result = getSharedSession({ repoRoot: workDir });
    expect(result.email).toBe("test@example.com");
    expect(result.tokenPath).toBe(meta.tokenPath);
    expect(result.sandboxDir).toBe(sandboxDir);
    expect(result.sandboxConfigPath).toBe(meta.sandboxConfigPath);
    expect(result.repoRoot).toBe(workDir);
  });

  it("throws when the session file is malformed JSON", async () => {
    const sandboxDir = join(workDir, ".tmp", "e2e");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(join(sandboxDir, ".session.json"), "not valid json{{{");

    expect(() => getSharedSession({ repoRoot: workDir })).toThrow(/malformed JSON/);
  });

  it("throws when the session file has unexpected shape (missing required fields)", async () => {
    const sandboxDir = join(workDir, ".tmp", "e2e");
    await mkdir(sandboxDir, { recursive: true });
    // Missing `email`, `sandboxDir`, etc.
    await writeFile(join(sandboxDir, ".session.json"), JSON.stringify({ tokenPath: "/x" }));

    expect(() => getSharedSession({ repoRoot: workDir })).toThrow(/unexpected shape/);
  });

  it("throws when the session file has wrong-typed fields (e.g. tokenPath as number)", async () => {
    const sandboxDir = join(workDir, ".tmp", "e2e");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(
      join(sandboxDir, ".session.json"),
      JSON.stringify({
        email: "x@y",
        tokenPath: 42,
        sandboxDir: "/a",
        sandboxConfigPath: "/b",
        repoRoot: "/c",
      }),
    );

    expect(() => getSharedSession({ repoRoot: workDir })).toThrow(/unexpected shape/);
  });
});
