// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { unlink } from "node:fs/promises";

import { ConfigError, resolveAuthTokenPath } from "@ttctl/core";

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
 * the case where an auth token existed and was deleted from the idempotent
 * no-op (no token present). Both are success cases — signout MUST be
 * idempotent — but scripts may want to differentiate (e.g. to count active
 * sessions across machines).
 *
 * `error` carries a generic message; the only realistic non-ENOENT failure is
 * a permissions issue on the on-disk file, which the user must resolve out of
 * band.
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
 *   1. Load `.ttctl.yaml` and resolve the auth-token path (honors the
 *      optional `auth-token-path` field; falls back to platform defaults).
 *   2. Delete the auth token via `unlink` (idempotent — ENOENT is silent).
 *   3. Report `removed: true` when the file was deleted, `false` when it
 *      was already absent.
 *   4. Emit the result and exit. Always 0 in the success path.
 *
 * Loading config is required because the token path can be customized via
 * `auth-token-path` in `.ttctl.yaml`. A `ConfigError` (no config found, or
 * malformed) surfaces as an `error` result so the user-facing message is
 * actionable. Other unlink errors (EACCES, EBUSY, etc.) propagate as
 * `error` results with exit code 1 — the user must resolve the filesystem
 * condition out of band before trying again.
 */
export async function runAuthSignOut(options: AuthSignOutOptions): Promise<void> {
  const result = await performSignOut();
  const rendered = formatSignOutOutput(result, options.output);
  const stream = result.status === "signed-out" ? process.stdout : process.stderr;
  stream.write(rendered + "\n");
  process.exit(exitCodeForSignOutResult(result));
}

async function performSignOut(): Promise<SignOutResult> {
  let tokenPath: string;
  try {
    const { config, path: configPath } = resolveConfigForCli();
    tokenPath = resolveAuthTokenPath({ config, configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      return { status: "error", message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }

  // Token deletion revokes the identity-bearing credential. ENOENT is treated
  // as a no-op (already-gone is the same as "deleted" from the user's
  // perspective); other errors abort with `error`.
  const outcome = await tryUnlink(tokenPath);
  if (outcome.status === "error") return outcome;

  return {
    status: "signed-out",
    removed: outcome.removed,
    path: tokenPath,
  };
}

type UnlinkOutcome = { status: "ok"; removed: boolean } | { status: "error"; message: string };

/**
 * Unlink `path`. Returns `removed: true` if the file existed and was
 * deleted, `removed: false` if it was already absent (ENOENT), or an
 * error outcome for any other failure.
 */
async function tryUnlink(path: string): Promise<UnlinkOutcome> {
  try {
    await unlink(path);
    return { status: "ok", removed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "ok", removed: false };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }
}
