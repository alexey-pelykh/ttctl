// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
import { DRY_RUN_NO_OP_STDERR_NOTE, getCliDryRun, isMutationCommand, resetCliDryRun } from "../lib/dry-run.js";
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

  it("reports the @ttctl/cli package.json version, not a hardcoded literal (#582)", () => {
    // Independently re-read the CLI package's own package.json (two levels
    // up from src/__tests__/), then assert the Commander program reports
    // exactly that. buildProgram() wires
    // `.version(readPackageVersion(import.meta.url))`, which resolves the
    // same manifest from src/program.ts (→ ../package.json). This guards
    // against a re-hardcoded literal: at a stamped release build the
    // manifest carries the real version while a reverted `.version("0.0.0")`
    // literal would not, diverging this assertion.
    const cliPackageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const { version: manifestVersion } = JSON.parse(readFileSync(cliPackageJsonPath, "utf-8")) as { version: string };
    expect(manifestVersion.length).toBeGreaterThan(0);
    const program = buildProgram();
    expect(program.version()).toBe(manifestVersion);
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

  it("`profile employment update` exposes `--skill-id` repeatable (replacement on supply, #541)", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    const employment = profile?.commands.find((c) => c.name() === "employment");
    const update = employment?.commands.find((c) => c.name() === "update");
    expect(update).toBeDefined();
    const skillOpt = update?.options.find((o) => o.long === "--skill-id");
    expect(skillOpt).toBeDefined();
    expect(skillOpt?.flags).toContain("<id>");
  });

  it("`profile portfolio update` exposes `--skill-id` repeatable (replacement on supply, #541)", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    const portfolio = profile?.commands.find((c) => c.name() === "portfolio");
    const update = portfolio?.commands.find((c) => c.name() === "update");
    expect(update).toBeDefined();
    const skillOpt = update?.options.find((o) => o.long === "--skill-id");
    expect(skillOpt).toBeDefined();
    expect(skillOpt?.flags).toContain("<id>");
  });

  it("`profile employment add` exposes `--primary-geography-id <id>` (#586)", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    const employment = profile?.commands.find((c) => c.name() === "employment");
    const add = employment?.commands.find((c) => c.name() === "add");
    expect(add).toBeDefined();
    const geoOpt = add?.options.find((o) => o.long === "--primary-geography-id");
    expect(geoOpt).toBeDefined();
    expect(geoOpt?.flags).toContain("<id>");
  });

  it("`profile employment update` exposes `--primary-geography-id <id>` (#586)", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    const employment = profile?.commands.find((c) => c.name() === "employment");
    const update = employment?.commands.find((c) => c.name() === "update");
    expect(update).toBeDefined();
    const geoOpt = update?.options.find((o) => o.long === "--primary-geography-id");
    expect(geoOpt).toBeDefined();
    expect(geoOpt?.flags).toContain("<id>");
  });

  it("`profile employment add` exposes `--engagement-id <id>` (#587)", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    const employment = profile?.commands.find((c) => c.name() === "employment");
    const add = employment?.commands.find((c) => c.name() === "add");
    expect(add).toBeDefined();
    const engOpt = add?.options.find((o) => o.long === "--engagement-id");
    expect(engOpt).toBeDefined();
    expect(engOpt?.flags).toContain("<id>");
  });

  it("`profile employment update` exposes `--engagement-id <id>` (#587)", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    const employment = profile?.commands.find((c) => c.name() === "employment");
    const update = employment?.commands.find((c) => c.name() === "update");
    expect(update).toBeDefined();
    const engOpt = update?.options.find((o) => o.long === "--engagement-id");
    expect(engOpt).toBeDefined();
    expect(engOpt?.flags).toContain("<id>");
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

/**
 * Tests for the global `--dry-run` flag (issue #52). The flag is a
 * boolean Option captured into the module-scoped holder via
 * `setCliDryRun` in the preAction hook; mutation handlers read it
 * through `getCliDryRun()` to route through the core's `dryRun`
 * option, while non-mutation leaves get a one-line stderr no-op note.
 *
 * Three layers of verification:
 *   1. Help-surface: the flag is registered AND visible in `--help`.
 *   2. State capture: `getCliDryRun()` returns the right value after
 *      preAction fires.
 *   3. Routing: mutation leaves do NOT emit the no-op note;
 *      non-mutation leaves DO.
 */
describe("program --dry-run flag (#52)", () => {
  beforeEach(() => {
    resetCliConfigPath();
    resetCliDryRun();
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
    resetCliDryRun();
  });

  it("registers --dry-run as a global option visible in help text (AC: visible in `ttctl --help`)", () => {
    const program = buildProgram();
    const helpText = program.helpInformation();
    expect(helpText).toContain("--dry-run");
    // The description should mention the no-op semantic for read commands
    // so the user knows the flag is mutation-targeted.
    expect(helpText).toContain("preview");
  });

  it("the --dry-run option is on the root program (visible to every sub-command via optsWithGlobals)", () => {
    const program = buildProgram();
    const dryRunOpt = program.options.find((o) => o.long === "--dry-run");
    expect(dryRunOpt).toBeDefined();
    // Boolean flag — no argument descriptor in the spec.
    expect(dryRunOpt?.flags).not.toContain("<");
  });

  it("--dry-run captures `true` into the module-scoped holder (preAction hook)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--dry-run", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliDryRun()).toBe(true);
  });

  it("default (no --dry-run) keeps captured value `false` (apply-path default)", async () => {
    const program = buildProgram();
    program.exitOverride();
    captureStdout();
    captureExit();
    try {
      await program.parseAsync(["auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    expect(getCliDryRun()).toBe(false);
  });

  it("--dry-run on a read command (`auth status`) emits the no-op stderr note BEFORE the action runs", async () => {
    const program = buildProgram();
    program.exitOverride();
    const stdout = captureStdout();
    const stderr = captureStderr();
    captureExit();
    try {
      await program.parseAsync(["--dry-run", "auth", "status"], { from: "user" });
    } catch (err) {
      if (!(err instanceof ExitInvoked)) throw err;
    }
    // Stderr carries the verbatim AC-mandated note.
    expect(stderr.lines.join("")).toContain(DRY_RUN_NO_OP_STDERR_NOTE);
    // The read command STILL ran (proceeds normally per AC) — stdout
    // carries the auth-status pretty rendering.
    expect(stdout.lines.join("")).toContain("Signed in as u@e.com");
  });

  it("--dry-run on a mutation leaf (`profile basic update`) does NOT emit the no-op note", () => {
    // We don't fully execute the mutation here (would require deeper
    // mocking of profile.basic.set); instead we verify the leaf is
    // tagged via markMutation, which is what the preAction hook checks.
    // Direct verification that `isMutationCommand(actionCommand)` is
    // true for the leaf — closing the routing-decision loop.
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    expect(profile).toBeDefined();
    const basic = profile?.commands.find((c) => c.name() === "basic");
    expect(basic).toBeDefined();
    const update = basic?.commands.find((c) => c.name() === "update");
    expect(update).toBeDefined();
    if (update !== undefined) {
      expect(isMutationCommand(update)).toBe(true);
    }
  });

  it("`profile skills add` is marked as a mutation so --dry-run routes through the core dryRun path (#396)", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    const skills = profile?.commands.find((c) => c.name() === "skills");
    expect(skills).toBeDefined();
    const add = skills?.commands.find((c) => c.name() === "add");
    expect(add).toBeDefined();
    if (add !== undefined) {
      expect(isMutationCommand(add)).toBe(true);
    }
  });

  it("--dry-run on the top-level alias (`profile update`) is also marked as a mutation", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    expect(profile).toBeDefined();
    const aliasUpdate = profile?.commands.find((c) => c.name() === "update");
    expect(aliasUpdate).toBeDefined();
    if (aliasUpdate !== undefined) {
      expect(isMutationCommand(aliasUpdate)).toBe(true);
    }
  });

  it("read leaves are NOT marked as mutation (regression guard)", () => {
    const program = buildProgram();
    const profile = program.commands.find((c) => c.name() === "profile");
    const basic = profile?.commands.find((c) => c.name() === "basic");
    const show = basic?.commands.find((c) => c.name() === "show");
    expect(show).toBeDefined();
    if (show !== undefined) {
      expect(isMutationCommand(show)).toBe(false);
    }
    // Top-level `profile show` alias likewise stays a read.
    const aliasShow = profile?.commands.find((c) => c.name() === "show");
    expect(aliasShow).toBeDefined();
    if (aliasShow !== undefined) {
      expect(isMutationCommand(aliasShow)).toBe(false);
    }
  });

  it("auth sub-commands are NOT marked as mutations (config-only writes are out of scope for #52)", () => {
    const program = buildProgram();
    const auth = program.commands.find((c) => c.name() === "auth");
    expect(auth).toBeDefined();
    for (const sub of auth?.commands ?? []) {
      // signin / signout / status / init — none of them target the
      // Toptal API mutation surface, so none is marked. The no-op
      // note will fire if `--dry-run` is ever passed alongside them.
      expect(isMutationCommand(sub)).toBe(false);
    }
  });
});
