// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";

import type { OutputFormat } from "../../../lib/output.js";
import { emitVisaListResult } from "./list.js";
import { handleVisasError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile visas remove <id>` (alias `rm`).
 */
export async function runProfileVisasRemove(id: string, format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("visas remove");

  let visas: profile.visas.TravelVisa[];
  try {
    visas = await profile.visas.remove(token, id);
  } catch (err) {
    handleVisasError("visas remove", err);
    return;
  }

  emitVisaListResult(visas, format, `Travel visa ${id} removed.`);
}
