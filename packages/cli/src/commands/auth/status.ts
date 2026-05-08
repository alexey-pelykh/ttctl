// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, getAuthStatus } from "@ttctl/core";
import type { AuthStatusResult } from "@ttctl/core";

import { resolveConfigForCli } from "../../lib/config-context.js";

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
 *   1. Resolve `.ttctl.yaml` (in-memory parsed via core). A missing/malformed
 *      config collapses to `invalid/no-session` — the user-facing
 *      "Run `ttctl auth signin`" hint is still the right next step, and
 *      surfacing the raw `ConfigError` would be more confusing than helpful
 *      in the read-only status path.
 *   2. Read `config.auth.token` directly (no separate file load — the token
 *      lives inline in the YAML config post-#107).
 *   3. Probe the gateway for session validity via `getAuthStatus(token)`.
 *      No token → invalid/no-session, short-circuited (no network call).
 *   4. Emit the result in the requested format.
 *   5. Exit the process with the corresponding code.
 *
 * `process.exit` is the terminal step: action handlers in commander otherwise
 * resolve to `undefined` and the process keeps the libuv event loop spinning
 * until natural exit, which is fine for CLI usage but loses the explicit
 * exit-code contract this command needs.
 */
export async function runAuthStatus(options: AuthStatusOptions): Promise<void> {
  let token: string | null;
  try {
    const { config } = resolveConfigForCli();
    token = config.auth.token ?? null;
  } catch (err) {
    if (err instanceof ConfigError) {
      const noSession: AuthStatusResult = { status: "invalid", reason: "no-session" };
      process.stdout.write(formatAuthStatusOutput(noSession, options.output) + "\n");
      process.exit(exitCodeForAuthStatus(noSession));
      return;
    }
    throw err;
  }
  const result = await getAuthStatus(token);
  process.stdout.write(formatAuthStatusOutput(result, options.output) + "\n");
  process.exit(exitCodeForAuthStatus(result));
}
