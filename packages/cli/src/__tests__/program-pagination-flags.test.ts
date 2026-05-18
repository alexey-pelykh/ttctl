// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mocks mirror `program-diagnostic-flags.test.ts` — every transitive
 * import resolves to a `vi.fn()` so the parse path runs in isolation.
 * Since action handlers exit before any service call, the mocks just
 * need to be valid no-op replacements for the imports.
 */
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    resolveConfig: vi.fn(),
    getAuthStatus: vi.fn(),
    setDiagnosticLogger: vi.fn(),
  };
});

import { getAuthStatus, resolveConfig } from "@ttctl/core";

import { resetCliConfigPath } from "../lib/config-context.js";
import { resetCliDryRun } from "../lib/dry-run.js";
import { buildProgram } from "../program.js";

const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedGetAuthStatus = vi.mocked(getAuthStatus);

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

function captureExit(): { exit: { code: number } | null } {
  const captured: { exit: { code: number } | null } = { exit: null };
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exit = { code: code ?? 0 };
    throw new ExitInvoked(code ?? 0);
  }) as never);
  return captured;
}

function captureStderr(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

function captureStdout(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

describe("--page / --per-page per-command flags (issues #138, #183)", () => {
  let tmpDir: string;
  let fixturePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ttctl-test-"));
    fixturePath = join(tmpDir, "config.yaml");
    writeFileSync(fixturePath, "auth:\n  credentials: 'op://Personal/ttctl'\n");

    resetCliConfigPath();
    resetCliDryRun();

    mockedResolveConfig.mockReset();
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: fixturePath,
    });
    mockedGetAuthStatus.mockReset();
    mockedGetAuthStatus.mockResolvedValue({ status: "invalid", reason: "no-session" });

    delete process.env["TTCTL_CONFIG_FILE"];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    resetCliConfigPath();
    resetCliDryRun();
  });

  // -------------------------------------------------------------------
  // Help visibility — flags appear on each paginating leaf, NOT on root
  // -------------------------------------------------------------------

  it("--page does NOT appear in the root program help (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--help"], { from: "user" });
    } catch {
      // commander.help() throws via exitOverride
    }
    const helpText = stdout.lines.join("");
    // Verify --page is NOT in the global option list (matches a help
    // line beginning with the option name, not a description-text
    // occurrence).
    expect(helpText).not.toMatch(/^\s+--page\b/m);
    expect(helpText).not.toMatch(/^\s+--per-page\b/m);
  });

  it("--page DOES appear in `jobs list --help` (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "list", "--help"], { from: "user" });
    } catch {
      // expected
    }
    const helpText = stdout.lines.join("");
    expect(helpText).toMatch(/--page <number>/);
    expect(helpText).toMatch(/--per-page <number>/);
  });

  it("--page DOES appear in `jobs saved --help` (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "saved", "--help"], { from: "user" });
    } catch {
      // expected
    }
    const helpText = stdout.lines.join("");
    expect(helpText).toMatch(/--page <number>/);
    expect(helpText).toMatch(/--per-page <number>/);
  });

  it("--page DOES appear in `jobs viewed --help` (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "viewed", "--help"], { from: "user" });
    } catch {
      // expected
    }
    const helpText = stdout.lines.join("");
    expect(helpText).toMatch(/--page <number>/);
    expect(helpText).toMatch(/--per-page <number>/);
  });

  it("--page DOES appear in `jobs not-interested-list --help` (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "not-interested-list", "--help"], { from: "user" });
    } catch {
      // expected
    }
    const helpText = stdout.lines.join("");
    expect(helpText).toMatch(/--page <number>/);
    expect(helpText).toMatch(/--per-page <number>/);
  });

  it("--page DOES appear in `timesheet list --help` (#374)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["timesheet", "list", "--help"], { from: "user" });
    } catch {
      // expected
    }
    const helpText = stdout.lines.join("");
    expect(helpText).toMatch(/--page <number>/);
    expect(helpText).toMatch(/--per-page <number>/);
  });

  it("--page does NOT appear on `timesheet show` / `timesheet submit` (#374 — list-only leaf)", async () => {
    for (const leaf of [
      ["timesheet", "show", "--help"],
      ["timesheet", "submit", "--help"],
    ]) {
      const program = buildProgram();
      program.exitOverride();
      const stdout = captureStdout();
      captureStderr();
      captureExit();
      try {
        await program.parseAsync(leaf, { from: "user" });
      } catch {
        // expected (help throws under exitOverride)
      }
      const helpText = stdout.lines.join("");
      expect(helpText).not.toMatch(/--page <number>/);
      expect(helpText).not.toMatch(/--per-page <number>/);
    }
  });

  // -------------------------------------------------------------------
  // Parser: positive-integer enforcement on the leaves themselves
  // -------------------------------------------------------------------

  it("--page 0 is rejected on `jobs list` (must be ≥ 1)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "list", "--page", "0"], { from: "user" });
    } catch {
      // Commander exits via exitOverride on InvalidArgumentError
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page must be a positive integer");
  });

  it("--per-page 1.5 is rejected on `jobs list` (must be Int)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "list", "--per-page", "1.5"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--per-page must be a positive integer");
  });

  it("--page -1 is rejected on `jobs saved` (must be positive)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "saved", "--page", "-1"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page must be a positive integer");
  });

  it("--page abc is rejected on `jobs viewed` (non-numeric)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["jobs", "viewed", "--page", "abc"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page must be a positive integer");
  });

  it("--per-page 0 is rejected on `timesheet list` (must be ≥ 1) (#374)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["timesheet", "list", "--per-page", "0"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--per-page must be a positive integer");
  });

  it("--page abc is rejected on `timesheet list` (non-numeric) (#374)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["timesheet", "list", "--page", "abc"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toContain("--page must be a positive integer");
  });

  // -------------------------------------------------------------------
  // Commander's standard "unknown option" fires on non-paginated leaves
  // -------------------------------------------------------------------

  it("--page on `applications list` fails with Commander's standard error (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["applications", "list", "--page", "2"], { from: "user" });
    } catch {
      // expected — Commander's parser throws via exitOverride
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toMatch(/error: unknown option '--page'/);
  });

  it("--per-page on `engagements list` fails with Commander's standard error (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["engagements", "list", "--per-page", "10"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toMatch(/error: unknown option '--per-page'/);
  });

  it("--page on `auth status` fails with Commander's standard error (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["auth", "status", "--page", "1"], { from: "user" });
    } catch {
      // expected
    }
    const errOut = stderr.lines.join("");
    expect(errOut).toMatch(/error: unknown option '--page'/);
  });

  // -------------------------------------------------------------------
  // Propagation: leaf's parsed options carry the page/perPage values
  // -------------------------------------------------------------------

  it("--page 2 on `jobs list` is accepted (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();

    // Find the `jobs list` leaf — Commander's `commands` is the
    // public reflection over registered subcommands.
    const jobs = program.commands.find((c) => c.name() === "jobs");
    expect(jobs).toBeDefined();
    const list = jobs?.commands.find((c) => c.name() === "list");
    expect(list).toBeDefined();
    if (!list) return;

    try {
      await program.parseAsync(["jobs", "list", "--page", "2"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    const opts = list.opts<{ page?: number; perPage?: number }>();
    expect(opts.page).toBe(2);
    expect(opts.perPage).toBeUndefined();
  });

  it("--per-page 5 on `jobs saved` is accepted (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();

    const jobs = program.commands.find((c) => c.name() === "jobs");
    const saved = jobs?.commands.find((c) => c.name() === "saved");
    expect(saved).toBeDefined();
    if (!saved) return;

    try {
      await program.parseAsync(["jobs", "saved", "--per-page", "5"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    const opts = saved.opts<{ page?: number; perPage?: number }>();
    expect(opts.page).toBeUndefined();
    expect(opts.perPage).toBe(5);
  });

  it("--page 3 --per-page 10 on `jobs viewed` carries both (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();

    const jobs = program.commands.find((c) => c.name() === "jobs");
    const viewed = jobs?.commands.find((c) => c.name() === "viewed");
    expect(viewed).toBeDefined();
    if (!viewed) return;

    try {
      await program.parseAsync(["jobs", "viewed", "--page", "3", "--per-page", "10"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    const opts = viewed.opts<{ page?: number; perPage?: number }>();
    expect(opts.page).toBe(3);
    expect(opts.perPage).toBe(10);
  });

  it("--page 4 on `jobs not-interested-list` is accepted (#183)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();

    const jobs = program.commands.find((c) => c.name() === "jobs");
    const nil = jobs?.commands.find((c) => c.name() === "not-interested-list");
    expect(nil).toBeDefined();
    if (!nil) return;

    try {
      await program.parseAsync(["jobs", "not-interested-list", "--page", "4"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    const opts = nil.opts<{ page?: number; perPage?: number }>();
    expect(opts.page).toBe(4);
  });
});
