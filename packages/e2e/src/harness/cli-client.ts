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
   * Absolute path to the isolated cookie jar. Forwarded to the spawned CLI
   * process via `TTCTL_COOKIE_JAR_PATH` env var, which `discoverCookieJarPath`
   * in `@ttctl/core` honors as an explicit override (added for the E2E
   * harness). The CLI reads/writes this file instead of `~/.ttctl/session.cookies`.
   */
  jarPath: string;
  /**
   * Working directory for the spawned CLI. Defaults to the repo root —
   * this mirrors how a developer invokes `ttctl` from the project tree
   * during local testing. Override only when a test deliberately exercises
   * CWD-dependent behavior (e.g. `.ttctl.yaml` discovery).
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
   * Per-invocation env overlay. Merged onto the harness's defaults
   * (TTCTL_COOKIE_JAR_PATH always wins so callers can't accidentally
   * unisolate the session — passing TTCTL_COOKIE_JAR_PATH here is rejected
   * to make the contract explicit).
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
}

/**
 * Build a programmatic CLI invoker bound to an isolated cookie jar.
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

  return {
    cliEntryPoint,
    run: async (args, runOptions = {}) => {
      const baseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        TTCTL_COOKIE_JAR_PATH: options.jarPath,
      };
      // Merge user overlay; reject attempts to override the jar (the whole
      // point of the harness is isolation — silently dropping it would
      // produce confusing "session not found" errors). `Reflect.deleteProperty`
      // (vs `delete env[k]`) sidesteps eslint's `no-dynamic-delete`; both
      // erase the key but the static-analyzer-friendly form is preferred
      // throughout this repo.
      if (runOptions.env) {
        for (const [k, v] of Object.entries(runOptions.env)) {
          if (k === "TTCTL_COOKIE_JAR_PATH") {
            throw new Error(
              `getCliClient: refusing to override TTCTL_COOKIE_JAR_PATH via run() env. ` +
                `Construct a separate client with the desired jar path instead.`,
            );
          }
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
