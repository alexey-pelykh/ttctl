// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentinel the transport primitives (mirrors `profile_employment_primary_geography`):
// if any dry-run path leaks a real transport call the stub throws, so the
// failure is loud rather than a silent live-API hit. `profile.employment.*`
// is intentionally NOT mocked — the `add` tool delegates its dry-run to the
// real `profile.employment.add(..., {dryRun:true})`; with an explicit
// `employerId` that path is zero-transport (no autocomplete, no mutation).
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error("profile_employment_engagement_id: transport fired during dry-run — dryRun branch is broken");
  };
  return {
    ...actual,
    stockTransport: vi.fn(transportSentinel),
    impersonatedTransport: vi.fn(transportSentinel),
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DryRunPreview } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerEmploymentTools } from "../profile/employment.js";

/**
 * Per-tool dry-run threading assertions for the #587 `engagementId`
 * parameter on `ttctl_profile_employment_add` / `ttctl_profile_employment_update`.
 *
 * The TalentEngagement id supplied to the MCP tool must appear verbatim in
 * the preview's `variables.input.employment.engagementId`. On update,
 * `engagementId` is NOT one of the merge placeholders (like its sibling
 * `primaryGeographyId`, unlike `industryIds`), so omitting it leaves the
 * field ABSENT from the preview (the apply-path read-current+merge supplies
 * it from current state via the `current.engagement` echo branch).
 *
 * The `employer_autocomplete` read query is NOT mocked here; the add test
 * passes an explicit `employerId` so `resolveEmployerId` takes the bypass
 * path (zero transport) per the #395 dry-run contract.
 */

function buildCtx(token = "user_emp_engagement_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token }),
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

interface DryRunEnvelope {
  ok: boolean;
  dryRun: boolean;
  preview: DryRunPreview;
}

// base64 `V1-TalentEngagement-7` — a TalentEngagement catalog id (the same
// shape `engagements list` surfaces as each row's `engagementId`).
const ENGAGEMENT_ID = "VjEtVGFsZW50RW5nYWdlbWVudC03";

describe("profile.employment engagementId — dry-run threading (#587)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerEmploymentTools(server, buildCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("employment_add dry-run preview carries the user-supplied engagementId verbatim", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_add");
    const result = (await handler(
      {
        company: "TrustedSec, LLC",
        role: "Security Engineer",
        employerId: "V1-Employer-stub",
        industryIds: ["VjEtSW5kdXN0cnktNzkz"],
        engagementId: ENGAGEMENT_ID,
        dryRun: true,
      },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("CreateEmployment");
    const employment = (parsed.preview.variables as { input: { employment: { engagementId: unknown } } }).input
      .employment;
    expect(employment.engagementId).toBe(ENGAGEMENT_ID);
  });

  it("employment_update dry-run preview shows the supplied engagementId verbatim", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-123", engagementId: ENGAGEMENT_ID, dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("UpdateEmployment");
    const employment = (parsed.preview.variables as { input: { employment: { engagementId: unknown } } }).input
      .employment;
    expect(employment.engagementId).toBe(ENGAGEMENT_ID);
  });

  it("employment_update dry-run WITHOUT engagementId omits it (apply path merges from current state)", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-123", role: "New Title", dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    const employment = (parsed.preview.variables as { input: { employment: Record<string, unknown> } }).input
      .employment;
    // engagementId is not a merge placeholder; when omitted it is simply
    // absent from the preview (read-current+merge supplies it from the
    // row's current `engagement` linkage).
    expect(employment).not.toHaveProperty("engagementId");
  });
});
