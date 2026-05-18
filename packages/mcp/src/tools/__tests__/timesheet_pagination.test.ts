// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real and override
// `timesheet.list` so the tests can stub `TimesheetListPage` outcomes
// without touching any transport. Same pattern as `jobs_pagination.test.ts`
// (#369) — see there for the importOriginal rationale.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    timesheet: {
      ...actual.timesheet,
      list: vi.fn(),
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { timesheet } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerTimesheetTools } from "../timesheet.js";

/**
 * MCP pagination behavior on `ttctl_timesheet_list` per issue #374.
 *
 * Pre-#374 the tool accepted only `engagement` and unwrapped
 * `TimesheetListItem[]` directly. Post-#374 the tool accepts optional
 * `page` / `perPage` (positive integers, defaults applied server-side
 * by core), forwards them to `timesheet.list()`, and surfaces the
 * response as `{ items, pageInfo }` so LLM callers can detect
 * `hasNextPage` and iterate.
 *
 * **Subset envelope**: `pageInfo` carries `currentPage` + `perPage` +
 * `hasNextPage` but NOT `totalPages` — the wire `BillingCycleConnection`
 * has no `totalCount` field, so the offset envelope is the documented
 * subset. `hasNextPage` is the heuristic `items.length === perPage`.
 *
 * Pinned behaviors:
 *
 *   1. `page` and `perPage` registered as optional integer fields on
 *      the input schema.
 *   2. Service call receives the forwarded options when supplied;
 *      receives no overrides when both omitted (defaults applied
 *      server-side).
 *   3. Apply-path response wraps items as `{ items, pageInfo }` with
 *      the service-returned `currentPage` / `perPage` and the
 *      `hasNextPage` heuristic; `totalPages` is OMITTED.
 *   4. Dry-run preview variables carry `limit` and `offset` (the wire
 *      argument names) derived from page/perPage. Both wire variants
 *      (`PendingTimesheets`, `Timesheets`) carry pagination per #374.
 */

const MOCKED_LIST = timesheet.list as ReturnType<typeof vi.fn>;

const LIST_ITEM_FIXTURE: timesheet.TimesheetListItem = {
  id: "bc_test_001",
  startDate: "2026-05-01",
  endDate: "2026-05-15",
  hours: "40.0",
  minimumCommitment: { applicable: true, minimumHours: 20, reasonNotApplicable: null },
  timesheetOverdue: false,
  timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
  timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
  timesheetSubmitted: false,
  engagement: {
    id: "eng_1",
    job: {
      id: "job_1",
      title: "Senior Backend Engineer",
      client: { id: "cli_1", fullName: "Acme Inc." },
    },
  },
};

function buildPageFixture(overrides: Partial<timesheet.TimesheetListPage> = {}): timesheet.TimesheetListPage {
  return {
    items: [LIST_ITEM_FIXTURE],
    page: 1,
    perPage: 50,
    ...overrides,
  };
}

function buildAuthSuccessCtx(token = "user_timesheet_pagination_token"): ToolRegistrationContext {
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
  items: timesheet.TimesheetListItem[];
  pageInfo: { currentPage: number; perPage: number; hasNextPage: boolean };
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

describe("ttctl_timesheet_list — pagination (#374)", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_LIST.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerTimesheetTools(server, buildAuthSuccessCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers `page` and `perPage` optional integer fields on the input schema", () => {
    const internals = server as unknown as {
      _registeredTools: Record<string, { inputSchema?: unknown }>;
    };
    const entry = internals._registeredTools["ttctl_timesheet_list"];
    expect(entry).toBeDefined();
    const inputSchema = entry?.inputSchema as { shape: Record<string, unknown> } | undefined;
    expect(inputSchema?.shape["page"]).toBeDefined();
    expect(inputSchema?.shape["perPage"]).toBeDefined();
  });

  it("forwards `page` / `perPage` to the service and wraps response as { items, pageInfo }", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 10 }));

    const handler = getToolHandler(server, "ttctl_timesheet_list");
    const result = (await handler({ page: 2, perPage: 10 }, {})) as ToolSuccessShape;

    expect(MOCKED_LIST).toHaveBeenCalledTimes(1);
    const opts = MOCKED_LIST.mock.calls[0]?.[1] as timesheet.ListOptions;
    expect(opts.page).toBe(2);
    expect(opts.perPage).toBe(10);

    const parsed = parseToolPayload<ListResponsePayload>(result);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.id).toBe(LIST_ITEM_FIXTURE.id);
    // pageInfo is the SUBSET envelope — no totalPages.
    expect(parsed.pageInfo).toEqual({ currentPage: 2, perPage: 10, hasNextPage: false });
    expect("totalPages" in parsed.pageInfo).toBe(false);
  });

  it("forwards `engagement` alongside pagination", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture());

    const handler = getToolHandler(server, "ttctl_timesheet_list");
    await handler({ engagement: "act_xyz", page: 3, perPage: 5 }, {});

    const opts = MOCKED_LIST.mock.calls[0]?.[1] as timesheet.ListOptions;
    expect(opts.engagement).toBe("act_xyz");
    expect(opts.page).toBe(3);
    expect(opts.perPage).toBe(5);
  });

  it("omits `page` / `perPage` from forwarded opts when neither input is supplied (defaults applied server-side)", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture());

    const handler = getToolHandler(server, "ttctl_timesheet_list");
    await handler({}, {});

    const opts = MOCKED_LIST.mock.calls[0]?.[1] as timesheet.ListOptions;
    expect(opts.page).toBeUndefined();
    expect(opts.perPage).toBeUndefined();
  });

  it("hasNextPage = true when items.length === perPage (full page)", async () => {
    const fullItems = Array.from({ length: 3 }, (_, i) => ({ ...LIST_ITEM_FIXTURE, id: `bc_${i.toString()}` }));
    MOCKED_LIST.mockResolvedValueOnce({ items: fullItems, page: 1, perPage: 3 });

    const handler = getToolHandler(server, "ttctl_timesheet_list");
    const result = (await handler({ page: 1, perPage: 3 }, {})) as ToolSuccessShape;

    const parsed = parseToolPayload<ListResponsePayload>(result);
    expect(parsed.pageInfo.hasNextPage).toBe(true);
  });

  it("hasNextPage = false on an empty page", async () => {
    MOCKED_LIST.mockResolvedValueOnce({ items: [], page: 1, perPage: 50 });

    const handler = getToolHandler(server, "ttctl_timesheet_list");
    const result = (await handler({}, {})) as ToolSuccessShape;

    const parsed = parseToolPayload<ListResponsePayload>(result);
    expect(parsed.items).toEqual([]);
    expect(parsed.pageInfo).toEqual({ currentPage: 1, perPage: 50, hasNextPage: false });
  });

  it("dry-run viewer-wide → PendingTimesheets preview with explicit limit/offset", async () => {
    const handler = getToolHandler(server, "ttctl_timesheet_list");
    const result = (await handler({ page: 3, perPage: 10, dryRun: true }, {})) as ToolSuccessShape;

    // Dry-run path MUST short-circuit before the service call.
    expect(MOCKED_LIST).not.toHaveBeenCalled();

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("PendingTimesheets");
    // page 3, perPage 10 → limit = 10, offset = (3-1)*10 = 20
    expect(parsed.preview.variables["limit"]).toBe(10);
    expect(parsed.preview.variables["offset"]).toBe(20);
  });

  it("dry-run engagement-scoped → Timesheets preview with jobActivityItemId + limit + offset", async () => {
    const handler = getToolHandler(server, "ttctl_timesheet_list");
    const result = (await handler({ engagement: "act_xyz", dryRun: true }, {})) as ToolSuccessShape;

    expect(MOCKED_LIST).not.toHaveBeenCalled();
    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.preview.operationName).toBe("Timesheets");
    expect(parsed.preview.variables["jobActivityItemId"]).toBe("act_xyz");
    // Defaults: page 1, perPage 50 → limit = 50, offset = 0
    expect(parsed.preview.variables["limit"]).toBe(timesheet.DEFAULT_PER_PAGE);
    expect(parsed.preview.variables["offset"]).toBe(0);
  });

  it("dry-run defaults: page 1, perPage 50 → limit/offset reflect timesheet.DEFAULT_*", async () => {
    const handler = getToolHandler(server, "ttctl_timesheet_list");
    const result = (await handler({ dryRun: true }, {})) as ToolSuccessShape;

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.preview.operationName).toBe("PendingTimesheets");
    expect(parsed.preview.variables["limit"]).toBe(timesheet.DEFAULT_PER_PAGE);
    expect(parsed.preview.variables["offset"]).toBe(0);
  });
});
