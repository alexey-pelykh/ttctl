// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Shared helpers for `ttctl profile reviews` leaves.
 *
 * Re-exports `loadAuthTokenOrExit` from the parent `../shared.ts` (post-#107
 * unification — see that file's comment for the in-memory token rationale).
 */

export { loadAuthTokenOrExit } from "../shared.js";

export function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, width - 1)}…`;
}
