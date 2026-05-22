// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { payments } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handlePaymentsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl payments summary` (#448). Reads the talent's
 * aggregate payment totals via the lightweight `GetTalentPaymentSummary`
 * query — wraps `payments.summary()`. Sibling to `payments payouts list`,
 * which returns the individual payout rows (paginated); `summary` is the
 * at-a-glance financial overview (six server-computed totals, no row
 * payload).
 */
export async function runPaymentsSummary(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("payments summary", output);

  let result: payments.PayoutsSummary;
  try {
    result = await payments.summary(token);
  } catch (err) {
    handlePaymentsError("payments summary", err, output);
  }

  emitResult(result, output, {
    pretty: (data) => formatPaymentsSummary(data),
  });
}

/**
 * Render the aggregate payment summary as a sectioned, label-aligned
 * block. `json` / `yaml` surface the bare six-field projection.
 */
export function formatPaymentsSummary(s: payments.PayoutsSummary): string {
  return [
    "Payment summary",
    `  Paid:        ${s.totalPaid}`,
    `  Due:         ${s.totalDue}`,
    `  Outstanding: ${s.totalOutstanding}`,
    `  Overdue:     ${s.totalOverdue}`,
    `  On hold:     ${s.totalOnHold}`,
    `  Disputed:    ${s.totalDisputed}`,
  ].join("\n");
}
