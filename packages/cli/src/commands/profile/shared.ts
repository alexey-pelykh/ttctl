// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, TtctlError, loadAuthToken, profile, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";

/**
 * Resolve the auth-token path from the user's `.ttctl.yaml` (honors
 * `auth-token-path`; falls back to platform defaults). On `ConfigError`,
 * surfaces the discriminator code (`NO_CREDS` / `PARSE` / `VALIDATION` /
 * `PERMISSION`) and the message verbatim, then exits non-zero.
 *
 * Mirrors the helper on `basic/show.ts` — extracted here so the four
 * sub-domains landing in #74 don't each re-import the same five symbols.
 *
 * The `commandLabel` argument is the user-visible prefix used in the
 * error line (e.g. `"profile education add"`); pick the leaf-verb pair
 * that triggered the call.
 */
export function resolveAuthTokenPathOrExit(commandLabel: string): string {
  try {
    const { config, path: configPath } = resolveConfig();
    return resolveAuthTokenPath({ config, configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Load the persisted auth token, exiting non-zero with an `UNAUTHENTICATED`
 * stderr message when no token is on disk. The "run `ttctl auth signin`"
 * hint matches the post-`AuthRevokedError` rendering, so the user sees a
 * uniform recovery path whether they've never signed in or signed in but
 * expired.
 */
export async function loadAuthTokenOrExit(commandLabel: string): Promise<string> {
  const tokenPath = resolveAuthTokenPathOrExit(commandLabel);
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      `${commandLabel} failed (UNAUTHENTICATED): No auth token found. Run \`ttctl auth signin\` to sign in.\n`,
    );
    process.exit(1);
  }
  return token;
}

/**
 * Render a domain error from any of the four sub-domain services
 * (education, certifications, employment, industries). All four reuse
 * `profile.basic.ProfileError` for domain errors and pass `TtctlError`
 * subclasses through verbatim — the rendering is therefore identical
 * across sub-domains.
 *
 * `commandLabel` is the user-facing leaf-verb pair (e.g.
 * `"profile education add"`). Returns `never` (always exits).
 */
export function presentSubDomainError(commandLabel: string, err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.basic.ProfileError) {
    process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${commandLabel} failed: ${message}\n`);
  process.exit(1);
}

/**
 * Parse the `--limit` flag for autocomplete-style sub-commands. Rejects
 * non-integers and values outside `1..50` with a `VALIDATION_ERROR`
 * stderr line and exits non-zero. The 1..50 ceiling matches the
 * back-end's autocomplete semantics — wider catalogs are paginated by
 * the upstream API, not by the CLI.
 *
 * `commandLabel` is the user-facing leaf-verb pair (e.g.
 * `"profile industries autocomplete"`). Returns the parsed integer.
 */
export function parseLimitOrExit(raw: string, commandLabel: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    process.stderr.write(
      `${commandLabel} failed (VALIDATION_ERROR): --limit must be an integer between 1 and 50; got "${raw}"\n`,
    );
    process.exit(1);
  }
  return n;
}
