// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { loadAuthToken, profile, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { emitVisaListResult } from "./list.js";
import { handleConfigError, handleVisasError } from "./shared.js";

/**
 * Action handler for `ttctl profile visas remove <id>` (alias `rm`).
 */
export async function runProfileVisasRemove(id: string, format: OutputFormat): Promise<void> {
  const tokenPath = handleConfigError("visas remove", () => {
    const { config, path: configPath } = resolveConfig();
    return resolveAuthTokenPath({ config, configPath });
  });
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "visas remove failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  let visas: profile.visas.TravelVisa[];
  try {
    visas = await profile.visas.remove(token, id);
  } catch (err) {
    handleVisasError("visas remove", err);
    return;
  }

  emitVisaListResult(visas, format, `Travel visa ${id} removed.`);
}
