// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  AuthTokenPersistError,
  ConfigError,
  OnePasswordError,
  SignInError,
  persistAuthToken,
  resolveCredentials,
  signIn,
} from "@ttctl/core";
import type { ConfigErrorCode, SignInErrorCode } from "@ttctl/core";

import { resolveConfigForCli } from "../../lib/config-context.js";

/**
 * Output format for `ttctl auth signin`. Mirrors `auth status` — `table` is
 * the human-readable default, `json` emits the `SignInResult` discriminated
 * union for scripting. Other formats (csv, yaml) are deferred to the global
 * output-formatter issue, matching the same scope boundary as `auth status`.
 */
export type AuthSignInOutput = "table" | "json";

export interface AuthSignInOptions {
  output: AuthSignInOutput;
}

/**
 * CLI-level error code surfaced in JSON output. Extends `SignInErrorCode`
 * (from core) with codes specific to the orchestration this command performs
 * around the core `signIn` call (1Password resolution, token persistence)
 * plus the `ConfigErrorCode` discriminator from core's resolver. Stable
 * strings — script consumers can branch on them without pattern-matching
 * prose messages.
 */
export type SignInResultErrorCode =
  | SignInErrorCode
  | ConfigErrorCode
  | "ONEPASSWORD_ERROR"
  | "SAVE_FAILED"
  | "NO_CREDENTIALS";

/**
 * Terminal outcome of `ttctl auth signin`. `signed-in` carries the verified
 * `email` (the same string passed to `EmailPasswordSignIn`). `error` carries
 * a stable `code` for scripting plus a human-readable `message` already
 * containing any actionable hint.
 */
export type SignInResult =
  | { status: "signed-in"; email: string }
  | { status: "error"; code: SignInResultErrorCode; message: string };

/**
 * Map a `SignInResult` to a process exit code:
 *   - `signed-in`            → 0 (success)
 *   - `error`/`NETWORK_ERROR` → 2 (transient/retryable — same convention as
 *     `auth status` `unreachable`)
 *   - `error`/anything else  → 1 (user-actionable: bad credentials, missing
 *     1Password CLI, malformed config, MFA required, disk failure)
 *
 * The 1/2 split matches `auth status` so shell consumers can compose:
 * `ttctl auth signin || case $? in 1) ... ;; 2) retry ;; esac`.
 */
export function exitCodeForSignInResult(result: SignInResult): number {
  if (result.status === "signed-in") return 0;
  if (result.code === "NETWORK_ERROR") return 2;
  return 1;
}

/**
 * Render a `SignInResult` for the table format. Success collapses to a
 * single-line confirmation; failures surface the underlying message verbatim
 * (the upstream errors already carry actionable hints — `OnePasswordError`
 * names the install URL, `ConfigError` names the missing path).
 */
export function formatSignInTable(result: SignInResult): string {
  if (result.status === "signed-in") {
    return `Signed in as ${result.email}`;
  }
  return `Sign-in failed (${result.code}): ${result.message}`;
}

/**
 * Format a `SignInResult` for the requested output mode. The JSON shape
 * mirrors the discriminated union 1:1 — `email` only on success, `code` and
 * `message` only on error — so callers can consume the same union structure
 * over the wire.
 */
export function formatSignInOutput(result: SignInResult, output: AuthSignInOutput): string {
  if (output === "json") {
    return JSON.stringify(result);
  }
  return formatSignInTable(result);
}

/**
 * Translate a thrown error to a `SignInResult` with the stable error code.
 * Centralizes the error-class → code mapping so the run loop stays linear.
 */
function classifyError(err: unknown): SignInResult {
  if (err instanceof SignInError) {
    return { status: "error", code: err.code, message: err.message };
  }
  if (err instanceof OnePasswordError) {
    return { status: "error", code: "ONEPASSWORD_ERROR", message: err.message };
  }
  if (err instanceof ConfigError) {
    return { status: "error", code: err.code, message: err.message };
  }
  if (err instanceof AuthTokenPersistError) {
    // Surface bearer in the rescue line per AC-4 — operator can save manually.
    const rescue = err.bearerRescue !== undefined ? `\nBearer (rescue): ${err.bearerRescue}` : "";
    return {
      status: "error",
      code: "SAVE_FAILED",
      message: `${err.message}${rescue}`,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: "error", code: "UNKNOWN", message };
}

/**
 * Run the `auth signin` command end-to-end:
 *   1. Discover and load `.ttctl.yaml` (`ConfigError` on missing/invalid).
 *   2. Refuse Form C (token-only, no credentials) per FR-3.3 — signin
 *      requires `auth.credentials` to be configured.
 *   3. Resolve credentials — Form A reaches `op` CLI, Form B is literal
 *      (`OnePasswordError` on Form A failures).
 *   4. Sign in via `core.signIn`, capturing the bearer token.
 *   5. Persist the token back to the SAME YAML config under `auth.token`
 *      via `persistAuthToken` — atomic write, mode 0600, comment fidelity,
 *      symlink + sync-root refusal.
 *   6. Emit the result and exit with the corresponding code.
 *
 * Errors are routed to stderr; success goes to stdout. `process.exit` is the
 * terminal step for the same reason as `auth status` — Commander action
 * handlers otherwise resolve to `undefined` and we'd lose the exit-code
 * contract that scripts rely on.
 */
export async function runAuthSignIn(options: AuthSignInOptions): Promise<void> {
  const result = await performSignIn();
  const rendered = formatSignInOutput(result, options.output);
  const stream = result.status === "signed-in" ? process.stdout : process.stderr;
  stream.write(rendered + "\n");
  process.exit(exitCodeForSignInResult(result));
}

async function performSignIn(): Promise<SignInResult> {
  let configResult: ReturnType<typeof resolveConfigForCli>;
  try {
    configResult = resolveConfigForCli();
  } catch (err) {
    return classifyError(err);
  }

  // Form C refusal (FR-3.3): signin requires credentials. A token-only
  // config has no credentials to drive EmailPasswordSignIn.
  const credentialsValue = configResult.config.auth.credentials;
  if (credentialsValue === undefined) {
    return {
      status: "error",
      code: "NO_CREDENTIALS",
      message:
        "ttctl auth signin requires `auth.credentials` to be configured. " +
        'Add a 1Password reference (`auth.credentials: "op://..."`) or literal ' +
        "`{ username, password }` to your config and try again.",
    };
  }

  let credentials: ReturnType<typeof resolveCredentials>;
  try {
    credentials = resolveCredentials(credentialsValue);
  } catch (err) {
    return classifyError(err);
  }

  let token: string;
  try {
    ({ token } = await signIn(credentials));
  } catch (err) {
    return classifyError(err);
  }

  try {
    await persistAuthToken(configResult.path, token);
  } catch (err) {
    return classifyError(err);
  }

  return { status: "signed-in", email: credentials.email };
}
