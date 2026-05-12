// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { AuthTokenPersistError, ConfigError, clearAuthToken, signOut } from "@ttctl/core";
import type { SignOutResult as CoreSignOutResult } from "@ttctl/core";

import { resolveConfigForCli } from "../../lib/config-context.js";
import { formatYaml } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";

/**
 * Output format for `ttctl auth signout`. Aligned with the cross-CLI
 * `OutputFormat` post-#126: `pretty` (default) is the human-readable
 * confirmation, `json` and `yaml` emit the machine-readable shape for
 * scripting.
 */
export interface AuthSignOutOptions {
  output: OutputFormat;
}

/**
 * Server-side LogOut outcome surfaced alongside the local-clear result.
 * Stable strings so scripts can branch on the JSON / YAML output without
 * pattern-matching prose. Maps from `core.signOut()`'s
 * {@link CoreSignOutResult} discriminated union plus the "no token to
 * call with" short-circuit.
 *
 * **Naming is deliberately scoped to "log-out", not "revoke"**. Live
 * evidence (issue #180, 2026-05-12) shows the `LogOut` mutation on
 * `talent_profile/graphql` succeeds but does NOT propagate to bearer
 * invalidation for subsequent `mobile-gateway` calls — the bearer remains
 * valid against `getAuthStatus` across t=0/30/60/180/300s. The 24-72h
 * natural aging-out (CLAUDE.md § Auth Model) is the load-bearing
 * revocation defense. `serverLogOut: "logged-out"` therefore claims only
 * "the LogOut mutation was acknowledged by talent_profile" — NOT "the
 * bearer is now invalid for downstream calls".
 *
 * `logged-out`      — talent_profile responded `data.logOut.success === true`;
 *                     the LogOut flow itself was acknowledged (audit log,
 *                     web-session/cookie cleanup, defense-in-depth signal).
 *                     Does NOT imply bearer revocation — see note above.
 * `already-invalid` — bearer was already invalid server-side (HTTP 401/403 or
 *                     GraphQL auth-revoke code); user intent (kill the bearer)
 *                     is satisfied transitively.
 * `skipped`         — no token to call with (idempotent local-only signout).
 * `unreachable`     — could not deliver the LogOut signal (network /
 *                     HTTP / wire-shape divergence). The local clear still
 *                     ran; the 24-72h aging-out is the load-bearing defense.
 */
export type ServerLogOutOutcome = "logged-out" | "already-invalid" | "skipped" | "unreachable";

/**
 * Map a {@link CoreSignOutResult} to the CLI's {@link ServerLogOutOutcome}.
 * Collapses the per-reason discriminator of `unreachable` / `invalid` into
 * the four CLI-level outcomes. The full reason is surfaced separately via
 * {@link serverLogOutStderrWarning} for the unreachable path.
 */
export function mapCoreSignOutResult(result: CoreSignOutResult): ServerLogOutOutcome {
  if (result.status === "logged-out") return "logged-out";
  if (result.status === "invalid") {
    // no-session is the empty-token short-circuit; the CLI handles that
    // before calling core.signOut(), so it shouldn't surface here. If it
    // does (defensive), treat the same as the local "skipped" branch.
    if (result.reason === "no-session") return "skipped";
    return "already-invalid";
  }
  return "unreachable";
}

/**
 * Build a human-readable stderr warning for the `unreachable` server-side
 * outcome. Returns `null` for every other outcome — the success path stays
 * quiet on stderr. The warning text names the reason and tells the user
 * the bearer will age out as the load-bearing defense (24-72h empirical
 * per `research/notes/02-auth-and-clients.md`).
 */
export function serverLogOutStderrWarning(result: CoreSignOutResult): string | null {
  if (result.status !== "unreachable") return null;
  const reason = result.reason;
  let detail: string;
  switch (reason.kind) {
    case "transport":
      detail = `transport error (${reason.reason})`;
      break;
    case "http-status":
      detail = `HTTP ${reason.status.toString()} from talent_profile/graphql`;
      break;
    case "graphql-error":
      detail = `GraphQL error: ${reason.message}`;
      break;
    case "payload-missing":
      detail = "talent_profile/graphql returned an unrecognized payload shape (missing data.logOut)";
      break;
    case "success-false":
      detail = "talent_profile/graphql returned data.logOut.success: false";
      break;
  }
  return `warning: server-side LogOut could not be delivered (${detail}); local token cleared, the bearer will age out server-side in 24-72h`;
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
 * `serverLogOut` is the server-side LogOut outcome (post-#180) — see
 * {@link ServerLogOutOutcome}. Always populated on the success branch.
 * `serverLogOut: "unreachable"` is a soft warning — local state is still
 * cleared; the bearer ages out server-side as the load-bearing defense.
 * **Note**: `serverLogOut: "logged-out"` claims only "talent_profile
 * acknowledged the LogOut mutation"; it does NOT claim "the bearer is now
 * invalid for downstream calls". See {@link ServerLogOutOutcome} for the
 * full empirical scope.
 *
 * `error` carries a generic message; the only realistic non-permission
 * failure is a YAML parse error or a write-back contention (mtime drift),
 * which the user must resolve out of band.
 */
export type SignOutResult =
  | { status: "signed-out"; removed: boolean; path: string; serverLogOut: ServerLogOutOutcome }
  | { status: "error"; message: string };

/**
 * Render a `SignOutResult` for the human-readable `pretty` format. The
 * success line is "Signed out." regardless of whether a token was
 * removed — the user-facing semantics ("you are no longer signed in")
 * are identical, and the AC explicitly calls out idempotency. Errors
 * surface verbatim.
 */
export function formatSignOutPretty(result: SignOutResult): string {
  if (result.status === "signed-out") {
    return "Signed out.";
  }
  return `Sign-out failed: ${result.message}`;
}

/**
 * Format a `SignOutResult` for the requested output mode. JSON and YAML
 * shapes mirror the discriminated union exactly — `removed` and `path`
 * on success, `message` on error — so scripts can branch on `removed`
 * to detect the no-op case.
 */
export function formatSignOutOutput(result: SignOutResult, output: OutputFormat): string {
  if (output === "json") {
    return JSON.stringify(result);
  }
  if (output === "yaml") {
    return formatYaml(result);
  }
  return formatSignOutPretty(result);
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
 *   2. If `auth.token` is present:
 *      a. Call `core.signOut(token)` to attempt server-side LogOut via
 *         the `LogOut` mutation against talent_profile/graphql.
 *      b. Remove the field via `clearAuthToken` (yaml.parseDocument +
 *         deleteIn — preserves comments and credentials).
 *      c. If the server-side call returned `unreachable`, emit a stderr
 *         warning. The local clear still ran — the bearer ages out
 *         server-side in 24-72h as the load-bearing defense.
 *   3. If `auth.token` was already absent, exit 0 with `removed: false`
 *      and `serverLogOut: "skipped"` (idempotent no-op).
 *   4. Emit the result and exit. Always 0 in the success path — server-
 *      side LogOut failure is a soft warning, not an exit-code signal.
 *
 * `clearAuthToken` enforces the same security gates as `persistAuthToken`
 * (symlink refusal, sync-root refusal, atomic write, mode 0600).
 *
 * `core.signOut()` never throws — every failure is classified into
 * `CoreSignOutResult` and surfaced via `mapCoreSignOutResult`.
 */
export async function runAuthSignOut(options: AuthSignOutOptions): Promise<void> {
  const { result, stderrWarning } = await performSignOut();
  const rendered = formatSignOutOutput(result, options.output);
  const stream = result.status === "signed-out" ? process.stdout : process.stderr;
  if (stderrWarning !== null) {
    process.stderr.write(stderrWarning + "\n");
  }
  stream.write(rendered + "\n");
  process.exit(exitCodeForSignOutResult(result));
}

async function performSignOut(): Promise<{ result: SignOutResult; stderrWarning: string | null }> {
  let configPath: string;
  let token: string | undefined;
  try {
    const { config, path } = resolveConfigForCli();
    configPath = path;
    token = config.auth.token;
  } catch (err) {
    if (err instanceof ConfigError) {
      return { result: { status: "error", message: err.message }, stderrWarning: null };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { result: { status: "error", message }, stderrWarning: null };
  }

  if (token === undefined) {
    // Idempotent no-op — token field already absent. Don't open the file
    // for write AND don't call talent_profile (nothing to call with). Report
    // success with removed: false / serverLogOut: "skipped" so scripts can
    // detect the no-op case.
    return {
      result: { status: "signed-out", removed: false, path: configPath, serverLogOut: "skipped" },
      stderrWarning: null,
    };
  }

  // Attempt server-side LogOut BEFORE clearing the local token. The
  // ordering matters: we want the bearer in hand when calling LogOut so
  // talent_profile can authenticate the request. core.signOut()
  // never throws (every failure mode is classified into CoreSignOutResult),
  // so this branch is safe to await without try/catch.
  const coreResult = await signOut(token);
  const serverLogOut = mapCoreSignOutResult(coreResult);
  const stderrWarning = serverLogOutStderrWarning(coreResult);

  try {
    await clearAuthToken(configPath);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof AuthTokenPersistError) {
      return { result: { status: "error", message: err.message }, stderrWarning };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { result: { status: "error", message }, stderrWarning };
  }

  return {
    result: { status: "signed-out", removed: true, path: configPath, serverLogOut },
    stderrWarning,
  };
}
