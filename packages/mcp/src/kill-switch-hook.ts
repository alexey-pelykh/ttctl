// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  checkKillSwitch,
  formatKillSwitchMessage,
  KILL_SWITCH_DEFAULT_REFETCH_INTERVAL_MS,
  KILL_SWITCH_DEFAULT_TIMEOUT_MS,
  readPackageVersion,
} from "@ttctl/core";

/**
 * MCP-side wire-up for the remote version-killed manifest (#312).
 *
 * Invoked from `buildServer` at construction time (AC 4). Two
 * differences from the CLI hook:
 *
 *   1. **Fire-and-forget**: the server constructor must stay sync
 *      (the MCP SDK's `McpServer` doesn't support an async build path,
 *      and a long blocking startup would interrupt the JSON-RPC
 *      handshake with the client). The check runs as a detached
 *      Promise; the warning lands on stderr whenever the fetch
 *      resolves.
 *   2. **Always warn, never refuse**: refusing a long-lived MCP
 *      server has no usable semantics — mid-flight tool calls would
 *      be interrupted, the Claude Desktop / Cursor session would
 *      receive a partial response, and the operator may not see the
 *      stderr trail. The runbook documents this asymmetry.
 *
 * Also schedules a recurring refetch every ~24h per the issue's
 * frequency spec, with `.unref()` so the timer never holds the
 * process alive — natural Node exit semantics remain intact.
 *
 * **Fail-silent contract**: every error path is swallowed. Even an
 * unexpected throw inside the fire-and-forget Promise is caught (via
 * the `.catch()` on the returned Promise) so no `unhandledRejection`
 * fires.
 */

export interface McpKillSwitchHookOptions {
  /** Override stderr writer. Default: `process.stderr.write`. */
  writeStderr?: (chunk: string) => void;
  /** Override the running version (default: read from this package's package.json). */
  version?: string;
  /** Override the manifest URL. */
  url?: string;
  /** Override the per-fetch timeout (ms). */
  timeoutMs?: number;
  /** Override the refetch interval (ms). Default: ~24h. */
  refetchIntervalMs?: number;
  /** Injected fetch. Tests pass a mock. */
  fetchFn?: typeof globalThis.fetch;
  /**
   * Override `setInterval`. Tests inject a controllable timer to verify
   * the refetch loop without waiting 24h. The returned handle must
   * carry an `unref` method (Node's `Timeout`). When omitted, the real
   * `setInterval` is used.
   */
  setIntervalFn?: typeof globalThis.setInterval;
}

/** Returned handle for callers that want to cancel the refetch loop. */
export interface McpKillSwitchHandle {
  /** Stop the refetch timer. After this, no further checks fire. */
  stop: () => void;
  /**
   * The Promise from the initial at-startup check. Exposed for tests
   * that need to await the first-fetch completion. Production callers
   * do NOT await this — buildServer is sync.
   */
  initialCheck: Promise<void>;
}

async function runOnce(opts: McpKillSwitchHookOptions, version: string): Promise<void> {
  try {
    const result = await checkKillSwitch({
      version,
      ...(opts.url !== undefined ? { url: opts.url } : {}),
      timeoutMs: opts.timeoutMs ?? KILL_SWITCH_DEFAULT_TIMEOUT_MS,
      ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    });

    if (result.status !== "match") return;

    const writeStderr =
      opts.writeStderr ??
      ((chunk: string): void => {
        process.stderr.write(chunk);
      });
    writeStderr(
      formatKillSwitchMessage({
        toolName: "ttctl mcp",
        version,
        entry: result.entry,
      }),
    );
    // Per docstring: MCP always warns even when entry.action === "refuse".
    // No process.exit, no server-side enforcement of refuse.
  } catch {
    // Outer envelope: even if checkKillSwitch were to throw (it shouldn't —
    // it returns a discriminated result for every failure path), swallow
    // here so the fire-and-forget Promise never surfaces as an
    // unhandledRejection.
  }
}

/**
 * Schedule the startup + recurring kill-switch checks for the MCP
 * server. Returns a handle the caller can use to stop the refetch
 * timer (mostly useful for tests; production callers ignore it — the
 * `.unref()` timer dies naturally on process exit).
 */
export function scheduleMcpKillSwitch(opts: McpKillSwitchHookOptions = {}): McpKillSwitchHandle {
  const version = opts.version ?? readPackageVersion(import.meta.url);
  const refetchIntervalMs = opts.refetchIntervalMs ?? KILL_SWITCH_DEFAULT_REFETCH_INTERVAL_MS;
  const setIntervalImpl = opts.setIntervalFn ?? globalThis.setInterval;

  const initialCheck = runOnce(opts, version);

  const timer = setIntervalImpl(() => {
    void runOnce(opts, version);
  }, refetchIntervalMs);
  // Don't hold the process alive solely for this timer — natural Node
  // exit semantics (e.g., stdin EOF terminating the MCP transport)
  // must still terminate the daemon. The injected setIntervalFn type
  // is `typeof globalThis.setInterval` which returns NodeJS.Timeout —
  // .unref() is always present on the contract; tests supply a stub
  // that includes the method.
  timer.unref();

  return {
    stop: (): void => {
      clearInterval(timer);
    },
    initialCheck,
  };
}
