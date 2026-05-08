// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { emitVisaListResult } from "./list.js";
import { handleVisasError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile visas update <id>`. Updates only
 * the fields supplied; rejects an empty update with `VALIDATION_ERROR`.
 */
export async function runProfileVisasUpdate(
  id: string,
  options: { country?: string; type?: string; expires?: string; output: OutputFormat },
): Promise<void> {
  const changes: profile.visas.TravelVisaInput = {};
  if (options.country !== undefined) changes.countryId = options.country;
  if (options.type !== undefined) changes.visaType = options.type;
  if (options.expires !== undefined) changes.expiryDate = options.expires;

  if (Object.keys(changes).length === 0) {
    process.stderr.write(
      "visas update failed (VALIDATION_ERROR): supply at least one field flag (--country, --type, or --expires).\n",
    );
    process.exit(1);
  }
  const token = await loadAuthTokenOrExit("visas update");

  let visas: profile.visas.TravelVisa[];
  try {
    visas = await profile.visas.update(token, id, changes);
  } catch (err) {
    handleVisasError("visas update", err);
    return;
  }

  emitVisaListResult(visas, options.output, `Travel visa ${id} updated.`);
}
