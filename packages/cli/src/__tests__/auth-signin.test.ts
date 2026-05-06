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
    createCookieJar: vi.fn(() => ({})),
    discoverCookieJarPath: vi.fn(() => "/tmp/test-jar"),
    resolveConfig: vi.fn(),
    resolveCredentials: vi.fn(),
    saveCookieJar: vi.fn(),
    signIn: vi.fn(),
  };
});

import {
  ConfigError,
  OnePasswordError,
  SignInError,
  createCookieJar,
  discoverCookieJarPath,
  resolveConfig,
  resolveCredentials,
  saveCookieJar,
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
const mockedSaveCookieJar = vi.mocked(saveCookieJar);
const mockedDiscoverPath = vi.mocked(discoverCookieJarPath);
const mockedCreateJar = vi.mocked(createCookieJar);

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

  it("returns 1 for CONFIG_ERROR", () => {
    expect(exitCodeForSignInResult({ status: "error", code: "CONFIG_ERROR", message: "bad yaml" })).toBe(1);
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
    mockedSaveCookieJar.mockReset();
    mockedDiscoverPath.mockReset();
    mockedCreateJar.mockReset();
    mockedDiscoverPath.mockReturnValue("/tmp/test-jar");
    mockedCreateJar.mockReturnValue({} as never);
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

  it("happy path: config → resolve → signIn → saveCookieJar → exit 0 + confirmation on stdout", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue(undefined);
    mockedSaveCookieJar.mockResolvedValue(undefined);

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toBe("Signed in as ada@example.com\n");
    expect(stderr.join("")).toBe("");
    // Sequencing: createJar → signIn called with creds + jar → save with discovered path + same jar
    expect(mockedCreateJar).toHaveBeenCalledTimes(1);
    expect(mockedSignIn).toHaveBeenCalledTimes(1);
    expect(mockedSaveCookieJar).toHaveBeenCalledTimes(1);
    expect(mockedSaveCookieJar.mock.calls[0]?.[0]).toBe("/tmp/test-jar");
  });

  it("happy path JSON: emits {status:signed-in, email} on stdout", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue(undefined);
    mockedSaveCookieJar.mockResolvedValue(undefined);

    const { stdout, exitCode } = await invoke("json");

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join("").trim())).toEqual({ status: "signed-in", email: "ada@example.com" });
  });

  it("ConfigError → exit 1, error to stderr (with hint preserved verbatim)", async () => {
    mockedResolveConfig.mockImplementation(() => {
      throw new ConfigError("No .ttctl.yaml found in CWD or $XDG_CONFIG_HOME/ttctl/config.yaml. See README for setup.");
    });

    const { stdout, stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toBe(
      "Sign-in failed (CONFIG_ERROR): No .ttctl.yaml found in CWD or $XDG_CONFIG_HOME/ttctl/config.yaml. See README for setup.\n",
    );
    // Should NOT proceed past config resolution
    expect(mockedResolveCredentials).not.toHaveBeenCalled();
    expect(mockedSignIn).not.toHaveBeenCalled();
    expect(mockedSaveCookieJar).not.toHaveBeenCalled();
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
    mockedResolveCredentials.mockImplementation(() => {
      throw new OnePasswordError("Item Personal/ttctl must have both 'username' and 'password' fields populated.");
    });

    const { stderr, exitCode } = await invoke("json");

    expect(exitCode).toBe(1);
    const parsed: unknown = JSON.parse(stderr.join("").trim());
    expect(parsed).toEqual({
      status: "error",
      code: "ONEPASSWORD_ERROR",
      message: "Item Personal/ttctl must have both 'username' and 'password' fields populated.",
    });
  });

  it("SignInError(INVALID_CREDENTIALS) → exit 1", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "wrong" });
    mockedSignIn.mockRejectedValue(new SignInError("INVALID_CREDENTIALS", "Invalid email or password"));

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toBe("Sign-in failed (INVALID_CREDENTIALS): Invalid email or password\n");
    expect(mockedSaveCookieJar).not.toHaveBeenCalled();
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

  it("saveCookieJar failure → exit 1 with SAVE_FAILED code and path mentioned", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: "op://Personal/ttctl" }, path: "/cwd/.ttctl.yaml" });
    mockedResolveCredentials.mockReturnValue({ email: "ada@example.com", password: "hunter2" });
    mockedSignIn.mockResolvedValue(undefined);
    mockedDiscoverPath.mockReturnValue("/home/u/.ttctl/session.cookies");
    mockedSaveCookieJar.mockRejectedValue(new Error("EACCES: permission denied"));

    const { stderr, exitCode } = await invoke("table");

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("SAVE_FAILED");
    expect(stderr.join("")).toContain("/home/u/.ttctl/session.cookies");
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

  it("uses createCookieJar (not loadCookieJar) → fresh empty jar so stale cookies cannot shadow new session", async () => {
    mockedResolveConfig.mockReturnValue({
      config: { auth: { email: "a@b.c", password: "p" } },
      path: "/cwd/.ttctl.yaml",
    });
    mockedResolveCredentials.mockReturnValue({ email: "a@b.c", password: "p" });
    mockedSignIn.mockResolvedValue(undefined);
    mockedSaveCookieJar.mockResolvedValue(undefined);

    await invoke("table");

    expect(mockedCreateJar).toHaveBeenCalledTimes(1);
    // The jar created is the same one passed to signIn and saveCookieJar
    const jar = mockedCreateJar.mock.results[0]?.value as unknown;
    expect(mockedSignIn.mock.calls[0]?.[1]).toBe(jar);
    expect(mockedSaveCookieJar.mock.calls[0]?.[1]).toBe(jar);
  });

  function isResult(o: unknown): o is SignInResult {
    return typeof o === "object" && o !== null && "status" in o;
  }

  it("preserves the success email exactly (no normalization, no email from elsewhere)", async () => {
    mockedResolveConfig.mockReturnValue({ config: { auth: { email: "Ada@EXAMPLE.com", password: "p" } }, path: "/x" });
    mockedResolveCredentials.mockReturnValue({ email: "Ada@EXAMPLE.com", password: "p" });
    mockedSignIn.mockResolvedValue(undefined);
    mockedSaveCookieJar.mockResolvedValue(undefined);

    const { stdout } = await invoke("json");
    const parsed: unknown = JSON.parse(stdout.join("").trim());
    if (!isResult(parsed)) throw new Error("expected SignInResult");
    if (parsed.status !== "signed-in") throw new Error("expected signed-in");
    expect(parsed.email).toBe("Ada@EXAMPLE.com");
  });
});
