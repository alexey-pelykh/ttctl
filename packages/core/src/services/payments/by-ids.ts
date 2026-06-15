// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { callGatewayShared } from "../_shared/transport.js";
import { PaymentsError } from "./index.js";
import type { Payout } from "./index.js";

/** Upper bound on the id list accepted by {@link showMany} — anti-automation friction. */
export const MAX_SHOW_MANY_IDS = 20 as const;

// Relay batch sibling of the singular `Payment` op (`node(id:)`, = `payouts.show`).
// Selects the same `paymentFields` selection as `PAYMENT_QUERY` in ./index.ts; keep
// the two in sync — the committed `PaymentsByIDs.snapshot.json` guards the field set.
const PAYMENTS_BY_IDS_QUERY = `query PaymentsByIDs($ids: [ID!]!) { nodes(ids: $ids) { __typename ... on TalentPayment { ...paymentFields } } }  fragment paymentFields on TalentPayment { __typename amount correctionAmount billingCycle { __typename id endDate startDate } description job { __typename id title client { __typename id fullName } } memorandums { __typename nodes { __typename amount balance downloadPdfUrl effectiveDate id } } kindCategory paymentGroupId createdAt updatedAt downloadPdfUrl dueDate paidAt id number status }`;

interface WireMemorandumNode {
  id: string;
  amount: string;
  balance: string;
  downloadPdfUrl: string | null;
  effectiveDate: string | null;
}

// Mirrors the private `WirePayment` shape in ./index.ts (the `node`/`nodes`
// surface returns the same `TalentPayment` fields). Re-declared rather than
// imported to keep ./index.ts's wire interfaces private; the projection below
// returns the shared `Payout`, so any field added to `Payout` is compiler-caught.
interface WirePaymentNode {
  id: string;
  number: number;
  amount: string;
  correctionAmount: string;
  description: string | null;
  status: string;
  kindCategory: string;
  paymentGroupId: number | null;
  billingCycle: { id: string; startDate: string; endDate: string } | null;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  downloadPdfUrl: string | null;
  job: { id: string; title: string | null; client: { id: string; fullName: string | null } | null } | null;
  memorandums: { nodes: (WireMemorandumNode | null)[] | null } | null;
}

interface PaymentsByIdsResponse {
  nodes: (WirePaymentNode | null)[] | null;
}

function projectNode(wire: WirePaymentNode): Payout {
  const memos = (wire.memorandums?.nodes ?? []).filter((m): m is WireMemorandumNode => m !== null);
  return {
    id: wire.id,
    number: wire.number,
    amount: wire.amount,
    correctionAmount: wire.correctionAmount,
    description: wire.description,
    status: wire.status,
    kindCategory: wire.kindCategory,
    paymentGroupId: wire.paymentGroupId,
    billingCycle: wire.billingCycle,
    dueDate: wire.dueDate,
    paidAt: wire.paidAt,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    downloadPdfUrl: wire.downloadPdfUrl,
    job: wire.job,
    memorandums: memos.map((m) => ({
      id: m.id,
      amount: m.amount,
      balance: m.balance,
      downloadPdfUrl: m.downloadPdfUrl,
      effectiveDate: m.effectiveDate,
    })),
  };
}

/**
 * Batch-fetch payouts by `TalentPayment.id` — the bulk sibling of
 * `payouts.show` (`Payment` / `node(id:)`), wrapping mobile-gateway
 * `PaymentsByIDs` (`nodes(ids:)`). Returns the found payouts in INPUT
 * order: the result is re-ordered client-side by matching each requested
 * id against the returned `id`.
 *
 * Throws `PaymentsError("MISSING_INPUT")` for an empty list or more than
 * {@link MAX_SHOW_MANY_IDS} ids.
 *
 * Unresolvable-id handling is wire-determined (verified live): an id the
 * wire resolves to no node is omitted from the result (partial fetch),
 * but a malformed/undecodable global id makes the gateway reject the WHOLE
 * batch with a `GRAPHQL_ERROR`, which propagates verbatim. Callers passing
 * untrusted ids must handle either outcome.
 */
export async function showMany(token: string, ids: string[]): Promise<Payout[]> {
  if (ids.length === 0) {
    throw new PaymentsError("MISSING_INPUT", "showMany requires at least one payment id.");
  }
  if (ids.length > MAX_SHOW_MANY_IDS) {
    throw new PaymentsError(
      "MISSING_INPUT",
      `showMany accepts at most ${MAX_SHOW_MANY_IDS.toString()} ids (got ${ids.length.toString()}).`,
    );
  }
  const data = await callGatewayShared<PaymentsByIdsResponse, PaymentsError>(
    "mobile-gateway",
    token,
    "PaymentsByIDs",
    PAYMENTS_BY_IDS_QUERY,
    { ids },
    PaymentsError,
  );
  const byId = new Map<string, Payout>();
  for (const node of data.nodes ?? []) {
    if (node === null) continue;
    byId.set(node.id, projectNode(node));
  }
  const out: Payout[] = [];
  for (const id of ids) {
    const payout = byId.get(id);
    if (payout !== undefined) out.push(payout);
  }
  return out;
}
