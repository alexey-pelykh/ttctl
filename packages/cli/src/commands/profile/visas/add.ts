// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { loadAuthToken, profile, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { emitVisaListResult } from "./list.js";
import { handleConfigError, handleVisasError } from "./shared.js";

/**
 * Action handler for `ttctl profile visas add`. Both `--country` (id)
 * and `--type` are required; `--expires` is optional.
 *
 * The `--issued` flag is reserved for future server support — empirically
 * `TravelVisa` does not surface an `issued` field on the read side, and
 * the inferred `TravelVisaInput` shape excludes it. We accept the flag
 * to avoid breaking script consumers that pre-populate it, but log a
 * stderr warning that it is currently silently dropped.
 */
export async function runProfileVisasAdd(options: {
  country: string;
  type: string;
  issued?: string;
  expires?: string;
  output: OutputFormat;
}): Promise<void> {
  if (options.issued !== undefined) {
    process.stderr.write(
      "warning: --issued is reserved (server has no `issuedDate` field on TravelVisaInput today); flag ignored.\n",
    );
  }

  const tokenPath = handleConfigError("visas add", () => {
    const { config, path: configPath } = resolveConfig();
    return resolveAuthTokenPath({ config, configPath });
  });
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "visas add failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  const input: profile.visas.TravelVisaInput = {
    countryId: options.country,
    visaType: options.type,
  };
  if (options.expires !== undefined) input.expiryDate = options.expires;

  let visas: profile.visas.TravelVisa[];
  try {
    visas = await profile.visas.add(token, input);
  } catch (err) {
    handleVisasError("visas add", err);
    return;
  }

  emitVisaListResult(visas, options.output, "Travel visa added.");
}
