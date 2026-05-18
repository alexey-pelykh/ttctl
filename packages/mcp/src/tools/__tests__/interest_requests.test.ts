// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applications } from "@ttctl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../_shared.js";
import { projectRow, registerInterestRequestsTools } from "../interest_requests.js";

/**
 * Tests for `ttctl_interest_requests_list` (#371). The tool is a thin
 * MCP-layer projection over `applications.list({ statusGroups:
 * ["ON_RECRUITER_REVIEW"] })`. No new wire op is introduced — the live
 * shape of `JobActivityItems` is covered by
 * `packages/e2e/src/15-applications-list.e2e.test.ts`.
 *
 * The tests below pin three things:
 *
 *   1. The projection helper (`projectRow`) computes `daysPending`
 *      correctly and emits the documented shape.
 *   2. The `olderThan` filter accepts the documented duration suffixes
 *      and rejects malformed values with `VALIDATION`.
 *   3. The `dryRun` branch emits the canonical envelope carrying the
 *      `JobActivityItems` op restricted to `ON_RECRUITER_REVIEW`.
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

function getRegisteredHandler(server: McpServer, name: string): ToolHandler {
  const internal = server as unknown as {
    _registeredTools: Record<string, { handler: unknown } | undefined>;
  };
  const tool = internal._registeredTools[name];
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool.handler as ToolHandler;
}

function buildStubCtx(): ToolRegistrationContext {
  const stubToken = "stub-bearer-for-tests";
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token: stubToken }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
  };
}

function buildRow(overrides: Partial<applications.JobActivityItem> = {}): applications.JobActivityItem {
  return {
    id: "ji_test_001",
    statusV2: { value: "AVAILABILITY_REQUEST_PENDING", verbose: "Job Interest Request" },
    statusGroupV2: { value: "ON_RECRUITER_REVIEW", verbose: "On Recruiter Review" },
    statusColor: null,
    lastUpdatedAt: "2026-05-01T00:00:00Z",
    job: {
      id: "job_001",
      title: "Senior TypeScript Engineer",
      url: "https://www.toptal.com/jobs/foo",
      client: { id: "client_001", fullName: "Acme Corp" },
    },
    jobApplication: null,
    engagement: null,
    availabilityRequest: { id: "ar_001" },
    interview: null,
    ...overrides,
  };
}

/**
 * Wrap rows in the {@link applications.JobActivityListPage} envelope
 * `applications.list` returns post-#377. `ttctl_interest_requests_list`
 * unwraps `.items` (it does not surface pagination — see #372 / R1);
 * `totalCount` mirrors the slice here because the stub is the whole
 * (filtered) set.
 */
function listPage(items: applications.JobActivityItem[]): applications.JobActivityListPage {
  return { items, totalCount: items.length, page: 1, perPage: 20 };
}

describe("projectRow", () => {
  it("computes daysPending as the integer number of days between lastUpdatedAt and now", () => {
    const row = buildRow({ lastUpdatedAt: "2026-05-01T00:00:00Z" });
    // 2026-05-15 00:00 UTC ⇒ 14 days after 2026-05-01.
    const now = Date.parse("2026-05-15T00:00:00Z");
    expect(projectRow(row, now).daysPending).toBe(14);
  });

  it("clamps daysPending to 0 when lastUpdatedAt is in the future (clock skew)", () => {
    const row = buildRow({ lastUpdatedAt: "2026-06-01T00:00:00Z" });
    const now = Date.parse("2026-05-01T00:00:00Z");
    expect(projectRow(row, now).daysPending).toBe(0);
  });

  it("emits daysPending=null when lastUpdatedAt cannot be parsed", () => {
    const row = buildRow({ lastUpdatedAt: "not-a-timestamp" });
    expect(projectRow(row, Date.now()).daysPending).toBeNull();
  });

  it("surfaces statusVerbose, jobTitle, clientName, jobUrl, lastUpdatedAt verbatim", () => {
    const row = buildRow();
    const out = projectRow(row, Date.parse("2026-05-15T00:00:00Z"));
    expect(out.statusVerbose).toBe("Job Interest Request");
    expect(out.jobTitle).toBe("Senior TypeScript Engineer");
    expect(out.clientName).toBe("Acme Corp");
    expect(out.jobUrl).toBe("https://www.toptal.com/jobs/foo");
    expect(out.lastUpdatedAt).toBe("2026-05-01T00:00:00Z");
  });

  it("emits clientName=null when the row's client is null", () => {
    const row = buildRow({ job: { id: "j", title: null, url: null, client: null } });
    expect(projectRow(row, Date.now()).clientName).toBeNull();
  });
});

describe("ttctl_interest_requests_list — handler", () => {
  let server: McpServer;
  let listSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerInterestRequestsTools(server, buildStubCtx());
    listSpy = vi.spyOn(applications, "list");
  });

  afterEach(() => {
    listSpy.mockRestore();
  });

  it("emits a dry-run envelope carrying the JobActivityItems op restricted to ON_RECRUITER_REVIEW", async () => {
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    const result = await handler({ dryRun: true });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text) as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string; variables: Record<string, unknown>; surface: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("JobActivityItems");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    expect(parsed.preview.variables).toEqual({ onlyStatusGroupFilter: ["ON_RECRUITER_REVIEW"] });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("calls applications.list with the ON_RECRUITER_REVIEW status-group filter on the apply path", async () => {
    listSpy.mockResolvedValue(listPage([]));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    await handler({});
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith("stub-bearer-for-tests", { statusGroups: ["ON_RECRUITER_REVIEW"] });
  });

  it("returns the projected rows as a JSON array", async () => {
    listSpy.mockResolvedValue(listPage([buildRow()]));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? "") as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    const firstRow = parsed[0] as { id: unknown; statusVerbose: unknown; jobTitle: unknown };
    expect(firstRow.id).toBe("ji_test_001");
    expect(firstRow.statusVerbose).toBe("Job Interest Request");
    expect(firstRow.jobTitle).toBe("Senior TypeScript Engineer");
  });

  it("accepts olderThan: `14d` and filters rows whose daysPending is below the threshold", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-20T00:00:00Z"));
    try {
      listSpy.mockResolvedValue(
        listPage([
          // 19 days old — keeps.
          buildRow({ id: "old", lastUpdatedAt: "2026-05-01T00:00:00Z" }),
          // 5 days old — drops.
          buildRow({ id: "fresh", lastUpdatedAt: "2026-05-15T00:00:00Z" }),
        ]),
      );
      const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
      const result = await handler({ olderThan: "14d" });
      const parsed = JSON.parse(result.content[0]?.text ?? "") as { id: string }[];
      expect(parsed.map((r) => r.id)).toEqual(["old"]);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("accepts olderThan: `2w` (weeks), `48h` (hours), and bare integer (days)", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-20T00:00:00Z"));
    try {
      const row = buildRow({ lastUpdatedAt: "2026-05-05T00:00:00Z" }); // 15 days / 360h old
      listSpy.mockResolvedValue(listPage([row]));
      const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");

      // 2w = 336h; row at 360h passes.
      const resultWeeks = await handler({ olderThan: "2w" });
      expect((JSON.parse(resultWeeks.content[0]?.text ?? "") as unknown[]).length).toBe(1);

      // 48h passes.
      const resultHours = await handler({ olderThan: "48h" });
      expect((JSON.parse(resultHours.content[0]?.text ?? "") as unknown[]).length).toBe(1);

      // Bare integer "15" = 15d = 360h; row exactly at threshold passes (>=).
      const resultBare = await handler({ olderThan: "15" });
      expect((JSON.parse(resultBare.content[0]?.text ?? "") as unknown[]).length).toBe(1);

      // 16d (= 384h) excludes the 360h-old row.
      const resultTighter = await handler({ olderThan: "16d" });
      expect((JSON.parse(resultTighter.content[0]?.text ?? "") as unknown[]).length).toBe(0);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("returns a VALIDATION error response for malformed olderThan values", async () => {
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    const result = await handler({ olderThan: "garbage" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: VALIDATION)");
    expect(text).toContain("garbage");
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("maps ApplicationsError thrown from applications.list into the error envelope", async () => {
    listSpy.mockRejectedValue(new applications.ApplicationsError("NETWORK_ERROR", "transport refused"));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    const result = await handler({});
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: NETWORK_ERROR)");
    expect(text).toContain("transport refused");
  });
});
