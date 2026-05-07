// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Shared helpers for `ttctl profile external` leaves.
 *
 * Each leaf needs the same auth-token boilerplate (load `.ttctl.yaml`,
 * resolve the token path, read the persisted token, surface a uniform
 * `UNAUTHENTICATED` message when missing). Centralising it here keeps the
 * per-leaf files focused on their own argument parsing and output
 * formatting.
 *
 * Co-located in the sub-tree (rather than promoted to `cli/src/lib/`) to
 * avoid collisions with the sister Wave-3 PRs (#73 / #74 / #75) which add
 * their own sub-trees in parallel.
 */

import { ConfigError, loadAuthToken, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";

/**
 * Resolve the persisted auth-token path from the user's `.ttctl.yaml`.
 *
 * `commandLabel` is the user-visible prefix that the CLI prints when a
 * `ConfigError` surfaces (e.g. `profile external update failed (CONFIG_ERROR): …`).
 * Pass the full sub-command path so the user can map the error to the
 * exact command they invoked.
 *
 * Exits the process on `ConfigError`. Anything else is rethrown so the
 * caller's normal error flow handles it.
 */
export function resolveAuthTokenPathOrExit(commandLabel: string): string {
  try {
    const { config, path: configPath } = resolveConfig();
    return resolveAuthTokenPath({ config, configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${commandLabel} failed (CONFIG_ERROR): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Load the persisted auth token, exiting with a uniform `UNAUTHENTICATED`
 * message if no token is on disk. Wraps the `loadAuthToken(path) → null`
 * convention in a one-liner that every leaf would otherwise duplicate.
 *
 * The exit message phrasing matches `profile.basic`'s "no token found"
 * message so the user-facing remediation is uniform across leaves.
 */
export async function loadAuthTokenOrExit(commandLabel: string, path: string): Promise<string> {
  const token = await loadAuthToken(path);
  if (token === null) {
    process.stderr.write(
      `${commandLabel} failed (UNAUTHENTICATED): No auth token found. Run \`ttctl auth signin\` to sign in.\n`,
    );
    process.exit(1);
  }
  return token;
}

/**
 * Truncate `s` to `width` characters with an ellipsis. Mirrors the helper
 * exported by `profile/basic/show.ts`. Co-located here rather than promoted
 * to a shared lib for the same parallelism rationale as the auth helpers.
 */
export function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, width - 1)}…`;
}

/**
 * Parse a `commander` boolean flag value into a TypeScript `boolean`.
 *
 * Commander's `--flag <value>` parses as a string; we convert
 * `"true"`/`"false"` (and a couple of common shorthand forms) to booleans
 * and exit with a CLI-shape error on unrecognised input.
 *
 * Why explicit string parsing instead of a `--flag` / `--no-flag` boolean?
 * The custom-requirements set has THREE booleans, and Commander's no-flag
 * negation would force the user to remember three negative-form flag names.
 * `--background-check true|false` reads the same regardless of the value
 * and matches the wire-shape (which is also `Boolean!`).
 */
export function parseBooleanFlag(commandLabel: string, flagName: string, value: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (normalised === "true" || normalised === "1" || normalised === "yes") return true;
  if (normalised === "false" || normalised === "0" || normalised === "no") return false;
  process.stderr.write(`${commandLabel} failed (VALIDATION_ERROR): --${flagName} expects true|false (got: ${value})\n`);
  process.exit(1);
}
