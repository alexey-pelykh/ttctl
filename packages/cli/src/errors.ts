// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError } from "@ttctl/core";

/**
 * CLI presentation contract for `TtctlError` subclasses (issue #77).
 *
 * The CLI surface renders any `TtctlError` in a uniform multi-block format
 * so users see the same shape whether the failure was an auth revocation,
 * a Cloudflare 403, or a (post-v1) scheduler-bearer expiry:
 *
 *     Error: <error.message>
 *
 *     Recovery: <error.recovery>
 *
 *     (Code: <error.code>)
 *
 * `error.message` may be multi-line (e.g. `Cf403Error.formatMessage`
 * produces a 3-paragraph walkthrough); the renderer passes it through
 * verbatim. `recovery` is one short imperative sentence. `code` is a
 * stable machine-readable token script consumers can branch on without
 * parsing prose.
 *
 * Pure function — no I/O. Callers route the result to `process.stderr` and
 * choose an exit code via `exitCodeForTtctlError`.
 */
export function formatTtctlErrorMessage(err: TtctlError): string {
  return [`Error: ${err.message}`, "", `Recovery: ${err.recovery}`, "", `(Code: ${err.code})`].join("\n");
}

/**
 * Map a `TtctlError` to a process exit code.
 *
 * Default is `1` (general error — auth revoked, Cloudflare clearance
 * expired, etc.). The 1 / 2 split mirrors the existing `auth status`
 * convention (1 = auth-related, 2 = transient/retryable). `Cf403*` codes
 * map to `2` because they are transport-level blocks the user cannot fix
 * by re-authenticating.
 */
export function exitCodeForTtctlError(err: TtctlError): number {
  if (err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT") {
    return 2;
  }
  return 1;
}

/**
 * Side-effecting renderer: write the formatted block to `process.stderr`
 * and `process.exit` with the corresponding code. Never returns.
 *
 * Command handlers gate this with `instanceof TtctlError` so the uniform
 * presentation only applies to typed-hierarchy errors — other domain
 * errors (`ProfileError`, `SignInError`, …) keep their existing
 * command-specific "(CODE): message" rendering.
 */
export function presentTtctlError(err: TtctlError): never {
  process.stderr.write(formatTtctlErrorMessage(err) + "\n");
  process.exit(exitCodeForTtctlError(err));
}
