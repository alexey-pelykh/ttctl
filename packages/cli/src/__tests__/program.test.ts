// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: re-export everything from real `@ttctl/core` (so the program
// module's transitive imports across every sub-command file resolve
// correctly) and override only the entry points the tests need to spy on.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    resolveConfig: vi.fn(),
    getAuthStatus: vi.fn(),
  };
});

import { resolveConfig, getAuthStatus } from "@ttctl/core";

import { getCliConfigPath, resetCliConfigPath } from "../lib/config-context.js";
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

/**
 * Tests for the `--config <path>` global option (issue #93).
 *
 * Exercises the program at the surface where Commander parses argv,
 * fires `preAction` hooks, captures the path into the module-scoped
 * `cliConfigPath` holder, and routes it through `resolveConfigForCli`
 * into the mocked core resolver.
 *
 * Two layers of verification per AC bullet:
 *   1. State capture: `getCliConfigPath()` returns the right value after
 *      the preAction hook fires.
 *   2. Plumbing: `resolveConfig` (from the mocked core) was called with
 *      the corresponding `{ path }` argument when an action ran.
 */
describe("program --config flag", () => {
  let tmpDir: string;
  let fixturePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ttctl-test-"));
    fixturePath = join(tmpDir, "config.yaml");
    writeFileSync(fixturePath, "auth:\n  credentials: 'op://Personal/ttctl'\n");

    // Reset module-scoped state between tests to keep them independent.
    resetCliConfigPath();

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
    delete process.env["TTCTL_CONFIG_FILE"];
    vi.restoreAllMocks();
    resetCliConfigPath();
  });

  it("--config <abs-path> captures the path into the module-scoped holder via preAction", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    const exit = captureExit();
    try {
      await program.parseAsync(["--config", fixturePath, "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(exit.exit?.code).toBe(1); // auth status with no token → invalid/no-session, exit 1
    expect(getCliConfigPath()).toBe(fixturePath);
  });

  it("--config <abs-path> threads through to resolveConfig as { path }", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureExit();
    try {
      await program.parseAsync(["--config", fixturePath, "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(mockedResolveConfig).toHaveBeenCalledTimes(1);
    expect(mockedResolveConfig).toHaveBeenCalledWith({ path: fixturePath });
  });

  it("no --config: resolveConfig is called WITHOUT a path arg (lets core fall back to TTCTL_CONFIG_FILE / ~/.ttctl.yaml)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureExit();
    try {
      await program.parseAsync(["auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliConfigPath()).toBeUndefined();
    expect(mockedResolveConfig).toHaveBeenCalledTimes(1);
    expect(mockedResolveConfig).toHaveBeenCalledWith();
  });

  it("TTCTL_CONFIG_FILE env var only: CLI does NOT pass an explicit path to core (env handling lives in core)", async () => {
    process.env["TTCTL_CONFIG_FILE"] = fixturePath;
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureExit();
    try {
      await program.parseAsync(["auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliConfigPath()).toBeUndefined();
    expect(mockedResolveConfig).toHaveBeenCalledWith();
  });

  it("--config and TTCTL_CONFIG_FILE both set: --config wins (no warning needed; explicit beats env)", async () => {
    process.env["TTCTL_CONFIG_FILE"] = "/some/other/env/path";
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureExit();
    try {
      await program.parseAsync(["--config", fixturePath, "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliConfigPath()).toBe(fixturePath);
    expect(mockedResolveConfig).toHaveBeenCalledWith({ path: fixturePath });
    expect(mockedResolveConfig).not.toHaveBeenCalledWith();
  });

  it("--config <missing-path>: exits 1 with ConfigError code NO_CREDS BEFORE any sub-command's action runs", async () => {
    const missingPath = join(tmpDir, "does-not-exist.yaml");
    const program = buildProgram();
    program.exitOverride();
    const stderr = captureStderr();
    captureStdout();
    const exit = captureExit();
    try {
      await program.parseAsync(["--config", missingPath, "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(exit.exit?.code).toBe(1);
    const stderrText = stderr.lines.join("");
    expect(stderrText).toContain("NO_CREDS");
    expect(stderrText).toContain(missingPath);
    expect(mockedResolveConfig).not.toHaveBeenCalled();
    expect(mockedGetAuthStatus).not.toHaveBeenCalled();
  });

  it("auth init: existence-gate does NOT fire for missing path (init is bootstrap; --config is OUTPUT)", async () => {
    // Per #114: `auth init`'s `--config <path>` is the OUTPUT destination,
    // not an input config — the file may or may not exist (existence is
    // governed by `auth init --force`). The global pre-flight gate must
    // NOT fire: if it did, `auth init` would be impossible to use against
    // a path that doesn't yet exist (i.e., its primary use case).
    //
    // Set stdin to non-TTY so init's first gate refuses cleanly without
    // hitting any prompt; the relevant assertion is that the GLOBAL
    // existence error did NOT fire (no NO_CREDS in stderr) and that
    // `setCliConfigPath` was cleared rather than set to the OUTPUT path
    // (auth init's handler reads its own `options.config`, not the
    // global context).
    const missingPath = join(tmpDir, "init-target.yaml");
    const originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    try {
      const program = buildProgram();
      program.exitOverride();
      const stderr = captureStderr();
      captureStdout();
      captureExit();
      try {
        await program.parseAsync(["--config", missingPath, "auth", "init"], { from: "user" });
      } catch (err) {
        if (!(err instanceof ExitInvoked)) throw err;
      }
      // Crucially: no NO_CREDS error fired (the global existence check
      // was suppressed). The init command itself handles non-TTY refusal.
      expect(stderr.lines.join("")).not.toContain("NO_CREDS");
      // setCliConfigPath was cleared for auth init (the OUTPUT path is
      // not propagated as the read-side resolver target).
      expect(getCliConfigPath()).toBeUndefined();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
    }
  });
});

describe("program help and metadata", () => {
  beforeEach(() => {
    resetCliConfigPath();
  });

  it("registers --config <path> as a global option visible in help text", () => {
    const program = buildProgram();
    const helpText = program.helpInformation();
    expect(helpText).toContain("--config <path>");
    // The description should mention precedence vs. TTCTL_CONFIG_FILE
    // and the home default so users see WHEN to reach for the flag.
    expect(helpText).toContain("TTCTL_CONFIG_FILE");
  });

  it("the --config option is on the root program (visible to every sub-command via optsWithGlobals)", () => {
    const program = buildProgram();
    const configOpt = program.options.find((o) => o.long === "--config");
    expect(configOpt).toBeDefined();
    expect(configOpt?.flags).toContain("<path>");
  });

  it("registers --json and --yaml boolean shortcuts at the root program level (post-#126)", () => {
    const program = buildProgram();
    const jsonOpt = program.options.find((o) => o.long === "--json");
    const yamlOpt = program.options.find((o) => o.long === "--yaml");
    expect(jsonOpt).toBeDefined();
    expect(yamlOpt).toBeDefined();
    // Boolean flags — no argument descriptor in the flag spec.
    expect(jsonOpt?.flags).not.toContain("<");
    expect(yamlOpt?.flags).not.toContain("<");
  });
});

/**
 * Tests for the post-#126 output-flag mutual exclusion and shortcut
 * propagation. The preAction hook is the single point of enforcement;
 * these tests pin its behavior so adding new sub-commands does not
 * silently regress the surface.
 */
describe("program output-format shortcuts (#126)", () => {
  beforeEach(() => {
    resetCliConfigPath();
    mockedResolveConfig.mockReset();
    mockedResolveConfig.mockReturnValue({
      config: { auth: { credentials: "op://Personal/ttctl" } },
      path: "/cwd/.ttctl.yaml",
    });
    mockedGetAuthStatus.mockReset();
    mockedGetAuthStatus.mockResolvedValue({ status: "valid", email: "u@e.com" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCliConfigPath();
  });

  it("--json propagates to actionCommand.output as `json` (preAction hook)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureExit();
    try {
      await program.parseAsync(["--json", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    // auth status pretty/json are different shapes; json is single-line
    // JSON of the AuthStatusResult — assert on that.
    const stdoutText = stdout.lines.join("").trim();
    expect(JSON.parse(stdoutText)).toEqual({ status: "valid", email: "u@e.com" });
  });

  it("--yaml propagates to actionCommand.output as `yaml` (preAction hook)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureExit();
    try {
      await program.parseAsync(["--yaml", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    const stdoutText = stdout.lines.join("");
    // YAML rendering of the result; check for block-style markers.
    expect(stdoutText).toContain("status: valid");
    expect(stdoutText).toContain("email: u@e.com");
  });

  it("--json and --yaml together raise a parse-time mutual-exclusion error", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stderr = captureStderr();
    captureStdout();
    const exit = captureExit();
    try {
      await program.parseAsync(["--json", "--yaml", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(exit.exit?.code).toBe(1);
    const stderrText = stderr.lines.join("");
    expect(stderrText).toContain("Conflicting output flags");
    expect(stderrText).toContain("--json");
    expect(stderrText).toContain("--yaml");
  });

  it("--output=json and --json together raise a parse-time mutual-exclusion error", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stderr = captureStderr();
    captureStdout();
    const exit = captureExit();
    try {
      await program.parseAsync(["--json", "auth", "status", "--output", "json"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(exit.exit?.code).toBe(1);
    const stderrText = stderr.lines.join("");
    expect(stderrText).toContain("Conflicting output flags");
    expect(stderrText).toContain("--output=json");
    expect(stderrText).toContain("--json");
  });

  it("--output=text is rejected with an invalid-format error from Commander", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stderr = captureStderr();
    captureStdout();
    captureExit();
    try {
      await program.parseAsync(["auth", "status", "--output", "text"], { from: "user" });
    } catch (err) {
      // commander throws InvalidArgumentError or a CommanderError on
      // invalid choice; the exit-override path may surface it as an
      // exception. We accept either ExitInvoked (process.exit fired)
      // or any commander error.
      if (!(err instanceof ExitInvoked) && !(err instanceof Error)) throw err;
    }
    const stderrText = stderr.lines.join("");
    // commander's choices error mentions the value AND the allowed
    // choices.
    expect(stderrText).toMatch(/text/);
  });

  it("-o pretty short alias works (verifies #83 -o still applies after the rename)", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureExit();
    try {
      await program.parseAsync(["auth", "status", "-o", "pretty"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(stdout.lines.join("")).toContain("Signed in as u@e.com");
  });

  it("--output=pretty (default) emits the human-readable line for auth status", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    captureExit();
    try {
      await program.parseAsync(["auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(stdout.lines.join("")).toContain("Signed in as u@e.com");
  });

  it("--json on a sub-command that has no --output option (auth init) is silently ignored at the root", async () => {
    // Set stdin non-TTY so init refuses cleanly without prompts.
    const originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    try {
      const program = buildProgram();
      program.exitOverride();
      const stderr = captureStderr();
      captureStdout();
      captureExit();
      try {
        await program.parseAsync(["--json", "auth", "init"], { from: "user" });
      } catch (err) {
        if (!(err instanceof ExitInvoked)) throw err;
      }
      // No mutual-exclusion error fires (only one flag was passed), and
      // no propagation happens (init has no --output). The init command
      // proceeds to its own non-TTY refusal path.
      expect(stderr.lines.join("")).not.toContain("Conflicting output flags");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
    }
  });
});
