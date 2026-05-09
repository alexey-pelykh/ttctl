// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Shared cancel sentinel used across the @clack/prompts mock. clack
 * exposes its own `Symbol.for("clack:cancel")` value at runtime; the
 * mock needs to expose an equivalent the tests can reference and
 * `isCancel()` can check via reference equality.
 */
const CLACK_CANCEL = Symbol.for("clack:cancel");

vi.mock("@clack/prompts", () => {
  // The mock is a thin queue-driven stub: tests push expected results
  // into per-prompt-type queues, and each call to `select` / `text` /
  // `password` / `confirm` shifts one. `isCancel` checks against the
  // module-private cancel symbol so a queued value of the symbol is
  // treated as a cancellation.
  const queues = {
    select: [] as unknown[],
    text: [] as unknown[],
    password: [] as unknown[],
    confirm: [] as unknown[],
  };
  const log: { info: string[]; warn: string[]; success: string[]; step: string[] } = {
    info: [],
    warn: [],
    success: [],
    step: [],
  };
  const cancels: string[] = [];
  const intros: string[] = [];
  const outros: string[] = [];

  return {
    select: vi.fn(async () => {
      if (queues.select.length === 0) throw new Error("clack mock: select queue empty");
      return queues.select.shift();
    }),
    text: vi.fn(async () => {
      if (queues.text.length === 0) throw new Error("clack mock: text queue empty");
      return queues.text.shift();
    }),
    password: vi.fn(async () => {
      if (queues.password.length === 0) throw new Error("clack mock: password queue empty");
      return queues.password.shift();
    }),
    confirm: vi.fn(async () => {
      if (queues.confirm.length === 0) throw new Error("clack mock: confirm queue empty");
      return queues.confirm.shift();
    }),
    isCancel: (value: unknown) => value === CLACK_CANCEL,
    log: {
      info: (msg: string) => log.info.push(msg),
      warn: (msg: string) => log.warn.push(msg),
      success: (msg: string) => log.success.push(msg),
      step: (msg: string) => log.step.push(msg),
    },
    cancel: (msg?: string) => cancels.push(msg ?? ""),
    intro: (msg?: string) => intros.push(msg ?? ""),
    outro: (msg?: string) => outros.push(msg ?? ""),
    // Test-only handles for queue setup + log inspection. Imported in
    // the test body via the same module specifier.
    __test__: { queues, log, cancels, intros, outros },
  };
});

import * as clack from "@clack/prompts";

import {
  exitCodeForInitResult,
  formatInitOutput,
  isStdinTty,
  runAuthInit,
} from "../commands/auth/init.js";
import type { AuthInitResult, OpCliInterface } from "../commands/auth/init.js";

interface ClackTestHandles {
  queues: {
    select: unknown[];
    text: unknown[];
    password: unknown[];
    confirm: unknown[];
  };
  log: { info: string[]; warn: string[]; success: string[]; step: string[] };
  cancels: string[];
  intros: string[];
  outros: string[];
}

const clackHandles = (clack as unknown as { __test__: ClackTestHandles }).__test__;

function resetClackQueues(): void {
  clackHandles.queues.select.length = 0;
  clackHandles.queues.text.length = 0;
  clackHandles.queues.password.length = 0;
  clackHandles.queues.confirm.length = 0;
  clackHandles.log.info.length = 0;
  clackHandles.log.warn.length = 0;
  clackHandles.log.success.length = 0;
  clackHandles.log.step.length = 0;
  clackHandles.cancels.length = 0;
  clackHandles.intros.length = 0;
  clackHandles.outros.length = 0;
}

/**
 * Builder for an in-memory `OpCliInterface` stub used by `runAuthInit`.
 * Tests customize per-method behavior; the default returns a small
 * representative listing.
 */
function buildOpCli(overrides: Partial<OpCliInterface> = {}): OpCliInterface {
  return {
    detect: overrides.detect ?? (() => true),
    listVaults: overrides.listVaults ?? (() => [{ id: "v1", name: "Personal" }]),
    listItems: overrides.listItems ?? (() => [{ id: "i1", title: "ttctl" }]),
  };
}

describe("formatInitOutput", () => {
  it("renders written/A as the form-A confirmation line", () => {
    expect(formatInitOutput({ status: "written", path: "/tmp/x.yaml", form: "A" })).toBe(
      "Wrote config to /tmp/x.yaml (form A: 1Password reference)",
    );
  });
  it("renders written/B as the form-B confirmation line", () => {
    expect(formatInitOutput({ status: "written", path: "/tmp/x.yaml", form: "B" })).toBe(
      "Wrote config to /tmp/x.yaml (form B: literal credentials)",
    );
  });
  it("passes through refusal/error messages verbatim", () => {
    expect(
      formatInitOutput({ status: "refused", reason: "non-tty", message: "tty required" }),
    ).toBe("tty required");
    expect(formatInitOutput({ status: "error", message: "boom" })).toBe("boom");
  });
});

describe("exitCodeForInitResult", () => {
  it("returns 0 for written", () => {
    expect(exitCodeForInitResult({ status: "written", path: "/x", form: "A" })).toBe(0);
  });
  it("returns 1 for refused", () => {
    expect(
      exitCodeForInitResult({ status: "refused", reason: "non-tty", message: "" }),
    ).toBe(1);
    expect(
      exitCodeForInitResult({ status: "refused", reason: "exists", message: "" }),
    ).toBe(1);
    expect(
      exitCodeForInitResult({ status: "refused", reason: "cancelled", message: "" }),
    ).toBe(1);
  });
  it("returns 1 for error", () => {
    expect(exitCodeForInitResult({ status: "error", message: "boom" })).toBe(1);
  });
});

describe("isStdinTty", () => {
  it("reflects process.stdin.isTTY === true", () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    expect(isStdinTty()).toBe(true);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: original });
  });
  it("reflects process.stdin.isTTY === undefined/false", () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    expect(isStdinTty()).toBe(false);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: undefined });
    expect(isStdinTty()).toBe(false);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: original });
  });
});

describe("runAuthInit", () => {
  let tmpDir: string;
  let configPath: string;
  let originalIsTty: unknown;

  beforeEach(() => {
    resetClackQueues();
    tmpDir = mkdtempSync(join(tmpdir(), "ttctl-init-test-"));
    configPath = join(tmpDir, "fresh.yaml");
    originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
    vi.restoreAllMocks();
  });

  /**
   * Helper that asserts an outcome and exposes the file content + mode
   * so tests don't repeat the file-shape boilerplate.
   */
  function readConfig(path: string): { content: string; mode: number } {
    const content = readFileSync(path, "utf8");
    const mode = statSync(path).mode & 0o777;
    return { content, mode };
  }

  it("Form A op-CLI present: vault → item → confirm → writes form-A YAML at 0o600", async () => {
    clackHandles.queues.select.push("A"); // form selector
    clackHandles.queues.select.push("Personal"); // vault picker
    clackHandles.queues.select.push("ttctl"); // item picker
    clackHandles.queues.confirm.push(true); // final confirm

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result).toEqual({ status: "written", path: configPath, form: "A" });
    const { content, mode } = readConfig(configPath);
    expect(content).toBe('auth:\n  credentials: "op://Personal/ttctl"\n');
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
    expect(clackHandles.outros).toContainEqual(expect.stringContaining("(form A: 1Password reference)"));
  });

  it("Form A op-CLI absent: freeform op:// reference path → writes form-A YAML", async () => {
    clackHandles.queues.select.push("A"); // form selector
    clackHandles.queues.text.push("op://Custom/myitem"); // freeform input

    const opCli = buildOpCli({ detect: () => false });
    const result = await runAuthInit({ config: configPath }, opCli);

    expect(result.status).toBe("written");
    expect(readConfig(configPath).content).toBe('auth:\n  credentials: "op://Custom/myitem"\n');
    // Fallback message surfaced via clack.log.info.
    expect(clackHandles.log.info.some((m) => m.includes("not installed"))).toBe(true);
  });

  it("Form A: listVaults throws → freeform fallback with stderr-style warning", async () => {
    clackHandles.queues.select.push("A");
    clackHandles.queues.text.push("op://X/Y");

    const opCli = buildOpCli({
      listVaults: () => {
        throw new Error("zod schema mismatch");
      },
    });
    const result = await runAuthInit({ config: configPath }, opCli);

    expect(result.status).toBe("written");
    expect(clackHandles.log.warn.some((m) => m.includes("op vault list failed"))).toBe(true);
  });

  it("Form A: listVaults empty → freeform fallback", async () => {
    clackHandles.queues.select.push("A");
    clackHandles.queues.text.push("op://X/Y");

    const opCli = buildOpCli({ listVaults: () => [] });
    const result = await runAuthInit({ config: configPath }, opCli);

    expect(result.status).toBe("written");
    expect(clackHandles.log.warn.some((m) => m.includes("no vaults"))).toBe(true);
  });

  it("Form A: listItems empty → freeform fallback", async () => {
    clackHandles.queues.select.push("A"); // form
    clackHandles.queues.select.push("Personal"); // vault
    clackHandles.queues.text.push("op://X/Y"); // freeform fallback

    const opCli = buildOpCli({ listItems: () => [] });
    const result = await runAuthInit({ config: configPath }, opCli);

    expect(result.status).toBe("written");
    expect(clackHandles.log.warn.some((m) => m.includes("LOGIN-category"))).toBe(true);
  });

  it("Form A: user declines confirm → cancelled (no file written)", async () => {
    clackHandles.queues.select.push("A");
    clackHandles.queues.select.push("Personal");
    clackHandles.queues.select.push("ttctl");
    clackHandles.queues.confirm.push(false); // declines

    const result = await runAuthInit({ config: configPath }, buildOpCli());
    expect(result).toEqual({
      status: "refused",
      reason: "cancelled",
      message: expect.stringContaining("Aborted"),
    });
    expect(existsSync(configPath)).toBe(false);
  });

  it("Form B confirm-N (default): aborts cleanly with no file written", async () => {
    clackHandles.queues.select.push("B");
    clackHandles.queues.confirm.push(false); // user picks N

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result).toEqual({
      status: "refused",
      reason: "cancelled",
      message: expect.stringContaining("Aborted"),
    });
    expect(existsSync(configPath)).toBe(false);
  });

  it("Form B confirm-Y: prompts username + password, writes form-B YAML", async () => {
    clackHandles.queues.select.push("B");
    clackHandles.queues.confirm.push(true); // proceed
    clackHandles.queues.text.push("ada@example.com");
    clackHandles.queues.password.push("hunter2");

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result).toEqual({ status: "written", path: configPath, form: "B" });
    const { content, mode } = readConfig(configPath);
    expect(content).toBe('auth:\n  credentials:\n    username: "ada@example.com"\n    password: "hunter2"\n');
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("Form B: password-with-quotes is escaped in YAML output", async () => {
    clackHandles.queues.select.push("B");
    clackHandles.queues.confirm.push(true);
    clackHandles.queues.text.push("ada@example.com");
    clackHandles.queues.password.push('quote"with\\backslash');

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result.status).toBe("written");
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain('password: "quote\\"with\\\\backslash"');
  });

  it("refuses to overwrite without --force BEFORE any prompt; existing file untouched", async () => {
    writeFileSync(configPath, "existing: content\n", { mode: 0o600 });
    // Deliberately do NOT push any clack queue items. The early
    // existence gate must fire BEFORE any prompt — pushing items here
    // would mask a regression where the gate moved past the form
    // selector.

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("exists");
      expect(result.message).toContain(configPath);
      expect(result.message).toContain("--force");
    }
    expect(readFileSync(configPath, "utf8")).toBe("existing: content\n");
    // Crucially: the form selector was NEVER reached. clack's intro/select
    // counters stay at zero.
    expect(clackHandles.intros.length).toBe(0);
  });

  it("--force overwrites atomically with fresh content + 0o600", async () => {
    writeFileSync(configPath, "existing: content\n", { mode: 0o644 });
    clackHandles.queues.select.push("A");
    clackHandles.queues.select.push("Personal");
    clackHandles.queues.select.push("ttctl");
    clackHandles.queues.confirm.push(true);

    const result = await runAuthInit({ config: configPath, force: true }, buildOpCli());

    expect(result.status).toBe("written");
    const { content, mode } = readConfig(configPath);
    expect(content).toBe('auth:\n  credentials: "op://Personal/ttctl"\n');
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("non-TTY refuses cleanly BEFORE any prompt runs", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("non-tty");
      expect(result.message).toContain("interactive");
    }
    // Crucially: no prompt was consumed.
    expect(clackHandles.queues.select.length + clackHandles.queues.text.length).toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });

  it("--config <path> with non-existent parent dir creates the parent", async () => {
    const nestedDir = join(tmpDir, "nested", "deep");
    const nestedPath = join(nestedDir, "config.yaml");
    expect(existsSync(nestedDir)).toBe(false);

    clackHandles.queues.select.push("A");
    clackHandles.queues.select.push("Personal");
    clackHandles.queues.select.push("ttctl");
    clackHandles.queues.confirm.push(true);

    const result = await runAuthInit({ config: nestedPath }, buildOpCli());

    expect(result.status).toBe("written");
    expect(existsSync(nestedDir)).toBe(true);
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("cancellation at form selector returns cancelled (no file)", async () => {
    clackHandles.queues.select.push(CLACK_CANCEL);

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toBe("cancelled");
    expect(existsSync(configPath)).toBe(false);
  });

  it("cancellation at vault picker returns cancelled (no file)", async () => {
    clackHandles.queues.select.push("A"); // form
    clackHandles.queues.select.push(CLACK_CANCEL); // vault

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toBe("cancelled");
  });

  it("cancellation at password prompt returns cancelled (Form B)", async () => {
    clackHandles.queues.select.push("B");
    clackHandles.queues.confirm.push(true);
    clackHandles.queues.text.push("ada@example.com");
    clackHandles.queues.password.push(CLACK_CANCEL);

    const result = await runAuthInit({ config: configPath }, buildOpCli());

    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toBe("cancelled");
    expect(existsSync(configPath)).toBe(false);
  });

  it("Form A success: emitted YAML is parseable and conforms to ConfigLoadSchema", async () => {
    // writeNewConfig validates against ConfigLoadSchema before writing —
    // a malformed Form-A YAML would have caused this test to throw, so
    // its successful completion implicitly proves the validation passes.
    clackHandles.queues.select.push("A");
    clackHandles.queues.select.push("Personal");
    clackHandles.queues.select.push("ttctl");
    clackHandles.queues.confirm.push(true);

    const result: AuthInitResult = await runAuthInit({ config: configPath }, buildOpCli());
    expect(result.status).toBe("written");
  });
});
