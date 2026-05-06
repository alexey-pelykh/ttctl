// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ttctl/core", () => ({
  discoverCookieJarPath: vi.fn(),
}));

import { discoverCookieJarPath } from "@ttctl/core";

import {
  exitCodeForSignOutResult,
  formatSignOutOutput,
  formatSignOutTable,
  runAuthSignOut,
} from "../commands/auth/signout.js";

const mockedDiscoverPath = vi.mocked(discoverCookieJarPath);

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

interface ExitCalled {
  code: number;
}

function captureExit(): { exit: ExitCalled | null } {
  const captured = { exit: null as ExitCalled | null };
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exit = { code: code ?? 0 };
    throw new ExitInvoked(code ?? 0);
  }) as never);
  return captured;
}

function captureStreams(): { stdout: string[]; stderr: string[] } {
  const captured = { stdout: [] as string[], stderr: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

describe("formatSignOutTable", () => {
  it("renders signed-out (removed=true) as `Signed out.`", () => {
    expect(formatSignOutTable({ status: "signed-out", removed: true, path: "/p" })).toBe("Signed out.");
  });

  it("renders signed-out (removed=false, no jar present) ALSO as `Signed out.` (idempotent UX)", () => {
    expect(formatSignOutTable({ status: "signed-out", removed: false, path: "/p" })).toBe("Signed out.");
  });

  it("renders error as `Sign-out failed: <message>`", () => {
    expect(formatSignOutTable({ status: "error", message: "EACCES: permission denied" })).toBe(
      "Sign-out failed: EACCES: permission denied",
    );
  });
});

describe("formatSignOutOutput", () => {
  it("emits success JSON with status + removed + path", () => {
    const out = formatSignOutOutput({ status: "signed-out", removed: true, path: "/p" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "signed-out", removed: true, path: "/p" });
  });

  it("emits idempotent-success JSON distinguishing removed=false", () => {
    const out = formatSignOutOutput({ status: "signed-out", removed: false, path: "/p" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "signed-out", removed: false, path: "/p" });
  });

  it("emits error JSON with status + message", () => {
    const out = formatSignOutOutput({ status: "error", message: "boom" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "error", message: "boom" });
  });

  it("emits table when output=table", () => {
    expect(formatSignOutOutput({ status: "signed-out", removed: true, path: "/p" }, "table")).toBe("Signed out.");
  });
});

describe("exitCodeForSignOutResult", () => {
  it("returns 0 for signed-out (removed)", () => {
    expect(exitCodeForSignOutResult({ status: "signed-out", removed: true, path: "/p" })).toBe(0);
  });
  it("returns 0 for signed-out (idempotent no-op) — both branches must be 0 per AC", () => {
    expect(exitCodeForSignOutResult({ status: "signed-out", removed: false, path: "/p" })).toBe(0);
  });
  it("returns 1 for error", () => {
    expect(exitCodeForSignOutResult({ status: "error", message: "boom" })).toBe(1);
  });
});

describe("runAuthSignOut", () => {
  let tempDir: string;
  let jarPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ttctl-signout-test-"));
    jarPath = join(tempDir, "session.cookies");
    mockedDiscoverPath.mockReset();
    mockedDiscoverPath.mockReturnValue(jarPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function invoke(output: "table" | "json"): Promise<{ stdout: string[]; stderr: string[]; exitCode: number }> {
    const streams = captureStreams();
    const exit = captureExit();
    try {
      await runAuthSignOut({ output });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    if (exit.exit === null) throw new Error("process.exit was not called");
    return { stdout: streams.stdout, stderr: streams.stderr, exitCode: exit.exit.code };
  }

  it("removes an existing cookie jar and exits 0", async () => {
    writeFileSync(jarPath, "# Netscape HTTP Cookie File\n");
    expect(existsSync(jarPath)).toBe(true);

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("Signed out.\n");
    expect(stderr.join("")).toBe("");
    expect(existsSync(jarPath)).toBe(false);
  });

  it("is idempotent — succeeds with exit 0 when no cookie jar exists (ENOENT swallowed)", async () => {
    expect(existsSync(jarPath)).toBe(false);

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("Signed out.\n");
    expect(stderr.join("")).toBe("");
  });

  it("is idempotent across consecutive invocations", async () => {
    writeFileSync(jarPath, "# Netscape HTTP Cookie File\n");

    const first = await invoke("table");
    const second = await invoke("table");

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(existsSync(jarPath)).toBe(false);
  });

  it("emits JSON success with removed=true when jar existed", async () => {
    writeFileSync(jarPath, "# Netscape HTTP Cookie File\n");

    const { stdout, exitCode } = await invoke("json");

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "signed-out",
      removed: true,
      path: jarPath,
    });
  });

  it("emits JSON success with removed=false when jar was already absent (idempotent no-op)", async () => {
    const { stdout, exitCode } = await invoke("json");

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "signed-out",
      removed: false,
      path: jarPath,
    });
  });

  it("non-ENOENT errors propagate as error result with exit 1", async () => {
    // Place a DIRECTORY at the jar path. `unlink` on a directory yields
    // EISDIR (Linux), EPERM (macOS, Windows) — neither is ENOENT, so the
    // result must classify as `error`. The earlier "parent-is-file" trick
    // produced ENOTDIR on POSIX but ENOENT on Windows (path-resolution
    // semantics differ), so it's not portable.
    mkdirSync(jarPath);

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("Sign-out failed:");
  });
});
