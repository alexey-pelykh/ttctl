// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `PaymentsByIDs` runs against mobile-gateway via `stockTransport`.
vi.mock("../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport/index.js")>("../../../transport/index.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { MAX_SHOW_MANY_IDS, showMany } from "../index.js";
import { stockTransport } from "../../../transport/index.js";
import type { TransportResponse } from "../../../transport/index.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-pmt-by-ids";

interface MockResponse {
  status?: number;
  body: unknown;
}

function reply(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedStock.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

function node(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "TalentPayment",
    id,
    number: 1,
    amount: "100.00",
    correctionAmount: "0",
    description: null,
    status: "PAID",
    kindCategory: "TALENT_PAYMENT",
    paymentGroupId: null,
    billingCycle: null,
    dueDate: null,
    paidAt: null,
    createdAt: "2026-05-01T12:00:00Z",
    updatedAt: "2026-05-01T12:00:00Z",
    downloadPdfUrl: null,
    job: null,
    memorandums: { __typename: "MemorandumsConnection", nodes: [] },
    ...overrides,
  };
}

beforeEach(() => {
  mockedStock.mockReset();
});

describe("payments.showMany (PaymentsByIDs)", () => {
  it("returns the projected payouts in INPUT order, regardless of wire order", async () => {
    // Wire returns pmt-1 then pmt-2; caller asked for [pmt-2, pmt-1].
    reply({ body: { data: { nodes: [node("pmt-1"), node("pmt-2", { amount: "200.00" })] } } });
    const out = await showMany(TOKEN, ["pmt-2", "pmt-1"]);
    expect(out.map((p) => p.id)).toEqual(["pmt-2", "pmt-1"]);
    expect(out[0]?.amount).toBe("200.00");
  });

  it("passes the id list through to the wire as PaymentsByIDs", async () => {
    reply({ body: { data: { nodes: [node("pmt-1")] } } });
    await showMany(TOKEN, ["pmt-1"]);
    const body = mockedStock.mock.calls[0]?.[0].body as { operationName: string; variables: { ids: string[] } };
    expect(body.operationName).toBe("PaymentsByIDs");
    expect(body.variables.ids).toEqual(["pmt-1"]);
  });

  it("projects the full payout shape including memorandums", async () => {
    reply({
      body: {
        data: {
          nodes: [
            node("pmt-1", {
              billingCycle: { __typename: "BillingCycle", id: "bc-1", startDate: "2026-04-01", endDate: "2026-04-30" },
              memorandums: {
                __typename: "MemorandumsConnection",
                nodes: [
                  {
                    __typename: "Memorandum",
                    id: "mem-1",
                    amount: "10.00",
                    balance: "90.00",
                    downloadPdfUrl: null,
                    effectiveDate: "2026-04-15",
                  },
                ],
              },
            }),
          ],
        },
      },
    });
    const out = await showMany(TOKEN, ["pmt-1"]);
    expect(out[0]?.billingCycle?.id).toBe("bc-1");
    expect(out[0]?.memorandums).toEqual([
      { id: "mem-1", amount: "10.00", balance: "90.00", downloadPdfUrl: null, effectiveDate: "2026-04-15" },
    ]);
  });

  it("omits ids that resolve to no node (partial result)", async () => {
    reply({ body: { data: { nodes: [node("pmt-1")] } } });
    const out = await showMany(TOKEN, ["pmt-1", "pmt-missing"]);
    expect(out.map((p) => p.id)).toEqual(["pmt-1"]);
  });

  it("filters null nodes", async () => {
    reply({ body: { data: { nodes: [node("pmt-1"), null] } } });
    const out = await showMany(TOKEN, ["pmt-1", "pmt-2"]);
    expect(out.map((p) => p.id)).toEqual(["pmt-1"]);
  });

  it("returns [] when nodes is null", async () => {
    reply({ body: { data: { nodes: null } } });
    await expect(showMany(TOKEN, ["pmt-1"])).resolves.toEqual([]);
  });

  it("rejects an empty id list without touching the wire", async () => {
    await expect(showMany(TOKEN, [])).rejects.toMatchObject({ name: "PaymentsError", code: "MISSING_INPUT" });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects more than MAX_SHOW_MANY_IDS ids without touching the wire", async () => {
    const tooMany = Array.from({ length: MAX_SHOW_MANY_IDS + 1 }, (_, i) => `pmt-${i.toString()}`);
    await expect(showMany(TOKEN, tooMany)).rejects.toMatchObject({ name: "PaymentsError", code: "MISSING_INPUT" });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("propagates a GRAPHQL_ERROR when the wire rejects the whole batch on a bad id", async () => {
    reply({ body: { data: null, errors: [{ message: 'Node id "bogus" resolves to NotFound' }] } });
    await expect(showMany(TOKEN, ["pmt-1", "bogus"])).rejects.toMatchObject({
      name: "PaymentsError",
      code: "GRAPHQL_ERROR",
    });
  });
});
