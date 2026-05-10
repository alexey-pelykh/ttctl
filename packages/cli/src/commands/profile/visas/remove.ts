// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { emitVisaListResult } from "./list.js";
import { handleVisasError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile visas remove <id>` (alias `rm`).
 * Emits the v0.4 envelope (#128); the post-mutation list still renders
 * after the success line in pretty mode.
 */
export async function runProfileVisasRemove(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("visas remove", format);

  let visas: profile.visas.TravelVisa[];
  try {
    visas = await profile.visas.remove(token, id);
  } catch (err) {
    handleVisasError("visas remove", err, format);
    return;
  }

  emitVisaListResult(visas, format, "remove", { id, prettyHeader: id });
}
