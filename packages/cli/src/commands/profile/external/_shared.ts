// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Shared helpers for `ttctl profile external` leaves.
 *
 * Re-exports `loadAuthTokenOrExit` from the parent `../shared.ts` so the
 * sub-tree leaves can keep their `from "./_shared.js"` import shape
 * unchanged across the #107 refactor. (Pre-#107 each sub-tree had its own
 * implementation; post-#107 the auth-token logic is centralised at
 * profile/shared.ts to consume the in-memory `config.auth.token`.)
 */

export { loadAuthTokenOrExit } from "../shared.js";

/**
 * Truncate `s` to `width` characters with an ellipsis. Mirrors the helper
 * exported by `profile/basic/show.ts`.
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
