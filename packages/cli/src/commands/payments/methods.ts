// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { payments } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handlePaymentsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl payments methods list`. Lists configured
 * payment methods. The preferred method is annotated with a leading
 * marker in pretty / table rendering.
 */
export async function runPaymentsMethodsList(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("payments methods list", output);

  let items: payments.PaymentMethod[];
  try {
    items = await payments.methods.list(token);
  } catch (err) {
    handlePaymentsError("payments methods list", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatMethodsTable(data.items),
    table: (data) => formatMethodsTable(data.items),
    empty: { command: "payments.methods.list" },
  });
}

/**
 * Action handler for `ttctl payments methods show <id>`. No
 * per-id wire op exists; the service performs a client-side filter
 * on the full methods list.
 */
export async function runPaymentsMethodsShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("payments methods show", output);

  let item: payments.PaymentMethod;
  try {
    item = await payments.methods.show(token, id);
  } catch (err) {
    handlePaymentsError("payments methods show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatMethodDetail(data),
  });
}

export function formatMethodsTable(items: payments.PaymentMethod[]): string {
  const table = new Table({
    head: ["id", "method", "preferred", "name", "extra"],
    colAligns: ["left", "left", "center", "left", "left"],
  });
  for (const m of items) {
    const extra: string[] = [];
    if (m.payoneerId !== null && m.payoneerId !== "") extra.push(`payoneer=${m.payoneerId}`);
    if (m.toptalPaymentsPending === true) extra.push("pending");
    if (m.comment !== null && m.comment !== "") extra.push(m.comment);
    table.push([m.id, m.paymentMethod, m.preferredOption ? "★" : "", m.fullName ?? "(no name)", extra.join("; ")]);
  }
  return table.toString();
}

export function formatMethodDetail(m: payments.PaymentMethod): string {
  const lines: string[] = [];
  lines.push(`Payment method ${m.id}`);
  lines.push(`  Method: ${m.paymentMethod}`);
  lines.push(`  Preferred: ${m.preferredOption ? "yes" : "no"}`);
  if (m.fullName !== null) lines.push(`  Name: ${m.fullName}`);
  if (m.payoneerId !== null && m.payoneerId !== "") lines.push(`  Payoneer ID: ${m.payoneerId}`);
  if (m.toptalPaymentsPending !== null) {
    lines.push(`  Toptal Payments pending: ${m.toptalPaymentsPending ? "yes" : "no"}`);
  }
  if (m.comment !== null && m.comment !== "") lines.push(`  Comment: ${m.comment}`);
  return lines.join("\n");
}
