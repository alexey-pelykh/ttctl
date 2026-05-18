// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { payments } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handlePaymentsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl payments payouts list [--from <date>]
 * [--to <date>] [--page <number>] [--per-page <number>]`. Lists
 * historical payouts (default: most-recent first, server order).
 * Optional `--from` / `--to` filter by `createdOn` (inclusive
 * YYYY-MM-DD).
 *
 * Pagination (#373, mirrors jobs #138/#183): reads `--page` /
 * `--per-page` from the leaf's parsed options. When neither flag is
 * set, the service applies defaults (`page: 1, perPage: 20`) — the
 * same byte-shape as the pre-#373 hardcoded `offsetPagination: {
 * offset: 0, limit: 20 }`.
 *
 * Returns the payouts wrapped in the v0.4 list envelope with
 * `pageInfo: { currentPage, perPage, totalPages, hasNextPage }`. The
 * wire op also returns aggregate summary totals for the same window;
 * the CLI's `pretty` rendering surfaces them as a header line above
 * the table, while `json` / `yaml` carry the bare list shape per
 * envelope contract (the summary is intentionally NOT in the envelope
 * — it's a portal feature; if users ask for it on the wire we'll add
 * a parallel `payments payouts summary` leaf).
 */
export interface PaymentsPayoutsListOptions {
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
  output: OutputFormat;
}

export async function runPaymentsPayoutsList(opts: PaymentsPayoutsListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("payments payouts list", opts.output);

  const listOpts: payments.ListPayoutsOptions = {};
  if (opts.from !== undefined) listOpts.fromDate = opts.from;
  if (opts.to !== undefined) listOpts.toDate = opts.to;
  if (opts.page !== undefined) listOpts.page = opts.page;
  if (opts.perPage !== undefined) listOpts.perPage = opts.perPage;

  let result: payments.PayoutsListResult;
  try {
    result = await payments.payouts.list(token, listOpts);
  } catch (err) {
    handlePaymentsError("payments payouts list", err, opts.output);
  }

  const pageInfo = buildPayoutsPageInfo(result);
  emitResult(wrapListEnvelope(result.items, pageInfo), opts.output, {
    pretty: (data) => withPayoutsFooter(formatPayoutsBlock(data.items, result.summary), result),
    table: (data) => withPayoutsFooter(formatPayoutsTable(data.items), result),
    empty: { command: "payments.payouts.list" },
  });
}

/**
 * Append the offset-style pagination footer ("Page X of Y
 * (per_page=Z)") below a rendered payouts body (#373), mirroring
 * `renderJobsListPretty` in `commands/jobs/list.ts`. The footer is
 * appended ONLY when `totalCount > 0` — empty pages route through the
 * `emitResult` empty-state CTA before this closure runs, so the
 * `<= 0` guard is belt-and-suspenders.
 */
function withPayoutsFooter(body: string, result: payments.PayoutsListResult): string {
  if (result.totalCount <= 0) return body;
  return `${body}\n${formatPayoutsPageFooter(result.page, result.perPage, result.totalCount)}`;
}

/**
 * Render the pretty-format pagination footer for paginated payouts
 * lists (#373). Pure — directly unit-testable. `totalPages` is derived
 * as `Math.max(1, Math.ceil(totalCount / perPage))` so a single-page
 * result with `totalCount > 0` renders "Page 1 of 1". Parallels
 * `formatPageFooter` in `commands/jobs/shared.ts`.
 */
export function formatPayoutsPageFooter(currentPage: number, perPage: number, totalCount: number): string {
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  return `Page ${currentPage.toString()} of ${totalPages.toString()} (per_page=${perPage.toString()})`;
}

/**
 * Build the offset-style `pageInfo` block for the list envelope (#373)
 * from the service-layer's {@link payments.PayoutsListResult}. Wraps
 * the `totalPages` / `hasNextPage` arithmetic so the action handler and
 * the unit tests share one source of truth. Parallels
 * `buildJobsPageInfo` in `commands/jobs/shared.ts`.
 *
 * Pure — directly unit-testable.
 */
export function buildPayoutsPageInfo(result: payments.PayoutsListResult): {
  currentPage: number;
  perPage: number;
  totalPages: number;
  hasNextPage: boolean;
} {
  const totalPages = Math.max(1, Math.ceil(result.totalCount / result.perPage));
  return {
    currentPage: result.page,
    perPage: result.perPage,
    totalPages,
    hasNextPage: result.page < totalPages,
  };
}

/**
 * Action handler for `ttctl payments payouts show <id>`. Fetches a
 * single payout's detail by `TalentPayment.id`.
 */
export async function runPaymentsPayoutsShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("payments payouts show", output);

  let item: payments.Payout;
  try {
    item = await payments.payouts.show(token, id);
  } catch (err) {
    handlePaymentsError("payments payouts show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatPayoutDetail(data),
  });
}

/**
 * Render payouts as a header summary + cli-table3 table. `pretty`
 * combines both; `table` (the alternate emit-result mode) keeps just
 * the table for terminal-piped use.
 */
export function formatPayoutsBlock(items: payments.Payout[], summary: payments.PayoutsSummary): string {
  const lines: string[] = [];
  lines.push(
    `Paid: ${summary.totalPaid}  Due: ${summary.totalDue}  Outstanding: ${summary.totalOutstanding}  Overdue: ${summary.totalOverdue}  On hold: ${summary.totalOnHold}  Disputed: ${summary.totalDisputed}`,
  );
  lines.push("");
  lines.push(formatPayoutsTable(items));
  return lines.join("\n");
}

export function formatPayoutsTable(
  items: payments.Payout[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "number", "status", "amount", "due", "client"] });
    return empty.toString();
  }
  const idWidth = 22;
  const numberWidth = 9;
  const statusWidth = 12;
  const amountWidth = 12;
  const dueWidth = 12;
  // 6 columns × 2 padding + 7 borders ≈ 19
  const remaining = Math.max(15, terminalWidth - idWidth - numberWidth - statusWidth - amountWidth - dueWidth - 19);
  const clientWidth = Math.max(15, remaining);
  const table = new Table({
    head: ["id", "number", "status", "amount", "due", "client"],
    colWidths: [idWidth, numberWidth, statusWidth, amountWidth, dueWidth, clientWidth],
    colAligns: ["left", "right", "left", "right", "left", "left"],
    wordWrap: true,
  });
  for (const p of items) {
    table.push([
      p.id,
      p.number.toString(),
      p.status,
      p.amount,
      formatDate(p.dueDate),
      p.job?.client?.fullName ?? "(no client)",
    ]);
  }
  return table.toString();
}

/**
 * Render the single-payout detail as a sectioned multi-line block.
 */
export function formatPayoutDetail(p: payments.Payout): string {
  const lines: string[] = [];
  lines.push(`Payout ${p.id}`);
  lines.push(`  Number: ${p.number.toString()}`);
  lines.push(`  Status: ${p.status}`);
  lines.push(`  Kind:   ${p.kindCategory}`);
  lines.push(`  Amount: ${p.amount}`);
  if (p.correctionAmount !== "0" && p.correctionAmount !== "0.0" && p.correctionAmount !== "0.00") {
    lines.push(`  Correction: ${p.correctionAmount}`);
  }
  if (p.description !== null && p.description !== "") {
    lines.push(`  Description: ${p.description}`);
  }
  if (p.billingCycle !== null) {
    lines.push(`  Billing cycle: ${p.billingCycle.startDate} → ${p.billingCycle.endDate} (${p.billingCycle.id})`);
  }
  lines.push(`  Created: ${p.createdAt}`);
  lines.push(`  Updated: ${p.updatedAt}`);
  if (p.dueDate !== null) lines.push(`  Due: ${p.dueDate}`);
  if (p.paidAt !== null) lines.push(`  Paid: ${p.paidAt}`);
  if (p.paymentGroupId !== null) lines.push(`  Group ID: ${p.paymentGroupId}`);
  if (p.downloadPdfUrl !== null) lines.push(`  PDF: ${p.downloadPdfUrl}`);

  if (p.job !== null) {
    lines.push("");
    lines.push("Job");
    lines.push(`  ID: ${p.job.id}`);
    if (p.job.title !== null) lines.push(`  Title: ${p.job.title}`);
    if (p.job.client?.fullName != null) {
      lines.push(`  Client: ${p.job.client.fullName}`);
    }
  }

  if (p.memorandums.length > 0) {
    lines.push("");
    lines.push(`Memorandums (${p.memorandums.length.toString()})`);
    for (const m of p.memorandums) {
      const date = m.effectiveDate ?? "(no date)";
      lines.push(`  ${m.id}: ${date} — ${m.amount} (balance ${m.balance})`);
    }
  }

  return lines.join("\n");
}

/**
 * Format an ISO-8601 date string as YYYY-MM-DD for table compactness.
 * Returns `"—"` for `null`.
 */
export function formatDate(value: string | null): string {
  if (value === null || value === "") return "—";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m?.[1] ?? value;
}
