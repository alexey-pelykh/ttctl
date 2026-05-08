// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";
import { resolveConfigForCli } from "../../lib/config-context.js";

/**
 * Load the persisted auth token from the user's `.ttctl.yaml` (in-memory
 * read of `config.auth.token` after `resolveConfigForCli`). Exits with a
 * uniform `UNAUTHENTICATED` stderr message when no token is present —
 * Form A / B configs that haven't been signed-in yet, or post-signout
 * Form A / Form C configs where the token field was removed.
 *
 * Single-arg signature post-#107 — the prior dual-arg form
 * (`loadAuthTokenOrExit(label, tokenPath)`) is gone because the token
 * no longer lives in a separate file. Callers that need the in-memory
 * config object alongside the token can use `resolveConfigForCli()` directly.
 *
 * `commandLabel` is the user-visible prefix used in the error line (e.g.
 * `"profile education add"`); pick the leaf-verb pair that triggered the
 * call so the user maps the error back to their command.
 *
 * Async signature is preserved (returns `Promise<string>`) for source-
 * compatibility with the pre-#107 callers — every leaf already `await`s
 * this function, and downgrading to sync would mean ~50 callers also
 * change shape. The actual work is synchronous after `loadAuthToken` was
 * removed alongside the separate token file.
 */
export async function loadAuthTokenOrExit(commandLabel: string): Promise<string> {
  let config: ReturnType<typeof resolveConfigForCli>["config"];
  try {
    ({ config } = resolveConfigForCli());
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const token = config.auth.token;
  if (token === undefined) {
    process.stderr.write(
      `${commandLabel} failed (UNAUTHENTICATED): No auth token found in config. Run \`ttctl auth signin\` to sign in.\n`,
    );
    process.exit(1);
  }
  return Promise.resolve(token);
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
