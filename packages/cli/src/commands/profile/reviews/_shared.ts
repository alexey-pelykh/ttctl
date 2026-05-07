// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Shared helpers for `ttctl profile reviews` leaves.
 *
 * Mirrors `cli/src/commands/profile/external/_shared.ts` — see that file
 * for the rationale on co-locating these helpers in the sub-tree rather
 * than promoting to `cli/src/lib/`.
 */

import { ConfigError, loadAuthToken, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";

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

export function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, width - 1)}…`;
}
