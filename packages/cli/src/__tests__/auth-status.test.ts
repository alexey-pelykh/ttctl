// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ttctl/core", () => ({
  discoverCookieJarPath: vi.fn(() => "/tmp/test-jar"),
  loadCookieJar: vi.fn(),
  getAuthStatus: vi.fn(),
}));

import { discoverCookieJarPath, getAuthStatus, loadCookieJar } from "@ttctl/core";
import type { AuthStatusResult } from "@ttctl/core";

import {
  exitCodeForAuthStatus,
  formatAuthStatusOutput,
  formatAuthStatusTable,
  runAuthStatus,
} from "../commands/auth/status.js";

const mockedLoadJar = vi.mocked(loadCookieJar);
const mockedFetchStatus = vi.mocked(getAuthStatus);
const mockedDiscoverPath = vi.mocked(discoverCookieJarPath);

interface ExitCalled {
  code: number;
}

function captureExit(): { exit: ExitCalled | null } {
  const captured = { exit: null as ExitCalled | null };
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exit = { code: code ?? 0 };
    // process.exit's return type is `never`; throw to short-circuit caller flow
    // (action handlers awaiting after exit would otherwise continue in tests).
    throw new ExitInvoked(code ?? 0);
  }) as never);
  return captured;
}

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

function captureStdout(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

describe("exitCodeForAuthStatus", () => {
  it("returns 0 for valid", () => {
    expect(exitCodeForAuthStatus({ status: "valid", email: "x@y.z" })).toBe(0);
  });
  it("returns 1 for invalid", () => {
    expect(exitCodeForAuthStatus({ status: "invalid", reason: "no-session" })).toBe(1);
    expect(exitCodeForAuthStatus({ status: "invalid", reason: "session-expired" })).toBe(1);
    expect(exitCodeForAuthStatus({ status: "invalid", reason: "no-email-in-response" })).toBe(1);
    expect(exitCodeForAuthStatus({ status: "invalid", reason: "unexpected-status" })).toBe(1);
  });
  it("returns 2 for unreachable", () => {
    expect(exitCodeForAuthStatus({ status: "unreachable", reason: "ECONNREFUSED" })).toBe(2);
  });
});

describe("formatAuthStatusTable", () => {
  it("formats valid as `Signed in as <email>`", () => {
    expect(formatAuthStatusTable({ status: "valid", email: "user@example.com" })).toBe("Signed in as user@example.com");
  });
  it("formats no-session with sign-in instructions", () => {
    expect(formatAuthStatusTable({ status: "invalid", reason: "no-session" })).toBe(
      "No session found. Run `ttctl auth signin`.",
    );
  });
  it("formats session-expired with sign-in instructions", () => {
    expect(formatAuthStatusTable({ status: "invalid", reason: "session-expired" })).toBe(
      "Session expired. Run `ttctl auth signin`.",
    );
  });
  it("formats no-email-in-response as session-expired (collapses to same UX)", () => {
    expect(formatAuthStatusTable({ status: "invalid", reason: "no-email-in-response" })).toBe(
      "Session expired. Run `ttctl auth signin`.",
    );
  });
  it("formats unexpected-status as session-expired (collapses to same UX)", () => {
    expect(formatAuthStatusTable({ status: "invalid", reason: "unexpected-status" })).toBe(
      "Session expired. Run `ttctl auth signin`.",
    );
  });
  it("formats unreachable as `Could not reach Toptal.`", () => {
    expect(formatAuthStatusTable({ status: "unreachable", reason: "ECONNREFUSED" })).toBe("Could not reach Toptal.");
  });
});

describe("formatAuthStatusOutput", () => {
  it("emits valid as JSON with status + email (no reason field)", () => {
    const out = formatAuthStatusOutput({ status: "valid", email: "user@example.com" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "valid", email: "user@example.com" });
  });
  it("emits invalid as JSON with status + reason (no email field)", () => {
    const out = formatAuthStatusOutput({ status: "invalid", reason: "no-session" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "invalid", reason: "no-session" });
  });
  it("emits unreachable as JSON with status + reason", () => {
    const out = formatAuthStatusOutput({ status: "unreachable", reason: "ECONNREFUSED" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "unreachable", reason: "ECONNREFUSED" });
  });
  it("emits table format when output is `table`", () => {
    expect(formatAuthStatusOutput({ status: "valid", email: "u@e.com" }, "table")).toBe("Signed in as u@e.com");
  });
});

describe("runAuthStatus", () => {
  beforeEach(() => {
    mockedLoadJar.mockReset();
    mockedFetchStatus.mockReset();
    mockedDiscoverPath.mockReset();
    mockedDiscoverPath.mockReturnValue("/tmp/test-jar");
    // The jar is opaque to runAuthStatus once getAuthStatus is mocked — pass
    // a sentinel rather than pulling tough-cookie into the cli devDeps just
    // for a value that is never inspected.
    mockedLoadJar.mockResolvedValue({} as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runAndCapture(
    result: AuthStatusResult,
    output: "table" | "json",
  ): Promise<{ stdout: string[]; exitCode: number }> {
    mockedFetchStatus.mockResolvedValue(result);
    const stdout = captureStdout();
    const exit = captureExit();
    try {
      await runAuthStatus({ output });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    if (exit.exit === null) throw new Error("process.exit was not called");
    return { stdout: stdout.lines, exitCode: exit.exit.code };
  }

  it("exit-path 1: valid → exit 0 + `Signed in as <email>`", async () => {
    const { stdout, exitCode } = await runAndCapture({ status: "valid", email: "user@example.com" }, "table");
    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("Signed in as user@example.com\n");
  });

  it("exit-path 2: invalid (no session) → exit 1 + sign-in message", async () => {
    const { stdout, exitCode } = await runAndCapture({ status: "invalid", reason: "no-session" }, "table");
    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("No session found. Run `ttctl auth signin`.\n");
  });

  it("exit-path 2: invalid (session-expired) → exit 1 + expired message", async () => {
    const { stdout, exitCode } = await runAndCapture({ status: "invalid", reason: "session-expired" }, "table");
    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("Session expired. Run `ttctl auth signin`.\n");
  });

  it("exit-path 3: unreachable → exit 2 + unreachable message", async () => {
    const { stdout, exitCode } = await runAndCapture({ status: "unreachable", reason: "ECONNREFUSED" }, "table");
    expect(exitCode).toBe(2);
    expect(stdout.join("")).toBe("Could not reach Toptal.\n");
  });

  it("emits valid result as JSON when -o json", async () => {
    const { stdout, exitCode } = await runAndCapture({ status: "valid", email: "u@e.com" }, "json");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({ status: "valid", email: "u@e.com" });
  });

  it("emits invalid result as JSON when -o json", async () => {
    const { stdout, exitCode } = await runAndCapture({ status: "invalid", reason: "no-session" }, "json");
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.join("").trim())).toEqual({ status: "invalid", reason: "no-session" });
  });

  it("emits unreachable result as JSON when -o json", async () => {
    const { stdout, exitCode } = await runAndCapture({ status: "unreachable", reason: "DNS lookup failed" }, "json");
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "unreachable",
      reason: "DNS lookup failed",
    });
  });

  it("calls discoverCookieJarPath then loadCookieJar with that path then getAuthStatus with the jar", async () => {
    const jar = { __sentinelJar: true } as never;
    mockedDiscoverPath.mockReturnValue("/some/path/session.cookies");
    mockedLoadJar.mockResolvedValue(jar);
    mockedFetchStatus.mockResolvedValue({ status: "valid", email: "x@y.z" });
    captureStdout();
    captureExit();
    try {
      await runAuthStatus({ output: "table" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(mockedDiscoverPath).toHaveBeenCalledTimes(1);
    expect(mockedLoadJar).toHaveBeenCalledWith("/some/path/session.cookies");
    expect(mockedFetchStatus).toHaveBeenCalledWith(jar);
  });
});
