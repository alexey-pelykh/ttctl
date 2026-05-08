// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ttctl/core", async () => {
  // Implement the error classes locally so `instanceof` checks in signin.ts
  // resolve against THESE constructors (vi.mock replaces the imports). The
  // signatures track the real classes in `packages/core/src/auth.ts`,
  // `onepassword.ts`, `config.ts`, and `configWriter.ts`.
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
  class AuthTokenPersistError extends Error {
    override readonly name = "AuthTokenPersistError";
    constructor(
      message: string,
      public readonly configPath: string,
      public readonly cause?: NodeJS.ErrnoException,
      public readonly bearerRescue?: string,
    ) {
      super(message);
    }
  }
  return {
    AuthTokenPersistError,
    ConfigError,
    OnePasswordError,
    SignInError,
    persistAuthToken: vi.fn(),
    resolveConfig: vi.fn(),
    resolveCredentials: vi.fn(),
    signIn: vi.fn(),
  };
});

import {
  AuthTokenPersistError,
  ConfigError,
  OnePasswordError,
  SignInError,
  persistAuthToken,
  resolveConfig,
  resolveCredentials,
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
const mockedPersistAuthToken = vi.mocked(persistAuthToken);

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

  it("returns 1 for NO_CREDENTIALS (Form C refusal)", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "NO_CREDENTIALS", message: "no creds" })).toBe(1);
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
    mockedPersistAuthToken.mockReset();
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

  it("happy path Form A (1P ref): config → resolve → signIn → persistAuthToken → exit 0 + confirmation on stdout", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: "/cwd/.ttctl.yaml",
    });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue({ token: "user_abc_123" });
    mockedPersistAuthToken.mockResolvedValue(undefined);

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("Signed in as ada@example.com\n");
    expect(stderr.join("")).toBe("");
    expect(mockedSignIn).toHaveBeenCalledTimes(1);
    expect(mockedSignIn.mock.calls[0]?.[0]).toEqual({ email: "ada@example.com", password: "hunter2" });
    // persistAuthToken is called with the resolved YAML config path + the captured token
    expect(mockedPersistAuthToken).toHaveBeenCalledTimes(1);
    expect(mockedPersistAuthToken.mock.calls[0]?.[0]).toBe("/cwd/.ttctl.yaml");
    expect(mockedPersistAuthToken.mock.calls[0]?.[1]).toBe("user_abc_123");
    // resolveCredentials was called with the auth.credentials value, not the whole auth block
    expect(mockedResolveCredentials).toHaveBeenCalledWith("op://Personal/ttctl");
  });

  it("happy path Form B (literal): credentials extraction works for {username, password}", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: { username: "ada@example.com", password: "hunter2" } } },
      path: "/cwd/.ttctl.yaml",
    });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue({ token: "user_xxx_yyy" });
    mockedPersistAuthToken.mockResolvedValue(undefined);

    const { exitCode } = await invoke("table");
    expect(exitCode).toBe(0);
    expect(mockedResolveCredentials).toHaveBeenCalledWith({ username: "ada@example.com", password: "hunter2" });
  });

  it("happy path JSON: emits {status:signed-in, email} on stdout", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: "/cwd/.ttctl.yaml",
    });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue({ token: "tok" });
    mockedPersistAuthToken.mockResolvedValue(undefined);

    const { stdout, exitCode } = await invoke("json");

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({ status: "signed-in", email: "ada@example.com" });
  });

  it("Form C (token-only) → REFUSE with NO_CREDENTIALS code (FR-3.3)", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { token: "user_existing_xxx" } },
      path: "/cwd/.ttctl.yaml",
    });

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toMatch(/NO_CREDENTIALS/);
    expect(stderr.join("")).toMatch(/auth\.credentials/);
    // Should NOT call signIn or persistAuthToken
    expect(mockedSignIn).not.toHaveBeenCalled();
    expect(mockedPersistAuthToken).not.toHaveBeenCalled();
  });

  it("ConfigError → exit 1, error to stderr (code surfaced from ConfigError discriminator)", async () => {
    mockedResolveConfig.mockImplementation(() => {
      throw new ConfigError(
        "No config found. Pass --config <path>, set TTCTL_CONFIG_FILE, or place config at ~/.ttctl.yaml. See README for setup.",
        "NO_CREDS",
      );
    });

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toMatch(/Sign-in failed \(NO_CREDS\):/);
    expect(stderr.join("")).toMatch(/No config found/);
    expect(mockedResolveCredentials).not.toHaveBeenCalled();
    expect(mockedSignIn).not.toHaveBeenCalled();
    expect(mockedPersistAuthToken).not.toHaveBeenCalled();
  });

  it("OnePasswordError → exit 1, message preserves install hint verbatim", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: "/cwd/.ttctl.yaml",
    });
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

  it("SignInError(INVALID_CREDENTIALS) → exit 1", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: "/cwd/.ttctl.yaml",
    });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "wrong" });
    mockedSignIn.mockRejectedValue(new SignInError("INVALID_CREDENTIALS", "Invalid email or password"));

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toBe("Sign-in failed (INVALID_CREDENTIALS): Invalid email or password\n");
    expect(mockedPersistAuthToken).not.toHaveBeenCalled();
  });

  it("SignInError(NETWORK_ERROR) → exit 2 (retryable)", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: "/cwd/.ttctl.yaml",
    });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockRejectedValue(new SignInError("NETWORK_ERROR", "Sign-in request failed: ECONNREFUSED"));

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("NETWORK_ERROR");
  });

  it("AuthTokenPersistError → exit 1 with SAVE_FAILED + bearer rescue line", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: "/home/u/.ttctl.yaml",
    });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue({ token: "user_rescue_token_xyz" });
    mockedPersistAuthToken.mockRejectedValue(
      new AuthTokenPersistError(
        "Cannot write config file at /home/u/.ttctl.yaml: EROFS: read-only filesystem",
        "/home/u/.ttctl.yaml",
        undefined,
        "user_rescue_token_xyz",
      ),
    );

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("SAVE_FAILED");
    expect(stderr.join("")).toContain("/home/u/.ttctl.yaml");
    expect(stderr.join("")).toContain("EROFS");
    // Bearer rescue: the captured token must appear verbatim in stderr so
    // the operator can save it manually before retrying.
    expect(stderr.join("")).toContain("user_rescue_token_xyz");
  });

  it("non-Error thrown by core → captured as UNKNOWN with stringified value", async () => {
    mockedResolveConfig.mockImplementation(() => {
      throw "weird non-error";
    });

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("UNKNOWN");
    expect(stderr.join("")).toContain("weird non-error");
  });

  function isResult(o: unknown): o is SignInResult {
    return typeof o === "object" && o !== null && "status" in o;
  }

  it("preserves the success email exactly (no normalization)", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: { username: "Ada@EXAMPLE.com", password: "p" } } },
      path: "/x",
    });
    mockedResolveCredentials.mockReturnValue({ email: "Ada@EXAMPLE.com", password: "p" });
    mockedSignIn.mockResolvedValue({ token: "tok" });
    mockedPersistAuthToken.mockResolvedValue(undefined);

    const { stdout } = await invoke("json");
    const parsed: unknown = JSON.parse(stdout.join("").trim());
    if (!isResult(parsed)) throw new Error("expected SignInResult");
    if (parsed.status !== "signed-in") throw new Error("expected signed-in");
    expect(parsed.email).toBe("Ada@EXAMPLE.com");
  });
});
