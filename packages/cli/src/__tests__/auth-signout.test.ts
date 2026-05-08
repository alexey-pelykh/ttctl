// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ttctl/core", () => {
  // Local error classes so the `instanceof` checks in signout.ts resolve
  // against THESE constructors (vi.mock replaces the imports). Track real
  // class shapes from `packages/core/src/{config,configWriter}.ts`.
  class ConfigError extends Error {
    override readonly name = "ConfigError";
    constructor(
      message: string,
      public readonly code: "NO_CREDS" | "PARSE" | "VALIDATION" | "PERMISSION" = "NO_CREDS",
      public readonly path?: string,
    ) {
      super(message);
    }
  }
  class AuthTokenPersistError extends Error {
    override readonly name = "AuthTokenPersistError";
    constructor(
      message: string,
      public readonly configPath: string,
    ) {
      super(message);
    }
  }
  return {
    AuthTokenPersistError,
    ConfigError,
    clearAuthToken: vi.fn(),
    resolveConfig: vi.fn(),
  };
});

import { AuthTokenPersistError, ConfigError, clearAuthToken, resolveConfig } from "@ttctl/core";

import {
  exitCodeForSignOutResult,
  formatSignOutOutput,
  formatSignOutTable,
  runAuthSignOut,
} from "../commands/auth/signout.js";

const mockedClearAuthToken = vi.mocked(clearAuthToken);
const mockedResolveConfig = vi.mocked(resolveConfig);

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

  it("renders signed-out (removed=false, no token present) ALSO as `Signed out.` (idempotent UX)", () => {
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
  beforeEach(() => {
    mockedResolveConfig.mockReset();
    mockedClearAuthToken.mockReset();
  });

  afterEach(() => {
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

  it("Form D (cred + token) → calls clearAuthToken; exits 0; removed=true; path is the YAML config", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl", token: "user_xxx_yyy" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedClearAuthToken.mockResolvedValue(undefined);

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("Signed out.\n");
    expect(stderr.join("")).toBe("");
    expect(mockedClearAuthToken).toHaveBeenCalledTimes(1);
    expect(mockedClearAuthToken).toHaveBeenCalledWith("/home/u/.ttctl.yaml");
  });

  it("Form A (cred only) → idempotent no-op; exits 0; removed=false; clearAuthToken NOT called", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: "/home/u/.ttctl.yaml",
    });

    const { stdout, exitCode } = await invoke("json");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "signed-out",
      removed: false,
      path: "/home/u/.ttctl.yaml",
    });
    expect(mockedClearAuthToken).not.toHaveBeenCalled();
  });

  it("Form C (token only) → calls clearAuthToken; removed=true (token field is removed)", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { token: "user_xxx_yyy" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedClearAuthToken.mockResolvedValue(undefined);

    const { stdout, exitCode } = await invoke("json");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "signed-out",
      removed: true,
      path: "/home/u/.ttctl.yaml",
    });
    expect(mockedClearAuthToken).toHaveBeenCalledWith("/home/u/.ttctl.yaml");
  });

  it("AuthTokenPersistError from clearAuthToken (e.g. mtime drift) → exit 1 with error", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl", token: "user_xxx_yyy" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedClearAuthToken.mockRejectedValue(
      new AuthTokenPersistError("Config file at /home/u/.ttctl.yaml was modified concurrently", "/home/u/.ttctl.yaml"),
    );

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("Sign-out failed:");
    expect(stderr.join("")).toContain("modified concurrently");
  });

  it("ConfigError from resolve → exit 1 with config error message; clearAuthToken NOT called", async () => {
    mockedResolveConfig.mockImplementation(() => {
      throw new ConfigError(
        "No config found. Pass --config <path>, set TTCTL_CONFIG_FILE, or place config at ~/.ttctl.yaml.",
      );
    });

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("No config found");
    expect(mockedClearAuthToken).not.toHaveBeenCalled();
  });
});
