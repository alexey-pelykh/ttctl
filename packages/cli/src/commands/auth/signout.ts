// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { AuthTokenPersistError, ConfigError, clearAuthToken } from "@ttctl/core";

import { resolveConfigForCli } from "../../lib/config-context.js";

/**
 * Output format for `ttctl auth signout`. Mirrors the rest of the auth
 * subcommand tree — `table` is the human-readable default, `json` is the
 * machine-readable shape for scripting.
 */
export type AuthSignOutOutput = "table" | "json";

export interface AuthSignOutOptions {
  output: AuthSignOutOutput;
}

/**
 * Terminal outcome of `ttctl auth signout`. The `removed` flag distinguishes
 * the case where an auth token existed and was removed from the YAML config
 * from the idempotent no-op (no token field present). Both are success
 * cases — signout MUST be idempotent — but scripts may want to differentiate
 * (e.g. to count active sessions across machines).
 *
 * `path` is the YAML config file path that the `auth.token` field was
 * removed from.
 *
 * `error` carries a generic message; the only realistic non-permission
 * failure is a YAML parse error or a write-back contention (mtime drift),
 * which the user must resolve out of band.
 */
export type SignOutResult =
  | { status: "signed-out"; removed: boolean; path: string }
  | { status: "error"; message: string };

/**
 * Render a `SignOutResult` for the table format. The success line is "Signed
 * out." regardless of whether a token was removed — the user-facing semantics
 * ("you are no longer signed in") are identical, and the AC explicitly calls
 * out idempotency. Errors surface verbatim.
 */
export function formatSignOutTable(result: SignOutResult): string {
  if (result.status === "signed-out") {
    return "Signed out.";
  }
  return `Sign-out failed: ${result.message}`;
}

/**
 * Format a `SignOutResult` for the requested output mode. JSON shape mirrors
 * the discriminated union exactly — `removed` and `path` on success, `message`
 * on error — so scripts can branch on `removed` to detect the no-op case.
 */
export function formatSignOutOutput(result: SignOutResult, output: AuthSignOutOutput): string {
  if (output === "json") {
    return JSON.stringify(result);
  }
  return formatSignOutTable(result);
}

/**
 * Map a `SignOutResult` to a process exit code. Both success branches
 * (`removed: true` and `removed: false`) return 0 — signout is idempotent
 * by AC. Only filesystem failures other than ENOENT exit non-zero.
 */
export function exitCodeForSignOutResult(result: SignOutResult): number {
  return result.status === "signed-out" ? 0 : 1;
}

/**
 * Run the `auth signout` command end-to-end:
 *   1. Resolve `.ttctl.yaml` and read it (in-memory parsed via core).
 *   2. If `auth.token` is present, remove the field via `clearAuthToken`
 *      (yaml.parseDocument + deleteIn — preserves comments and credentials).
 *   3. If `auth.token` was already absent, exit 0 with `removed: false`
 *      (idempotent no-op; AC-6 requires this branch).
 *   4. Emit the result and exit. Always 0 in the success path.
 *
 * `clearAuthToken` enforces the same security gates as `persistAuthToken`
 * (symlink refusal, sync-root refusal, atomic write, mode 0600).
 */
export async function runAuthSignOut(options: AuthSignOutOptions): Promise<void> {
  const result = await performSignOut();
  const rendered = formatSignOutOutput(result, options.output);
  const stream = result.status === "signed-out" ? process.stdout : process.stderr;
  stream.write(rendered + "\n");
  process.exit(exitCodeForSignOutResult(result));
}

async function performSignOut(): Promise<SignOutResult> {
  let configPath: string;
  let hasToken: boolean;
  try {
    const { config, path } = resolveConfigForCli();
    configPath = path;
    hasToken = config.auth.token !== undefined;
  } catch (err) {
    if (err instanceof ConfigError) {
      return { status: "error", message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }

  if (!hasToken) {
    // Idempotent no-op — token field already absent. Don't open the file
    // for write at all; report success with removed: false so scripts can
    // detect the no-op case.
    return { status: "signed-out", removed: false, path: configPath };
  }

  try {
    await clearAuthToken(configPath);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof AuthTokenPersistError) {
      return { status: "error", message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }

  return { status: "signed-out", removed: true, path: configPath };
}
