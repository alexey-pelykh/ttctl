// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentinel the transport primitives (mirrors `dryrun-smoke.test.ts`):
// if any dry-run path leaks a real transport call the stub throws, so
// the failure is loud rather than a silent live-API hit. `profile.
// employment.*` is intentionally NOT mocked — the `add` tool delegates
// its dry-run to the real `profile.employment.add(..., {dryRun:true})`
// (per #395, so the preview carries the resolved employerId); with an
// explicit `employerId` that path is zero-transport (no autocomplete,
// no mutation). The pure `buildDryRunPreview` primitive stays real so
// the emitted preview is the verbatim wire shape.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error("profile_employment_industry_ids: transport fired during dry-run — dryRun branch is broken");
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
 * Per-tool dry-run assertions for the #403 `industryIds` parameter on
 * `ttctl_profile_employment_add` / `ttctl_profile_employment_update`.
 *
 * Issue #403 AC#3: "Dry-run preview shows the user-supplied
 * `industryIds` (vs. the `<resolved at send-time>` placeholder) when
 * present". These tests are the surface-threading proof: the catalog
 * ids supplied to the MCP tool must appear verbatim in the preview's
 * `variables.input.employment.industryIds`, NOT the
 * `DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER`.
 *
 * The `employer_autocomplete` read query is NOT mocked here; the add
 * test passes an explicit `employerId` so `resolveEmployerId` takes the
 * bypass path (zero transport) per the #395 dry-run contract.
 */

function buildCtx(token = "user_emp_industry_token"): ToolRegistrationContext {
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

const INDUSTRY_IDS = ["VjEtSW5kdXN0cnktNzkz", "VjEtSW5kdXN0cnktNzg3"];

describe("profile.employment industryIds — dry-run threading (#403)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerEmploymentTools(server, buildCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("employment_add dry-run preview carries the user-supplied industryIds verbatim", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_add");
    const result = (await handler(
      {
        company: "TrustedSec, LLC",
        role: "Odoo Expert",
        employerId: "V1-Employer-stub",
        industryIds: INDUSTRY_IDS,
        dryRun: true,
      },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("CreateEmployment");
    const employment = (parsed.preview.variables as { input: { employment: { industryIds: unknown } } }).input
      .employment;
    expect(employment.industryIds).toEqual(INDUSTRY_IDS);
  });

  it("employment_update dry-run preview shows supplied industryIds, overriding the merge placeholder", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-123", industryIds: INDUSTRY_IDS, dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("UpdateEmployment");
    const employment = (parsed.preview.variables as { input: { employment: { industryIds: unknown } } }).input
      .employment;
    // User-supplied set wins over DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER.
    expect(employment.industryIds).toEqual(INDUSTRY_IDS);
  });

  it("employment_update dry-run WITHOUT industryIds keeps the merge placeholder (preserve-on-omit)", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-123", role: "New Title", dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    const employment = (parsed.preview.variables as { input: { employment: { industryIds: unknown } } }).input
      .employment;
    // No override supplied → the apply path resolves industryIds from
    // current state; the preview surfaces the placeholder verbatim.
    expect(employment.industryIds).toBe("<resolved at send-time by reading current state>");
  });
});
