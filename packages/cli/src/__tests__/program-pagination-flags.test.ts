// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mocks mirror `program-diagnostic-flags.test.ts` — every transitive
 * import resolves to a `vi.fn()` so the preAction hook's pagination
 * logic runs in isolation. We don't run any sub-command's action; the
 * preAction hook fires before action handlers, so the flag-handling
 * branch is exercised by `parseAsync(...)` alone.
 */
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    resolveConfig: vi.fn(),
    getAuthStatus: vi.fn(),
    setDiagnosticLogger: vi.fn(),
  };
});

import { getAuthStatus, resolveConfig } from "@ttctl/core";

import { resetCliConfigPath } from "../lib/config-context.js";
import { resetCliDryRun } from "../lib/dry-run.js";
import { getCliPagination, resetCliPagination } from "../lib/pagination.js";
import { buildProgram } from "../program.js";

const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedGetAuthStatus = vi.mocked(getAuthStatus);

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

function captureExit(): { exit: { code: number } | null } {
  const captured: { exit: { code: number } | null } = { exit: null };
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exit = { code: code ?? 0 };
    throw new ExitInvoked(code ?? 0);
  }) as never);
  return captured;
}

function captureStderr(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

function captureStdout(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

describe("program --page / --per-page global flags (issue #138)", () => {
  let tmpDir: string;
  let fixturePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ttctl-test-"));
    fixturePath = join(tmpDir, "config.yaml");
    writeFileSync(fixturePath, "auth:\n  credentials: 'op://Personal/ttctl'\n");

    resetCliConfigPath();
    resetCliDryRun();
    resetCliPagination();

    mockedResolveConfig.mockReset();
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: fixturePath,
    });
    mockedGetAuthStatus.mockReset();
    mockedGetAuthStatus.mockResolvedValue({ status: "invalid", reason: "no-session" });

    delete process.env["TTCTL_CONFIG_FILE"];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    resetCliConfigPath();
    resetCliDryRun();
    resetCliPagination();
  });

  // -------------------------------------------------------------------
  // AC #1: visible in `ttctl --help`
  // -------------------------------------------------------------------

  it("--page appears in the root program help (AC #1)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--help"], { from: "user" });
    } catch {
      // commander.help() throws via exitOverride
    }
    const helpText = stdout.lines.join("");
    expect(helpText).toContain("--page");
    expect(helpText).toContain("1-indexed");
  });

  it("--per-page appears in the root program help (AC #1)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--help"], { from: "user" });
    } catch {
      // expected
    }
    const helpText = stdout.lines.join("");
    expect(helpText).toContain("--per-page");
    expect(helpText).toContain("items per page");
  });

  // -------------------------------------------------------------------
  // Parser: positive-integer enforcement
  // -------------------------------------------------------------------

  it("--page 0 is rejected (must be ≥ 1)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--page", "0", "jobs", "list"], { from: "user" });
    } catch {
      // Commander exits via exitOverride on InvalidArgumentError
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page must be a positive integer");
  });

  it("--per-page 1.5 is rejected (must be Int)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--per-page", "1.5", "jobs", "list"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--per-page must be a positive integer");
  });

  it("--page -1 is rejected (must be positive)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--page", "-1", "jobs", "list"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page must be a positive integer");
  });

  it("--page abc is rejected (non-numeric)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--page", "abc", "jobs", "list"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page must be a positive integer");
  });

  // -------------------------------------------------------------------
  // No-flag default: empty pagination captured
  // -------------------------------------------------------------------

  it("no flag: captured pagination is empty (server applies defaults)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "list"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliPagination()).toEqual({});
  });

  // -------------------------------------------------------------------
  // Refusal on non-paginated leaves (user decision: exit non-zero)
  // -------------------------------------------------------------------

  it("--page on `auth status` (non-paginated) refuses with non-zero exit", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    const exit = captureExit();
    try {
      await program.parseAsync(["--page", "1", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page / --per-page not supported by 'auth status'");
    expect(errOut).toContain("wire operation does not paginate");
    expect(exit.exit?.code).toBe(1);
  });

  it("--per-page on `applications list` (non-paginated wire op) refuses", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    const exit = captureExit();
    try {
      await program.parseAsync(["--per-page", "10", "applications", "list"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page / --per-page not supported by 'applications list'");
    expect(exit.exit?.code).toBe(1);
  });

  it("--page on `profile portfolio list` (no-pagination wire op) refuses", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    const exit = captureExit();
    try {
      await program.parseAsync(["--page", "1", "profile", "portfolio", "list"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page / --per-page not supported by 'profile portfolio list'");
    expect(exit.exit?.code).toBe(1);
  });

  // -------------------------------------------------------------------
  // Propagation to paginated leaves (jobs list / saved / viewed /
  // not-interested-list are all markPaginated()-tagged)
  // -------------------------------------------------------------------

  it("--page 2 on `jobs list` propagates to getCliPagination()", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--page", "2", "jobs", "list"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliPagination()).toEqual({ page: 2 });
  });

  it("--per-page 5 on `jobs saved` propagates", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--per-page", "5", "jobs", "saved"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliPagination()).toEqual({ perPage: 5 });
  });

  it("--page 3 --per-page 10 on `jobs viewed` propagates both", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--page", "3", "--per-page", "10", "jobs", "viewed"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliPagination()).toEqual({ page: 3, perPage: 10 });
  });

  it("--page 4 on `jobs not-interested-list` propagates", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--page", "4", "jobs", "not-interested-list"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliPagination()).toEqual({ page: 4 });
  });
});
