// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real and override
// only `applications.list` so the tests can stub JobActivityListPage
// outcomes without touching any transport. Same pattern as
// `jobs_pagination.test.ts` (#369) — the spread preserves
// `applications.DEFAULT_PAGE` / `DEFAULT_PER_PAGE` / `STATUS_GROUPS` /
// `ApplicationsError`, which the tool's dry-run + error paths use.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    applications: {
      ...actual.applications,
      list: vi.fn(),
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applications } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerApplicationsTools } from "../applications.js";

/**
 * MCP pagination behavior on `ttctl_applications_list`, per issue #377
 * (the deferred applications half of #369 — sibling of the four
 * `ttctl_jobs_*` paginating tools).
 *
 * Pre-#377 the tool accepted no pagination parameters and emitted a
 * bare `JobActivityItem[]`. Post-#377 it accepts optional `page` /
 * `perPage` (positive integers, defaults applied server-side by the
 * core), forwards them to `applications.list()`, and surfaces the
 * response as `{ items, pageInfo }` so LLM callers can detect
 * `hasNextPage` and iterate.
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
 *   4. Dry-run preview variables carry `page` and `pageSize` (the wire
 *      argument name) plus the null-coerced filters — mirroring the
 *      apply-path wire shape EXACTLY (#377 / #369 dry-run discipline).
 *
 * Zod validation (positive-integer constraint) is exercised by the MCP
 * framework on input parse — the tests cover the apply path downstream
 * of validation.
 */

const MOCKED_LIST = applications.list as ReturnType<typeof vi.fn>;

const ITEM_FIXTURE: applications.JobActivityItem = {
  id: "act_test_001",
  statusV2: { value: "ACTIVE", verbose: "Active" },
  statusGroupV2: { value: "ACTIVE_ENGAGEMENT", verbose: "Active engagement" },
  statusColor: null,
  lastUpdatedAt: "2026-05-01T00:00:00Z",
  job: {
    id: "job_001",
    title: "Senior TypeScript Engineer",
    url: "https://www.toptal.com/jobs/job_001",
    client: { id: "client_001", fullName: "Acme Corp" },
  },
  jobApplication: null,
  engagement: null,
  availabilityRequest: null,
  interview: null,
};

function buildPageFixture(overrides: Partial<applications.JobActivityListPage> = {}): applications.JobActivityListPage {
  return {
    items: [ITEM_FIXTURE],
    totalCount: 37,
    page: 1,
    perPage: 20,
    ...overrides,
  };
}

function buildAuthSuccessCtx(token = "user_applications_pagination_token"): ToolRegistrationContext {
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
  items: applications.JobActivityItem[];
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

describe("ttctl_applications_list MCP tool — pagination (#377)", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_LIST.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerApplicationsTools(server, buildAuthSuccessCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers `page` and `perPage` optional integer fields on the input schema", () => {
    const internals = server as unknown as {
      _registeredTools: Record<string, { inputSchema?: unknown }>;
    };
    const entry = internals._registeredTools["ttctl_applications_list"];
    expect(entry).toBeDefined();
    const inputSchema = entry?.inputSchema as { shape: Record<string, unknown> } | undefined;
    expect(inputSchema?.shape["page"]).toBeDefined();
    expect(inputSchema?.shape["perPage"]).toBeDefined();
  });

  it("forwards `page` / `perPage` to applications.list and wraps the response as { items, pageInfo }", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 10, totalCount: 37 }));

    const handler = getToolHandler(server, "ttctl_applications_list");
    const result = (await handler({ page: 2, perPage: 10 }, {})) as ToolSuccessShape;

    // Service received the forwarded pagination opts (last positional
    // arg is `ListOptions`; first is the bearer token).
    expect(MOCKED_LIST).toHaveBeenCalledTimes(1);
    const opts = MOCKED_LIST.mock.calls[0]?.[1] as applications.ListOptions;
    expect(opts.page).toBe(2);
    expect(opts.perPage).toBe(10);

    // Tool result is the `{ items, pageInfo }` wrapper. `totalPages`
    // = ceil(37/10) = 4; `hasNextPage` = page(2) < totalPages(4) = true.
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

    const handler = getToolHandler(server, "ttctl_applications_list");
    await handler({}, {});

    const opts = MOCKED_LIST.mock.calls[0]?.[1] as applications.ListOptions;
    expect(opts.page).toBeUndefined();
    expect(opts.perPage).toBeUndefined();
  });

  it("derives `hasNextPage: false` when totalPages == currentPage (last page)", async () => {
    // 21 items, perPage 20 → totalPages = ceil(21/20) = 2, page 2 = last.
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 20, totalCount: 21 }));

    const handler = getToolHandler(server, "ttctl_applications_list");
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

    const handler = getToolHandler(server, "ttctl_applications_list");
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

  it("emits a dry-run preview whose variables carry `page` / `pageSize` + null-coerced filters (mirroring the apply-path wire shape)", async () => {
    const handler = getToolHandler(server, "ttctl_applications_list");
    const result = (await handler({ page: 3, perPage: 5, dryRun: true }, {})) as ToolSuccessShape;

    // Dry-run path short-circuits before the service call.
    expect(MOCKED_LIST).not.toHaveBeenCalled();

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("JobActivityItems");
    expect(parsed.preview.variables["page"]).toBe(3);
    expect(parsed.preview.variables["pageSize"]).toBe(5);
    // No filters supplied → null-coerced exactly as the apply path sends.
    expect(parsed.preview.variables["keywords"]).toBeNull();
    expect(parsed.preview.variables["onlyStatusGroupFilter"]).toBeNull();
  });

  it("emits a dry-run preview whose variables carry the DEFAULT `page: 1` / `pageSize: 20` when neither pagination input is supplied", async () => {
    const handler = getToolHandler(server, "ttctl_applications_list");
    const result = (await handler({ dryRun: true }, {})) as ToolSuccessShape;

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.preview.variables["page"]).toBe(applications.DEFAULT_PAGE);
    expect(parsed.preview.variables["pageSize"]).toBe(applications.DEFAULT_PER_PAGE);
  });

  // Pin that pagination and filters co-exist on the same call — guards
  // against a future regression where forwarding `page` / `perPage`
  // drops the `keywords` / `statusGroups` filter (apply + dry-run).
  it("forwards page + perPage AND filter args together (apply path)", async () => {
    MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 15, totalCount: 30 }));

    const handler = getToolHandler(server, "ttctl_applications_list");
    await handler({ keywords: ["python"], statusGroups: ["ARCHIVED"], page: 2, perPage: 15 }, {});

    const opts = MOCKED_LIST.mock.calls[0]?.[1] as applications.ListOptions;
    expect(opts.keywords).toEqual(["python"]);
    expect(opts.statusGroups).toEqual(["ARCHIVED"]);
    expect(opts.page).toBe(2);
    expect(opts.perPage).toBe(15);
  });

  it("dry-run carries filters + pagination together (null-coercion only when absent)", async () => {
    const handler = getToolHandler(server, "ttctl_applications_list");
    const result = (await handler(
      { keywords: ["rust"], statusGroups: ["ON_CLIENT_REVIEW"], page: 4, perPage: 25, dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = parseToolPayload<DryRunEnvelope>(result);
    expect(parsed.preview.variables["keywords"]).toEqual(["rust"]);
    expect(parsed.preview.variables["onlyStatusGroupFilter"]).toEqual(["ON_CLIENT_REVIEW"]);
    expect(parsed.preview.variables["page"]).toBe(4);
    expect(parsed.preview.variables["pageSize"]).toBe(25);
  });
});
