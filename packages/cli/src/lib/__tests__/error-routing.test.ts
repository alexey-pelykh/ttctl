// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { AuthRevokedError, Cf403Error, Cf403PersistentError, engagements } from "@ttctl/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDomainError } from "../error-routing.js";

interface CapturedStream {
  lines: string[];
}

function captureStdout(): CapturedStream {
  const captured: CapturedStream = { lines: [] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

function captureStderr(): CapturedStream {
  const captured: CapturedStream = { lines: [] };
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

/**
 * Run `fn` while spying on `process.exit`. Asserts the spy was called
 * with `expectedCode`. The spy implementation throws a sentinel error so
 * the rest of `fn` does not execute after a logical exit (mirrors the
 * pattern from `envelopes.test.ts`).
 */
function expectExit(expectedCode: number, fn: () => never): void {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((c?: string | number | null | undefined) => {
    throw new Error(`__EXIT_${c?.toString() ?? "0"}__`);
  }) as unknown as (code?: number) => never);
  try {
    fn();
  } catch (err) {
    expect((err as Error).message).toBe(`__EXIT_${expectedCode.toString()}__`);
    exitSpy.mockRestore();
    return;
  }
  exitSpy.mockRestore();
  throw new Error("handleDomainError did not call process.exit");
}

afterEach(() => {
  vi.restoreAllMocks();
});

// =======================================================================
// TtctlError branch — pretty path delegates to presentTtctlError
// =======================================================================

describe("handleDomainError — TtctlError branch", () => {
  it("pretty: renders the 3-block TtctlError layout on STDERR and exits 1 for AUTH_REVOKED", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    expectExit(1, () =>
      handleDomainError(
        "engagements show",
        new AuthRevokedError("Session is invalid or expired."),
        engagements.EngagementsError,
        "pretty",
      ),
    );
    expect(stdout.lines.join("")).toBe("");
    const stderrJoined = stderr.lines.join("");
    expect(stderrJoined).toContain("Error: Session is invalid or expired.");
    expect(stderrJoined).toContain("Recovery: Run `ttctl auth signin` to re-authenticate.");
    expect(stderrJoined).toContain("(Code: AUTH_REVOKED)");
  });

  it("pretty: exits 2 for CF_403_CLEARANCE (transport-level — matches exitCodeForTtctlError)", () => {
    captureStdout();
    captureStderr();
    expectExit(2, () =>
      handleDomainError(
        "applications list",
        new Cf403Error("talent-profile", "https://example.com/api"),
        engagements.EngagementsError,
        "pretty",
      ),
    );
  });

  it("pretty: exits 2 for CF_403_PERSISTENT (transport-level — matches exitCodeForTtctlError)", () => {
    captureStdout();
    captureStderr();
    expectExit(2, () =>
      handleDomainError(
        "scheduler op",
        new Cf403PersistentError("scheduler", "https://example.com/api"),
        engagements.EngagementsError,
        "pretty",
      ),
    );
  });

  it("json: routes the envelope to STDOUT with hint=recovery and exits 1 for AUTH_REVOKED", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    expectExit(1, () =>
      handleDomainError(
        "engagements show",
        new AuthRevokedError("Session is invalid or expired."),
        engagements.EngagementsError,
        "json",
      ),
    );
    expect(stderr.lines.join("")).toBe("");
    const out = stdout.lines.join("");
    const parsed = JSON.parse(out) as {
      ok: false;
      version: string;
      operation: string;
      errors: { code: string; message: string; hint?: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.operation).toBe("engagements.show");
    expect(parsed.errors[0]?.code).toBe("AUTH_REVOKED");
    expect(parsed.errors[0]?.message).toBe("Session is invalid or expired.");
    expect(parsed.errors[0]?.hint).toBe("Run `ttctl auth signin` to re-authenticate.");
  });

  it("json: exits 2 for CF_403_CLEARANCE", () => {
    captureStdout();
    expectExit(2, () =>
      handleDomainError(
        "engagements list",
        new Cf403Error("talent-profile", "https://example.com/api"),
        engagements.EngagementsError,
        "json",
      ),
    );
  });

  it("yaml: routes the envelope to STDOUT for TtctlError", () => {
    const stdout = captureStdout();
    expectExit(1, () =>
      handleDomainError(
        "engagements show",
        new AuthRevokedError("Bearer revoked."),
        engagements.EngagementsError,
        "yaml",
      ),
    );
    const out = stdout.lines.join("");
    expect(out).toContain("ok: false");
    expect(out).toContain("operation: engagements.show");
    expect(out).toContain("code: AUTH_REVOKED");
  });
});

// =======================================================================
// Domain-error branch — with and without hint adapter
// =======================================================================

describe("handleDomainError — domain-error branch", () => {
  it("json: routes envelope to STDOUT (no hint adapter — entry is just code+message)", () => {
    const stdout = captureStdout();
    expectExit(1, () =>
      handleDomainError(
        "applications show",
        new engagements.EngagementsError("NOT_FOUND", "Engagement not found."),
        engagements.EngagementsError,
        "json",
      ),
    );
    const parsed = JSON.parse(stdout.lines.join("")) as {
      ok: false;
      operation: string;
      errors: { code: string; message: string; hint?: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.operation).toBe("applications.show");
    expect(parsed.errors[0]?.code).toBe("NOT_FOUND");
    expect(parsed.errors[0]?.message).toBe("Engagement not found.");
    expect(parsed.errors[0]?.hint).toBeUndefined();
  });

  it("json: includes hint when the adapter returns a string for the given code", () => {
    const stdout = captureStdout();
    const hintForCode = (code: engagements.EngagementsErrorCode): string | undefined =>
      code === "NOT_FOUND" ? "Run `ttctl engagements list` to discover ids." : undefined;
    expectExit(1, () =>
      handleDomainError(
        "engagements show",
        new engagements.EngagementsError("NOT_FOUND", "Engagement not found."),
        engagements.EngagementsError,
        "json",
        hintForCode,
      ),
    );
    const parsed = JSON.parse(stdout.lines.join("")) as {
      errors: { code: string; hint?: string }[];
    };
    expect(parsed.errors[0]?.hint).toBe("Run `ttctl engagements list` to discover ids.");
  });

  it("json: omits hint when the adapter returns undefined (default-branch code)", () => {
    const stdout = captureStdout();
    const hintForCode = (code: engagements.EngagementsErrorCode): string | undefined =>
      code === "NOT_FOUND" ? "hint for NOT_FOUND" : undefined;
    expectExit(1, () =>
      handleDomainError(
        "engagements show",
        new engagements.EngagementsError("NETWORK_ERROR", "Network blew up."),
        engagements.EngagementsError,
        "json",
        hintForCode,
      ),
    );
    const parsed = JSON.parse(stdout.lines.join("")) as {
      errors: { code: string; hint?: string }[];
    };
    expect(parsed.errors[0]?.code).toBe("NETWORK_ERROR");
    expect(parsed.errors[0]?.hint).toBeUndefined();
  });

  it("pretty: routes the multi-line block to STDERR with the caller's commandLabel summary", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    expectExit(1, () =>
      handleDomainError(
        "engagements show",
        new engagements.EngagementsError("NOT_FOUND", "Engagement not found."),
        engagements.EngagementsError,
        "pretty",
      ),
    );
    expect(stdout.lines.join("")).toBe("");
    const stderrJoined = stderr.lines.join("");
    expect(stderrJoined).toContain("engagements show failed (NOT_FOUND): Engagement not found.");
    expect(stderrJoined).toContain("Error: Engagement not found.");
    expect(stderrJoined).toContain("(Code: NOT_FOUND)");
  });
});

// =======================================================================
// Catch-all branch — INTERNAL_ERROR
// =======================================================================

describe("handleDomainError — catch-all branch", () => {
  it("json: collapses a plain Error into an INTERNAL_ERROR envelope (uses err.message)", () => {
    const stdout = captureStdout();
    expectExit(1, () =>
      handleDomainError("engagements show", new Error("kaboom"), engagements.EngagementsError, "json"),
    );
    const parsed = JSON.parse(stdout.lines.join("")) as {
      ok: false;
      operation: string;
      errors: { code: string; message: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.operation).toBe("engagements.show");
    expect(parsed.errors[0]?.code).toBe("INTERNAL_ERROR");
    expect(parsed.errors[0]?.message).toBe("kaboom");
  });

  it("json: stringifies a non-Error throw into INTERNAL_ERROR.message", () => {
    const stdout = captureStdout();
    expectExit(1, () =>
      handleDomainError("engagements show", "raw-string-throw", engagements.EngagementsError, "json"),
    );
    const parsed = JSON.parse(stdout.lines.join("")) as {
      errors: { code: string; message: string }[];
    };
    expect(parsed.errors[0]?.code).toBe("INTERNAL_ERROR");
    expect(parsed.errors[0]?.message).toBe("raw-string-throw");
  });

  it("pretty: emits `<commandLabel> failed: <message>` summary on STDERR", () => {
    captureStdout();
    const stderr = captureStderr();
    expectExit(1, () =>
      handleDomainError("engagements show", new Error("kaboom"), engagements.EngagementsError, "pretty"),
    );
    const stderrJoined = stderr.lines.join("");
    expect(stderrJoined).toContain("engagements show failed: kaboom");
    expect(stderrJoined).toContain("(Code: INTERNAL_ERROR)");
  });
});

// =======================================================================
// Operation derivation — commandLabel spaces → dots
// =======================================================================

describe("handleDomainError — operation derivation", () => {
  it("converts spaces in commandLabel to dots in envelope.operation", () => {
    const stdout = captureStdout();
    expectExit(1, () =>
      handleDomainError(
        "profile industries autocomplete",
        new engagements.EngagementsError("UNKNOWN", "msg"),
        engagements.EngagementsError,
        "json",
      ),
    );
    const parsed = JSON.parse(stdout.lines.join("")) as { operation: string };
    expect(parsed.operation).toBe("profile.industries.autocomplete");
  });
});
