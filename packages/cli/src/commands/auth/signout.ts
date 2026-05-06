// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { unlink } from "node:fs/promises";

import { discoverCookieJarPath } from "@ttctl/core";

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
 * the case where a cookie jar existed and was deleted from the idempotent
 * no-op (no jar present). Both are success cases — the AC says signout MUST
 * be idempotent — but scripts may want to differentiate (e.g. to count active
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
 * out." regardless of whether a jar was removed — the user-facing semantics
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
 *   1. Resolve the cookie jar path (same discovery as `auth status` /
 *      `auth signin` — XDG/AppData-aware).
 *   2. Delete the file. ENOENT is treated as a no-op success (idempotent —
 *      `signout` after `signout` must not be a hard error).
 *   3. Emit the result and exit. Always 0 in the success path.
 *
 * Other unlink errors (EACCES, EBUSY, etc.) propagate as `error` results
 * with exit code 1 — the user must resolve the filesystem condition out of
 * band before trying again.
 */
export async function runAuthSignOut(options: AuthSignOutOptions): Promise<void> {
  const result = await performSignOut();
  const rendered = formatSignOutOutput(result, options.output);
  const stream = result.status === "signed-out" ? process.stdout : process.stderr;
  stream.write(rendered + "\n");
  process.exit(exitCodeForSignOutResult(result));
}

async function performSignOut(): Promise<SignOutResult> {
  const jarPath = discoverCookieJarPath();
  try {
    await unlink(jarPath);
    return { status: "signed-out", removed: true, path: jarPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "signed-out", removed: false, path: jarPath };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message };
  }
}
