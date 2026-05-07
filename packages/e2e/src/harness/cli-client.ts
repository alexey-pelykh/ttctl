// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "./paths.js";

/**
 * Result of a single CLI invocation. Mirrors the shape of `child_process.spawn`'s
 * stdio stream collection so test authors get the same data they'd see in a
 * shell: stdout, stderr, exit code.
 */
export interface CliInvocationResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliClientOptions {
  /**
   * Absolute path to the sandbox `.ttctl.yaml` fixture. Injected into the
   * spawned CLI subprocess's env as `TTCTL_CONFIG_FILE`, which (per #92)
   * the CLI's `resolveConfig` reads verbatim. The fixture's
   * `auth-token-path: ./auth.token` resolves against the config file's
   * directory → `<sandbox>/auth.token`, isolating the run from the user's
   * everyday session at `~/.config/ttctl/config.yaml` (or
   * `$XDG_CONFIG_HOME/ttctl/config.yaml`).
   *
   * Optional in the type so harness-internal unit tests can construct a
   * client to exercise spawn mechanics without needing isolation. Production
   * E2E callers MUST pass this (the source of the path is `cliConfigPath()`
   * in `paths.ts`, also exposed as `sandboxConfigPath` on the session
   * context).
   */
  configPath?: string;
  /**
   * Working directory for the spawned CLI. Defaults to the repo root.
   * Isolation no longer flows through CWD (see #92, #94 — `TTCTL_CONFIG_FILE`
   * env injection is the canonical mechanism); this option exists for
   * harness-internal tests that assert spawn-time CWD behavior.
   */
  cwd?: string;
  /**
   * Override the resolved CLI entry point. Tests use this to point at a
   * stub; production runs leave it unset so the harness discovers the
   * built `ttctl` umbrella entry from the workspace.
   */
  cliEntryPoint?: string;
  /**
   * Repository root override. Defaults to walking up from `process.cwd()`.
   * Tests inject a fixture root.
   */
  repoRoot?: string;
}

export interface CliInvocationOptions {
  /**
   * Optional stdin payload. Most CLI commands don't read stdin, but
   * future commands (e.g. interactive prompts) may.
   */
  input?: string;
  /**
   * Per-invocation env overlay. Merged onto `process.env` (with the
   * harness-injected `TTCTL_CONFIG_FILE` already in place — per-invocation
   * overlay wins, so a test that wants to exercise the negative case can
   * `env: { TTCTL_CONFIG_FILE: undefined }` to remove the injection).
   */
  env?: Record<string, string | undefined>;
  /**
   * Timeout in milliseconds. Defaults to 60s — long enough for a network
   * call against a Cloudflare-protected surface but bounded so a hung
   * subprocess doesn't stall the whole vitest run.
   */
  timeoutMs?: number;
}

export interface CliClient {
  /**
   * Spawn the CLI as a child process, await termination, and return the
   * captured streams + exit code. Never throws on non-zero exit — that's
   * a normal outcome the test author asserts on.
   */
  run(args: string[], options?: CliInvocationOptions): Promise<CliInvocationResult>;
  /**
   * Resolved path to the CLI entry point — exposed for diagnostics.
   */
  readonly cliEntryPoint: string;
  /**
   * Working directory the spawned CLI inherits — exposed for diagnostics
   * and so test authors can sanity-check isolation without re-deriving the
   * sandbox path.
   */
  readonly cwd: string;
}

/**
 * Build a programmatic CLI invoker bound to a sandbox config path.
 *
 * The CLI is invoked as `node <repo-root>/packages/ttctl/dist/cli.js`. We
 * deliberately avoid the `pnpm exec ttctl` path (slower, depends on the
 * binstub directory being in PATH) and the global `ttctl` bin (might not
 * be installed). Spawning via `process.execPath` (the current Node binary)
 * also keeps the version consistent with the test runner.
 *
 * The harness throws at construction time if the CLI build artifact is
 * missing — running E2E against an unbuilt workspace would surface as
 * cryptic "Cannot find module" errors deep inside the spawn output.
 *
 * Isolation strategy (per #94): each `run()` injects
 * `TTCTL_CONFIG_FILE=<options.configPath>` into the spawned CLI's env. The
 * CLI's `resolveConfig` (per #92) reads that path verbatim — no CWD
 * walking, no XDG/home fallback. The fixture `.ttctl.yaml` (written by
 * `writeSandboxConfig` in `paths.ts`) carries `auth-token-path:
 * ./auth.token`, which resolves against the config file's directory and
 * redirects token persistence to the sandbox.
 */
export function getCliClient(options: CliClientOptions): CliClient {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const cliEntryPoint = options.cliEntryPoint ?? join(repoRoot, "packages", "ttctl", "dist", "cli.js");
  if (!existsSync(cliEntryPoint)) {
    throw new Error(
      `CLI entry point not found at ${cliEntryPoint}. Run \`pnpm build\` before invoking the E2E harness.`,
    );
  }
  const cwd = options.cwd ?? repoRoot;
  const configPath = options.configPath;

  return {
    cliEntryPoint,
    cwd,
    run: async (args, runOptions = {}) => {
      const baseEnv: NodeJS.ProcessEnv = { ...process.env };
      // Inject TTCTL_CONFIG_FILE FIRST — this overrides any value the
      // parent process inherited from its own shell. The per-invocation
      // overlay applies AFTER, so a test asserting the negative case can
      // `env: { TTCTL_CONFIG_FILE: undefined }` to drop the injection.
      if (configPath !== undefined) {
        baseEnv["TTCTL_CONFIG_FILE"] = configPath;
      }
      // Merge user overlay. `Reflect.deleteProperty` (vs `delete env[k]`)
      // sidesteps eslint's `no-dynamic-delete`; both erase the key but the
      // static-analyzer-friendly form is preferred throughout this repo.
      if (runOptions.env) {
        for (const [k, v] of Object.entries(runOptions.env)) {
          if (v === undefined) {
            Reflect.deleteProperty(baseEnv, k);
          } else {
            baseEnv[k] = v;
          }
        }
      }

      const timeoutMs = runOptions.timeoutMs ?? 60_000;

      return new Promise<CliInvocationResult>((resolveInvocation, rejectInvocation) => {
        const child = spawn(process.execPath, [cliEntryPoint, ...args], {
          cwd,
          env: baseEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          rejectInvocation(err);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          if (timedOut) {
            rejectInvocation(
              new Error(
                `CLI invocation timed out after ${timeoutMs.toString()}ms: ` +
                  `${process.execPath} ${[cliEntryPoint, ...args].join(" ")}`,
              ),
            );
            return;
          }
          // signal-only termination → surface as -1 (vitest assertion will
          // include the signal in the failure context via stderr).
          const exitCode = code ?? (signal !== null ? -1 : 0);
          resolveInvocation({ stdout, stderr, exitCode });
        });

        if (runOptions.input !== undefined) {
          child.stdin.end(runOptions.input);
        } else {
          child.stdin.end();
        }
      });
    },
  };
}
