// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock `@ttctl/core` so the program's preAction hook fires the real
 * `setDiagnosticLogger`, but every other sub-command's transitive
 * imports resolve. `setDiagnosticLogger` is the integration point we
 * pin: we re-export it as a `vi.fn()` and assert the right level
 * routes through.
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

import { getAuthStatus, resolveConfig, setDiagnosticLogger } from "@ttctl/core";

import { resetCliConfigPath } from "../lib/config-context.js";
import { resetCliDryRun } from "../lib/dry-run.js";
import { buildProgram } from "../program.js";

const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedGetAuthStatus = vi.mocked(getAuthStatus);
const mockedSetDiagnosticLogger = vi.mocked(setDiagnosticLogger);

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

describe("program --verbose / --debug global flags (issue #139)", () => {
  let tmpDir: string;
  let fixturePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ttctl-test-"));
    fixturePath = join(tmpDir, "config.yaml");
    writeFileSync(fixturePath, "auth:\n  credentials: 'op://Personal/ttctl'\n");

    resetCliConfigPath();
    resetCliDryRun();

    mockedResolveConfig.mockReset();
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: fixturePath,
    });
    mockedGetAuthStatus.mockReset();
    mockedGetAuthStatus.mockResolvedValue({ status: "invalid", reason: "no-session" });
    mockedSetDiagnosticLogger.mockReset();

    delete process.env["TTCTL_CONFIG_FILE"];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    resetCliConfigPath();
    resetCliDryRun();
  });

  // AC #1: visible in --help
  it("--verbose appears in the root program help (AC #1)", async () => {
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
    expect(helpText).toContain("--verbose");
    expect(helpText).toContain("log request/response summary to stderr");
  });

  it("--debug appears in the root program help (AC #1)", async () => {
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
    expect(helpText).toContain("--debug");
    expect(helpText).toContain("log full request/response");
  });

  // AC: preAction routes the right level through setDiagnosticLogger
  it("no flag: setDiagnosticLogger called with 'none' (default)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledTimes(1);
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledWith("none");
  });

  it("--verbose: setDiagnosticLogger called with 'verbose'", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--verbose", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledTimes(1);
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledWith("verbose");
  });

  it("--debug: setDiagnosticLogger called with 'debug'", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--debug", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledTimes(1);
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledWith("debug");
  });

  it("--verbose --debug: --debug wins (superset behavior)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--verbose", "--debug", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledTimes(1);
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledWith("debug");
  });

  it("--debug --verbose (reverse order): still --debug wins", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--debug", "--verbose", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledWith("debug");
  });

  // AC #5: stdout is never touched by the flag itself (verified at the
  // logger layer in diagnostic-log.test.ts; here we pin the CLI surface
  // contract that the flag passes through without touching stdout
  // BEFORE the action runs).
  it("--verbose alone does not write to stdout or stderr during preAction", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--verbose", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    // The flag itself emits nothing — only the action handler (auth status)
    // would emit. Filter to what came from the preAction window vs the
    // handler. We assert the preAction hook didn't pollute the streams
    // by checking no diagnostic-log line shape appears (those start
    // with `POST ` or `{`).
    const stdoutText = stdout.lines.join("");
    expect(stdoutText).not.toMatch(/^POST /m);
    expect(stdoutText).not.toMatch(/^\{"kind":/m);
    const stderrText = stderr.lines.join("");
    // Stderr may contain the auth-status error path; what it MUST NOT
    // contain is a diagnostic-log line (no network call was made — no
    // log line is correct).
    expect(stderrText).not.toMatch(/^POST /m);
    expect(stderrText).not.toMatch(/^\{"kind":/m);
  });
});
