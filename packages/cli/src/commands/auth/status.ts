// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { discoverCookieJarPath, getAuthStatus, loadCookieJar } from "@ttctl/core";
import type { AuthStatusResult } from "@ttctl/core";

/**
 * Output format for `ttctl auth status`. `table` (the default) emits a
 * human-readable single-line summary; `json` emits the `AuthStatusResult`
 * shape verbatim for scripting.
 *
 * `csv` and `yaml` are explicitly out of scope until the global-flags issue
 * lands a unified output formatter — see issue #6 § Out of Scope.
 */
export type AuthStatusOutput = "table" | "json";

export interface AuthStatusOptions {
  output: AuthStatusOutput;
}

/**
 * Map an `AuthStatusResult` to a process exit code:
 *   - `valid`       → 0 (everything OK)
 *   - `invalid`     → 1 (auth-related; user must run `ttctl auth signin`)
 *   - `unreachable` → 2 (transport-level; transient, retryable)
 *
 * Three distinct codes are deliberate: shell consumers can branch on them
 * without parsing stdout (`if ttctl auth status; then ... else case $? in 1)
 * ... ;; 2) ... ;; esac`).
 */
export function exitCodeForAuthStatus(result: AuthStatusResult): number {
  if (result.status === "valid") return 0;
  if (result.status === "invalid") return 1;
  return 2;
}

/**
 * Render an `AuthStatusResult` for the table format. Keeps the user-facing
 * strings here so the CLI surface owns wording (the core library returns
 * stable machine-readable codes; this layer translates them to prose).
 *
 * Both `session-expired` and the rarer 200-with-malformed-payload cases
 * collapse to the same "Session expired" message — from the user's
 * perspective the next action is identical (re-run signin).
 */
export function formatAuthStatusTable(result: AuthStatusResult): string {
  if (result.status === "valid") {
    return `Signed in as ${result.email}`;
  }
  if (result.status === "invalid") {
    if (result.reason === "no-session") {
      return "No session found. Run `ttctl auth signin`.";
    }
    return "Session expired. Run `ttctl auth signin`.";
  }
  return "Could not reach Toptal.";
}

/**
 * Format an `AuthStatusResult` for the requested output mode. The JSON shape
 * mirrors `AuthStatusResult` 1:1 — `email` only on `valid`, `reason` on the
 * other two — which lets callers consume the same discriminated-union
 * structure on the wire.
 */
export function formatAuthStatusOutput(result: AuthStatusResult, output: AuthStatusOutput): string {
  if (output === "json") {
    return JSON.stringify(result);
  }
  return formatAuthStatusTable(result);
}

/**
 * Run the `auth status` command end-to-end:
 *   1. Discover and load the on-disk cookie jar (empty if file missing).
 *   2. Probe the gateway for session validity via `getAuthStatus`.
 *   3. Emit the result in the requested format.
 *   4. Exit the process with the corresponding code.
 *
 * `process.exit` is the terminal step: action handlers in commander otherwise
 * resolve to `undefined` and the process keeps the libuv event loop spinning
 * until natural exit, which is fine for CLI usage but loses the explicit
 * exit-code contract this command needs.
 */
export async function runAuthStatus(options: AuthStatusOptions): Promise<void> {
  const jarPath = discoverCookieJarPath();
  const jar = await loadCookieJar(jarPath);
  const result = await getAuthStatus(jar);
  process.stdout.write(formatAuthStatusOutput(result, options.output) + "\n");
  process.exit(exitCodeForAuthStatus(result));
}
