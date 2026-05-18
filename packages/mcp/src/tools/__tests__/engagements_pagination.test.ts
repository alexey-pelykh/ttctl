// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real and override
// `engagements.list` so the tests can stub `EngagementListPage`
// outcomes without touching any transport. Same `importOriginal`
// pattern used by `jobs_pagination.test.ts` (#369) and
// `profile_basic_update.test.ts` (#52).
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    engagements: {
      ...actual.engagements,
      list: vi.fn(),
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { engagements } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerEngagementsTools } from "../engagements.js";

/**
 * MCP pagination behavior on `ttctl_engagements_list`, per issue
 * #375. Sibling to the four `ttctl_jobs_*` tools covered by
 * `jobs_pagination.test.ts` (#369) — single paginating tool rather
 * than four, but the assertions follow the same shape.
 *
 * Pinned behaviors:
 *
 *   1. `page` and `perPage` registered as optional integer fields on
 *      the input schema.
 *   2. Service call receives the forwarded options when supplied;
 *      receives no overrides when both omitted (defaults applied
 *      server-side).
 *   3. Apply-path response wraps items as `{ items, pageInfo }` with
 *      the service-returned `currentPage` / `perPage` and derived
 *      `totalPages` / `hasNextPage`.
 *   4. Dry-run preview variables carry `page` and `pageSize` (the
 *      wire argument name) mirroring the apply-path wire shape; the
 *      `DEFAULT_PAGE` / `DEFAULT_PER_PAGE` constants apply when
 *      neither input is supplied.
 *   5. Pagination + filters co-exist on the same call (the
 *      `status` / `keywords` filters and `page` / `perPage`
 *      pagination must not interfere).
 *
 * Zod validation (positive-integer constraint) is exercised by the
 * MCP framework on input parse — covered by the same shared
 * primitive `jobs_pagination.test.ts` exercises (same `PAGE_FIELD`
 * shape). These tests cover the apply path downstream of validation.
 */

const MOCKED_LIST = engagements.list as ReturnType<typeof vi.fn>;

const ITEM_FIXTURE: engagements.EngagementListItem = {
  id: "act_eng_test_001",
  engagementId: "eng_test_001",
  statusV2: { value: "WORKING", verbose: "Working" },
  statusGroupV2: { value: "ACTIVE_ENGAGEMENT", verbose: "Active" },
  statusColor: "#00cc66",
  lastUpdatedAt: "2026-04-15T12:00:00Z",
  job: {
    id: "job_test_001",
    title: "Senior TS Engineer",
    url: "https://www.toptal.com/jobs/job_test_001",
    client: { id: "client_1", fullName: "Acme Corp" },
  },
  startDate: "2026-02-01",
  endDate: null,
  expectedHours: 40,
  commitment: { slug: "FULL_TIME" },
};

function buildPageFixture(overrides: Partial<engagements.EngagementListPage> = {}): engagements.EngagementListPage {
  return {
    items: [ITEM_FIXTURE],
    totalCount: 37,
    page: 1,
    perPage: 20,
    ...overrides,
  };
}

function buildAuthSuccessCtx(token = "user_engagements_pagination_token"): ToolRegistrationContext {
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
  items: engagements.EngagementListItem[];
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

describe("ttctl_engagements_list MCP tool — pagination (#375)", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_LIST.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerEngagementsTools(server, buildAuthSuccessCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers `page` and `perPage` optional integer fields on the input schema", () => {
    const internals = server as unknown as {
      _registeredTools: Record<string, { inputSchema?: unknown }>;
    };
    const entry = internals._registeredTools["ttctl_engagements_list"];
    expect(entry).toBeDefined();
    const inputSchema = entry?.inputSchema as { shape: Record<string, unknown> } | undefined;
    expect(inputSchema?.shape["page"]).toBeDefined();
    expect(inputSchema?.shape["perPage"]).toBeDefined();
  });

  it("forwards `page` / `perPage` to the service when supplied and wraps the response as { items, pageInfo }", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 10, totalCount: 37 }));

    const handler = getToolHandler(server, "ttctl_engagements_list");
    const result = (await handler({ page: 2, perPage: 10 }, {})) as ToolSuccessShape;

    expect(MOCKED_LIST).toHaveBeenCalledTimes(1);
    const opts = MOCKED_LIST.mock.calls[0]?.[1] as engagements.ListOptions;
    expect(opts.page).toBe(2);
    expect(opts.perPage).toBe(10);

    // totalPages = ceil(37/10) = 4; hasNextPage = page(2) < totalPages(4) = true.
    const parsed = parseToolPayload<ListResponsePayload>(result);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.id).toBe(ITEM_FIXTURE.id);
    expect(parsed.pageInfo).toEqual({
      currentPage: 2,
      perPage: 10,
      totalPages: 4,
      hasNextPage: true,
    });
  });

  it("omits `page` / `perPage` from the forwarded service opts when neither input is supplied (defaults applied server-side)", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture());

    const handler = getToolHandler(server, "ttctl_engagements_list");
    await handler({}, {});

    const opts = MOCKED_LIST.mock.calls[0]?.[1] as engagements.ListOptions;
    expect(opts.page).toBeUndefined();
    expect(opts.perPage).toBeUndefined();
  });

  it("derives `hasNextPage: false` when totalPages == currentPage (last page)", async () => {
    // 21 items, perPage 20 → totalPages = ceil(21/20) = 2, page 2 = last.
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 20, totalCount: 21 }));

    const handler = getToolHandler(server, "ttctl_engagements_list");
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
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ items: [], totalCount: 0, page: 1, perPage: 20 }));

    const handler = getToolHandler(server, "ttctl_engagements_list");
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

  it("emits a dry-run preview whose variables carry `page` and `pageSize` from the forwarded opts (mirroring the apply-path wire shape)", async () => {
    const handler = getToolHandler(server, "ttctl_engagements_list");
    const result = (await handler({ status: "active", page: 3, perPage: 5, dryRun: true }, {})) as ToolSuccessShape;

    // Dry-run short-circuits before the service call.
    expect(MOCKED_LIST).not.toHaveBeenCalled();

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("JobActivityItems");
    expect(parsed.preview.variables["page"]).toBe(3);
    expect(parsed.preview.variables["pageSize"]).toBe(5);
    expect(parsed.preview.variables["onlyStatusGroupFilter"]).toEqual(["ACTIVE_ENGAGEMENT"]);
  });

  it("emits a dry-run preview whose variables carry the DEFAULT `page: 1` / `pageSize: 20` when neither pagination input is supplied", async () => {
    const handler = getToolHandler(server, "ttctl_engagements_list");
    const result = (await handler({ dryRun: true }, {})) as ToolSuccessShape;

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.preview.variables["page"]).toBe(engagements.DEFAULT_PAGE);
    expect(parsed.preview.variables["pageSize"]).toBe(engagements.DEFAULT_PER_PAGE);
  });

  // Guards against a regression where forwarding `page` / `perPage`
  // accidentally drops the filter args (status / keywords) on the
  // apply path.
  it("forwards pagination AND filter args together on the apply path", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 15, totalCount: 30 }));

    const handler = getToolHandler(server, "ttctl_engagements_list");
    await handler({ status: "past", keywords: ["acme"], page: 2, perPage: 15 }, {});

    const opts = MOCKED_LIST.mock.calls[0]?.[1] as engagements.ListOptions;
    expect(opts.status).toBe("past");
    expect(opts.keywords).toEqual(["acme"]);
    expect(opts.page).toBe(2);
    expect(opts.perPage).toBe(15);
  });

  it("forwards filters AND pagination together on the dry-run path (status=all, keywords, page, perPage)", async () => {
    const handler = getToolHandler(server, "ttctl_engagements_list");
    const result = (await handler(
      { status: "all", keywords: ["acme", "widget"], page: 4, perPage: 8, dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.preview.variables["keywords"]).toEqual(["acme", "widget"]);
    expect(parsed.preview.variables["onlyStatusGroupFilter"]).toEqual(["ACTIVE_ENGAGEMENT", "CLOSED_ENGAGEMENT"]);
    expect(parsed.preview.variables["page"]).toBe(4);
    expect(parsed.preview.variables["pageSize"]).toBe(8);
  });
});
