// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatCrashLog, installCrashHandlers } from "../crash-handlers.js";

const KNOWN_BEARER = "user_abc123def456789012345678_abcdefghij1234567890";

describe("formatCrashLog (issue #207)", () => {
  it("redacts a bearer-shaped substring in the error message", () => {
    const err = new Error(`auth failed for ${KNOWN_BEARER}`);
    const out = formatCrashLog(err, "uncaughtException");
    expect(out).not.toContain(KNOWN_BEARER);
    expect(out).toContain("***REDACTED***");
  });

  it("redacts a bearer-shaped substring in the stack frames", () => {
    // Build a real Error so .stack is populated, then mutate the stack to
    // include a bearer-shaped substring. Real-world reproduction: a thrown
    // error captured in a transport call site where a `Token token=<bearer>`
    // header value is reflected into the message at construction time.
    const err = new Error("transport failed");
    err.stack = [
      "Error: transport failed",
      `  at sendRequest (replayed Authorization: Token token=${KNOWN_BEARER})`,
      "  at /home/me/.ttctl/cli.ts:42:7",
    ].join("\n");
    const out = formatCrashLog(err, "uncaughtException");
    expect(out).not.toContain(KNOWN_BEARER);
    expect(out).toContain("***REDACTED***");
    expect(out).toContain("transport failed");
    expect(out).toContain("/home/me/.ttctl/cli.ts:42:7");
  });

  it("includes the kind discriminator prefix", () => {
    const err = new Error("oops");
    expect(formatCrashLog(err, "uncaughtException")).toContain("[uncaughtException]");
    expect(formatCrashLog(err, "unhandledRejection")).toContain("[unhandledRejection]");
  });

  it("renders the error name and message", () => {
    const err = new TypeError("not a function");
    const out = formatCrashLog(err, "uncaughtException");
    expect(out).toContain("TypeError: not a function");
  });

  it("handles non-Error rejections (string)", () => {
    const out = formatCrashLog(`rejected with ${KNOWN_BEARER}`, "unhandledRejection");
    expect(out).toContain("[unhandledRejection] UnknownError: rejected with ***REDACTED***");
    expect(out).not.toContain(KNOWN_BEARER);
  });

  it("handles non-Error rejections (number, undefined, null)", () => {
    expect(formatCrashLog(42, "unhandledRejection")).toContain("UnknownError: 42");
    expect(formatCrashLog(undefined, "unhandledRejection")).toContain("UnknownError: undefined");
    expect(formatCrashLog(null, "unhandledRejection")).toContain("UnknownError: null");
  });

  it("renders only the head when the Error has no stack (defensive)", () => {
    const err = new Error("no stack here");
    err.stack = undefined;
    const out = formatCrashLog(err, "uncaughtException");
    expect(out).toBe("[uncaughtException] Error: no stack here");
  });

  it("does NOT include process.env values (intentional omission)", () => {
    // The handler is structurally not allowed to dump process.env. We pin
    // this by asserting a sentinel value injected into env via vi.stubEnv
    // does not appear in the output for a benign error.
    vi.stubEnv("TTCTL_CRASH_TEST_SENTINEL", "should-not-leak-XYZZY");
    try {
      const out = formatCrashLog(new Error("benign"), "uncaughtException");
      expect(out).not.toContain("should-not-leak-XYZZY");
      expect(out).not.toContain("TTCTL_CRASH_TEST_SENTINEL");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does NOT include the joined process.argv (intentional omission)", () => {
    // Argv may carry shell-completion fragments or paste-history hints.
    // The handler must not embed the whole arg vector in any crash log.
    const out = formatCrashLog(new Error("benign"), "uncaughtException");
    expect(out).not.toContain(process.argv.join(" "));
  });

  it("AC-bound: crash output excludes a known secret value", () => {
    // Canonical acceptance test for issue #207. A crash path that
    // interpolates the bearer must emit a crash log that does NOT
    // contain the bearer literal anywhere.
    const err = new Error(`signin response: Authorization: Token token=${KNOWN_BEARER}`);
    err.stack = `Error: signin response\n  at /a/b/c.ts (${KNOWN_BEARER})`;
    const out = formatCrashLog(err, "uncaughtException");
    expect(out).not.toContain(KNOWN_BEARER);
  });
});

describe("installCrashHandlers — listener registration", () => {
  // Capture process-level listeners installed by the handler so each test
  // can register, observe, and unregister cleanly. We don't actually fire
  // the events (that would call process.exit and abort the test runner);
  // we register, invoke the listener manually with `process.exit` mocked,
  // and unregister in afterEach.
  //
  // EVERY test in this block calls `installCrashHandlers()`, which adds
  // ONE listener to each of `uncaughtException` and `unhandledRejection`.
  // The afterEach captures the diff between the pre- and post-test
  // listener arrays and removes whatever was added, regardless of which
  // specific listener slot the individual test exercised.

  let preInstallExceptionListeners: ReadonlyArray<(err: Error) => void> = [];
  let preInstallRejectionListeners: ReadonlyArray<(reason: unknown) => void> = [];

  beforeEach(() => {
    preInstallExceptionListeners = [...(process.listeners("uncaughtException") as ((err: Error) => void)[])];
    preInstallRejectionListeners = [...(process.listeners("unhandledRejection") as ((reason: unknown) => void)[])];
  });

  afterEach(() => {
    // Remove any listener that was not present before the test ran. This
    // tolerates installCrashHandlers being called once per test (the
    // expected case) and is robust to a test installing handlers and
    // exercising only one of the two listener slots.
    const currentExceptionListeners = process.listeners("uncaughtException") as ((err: Error) => void)[];
    const currentRejectionListeners = process.listeners("unhandledRejection") as ((reason: unknown) => void)[];
    for (const l of currentExceptionListeners) {
      if (!preInstallExceptionListeners.includes(l)) process.off("uncaughtException", l);
    }
    for (const l of currentRejectionListeners) {
      if (!preInstallRejectionListeners.includes(l)) process.off("unhandledRejection", l);
    }
    expect(process.listenerCount("uncaughtException")).toBe(preInstallExceptionListeners.length);
    expect(process.listenerCount("unhandledRejection")).toBe(preInstallRejectionListeners.length);
  });

  it("registers one listener for each of uncaughtException and unhandledRejection", () => {
    const beforeException = preInstallExceptionListeners.length;
    const beforeRejection = preInstallRejectionListeners.length;

    installCrashHandlers();

    expect(process.listenerCount("uncaughtException")).toBe(beforeException + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeRejection + 1);
  });

  it("the uncaughtException listener writes a redacted log to stderr and exits 1", () => {
    installCrashHandlers();
    const listener = (process.listeners("uncaughtException") as ((err: Error) => void)[])[
      preInstallExceptionListeners.length
    ];
    expect(listener).toBeDefined();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // process.exit's signature returns `never`; we intercept to keep the
      // test runner alive. Throwing here would surface as a test failure
      // rather than a process termination.
      return undefined as never;
    }) as typeof process.exit);

    try {
      (listener as (err: Error) => void)(new Error(`crash with ${KNOWN_BEARER}`));
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const written = stderrSpy.mock.calls[0]?.[0];
      expect(written).toBeDefined();
      const str = typeof written === "string" ? written : (written as Buffer).toString("utf8");
      expect(str).toContain("[uncaughtException]");
      expect(str).toContain("***REDACTED***");
      expect(str).not.toContain(KNOWN_BEARER);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("the unhandledRejection listener writes a redacted log to stderr and exits 1", () => {
    installCrashHandlers();
    const listener = (process.listeners("unhandledRejection") as ((reason: unknown) => void)[])[
      preInstallRejectionListeners.length
    ];
    expect(listener).toBeDefined();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      return undefined as never;
    }) as typeof process.exit);

    try {
      (listener as (reason: unknown) => void)(`rejection containing ${KNOWN_BEARER}`);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const written = stderrSpy.mock.calls[0]?.[0];
      const str = typeof written === "string" ? written : (written as Buffer).toString("utf8");
      expect(str).toContain("[unhandledRejection]");
      expect(str).toContain("***REDACTED***");
      expect(str).not.toContain(KNOWN_BEARER);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
