// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ttctl/core", async () => {
  // Implement the error classes locally so `instanceof` checks in signin.ts
  // resolve against THESE constructors (vi.mock replaces the imports). The
  // signatures track the real classes in `packages/core/src/auth.ts`,
  // `onepassword.ts`, and `config.ts`.
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
  class OnePasswordError extends Error {
    override readonly name = "OnePasswordError";
  }
  class SignInError extends Error {
    override readonly name = "SignInError";
    constructor(
      public readonly code: "INVALID_CREDENTIALS" | "MFA_REQUIRED" | "NETWORK_ERROR" | "UNKNOWN",
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ConfigError,
    OnePasswordError,
    SignInError,
    resolveAuthTokenPath: vi.fn(() => "/tmp/test-auth.token"),
    resolveConfig: vi.fn(),
    resolveCredentials: vi.fn(),
    saveAuthToken: vi.fn(),
    signIn: vi.fn(),
  };
});

import {
  ConfigError,
  OnePasswordError,
  SignInError,
  resolveAuthTokenPath,
  resolveConfig,
  resolveCredentials,
  saveAuthToken,
  signIn,
} from "@ttctl/core";

import {
  exitCodeForSignInResult,
  formatSignInOutput,
  formatSignInTable,
  runAuthSignIn,
} from "../commands/auth/signin.js";
import type { SignInResult } from "../commands/auth/signin.js";

const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedResolveCredentials = vi.mocked(resolveCredentials);
const mockedSignIn = vi.mocked(signIn);
const mockedSaveAuthToken = vi.mocked(saveAuthToken);
const mockedResolveTokenPath = vi.mocked(resolveAuthTokenPath);

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

describe("exitCodeForSignInResult", () => {
  it("returns 0 for signed-in", () => {
    expect(exitCodeForSignInResult({ status: "signed-in", email: "u@e.com" })).toBe(0);
  });

  it("returns 2 for NETWORK_ERROR (transient/retryable)", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "NETWORK_ERROR", message: "timeout" })).toBe(2);
  });

  it("returns 1 for INVALID_CREDENTIALS", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "INVALID_CREDENTIALS", message: "bad creds" })).toBe(1);
  });

  it("returns 1 for MFA_REQUIRED", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "MFA_REQUIRED", message: "mfa" })).toBe(1);
  });

  it("returns 1 for ONEPASSWORD_ERROR", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "ONEPASSWORD_ERROR", message: "no op cli" })).toBe(1);
  });

  it("returns 1 for ConfigError codes (NO_CREDS / PARSE / VALIDATION / PERMISSION)", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "NO_CREDS", message: "no config" })).toBe(1);
    expect(exitCodeForSignInResult({ status: "error", code: "PARSE", message: "bad yaml" })).toBe(1);
    expect(exitCodeForSignInResult({ status: "error", code: "VALIDATION", message: "bad shape" })).toBe(1);
    expect(exitCodeForSignInResult({ status: "error", code: "PERMISSION", message: "denied" })).toBe(1);
  });

  it("returns 1 for SAVE_FAILED", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "SAVE_FAILED", message: "EACCES" })).toBe(1);
  });

  it("returns 1 for UNKNOWN", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "UNKNOWN", message: "?" })).toBe(1);
  });
});

describe("formatSignInTable", () => {
  it("formats signed-in as `Signed in as <email>`", () => {
    expect(formatSignInTable({ status: "signed-in", email: "ada@example.com" })).toBe("Signed in as ada@example.com");
  });

  it("formats error as `Sign-in failed (<code>): <message>`", () => {
    expect(
      formatSignInTable({ status: "error", code: "INVALID_CREDENTIALS", message: "Invalid email or password" }),
    ).toBe("Sign-in failed (INVALID_CREDENTIALS): Invalid email or password");
  });
});

describe("formatSignInOutput", () => {
  it("emits signed-in JSON with status + email (no error fields)", () => {
    const out = formatSignInOutput({ status: "signed-in", email: "ada@example.com" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "signed-in", email: "ada@example.com" });
  });

  it("emits error JSON with status + code + message (no email)", () => {
    const out = formatSignInOutput({ status: "error", code: "MFA_REQUIRED", message: "MFA needed" }, "json");
    expect(JSON.parse(out)).toEqual({ status: "error", code: "MFA_REQUIRED", message: "MFA needed" });
  });

  it("emits table format when output is `table`", () => {
    expect(formatSignInOutput({ status: "signed-in", email: "u@e.com" }, "table")).toBe("Signed in as u@e.com");
  });
});

describe("runAuthSignIn", () => {
  beforeEach(() => {
    mockedResolveConfig.mockReset();
    mockedResolveCredentials.mockReset();
    mockedSignIn.mockReset();
    mockedSaveAuthToken.mockReset();
    mockedResolveTokenPath.mockReset();
    mockedResolveTokenPath.mockReturnValue("/tmp/test-auth.token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function invoke(output: "table" | "json"): Promise<{ stdout: string[]; stderr: string[]; exitCode: number }> {
    const streams = captureStreams();
    const exit = captureExit();
    try {
      await runAuthSignIn({ output });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    if (exit.exit === null) throw new Error("process.exit was not called");
    return { stdout: streams.stdout, stderr: streams.stderr, exitCode: exit.exit.code };
  }

  it("happy path: config → resolve → signIn → saveAuthToken → exit 0 + confirmation on stdout", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue({ token: "tok-abc-123" });
    mockedSaveAuthToken.mockResolvedValue(undefined);

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("Signed in as ada@example.com\n");
    expect(stderr.join("")).toBe("");
    // signIn called with creds (no jar argument); saveAuthToken called with the resolved path + the captured token
    expect(mockedSignIn).toHaveBeenCalledTimes(1);
    expect(mockedSignIn.mock.calls[0]?.[0]).toEqual({ email: "ada@example.com", password: "hunter2" });
    expect(mockedSignIn.mock.calls[0]).toHaveLength(1);
    expect(mockedSaveAuthToken).toHaveBeenCalledTimes(1);
    expect(mockedSaveAuthToken.mock.calls[0]?.[0]).toBe("/tmp/test-auth.token");
    expect(mockedSaveAuthToken.mock.calls[0]?.[1]).toBe("tok-abc-123");
    // resolveAuthTokenPath called with the loaded config + its path
    expect(mockedResolveTokenPath).toHaveBeenCalledTimes(1);
    expect(mockedResolveTokenPath.mock.calls[0]?.[0]).toEqual({
      config: { auth: "op://Personal/ttctl" },
      configPath: "/cwd/.ttctl.yaml",
    });
  });

  it("happy path JSON: emits {status:signed-in, email} on stdout", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue({ token: "tok" });
    mockedSaveAuthToken.mockResolvedValue(undefined);

    const { stdout, exitCode } = await invoke("json");

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({ status: "signed-in", email: "ada@example.com" });
  });

  it("ConfigError → exit 1, error to stderr (code surfaced from ConfigError discriminator)", async () => {
    mockedResolveConfig.mockImplementation(() => {
      throw new ConfigError(
        "No config found. Set TTCTL_CONFIG_FILE or place config at $XDG_CONFIG_HOME/ttctl/config.yaml or ~/.config/ttctl/config.yaml. See README for setup.",
        "NO_CREDS",
      );
    });

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe(
      "Sign-in failed (NO_CREDS): No config found. Set TTCTL_CONFIG_FILE or place config at $XDG_CONFIG_HOME/ttctl/config.yaml or ~/.config/ttctl/config.yaml. See README for setup.\n",
    );
    // Should NOT proceed past config resolution
    expect(mockedResolveCredentials).not.toHaveBeenCalled();
    expect(mockedSignIn).not.toHaveBeenCalled();
    expect(mockedSaveAuthToken).not.toHaveBeenCalled();
  });

  it("OnePasswordError → exit 1, message preserves install hint verbatim", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockImplementation(() => {
      throw new OnePasswordError(
        "1Password CLI (`op`) not found. Install: https://developer.1password.com/docs/cli/get-started/",
      );
    });

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("ONEPASSWORD_ERROR");
    expect(stderr.join("")).toContain("1Password CLI (`op`) not found");
    expect(stderr.join("")).toContain("Install:");
    expect(mockedSignIn).not.toHaveBeenCalled();
  });

  it("OnePasswordError JSON → emits {status:error, code:ONEPASSWORD_ERROR, message}", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    const opErrorMessage =
      "Item Personal/ttctl must have fields with USERNAME and PASSWORD purposes (LOGIN-category items have these by default).";
    mockedResolveCredentials.mockImplementation(() => {
      throw new OnePasswordError(opErrorMessage);
    });

    const { stderr, exitCode } = await invoke("json");

    expect(exitCode).toBe(1);
    const parsed: unknown = JSON.parse(stderr.join("").trim());
    expect(parsed).toEqual({
      status: "error",
      code: "ONEPASSWORD_ERROR",
      message: opErrorMessage,
    });
  });

  it("SignInError(INVALID_CREDENTIALS) → exit 1", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "wrong" });
    mockedSignIn.mockRejectedValue(new SignInError("INVALID_CREDENTIALS", "Invalid email or password"));

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toBe("Sign-in failed (INVALID_CREDENTIALS): Invalid email or password\n");
    expect(mockedSaveAuthToken).not.toHaveBeenCalled();
  });

  it("SignInError(MFA_REQUIRED) → exit 1 with surfaced MFA code", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockRejectedValue(new SignInError("MFA_REQUIRED", "Multi-factor authentication required"));

    const { stderr, exitCode } = await invoke("json");

    expect(exitCode).toBe(1);
    const parsed: unknown = JSON.parse(stderr.join("").trim());
    expect(parsed).toEqual({
      status: "error",
      code: "MFA_REQUIRED",
      message: "Multi-factor authentication required",
    });
  });

  it("SignInError(NETWORK_ERROR) → exit 2 (retryable)", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockRejectedValue(new SignInError("NETWORK_ERROR", "Sign-in request failed: ECONNREFUSED"));

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("NETWORK_ERROR");
  });

  it("saveAuthToken failure → exit 1 with SAVE_FAILED code and path mentioned", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue({ token: "tok" });
    mockedResolveTokenPath.mockReturnValue("/home/u/.ttctl/auth.token");
    mockedSaveAuthToken.mockRejectedValue(new Error("EACCES: permission denied"));

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("SAVE_FAILED");
    expect(stderr.join("")).toContain("/home/u/.ttctl/auth.token");
    expect(stderr.join("")).toContain("EACCES");
  });

  it("non-Error thrown by core → captured as UNKNOWN with stringified value", async () => {
    mockedResolveConfig.mockImplementation(() => {
      throw "weird non-error";
    });

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    // ConfigError is the wrapper for the resolveConfig path, but a non-Error throw
    // bypasses instanceof checks → falls through to UNKNOWN.
    expect(stderr.join("")).toContain("UNKNOWN");
    expect(stderr.join("")).toContain("weird non-error");
  });

  function isResult(o: unknown): o is SignInResult {
    return typeof o === "object" && o !== null && "status" in o;
  }

  it("preserves the success email exactly (no normalization, no email from elsewhere)", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: { email: "Ada@EXAMPLE.com", password: "p" } }, path: "/x" });
    mockedResolveCredentials.mockReturnValue({ email: "Ada@EXAMPLE.com", password: "p" });
    mockedSignIn.mockResolvedValue({ token: "tok" });
    mockedSaveAuthToken.mockResolvedValue(undefined);

    const { stdout } = await invoke("json");
    const parsed: unknown = JSON.parse(stdout.join("").trim());
    if (!isResult(parsed)) throw new Error("expected SignInResult");
    if (parsed.status !== "signed-in") throw new Error("expected signed-in");
    expect(parsed.email).toBe("Ada@EXAMPLE.com");
  });
});
