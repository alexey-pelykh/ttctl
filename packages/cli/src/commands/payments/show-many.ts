// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { payments } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatPayoutDetail } from "./payouts.js";
import { handlePaymentsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl payments show-many <id...>`.
 * Batch-fetches several payouts in one wire round-trip via
 * `payments.showMany` (`PaymentsByIDs`), emitting the found payouts in
 * input order. Ids that resolve to no payout are reported (pretty: a
 * trailing "Not found" line; json / yaml consumers diff the returned
 * `id`s against their input).
 */
export async function runPaymentsShowMany(ids: string[], output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("payments show-many", output);

  let items: payments.Payout[];
  try {
    items = await payments.showMany(token, ids);
  } catch (err) {
    handlePaymentsError("payments show-many", err, output);
  }

  const found = new Set(items.map((p) => p.id));
  const missing = ids.filter((id) => !found.has(id));
  emitResult(items, output, {
    pretty: (data) => formatPayoutDetails(data, missing),
  });
}

/**
 * Render several payout detail views as one pretty block — each payout's
 * {@link formatPayoutDetail} output separated by a horizontal rule, with a
 * trailing "Not found" line listing any requested ids the API did not
 * return. Pure — directly unit-testable.
 */
export function formatPayoutDetails(items: payments.Payout[], missing: string[]): string {
  const blocks = items.map(formatPayoutDetail);
  if (missing.length > 0) {
    blocks.push(`Not found (${missing.length.toString()}): ${missing.join(", ")}`);
  }
  if (blocks.length === 0) return "No payments found.";
  return blocks.join("\n\n————————————————————————————————\n\n");
}
