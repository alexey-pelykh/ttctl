// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "./paths.js";

/**
 * Programmatic MCP-server invoker. The MCP server is hosted by the same
 * `ttctl` umbrella binary as the CLI (`ttctl mcp` mode); we spawn it as a
 * child process and keep its stdio open for the duration of a test.
 *
 * Scope note: at the time of writing (#20), the MCP server registers no
 * tools — `runMcpStdio()` boots an empty `McpServer` and connects stdio.
 * The harness exposes `getMcpClient()` so #21 (and follow-up MCP-tool
 * issues) can spawn the server without recreating the spawn boilerplate
 * each test. Full JSON-RPC framing is intentionally deferred to a
 * dedicated client utility (e.g. `@modelcontextprotocol/sdk/client`)
 * rather than reimplemented here.
 *
 * The returned handle exposes:
 *
 *   - `process` — the live `ChildProcess`. Test authors who need fine-
 *     grained control (e.g. piping to a JSON-RPC client from the SDK)
 *     reach for this directly.
 *   - `close()` — graceful shutdown. Sends SIGTERM, waits up to
 *     `closeTimeoutMs` for natural exit, then SIGKILLs.
 *   - `getStderr()` — accumulated stderr buffer. Diagnostic only —
 *     test failures should NOT include MCP server stderr in their
 *     assertion text (it can leak request payloads); use this for
 *     `console.log` during local debugging.
 *
 * Lifecycle: the harness does NOT register vitest hooks for the MCP
 * client. Test authors call `getMcpClient(...)` in `beforeAll` and
 * `await client.close()` in `afterAll` themselves — the client is opt-in
 * per test (most cases don't need MCP).
 *
 * Isolation strategy is identical to `getCliClient`: the spawned MCP
 * server inherits the configured `cwd` (the harness's sandbox) and
 * discovers its `.ttctl.yaml` (with the redirected `auth-token-path`)
 * via normal config discovery. No environment variable is involved.
 */
export interface McpClientOptions {
  /**
   * Working directory for the spawned MCP server. The harness's session
   * setup passes the sandbox dir here so config discovery picks up the
   * fixture `.ttctl.yaml`. Defaults to the repo root for harness-internal
   * unit tests.
   */
  cwd?: string;
  /**
   * Override the resolved CLI entry point (the same umbrella entry that
   * dispatches to MCP mode when `mcp` is `argv[2]`). Tests inject a stub.
   */
  cliEntryPoint?: string;
  /**
   * Repository root override. Defaults to walking up from `process.cwd()`.
   */
  repoRoot?: string;
  /**
   * Per-invocation env overlay. Merged onto `process.env`. The harness
   * does NOT inject any auth-related env vars — isolation flows through
   * `cwd`.
   */
  env?: Record<string, string | undefined>;
}

export interface McpClient {
  /**
   * Live child process running `ttctl mcp`. Stdio is piped; consumers
   * read JSON-RPC framed messages from `stdout` and write to `stdin`.
   */
  readonly process: ChildProcess;
  /**
   * Resolved path to the CLI entry point — exposed for diagnostics.
   */
  readonly cliEntryPoint: string;
  /**
   * Working directory the spawned MCP server inherits — exposed for
   * diagnostics.
   */
  readonly cwd: string;
  /**
   * Snapshot of stderr accumulated since spawn. Useful for diagnosing
   * server-side errors during local debugging. Spawn-time errors (e.g.
   * EACCES on the entry point) are also captured here, prefixed with
   * `[harness]`. Not a stream — just the captured-so-far buffer.
   */
  getStderr(): string;
  /**
   * Graceful shutdown. SIGTERM, then SIGKILL after `closeTimeoutMs`
   * (default 5s). Resolves once the process has exited (either way).
   */
  close(closeTimeoutMs?: number): Promise<void>;
}

/**
 * Spawn the MCP server bound to a sandbox working directory. The process
 * runs until `close()` is called.
 */
export function getMcpClient(options: McpClientOptions): McpClient {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const cliEntryPoint = options.cliEntryPoint ?? join(repoRoot, "packages", "ttctl", "dist", "cli.js");
  if (!existsSync(cliEntryPoint)) {
    throw new Error(
      `CLI entry point not found at ${cliEntryPoint}. Run \`pnpm build\` before invoking the E2E harness.`,
    );
  }
  const cwd = options.cwd ?? repoRoot;

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      if (v === undefined) {
        Reflect.deleteProperty(env, k);
      } else {
        env[k] = v;
      }
    }
  }

  const child = spawn(process.execPath, [cliEntryPoint, "mcp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });
  // Capture spawn-time errors (EACCES on the entry point, fork failures,
  // etc.) into the stderr buffer so they're observable via getStderr().
  // Without this listener, an `error` event on ChildProcess crashes the
  // harness process. existsSync covers ENOENT for the entry point but
  // not other failure modes.
  child.on("error", (err) => {
    stderrBuffer += `[harness] mcp spawn error: ${err.message}\n`;
  });

  return {
    process: child,
    cliEntryPoint,
    cwd,
    getStderr: () => stderrBuffer,
    close: async (closeTimeoutMs = 5_000) => {
      // Process is already dead — either via natural exit (exitCode set)
      // or signal (signalCode set; POSIX-only — Windows always reports
      // null signalCode). Skip the SIGTERM/wait-for-close dance to avoid
      // hanging on the `once("close")` listener registered after the
      // close event already fired.
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolveClose) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, closeTimeoutMs);
        child.once("close", () => {
          clearTimeout(timer);
          resolveClose();
        });
        child.kill("SIGTERM");
      });
    },
  };
}
