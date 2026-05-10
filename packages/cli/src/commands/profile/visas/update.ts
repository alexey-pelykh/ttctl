// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import { emitErrorAndExit } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { emitVisaListResult } from "./list.js";
import { handleVisasError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile visas update <id>`. Updates only
 * the fields supplied; rejects an empty update with `VALIDATION_ERROR`
 * via the envelope ABI (#128).
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
    emitErrorAndExit({
      operation: "profile.visas.update",
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "supply at least one field flag (--country, --type, or --expires).",
        },
      ],
      prettySummary:
        "visas update failed (VALIDATION_ERROR): supply at least one field flag (--country, --type, or --expires).",
    });
  }
  const token = await loadAuthTokenOrExit("visas update", options.output);

  let visas: profile.visas.TravelVisa[];
  try {
    visas = await profile.visas.update(token, id, changes);
  } catch (err) {
    handleVisasError("visas update", err, options.output);
    return;
  }

  emitVisaListResult(visas, options.output, "update", { prettyHeader: `Travel visa ${id} updated.` });
}
