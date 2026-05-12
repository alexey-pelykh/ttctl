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
    signOut: vi.fn(),
  };
});

import { AuthTokenPersistError, ConfigError, clearAuthToken, resolveConfig, signOut } from "@ttctl/core";
import type { SignOutResult as CoreSignOutResult } from "@ttctl/core";

import {
  exitCodeForSignOutResult,
  formatSignOutOutput,
  formatSignOutPretty,
  mapCoreSignOutResult,
  runAuthSignOut,
  serverLogOutStderrWarning,
} from "../commands/auth/signout.js";

const mockedClearAuthToken = vi.mocked(clearAuthToken);
const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedSignOut = vi.mocked(signOut);

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

describe("formatSignOutPretty", () => {
  it("renders signed-out (removed=true) as `Signed out.`", () => {
    expect(formatSignOutPretty({ status: "signed-out", removed: true, path: "/p", serverLogOut: "logged-out" })).toBe(
      "Signed out.",
    );
  });

  it("renders signed-out (removed=false, no token present) ALSO as `Signed out.` (idempotent UX)", () => {
    expect(formatSignOutPretty({ status: "signed-out", removed: false, path: "/p", serverLogOut: "skipped" })).toBe(
      "Signed out.",
    );
  });

  it("renders signed-out with serverLogOut=unreachable as `Signed out.` (warning is stderr only)", () => {
    // The unreachable case is a stderr WARNING — the pretty stdout line stays
    // identical so the idempotent UX contract holds across all success paths.
    expect(formatSignOutPretty({ status: "signed-out", removed: true, path: "/p", serverLogOut: "unreachable" })).toBe(
      "Signed out.",
    );
  });

  it("renders error as `Sign-out failed: <message>`", () => {
    expect(formatSignOutPretty({ status: "error", message: "EACCES: permission denied" })).toBe(
      "Sign-out failed: EACCES: permission denied",
    );
  });
});

describe("formatSignOutOutput", () => {
  it("emits success JSON with status + removed + path + serverLogOut", () => {
    const out = formatSignOutOutput(
      { status: "signed-out", removed: true, path: "/p", serverLogOut: "logged-out" },
      "json",
    );
    expect(JSON.parse(out)).toEqual({ status: "signed-out", removed: true, path: "/p", serverLogOut: "logged-out" });
  });

  it("emits idempotent-success JSON distinguishing removed=false + serverLogOut=skipped", () => {
    const out = formatSignOutOutput(
      { status: "signed-out", removed: false, path: "/p", serverLogOut: "skipped" },
      "json",
    );
    expect(JSON.parse(out)).toEqual({ status: "signed-out", removed: false, path: "/p", serverLogOut: "skipped" });
  });

  it("emits unreachable-serverLogOut JSON for scripts to detect post-#180 soft warning", () => {
    const out = formatSignOutOutput(
      { status: "signed-out", removed: true, path: "/p", serverLogOut: "unreachable" },
      "json",
    );
    expect(JSON.parse(out)).toEqual({ status: "signed-out", removed: true, path: "/p", serverLogOut: "unreachable" });
  });

  it("emits already-invalid serverLogOut JSON when bearer was already invalid server-side", () => {
    const out = formatSignOutOutput(
      { status: "signed-out", removed: true, path: "/p", serverLogOut: "already-invalid" },
      "json",
    );
    expect(JSON.parse(out)).toEqual({
      status: "signed-out",
      removed: true,
      path: "/p",
      serverLogOut: "already-invalid",
    });
  });

  it("emits error JSON with status + message", () => {
    const out = formatSignOutOutput({ status: "error", message: "boom" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "error", message: "boom" });
  });

  it("emits pretty when output=pretty", () => {
    expect(
      formatSignOutOutput({ status: "signed-out", removed: true, path: "/p", serverLogOut: "logged-out" }, "pretty"),
    ).toBe("Signed out.");
  });
  it("emits yaml when output=yaml", () => {
    const out = formatSignOutOutput(
      { status: "signed-out", removed: true, path: "/p", serverLogOut: "logged-out" },
      "yaml",
    );
    expect(out).toContain("status: signed-out");
    expect(out).toContain("removed: true");
    expect(out).toContain("path: /p");
    expect(out).toContain("serverLogOut: logged-out");
  });
});

describe("exitCodeForSignOutResult", () => {
  it("returns 0 for signed-out (removed)", () => {
    expect(
      exitCodeForSignOutResult({ status: "signed-out", removed: true, path: "/p", serverLogOut: "logged-out" }),
    ).toBe(0);
  });
  it("returns 0 for signed-out (idempotent no-op) — both branches must be 0 per AC", () => {
    expect(
      exitCodeForSignOutResult({ status: "signed-out", removed: false, path: "/p", serverLogOut: "skipped" }),
    ).toBe(0);
  });
  it("returns 0 for signed-out even when serverLogOut=unreachable (soft warning, not failure)", () => {
    expect(
      exitCodeForSignOutResult({ status: "signed-out", removed: true, path: "/p", serverLogOut: "unreachable" }),
    ).toBe(0);
  });
  it("returns 1 for error", () => {
    expect(exitCodeForSignOutResult({ status: "error", message: "boom" })).toBe(1);
  });
});

describe("mapCoreSignOutResult", () => {
  it("maps logged-out → logged-out", () => {
    expect(mapCoreSignOutResult({ status: "logged-out" })).toBe("logged-out");
  });
  it("maps invalid/session-expired → already-invalid", () => {
    expect(mapCoreSignOutResult({ status: "invalid", reason: "session-expired" })).toBe("already-invalid");
  });
  it("maps invalid/graphql-auth-error → already-invalid", () => {
    expect(mapCoreSignOutResult({ status: "invalid", reason: "graphql-auth-error" })).toBe("already-invalid");
  });
  it("maps invalid/no-session → skipped (defensive — CLI handles short-circuit before calling core.signOut)", () => {
    expect(mapCoreSignOutResult({ status: "invalid", reason: "no-session" })).toBe("skipped");
  });
  it("maps unreachable/transport → unreachable", () => {
    expect(mapCoreSignOutResult({ status: "unreachable", reason: { kind: "transport", reason: "ECONNREFUSED" } })).toBe(
      "unreachable",
    );
  });
  it("maps unreachable/http-status → unreachable", () => {
    expect(mapCoreSignOutResult({ status: "unreachable", reason: { kind: "http-status", status: 503 } })).toBe(
      "unreachable",
    );
  });
  it("maps unreachable/graphql-error → unreachable", () => {
    expect(
      mapCoreSignOutResult({
        status: "unreachable",
        reason: { kind: "graphql-error", message: "rate limited" },
      }),
    ).toBe("unreachable");
  });
  it("maps unreachable/payload-missing → unreachable", () => {
    expect(mapCoreSignOutResult({ status: "unreachable", reason: { kind: "payload-missing" } })).toBe("unreachable");
  });
  it("maps unreachable/success-false → unreachable", () => {
    expect(mapCoreSignOutResult({ status: "unreachable", reason: { kind: "success-false" } })).toBe("unreachable");
  });
});

describe("serverLogOutStderrWarning", () => {
  it("returns null for logged-out (no warning needed)", () => {
    expect(serverLogOutStderrWarning({ status: "logged-out" })).toBeNull();
  });
  it("returns null for invalid (no warning needed)", () => {
    expect(serverLogOutStderrWarning({ status: "invalid", reason: "session-expired" })).toBeNull();
  });
  it("returns a warning naming the transport reason for unreachable/transport", () => {
    const warning = serverLogOutStderrWarning({
      status: "unreachable",
      reason: { kind: "transport", reason: "ECONNREFUSED 1.2.3.4:443" },
    });
    expect(warning).toContain("warning: server-side LogOut could not be delivered");
    expect(warning).toContain("ECONNREFUSED");
    expect(warning).toContain("24-72h");
  });
  it("returns a warning naming the HTTP status for unreachable/http-status", () => {
    const warning = serverLogOutStderrWarning({
      status: "unreachable",
      reason: { kind: "http-status", status: 503 },
    });
    expect(warning).toContain("HTTP 503");
  });
  it("returns a warning naming the GraphQL message for unreachable/graphql-error", () => {
    const warning = serverLogOutStderrWarning({
      status: "unreachable",
      reason: { kind: "graphql-error", message: "Rate limited" },
    });
    expect(warning).toContain("Rate limited");
  });
  it("returns a warning for unreachable/payload-missing", () => {
    const warning = serverLogOutStderrWarning({
      status: "unreachable",
      reason: { kind: "payload-missing" },
    });
    expect(warning).toContain("unrecognized payload shape");
  });
  it("returns a warning for unreachable/success-false", () => {
    const warning = serverLogOutStderrWarning({
      status: "unreachable",
      reason: { kind: "success-false" },
    });
    expect(warning).toContain("data.logOut.success: false");
  });
});

describe("runAuthSignOut", () => {
  beforeEach(() => {
    mockedResolveConfig.mockReset();
    mockedClearAuthToken.mockReset();
    mockedSignOut.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function invoke(output: "pretty" | "json"): Promise<{ stdout: string[]; stderr: string[]; exitCode: number }> {
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

  it("Form D (cred + token) + server-side logged-out → calls signOut + clearAuthToken; exits 0; removed=true; serverLogOut=logged-out", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl", token: "user_xxx_yyy" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedSignOut.mockResolvedValue({ status: "logged-out" } satisfies CoreSignOutResult);
    mockedClearAuthToken.mockResolvedValue(undefined);

    const { stdout, stderr, exitCode } = await invoke("json");

    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "signed-out",
      removed: true,
      path: "/home/u/.ttctl.yaml",
      serverLogOut: "logged-out",
    });
    expect(mockedSignOut).toHaveBeenCalledTimes(1);
    expect(mockedSignOut).toHaveBeenCalledWith("user_xxx_yyy");
    expect(mockedClearAuthToken).toHaveBeenCalledWith("/home/u/.ttctl.yaml");
  });

  it("Form D + server-side unreachable → still clears local; stderr warning; exits 0; serverLogOut=unreachable", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl", token: "user_xxx_yyy" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedSignOut.mockResolvedValue({
      status: "unreachable",
      reason: { kind: "transport", reason: "ECONNREFUSED 1.2.3.4:443" },
    } satisfies CoreSignOutResult);
    mockedClearAuthToken.mockResolvedValue(undefined);

    const { stdout, stderr, exitCode } = await invoke("json");

    expect(exitCode).toBe(0);
    // Local clear still ran — the local-state contract is unconditional.
    expect(mockedClearAuthToken).toHaveBeenCalledWith("/home/u/.ttctl.yaml");
    // Warning on stderr names the failure mode.
    expect(stderr.join("")).toContain("warning: server-side LogOut could not be delivered");
    expect(stderr.join("")).toContain("ECONNREFUSED");
    // Stdout result still emits success — server-side is a soft warning.
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "signed-out",
      removed: true,
      path: "/home/u/.ttctl.yaml",
      serverLogOut: "unreachable",
    });
  });

  it("Form D + server-side already-invalid → no warning; exits 0; serverLogOut=already-invalid", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl", token: "user_xxx_yyy" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedSignOut.mockResolvedValue({ status: "invalid", reason: "session-expired" } satisfies CoreSignOutResult);
    mockedClearAuthToken.mockResolvedValue(undefined);

    const { stdout, stderr, exitCode } = await invoke("json");

    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "signed-out",
      removed: true,
      path: "/home/u/.ttctl.yaml",
      serverLogOut: "already-invalid",
    });
  });

  it("Form A (cred only) → no signOut call; idempotent no-op; exits 0; serverLogOut=skipped; clearAuthToken NOT called", async () => {
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
      serverLogOut: "skipped",
    });
    expect(mockedSignOut).not.toHaveBeenCalled();
    expect(mockedClearAuthToken).not.toHaveBeenCalled();
  });

  it("Form C (token only) + server-side logged-out → calls clearAuthToken; removed=true; serverLogOut=logged-out", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { token: "user_xxx_yyy" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedSignOut.mockResolvedValue({ status: "logged-out" } satisfies CoreSignOutResult);
    mockedClearAuthToken.mockResolvedValue(undefined);

    const { stdout, exitCode } = await invoke("json");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({
      status: "signed-out",
      removed: true,
      path: "/home/u/.ttctl.yaml",
      serverLogOut: "logged-out",
    });
    expect(mockedSignOut).toHaveBeenCalledWith("user_xxx_yyy");
    expect(mockedClearAuthToken).toHaveBeenCalledWith("/home/u/.ttctl.yaml");
  });

  it("AuthTokenPersistError from clearAuthToken (e.g. mtime drift) → exit 1 with error; warning still emitted if signOut was unreachable", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl", token: "user_xxx_yyy" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedSignOut.mockResolvedValue({ status: "logged-out" } satisfies CoreSignOutResult);
    mockedClearAuthToken.mockRejectedValue(
      new AuthTokenPersistError("Config file at /home/u/.ttctl.yaml was modified concurrently", "/home/u/.ttctl.yaml"),
    );

    const { stdout, stderr, exitCode } = await invoke("pretty");

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("Sign-out failed:");
    expect(stderr.join("")).toContain("modified concurrently");
  });

  it("ConfigError from resolve → exit 1 with config error message; signOut + clearAuthToken NOT called", async () => {
    mockedResolveConfig.mockImplementation(() => {
      throw new ConfigError(
        "No config found. Pass --config <path>, set TTCTL_CONFIG_FILE, or place config at ~/.ttctl.yaml.",
      );
    });

    const { stdout, stderr, exitCode } = await invoke("pretty");

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("No config found");
    expect(mockedSignOut).not.toHaveBeenCalled();
    expect(mockedClearAuthToken).not.toHaveBeenCalled();
  });
});
