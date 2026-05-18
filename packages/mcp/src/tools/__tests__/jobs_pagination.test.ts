// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real and override
// the four paginating jobs read functions so the tests can stub
// JobListPage outcomes without touching any transport. Same pattern as
// `profile_basic_update.test.ts` for #52 — see there for the
// importOriginal rationale.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    jobs: {
      ...actual.jobs,
      list: vi.fn(),
      saved: vi.fn(),
      viewedList: vi.fn(),
      notInterestedList: vi.fn(),
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jobs } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerJobsTools } from "../jobs.js";

/**
 * MCP pagination behavior on the four `ttctl_jobs_*` read-list tools
 * (`list`, `saved`, `viewed`, `not_interested_list`), per issue #369.
 *
 * Pre-#369 the MCP tools accepted no pagination parameters and unwrapped
 * `JobListPage` to bare `items[]`. Post-#369 each tool accepts optional
 * `page` / `perPage` (positive integers, defaults applied server-side
 * by the core), forwards them to the corresponding `jobs.*()` service
 * call, and surfaces the response as `{ items, pageInfo }` so LLM
 * callers can detect `hasNextPage` and iterate.
 *
 * Pinned behaviors per tool (× 4):
 *
 *   1. `page` and `perPage` registered as optional integer fields on the
 *      input schema.
 *   2. Service call receives the forwarded options when supplied
 *      (`{ page, perPage }` populated from args); receives no overrides
 *      when both omitted (defaults applied server-side).
 *   3. Apply-path response wraps items as `{ items, pageInfo }` with the
 *      service-returned `currentPage` / `perPage` and derived
 *      `totalPages` / `hasNextPage`.
 *   4. Dry-run preview variables carry `page` and `pageSize` (the wire
 *      argument name) mirroring the apply-path wire shape (#369).
 *
 * Zod validation (positive-integer constraint) is exercised by the
 * MCP framework on input parse — the tests cover the apply path
 * downstream of validation.
 */

const MOCKED_LIST = jobs.list as ReturnType<typeof vi.fn>;
const MOCKED_SAVED = jobs.saved as ReturnType<typeof vi.fn>;
const MOCKED_VIEWED_LIST = jobs.viewedList as ReturnType<typeof vi.fn>;
const MOCKED_NOT_INTERESTED_LIST = jobs.notInterestedList as ReturnType<typeof vi.fn>;

const ITEM_FIXTURE: jobs.JobListItem = {
  id: "job_test_001",
  title: "Senior TS Engineer",
  url: "https://www.toptal.com/jobs/job_test_001",
  client: { id: "client_1", fullName: "Acme Corp" },
  commitment: { slug: "FULL_TIME" },
  workType: { slug: "REMOTE" },
  specialization: { title: "TypeScript" },
  expectedHours: 40,
  maxRate: 110,
  startDate: "2026-06-01",
  postedWhen: "2026-05-15",
  viewed: false,
  saved: false,
  notInterested: false,
};

function buildPageFixture(overrides: Partial<jobs.JobListPage> = {}): jobs.JobListPage {
  return {
    items: [ITEM_FIXTURE],
    totalCount: 37,
    page: 1,
    perPage: 20,
    ...overrides,
  };
}

function buildAuthSuccessCtx(token = "user_jobs_pagination_token"): ToolRegistrationContext {
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
  items: jobs.JobListItem[];
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

/**
 * Per-tool table — one row per paginating tool — lets the assertions
 * stay byte-identical across all four tools without four near-duplicate
 * describe blocks.
 */
interface PaginatingToolSpec {
  toolName: string;
  serviceMock: ReturnType<typeof vi.fn>;
  /**
   * For the dry-run path: the expected `saved` / `notInterested` filter
   * variables the tool's `buildJobsListVariables` call attaches (mirrors
   * the apply-path wire shape).
   */
  expectedDryRunFilter: { saved: { eq: boolean } | null; notInterested: { eq: boolean } | null };
}

const TOOL_SPECS: PaginatingToolSpec[] = [
  {
    toolName: "ttctl_jobs_list",
    serviceMock: MOCKED_LIST,
    expectedDryRunFilter: { saved: null, notInterested: null },
  },
  {
    toolName: "ttctl_jobs_saved",
    serviceMock: MOCKED_SAVED,
    expectedDryRunFilter: { saved: { eq: true }, notInterested: null },
  },
  {
    toolName: "ttctl_jobs_viewed",
    serviceMock: MOCKED_VIEWED_LIST,
    expectedDryRunFilter: { saved: null, notInterested: null },
  },
  {
    toolName: "ttctl_jobs_not_interested_list",
    serviceMock: MOCKED_NOT_INTERESTED_LIST,
    expectedDryRunFilter: { saved: null, notInterested: { eq: true } },
  },
];

describe("ttctl_jobs_* MCP tools — pagination (#369)", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_LIST.mockReset();
    MOCKED_SAVED.mockReset();
    MOCKED_VIEWED_LIST.mockReset();
    MOCKED_NOT_INTERESTED_LIST.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerJobsTools(server, buildAuthSuccessCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(TOOL_SPECS)("$toolName", ({ toolName, serviceMock, expectedDryRunFilter }) => {
    it("registers `page` and `perPage` optional integer fields on the input schema", () => {
      const internals = server as unknown as {
        _registeredTools: Record<string, { inputSchema?: unknown }>;
      };
      const entry = internals._registeredTools[toolName];
      expect(entry).toBeDefined();
      const inputSchema = entry?.inputSchema as { shape: Record<string, unknown> } | undefined;
      expect(inputSchema?.shape["page"]).toBeDefined();
      expect(inputSchema?.shape["perPage"]).toBeDefined();
    });

    it("forwards `page` / `perPage` to the service when supplied and wraps the response as { items, pageInfo }", async () => {
      serviceMock.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 10, totalCount: 37 }));

      const handler = getToolHandler(server, toolName);
      const result = (await handler({ page: 2, perPage: 10 }, {})) as ToolSuccessShape;

      // Service received the forwarded pagination opts (last positional
      // arg is `ListOptions`; first is the bearer token).
      expect(serviceMock).toHaveBeenCalledTimes(1);
      const call = serviceMock.mock.calls[0];
      const opts = call?.[1] as jobs.ListOptions;
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
      serviceMock.mockResolvedValueOnce(buildPageFixture());

      const handler = getToolHandler(server, toolName);
      await handler({}, {});

      const opts = serviceMock.mock.calls[0]?.[1] as jobs.ListOptions;
      expect(opts.page).toBeUndefined();
      expect(opts.perPage).toBeUndefined();
    });

    it("derives `hasNextPage: false` when totalPages == currentPage (last page)", async () => {
      // 21 items, perPage 20 → totalPages = ceil(21/20) = 2, page 2 = last.
      serviceMock.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 20, totalCount: 21 }));

      const handler = getToolHandler(server, toolName);
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
      serviceMock.mockResolvedValueOnce(buildPageFixture({ items: [], totalCount: 0, page: 1, perPage: 20 }));

      const handler = getToolHandler(server, toolName);
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
      const handler = getToolHandler(server, toolName);
      const result = (await handler({ page: 3, perPage: 5, dryRun: true }, {})) as ToolSuccessShape;

      // Dry-run path short-circuits before the service call — verify
      // the service was NOT invoked.
      expect(serviceMock).not.toHaveBeenCalled();

      const parsed = parseToolPayload<DryRunEnvelope>(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.preview.operationName).toBe("JobsList");
      expect(parsed.preview.variables["page"]).toBe(3);
      expect(parsed.preview.variables["pageSize"]).toBe(5);
      expect(parsed.preview.variables["saved"]).toEqual(expectedDryRunFilter.saved);
      expect(parsed.preview.variables["notInterested"]).toEqual(expectedDryRunFilter.notInterested);
    });

    it("emits a dry-run preview whose variables carry the DEFAULT `page: 1` / `pageSize: 20` when neither pagination input is supplied", async () => {
      const handler = getToolHandler(server, toolName);
      const result = (await handler({ dryRun: true }, {})) as ToolSuccessShape;

      const parsed = parseToolPayload<DryRunEnvelope>(result);
      expect(parsed.preview.variables["page"]).toBe(jobs.DEFAULT_PAGE);
      expect(parsed.preview.variables["pageSize"]).toBe(jobs.DEFAULT_PER_PAGE);
    });
  });

  // ttctl_jobs_list carries the filter fields too — pin that pagination
  // and filters co-exist on the same call. The shared tests above cover
  // each tool's pagination behavior; this guards against a future
  // regression where forwarding `page` / `perPage` drops a filter.
  describe("ttctl_jobs_list — pagination + filters", () => {
    it("forwards page + perPage AND filter args together", async () => {
      MOCKED_LIST.mockResolvedValueOnce(buildPageFixture({ page: 2, perPage: 15, totalCount: 30 }));

      const handler = getToolHandler(server, "ttctl_jobs_list");
      await handler(
        {
          skills: ["typescript"],
          commitments: ["FULL_TIME"],
          page: 2,
          perPage: 15,
        },
        {},
      );

      const opts = MOCKED_LIST.mock.calls[0]?.[1] as jobs.ListOptions;
      expect(opts.skills).toEqual(["typescript"]);
      expect(opts.commitments).toEqual(["FULL_TIME"]);
      expect(opts.page).toBe(2);
      expect(opts.perPage).toBe(15);
    });
  });
});
