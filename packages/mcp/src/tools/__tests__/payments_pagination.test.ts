// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real and override
// `payments.payouts.list` only so the tests can stub `PayoutsListResult`
// outcomes without touching any transport. Same pattern as
// `jobs_pagination.test.ts` for #369/#376 — see there for the
// importOriginal rationale.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    payments: {
      ...actual.payments,
      payouts: {
        ...actual.payments.payouts,
        list: vi.fn(),
      },
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { payments } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerPaymentsTools } from "../payments.js";

/**
 * MCP pagination behavior on `ttctl_payments_payouts_list` (#373) —
 * the payments-side sibling of the four jobs read-list tools paginated
 * in #369/#376.
 *
 * Pre-#373 the tool accepted `fromDate`/`toDate` only and returned the
 * full `PayoutsListResult` (`{ items, summary }`) capped at the wire's
 * hard-coded 20 records. Post-#373 the tool accepts optional `page` /
 * `perPage` (positive integers, defaults applied server-side by the
 * core), forwards them to `payments.payouts.list()`, and wraps the
 * response as `{ items, summary, pageInfo }` so LLM callers can detect
 * `hasNextPage` and iterate. The `summary` field is preserved from the
 * pre-#373 payload (payouts-specific aggregate).
 *
 * Pinned behaviors:
 *
 *   1. `page` and `perPage` registered as optional integer fields on
 *      the input schema.
 *   2. Service call receives the forwarded options when supplied
 *      (`{ page, perPage }`); receives no overrides when both omitted
 *      (defaults applied server-side via `payments.DEFAULT_PAGE` /
 *      `payments.DEFAULT_PER_PAGE`).
 *   3. Apply-path response wraps payload as `{ items, summary,
 *      pageInfo }` with the service-returned `currentPage` / `perPage`
 *      and derived `totalPages` / `hasNextPage`.
 *   4. Dry-run preview variables carry resolved `offset` (= `(page-1) *
 *      perPage`) and `limit` (= `perPage`) — the wire argument names —
 *      mirroring the apply-path wire shape.
 *
 * Zod validation (positive-integer constraint) is exercised by the MCP
 * framework on input parse — the tests cover the apply path downstream
 * of validation.
 */

const MOCKED_LIST = payments.payouts.list as ReturnType<typeof vi.fn>;

const PAYOUT_FIXTURE: payments.Payout = {
  id: "pmt-1",
  number: 42,
  amount: "1234.56",
  correctionAmount: "0",
  description: "April payout",
  status: "PAID",
  kindCategory: "TALENT_PAYMENT",
  paymentGroupId: 1,
  billingCycle: { id: "bc-1", startDate: "2026-04-01", endDate: "2026-04-30" },
  dueDate: "2026-05-15",
  paidAt: "2026-05-10T12:00:00Z",
  createdAt: "2026-05-01T12:00:00Z",
  updatedAt: "2026-05-10T12:00:00Z",
  downloadPdfUrl: "https://example.com/payout.pdf",
  job: { id: "job-1", title: "Senior Engineer", client: { id: "cli-1", fullName: "Acme Inc." } },
  memorandums: [],
};

const SUMMARY_FIXTURE: payments.PayoutsSummary = {
  totalDisputed: "0",
  totalDue: "1234.56",
  totalOnHold: "0",
  totalOutstanding: "1234.56",
  totalOverdue: "0",
  totalPaid: "5000.00",
};

function buildResultFixture(overrides: Partial<payments.PayoutsListResult> = {}): payments.PayoutsListResult {
  return {
    items: [PAYOUT_FIXTURE],
    summary: SUMMARY_FIXTURE,
    totalCount: 37,
    page: 1,
    perPage: 20,
    ...overrides,
  };
}

function buildAuthSuccessCtx(token = "user_payments_pagination_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true as const, token }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token }),
  };
}

function getToolHandler(server: McpServer, name: string): (input: unknown, extra: unknown) => Promise<unknown> {
  const internals = server as unknown as { _registeredTools: Record<string, { handler: unknown }> };
  const entry = internals._registeredTools[name];
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry.handler as (input: unknown, extra: unknown) => Promise<unknown>;
}

interface ToolSuccessShape {
  content: { type: string; text: string }[];
}

interface ListResponsePayload {
  items: payments.Payout[];
  summary: payments.PayoutsSummary;
  pageInfo: { currentPage: number; perPage: number; totalPages: number; hasNextPage: boolean };
}

interface DryRunEnvelope {
  ok: true;
  dryRun: true;
  preview: { operationName: string; variables: Record<string, unknown> };
}

function parseToolPayload<T>(result: ToolSuccessShape): T {
  const text = result.content[0]?.text ?? "";
  return JSON.parse(text) as T;
}

describe("ttctl_payments_payouts_list MCP tool — pagination (#373)", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_LIST.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerPaymentsTools(server, buildAuthSuccessCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers `page` and `perPage` optional integer fields on the input schema", () => {
    const internals = server as unknown as {
      _registeredTools: Record<string, { inputSchema?: unknown }>;
    };
    const entry = internals._registeredTools["ttctl_payments_payouts_list"];
    expect(entry).toBeDefined();
    const inputSchema = entry?.inputSchema as { shape: Record<string, unknown> } | undefined;
    expect(inputSchema?.shape["page"]).toBeDefined();
    expect(inputSchema?.shape["perPage"]).toBeDefined();
  });

  it("forwards `page` / `perPage` to the service and wraps the response as { items, summary, pageInfo }", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildResultFixture({ page: 2, perPage: 10, totalCount: 37 }));

    const handler = getToolHandler(server, "ttctl_payments_payouts_list");
    const result = (await handler({ page: 2, perPage: 10 }, {})) as ToolSuccessShape;

    // Service received the forwarded pagination opts (last positional
    // arg is `ListPayoutsOptions`; first is the bearer token).
    expect(MOCKED_LIST).toHaveBeenCalledTimes(1);
    const opts = MOCKED_LIST.mock.calls[0]?.[1] as payments.ListPayoutsOptions;
    expect(opts.page).toBe(2);
    expect(opts.perPage).toBe(10);

    // Tool result is the `{ items, summary, pageInfo }` wrapper.
    // totalPages = ceil(37/10) = 4; hasNextPage = page(2) < totalPages(4) = true.
    const parsed = parseToolPayload<ListResponsePayload>(result);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.id).toBe(PAYOUT_FIXTURE.id);
    expect(parsed.summary.totalPaid).toBe(SUMMARY_FIXTURE.totalPaid);
    expect(parsed.pageInfo).toEqual({
      currentPage: 2,
      perPage: 10,
      totalPages: 4,
      hasNextPage: true,
    });
  });

  it("omits `page` / `perPage` from the forwarded service opts when neither input is supplied (defaults applied server-side)", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildResultFixture());

    const handler = getToolHandler(server, "ttctl_payments_payouts_list");
    await handler({}, {});

    const opts = MOCKED_LIST.mock.calls[0]?.[1] as payments.ListPayoutsOptions;
    expect(opts.page).toBeUndefined();
    expect(opts.perPage).toBeUndefined();
  });

  it("derives `hasNextPage: false` when totalPages == currentPage (last page)", async () => {
    // 21 items, perPage 20 → totalPages = ceil(21/20) = 2, page 2 = last.
    MOCKED_LIST.mockResolvedValueOnce(buildResultFixture({ page: 2, perPage: 20, totalCount: 21 }));

    const handler = getToolHandler(server, "ttctl_payments_payouts_list");
    const result = (await handler({ page: 2, perPage: 20 }, {})) as ToolSuccessShape;

    const parsed = parseToolPayload<ListResponsePayload>(result);
    expect(parsed.pageInfo).toEqual({
      currentPage: 2,
      perPage: 20,
      totalPages: 2,
      hasNextPage: false,
    });
  });

  it("clamps `totalPages` to a minimum of 1 when totalCount is 0 (empty page)", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildResultFixture({ items: [], totalCount: 0, page: 1, perPage: 20 }));

    const handler = getToolHandler(server, "ttctl_payments_payouts_list");
    const result = (await handler({}, {})) as ToolSuccessShape;

    const parsed = parseToolPayload<ListResponsePayload>(result);
    expect(parsed.items).toEqual([]);
    expect(parsed.pageInfo).toEqual({
      currentPage: 1,
      perPage: 20,
      totalPages: 1,
      hasNextPage: false,
    });
  });

  it("emits a dry-run preview whose variables carry resolved `offset` and `limit` from the forwarded opts (mirroring the apply-path wire shape)", async () => {
    const handler = getToolHandler(server, "ttctl_payments_payouts_list");
    const result = (await handler({ page: 3, perPage: 5, dryRun: true }, {})) as ToolSuccessShape;

    // Dry-run path short-circuits before the service call — verify
    // the service was NOT invoked.
    expect(MOCKED_LIST).not.toHaveBeenCalled();

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("Payments");
    // page 3, perPage 5 → offset = (3-1)*5 = 10, limit = 5.
    expect(parsed.preview.variables["offset"]).toBe(10);
    expect(parsed.preview.variables["limit"]).toBe(5);
    // No filters supplied → `filters: null` (apply-path coercion).
    expect(parsed.preview.variables["filters"]).toBeNull();
  });

  it("emits a dry-run preview whose variables carry the DEFAULT `offset: 0` / `limit: 20` when neither pagination input is supplied", async () => {
    const handler = getToolHandler(server, "ttctl_payments_payouts_list");
    const result = (await handler({ dryRun: true }, {})) as ToolSuccessShape;

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    // DEFAULT_PAGE=1, DEFAULT_PER_PAGE=20 → offset = (1-1)*20 = 0, limit = 20.
    expect(parsed.preview.variables["offset"]).toBe(0);
    expect(parsed.preview.variables["limit"]).toBe(payments.DEFAULT_PER_PAGE);
  });

  it("carries pagination AND filters together on both apply and dry-run paths (coexistence)", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildResultFixture({ page: 2, perPage: 15, totalCount: 60 }));

    const handler = getToolHandler(server, "ttctl_payments_payouts_list");

    // Apply path — both threaded to service opts.
    await handler({ fromDate: "2026-01-01", toDate: "2026-04-30", page: 2, perPage: 15 }, {});
    const opts = MOCKED_LIST.mock.calls[0]?.[1] as payments.ListPayoutsOptions;
    expect(opts.fromDate).toBe("2026-01-01");
    expect(opts.toDate).toBe("2026-04-30");
    expect(opts.page).toBe(2);
    expect(opts.perPage).toBe(15);

    // Dry-run path — both reflected in preview variables.
    const dryResult = (await handler(
      { fromDate: "2026-01-01", toDate: "2026-04-30", page: 2, perPage: 15, dryRun: true },
      {},
    )) as ToolSuccessShape;
    const parsed = parseToolPayload<DryRunEnvelope>(dryResult);
    expect(parsed.preview.variables["filters"]).toEqual({
      createdOn: { from: "2026-01-01", to: "2026-04-30" },
    });
    expect(parsed.preview.variables["offset"]).toBe(15);
    expect(parsed.preview.variables["limit"]).toBe(15);
  });
});
