// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { engagements } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import type { EnvelopePageInfo } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatDate } from "./list.js";
import { handleEngagementsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl engagements payments list <job-id>`. Lists
 * the payments under an engagement, addressed by its JOB id (the wire
 * op `GetEngagementPayments` takes `$jobId` — see core
 * `engagements.payments.list`).
 *
 * Pagination is ADR-007 row 4 (limit + forward cursor): `--limit` caps
 * the page; `--after <id>` is a forward cursor that IS a payment id. The
 * JSON / YAML envelope carries `pageInfo` with `hasNextPage` (and
 * `perPage` when `--limit` is set) — cursor pagination has no page
 * numbers, so `currentPage` / `totalPages` are intentionally omitted.
 * The pretty footer shows the total count and the next-page cursor.
 */
export interface EngagementsPaymentsListOptions {
  limit?: number;
  after?: string;
  output: OutputFormat;
}

export async function runEngagementsPaymentsList(jobId: string, opts: EngagementsPaymentsListOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements payments list", opts.output);

  const listOpts: engagements.EngagementPaymentsListOptions = {};
  if (opts.limit !== undefined) listOpts.limit = opts.limit;
  if (opts.after !== undefined) listOpts.after = opts.after;

  let page: engagements.EngagementPaymentsPage;
  try {
    page = await engagements.payments.list(token, jobId, listOpts);
  } catch (err) {
    handleEngagementsError("engagements payments list", err, opts.output);
  }

  const pageInfo: EnvelopePageInfo = { hasNextPage: page.nextCursor !== null };
  if (page.limit !== null) pageInfo.perPage = page.limit;
  emitResult(wrapListEnvelope(page.items, pageInfo), opts.output, {
    pretty: () => renderPaymentsPretty(page),
    table: () => renderPaymentsPretty(page),
    empty: { command: "engagements.payments.list" },
  });
}

/**
 * Render the payments table plus the cursor footer. The footer is
 * appended only when `totalCount > 0` — empty pages route through the
 * empty-state CTA before this renderer fires.
 */
function renderPaymentsPretty(page: engagements.EngagementPaymentsPage): string {
  const table = formatPaymentsTable(page.items);
  if (page.totalCount <= 0) return table;
  return `${table}\n${formatPaymentsFooter(page)}`;
}

/**
 * Cursor-style footer: "N shown · M total" plus the `--after` hint when
 * another page is available. Pure — directly unit-testable.
 */
export function formatPaymentsFooter(page: engagements.EngagementPaymentsPage): string {
  const base = `${page.items.length.toString()} shown · ${page.totalCount.toString()} total`;
  return page.nextCursor !== null ? `${base} · more: --after ${page.nextCursor}` : base;
}

/**
 * Render the payments list as a `cli-table3` table sized to the terminal
 * width. Columns: id (the cursor for `--after`), number, status, amount,
 * due, paid. Money values are decimal strings emitted verbatim — no
 * locale formatting, no rounding (parse with a decimal library, never
 * `parseFloat`).
 */
export function formatPaymentsTable(
  items: engagements.EngagementPayment[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  const head = ["id", "number", "status", "amount", "due", "paid"];
  if (items.length === 0) {
    return new Table({ head }).toString();
  }
  const idWidth = 22;
  const numberWidth = 10;
  const statusWidth = 12;
  const amountWidth = 14;
  const dueWidth = 12;
  // 6 columns × 2 padding + 7 borders ≈ 19
  const paidWidth = Math.max(12, terminalWidth - idWidth - numberWidth - statusWidth - amountWidth - dueWidth - 19);
  const table = new Table({
    head,
    colWidths: [idWidth, numberWidth, statusWidth, amountWidth, dueWidth, paidWidth],
    colAligns: ["left", "right", "left", "right", "left", "left"],
    wordWrap: true,
  });
  for (const p of items) {
    table.push([p.id, p.number.toString(), p.status, p.amount, formatDate(p.dueDate), formatDate(p.paidAt)]);
  }
  return table.toString();
}
