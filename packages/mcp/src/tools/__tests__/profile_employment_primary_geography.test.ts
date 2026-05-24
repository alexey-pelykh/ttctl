// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentinel the transport primitives (mirrors `profile_employment_industry_ids`):
// if any dry-run path leaks a real transport call the stub throws, so the
// failure is loud rather than a silent live-API hit. `profile.employment.*`
// is intentionally NOT mocked — the `add` tool delegates its dry-run to the
// real `profile.employment.add(..., {dryRun:true})`; with an explicit
// `employerId` that path is zero-transport (no autocomplete, no mutation).
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error("profile_employment_primary_geography: transport fired during dry-run — dryRun branch is broken");
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
 * Per-tool dry-run threading assertions for the #586 `primaryGeographyId`
 * parameter on `ttctl_profile_employment_add` / `ttctl_profile_employment_update`.
 *
 * The catalog Country id supplied to the MCP tool must appear verbatim in
 * the preview's `variables.input.employment.primaryGeographyId`. On update,
 * `primaryGeographyId` is NOT one of the merge placeholders (unlike
 * `industryIds`), so omitting it leaves the field ABSENT from the preview
 * (the apply-path read-current+merge supplies it from current state).
 *
 * The `employer_autocomplete` read query is NOT mocked here; the add test
 * passes an explicit `employerId` so `resolveEmployerId` takes the bypass
 * path (zero transport) per the #395 dry-run contract.
 */

function buildCtx(token = "user_emp_geo_token"): ToolRegistrationContext {
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

// base64 `V1-Country-234` = United States (sourced live via getCountries).
const GEO_ID = "VjEtQ291bnRyeS0yMzQ";

describe("profile.employment primaryGeographyId — dry-run threading (#586)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerEmploymentTools(server, buildCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("employment_add dry-run preview carries the user-supplied primaryGeographyId verbatim", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_add");
    const result = (await handler(
      {
        company: "TrustedSec, LLC",
        role: "Security Engineer",
        employerId: "V1-Employer-stub",
        industryIds: ["VjEtSW5kdXN0cnktNzkz"],
        primaryGeographyId: GEO_ID,
        dryRun: true,
      },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("CreateEmployment");
    const employment = (parsed.preview.variables as { input: { employment: { primaryGeographyId: unknown } } }).input
      .employment;
    expect(employment.primaryGeographyId).toBe(GEO_ID);
  });

  it("employment_update dry-run preview shows the supplied primaryGeographyId verbatim", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-123", primaryGeographyId: GEO_ID, dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("UpdateEmployment");
    const employment = (parsed.preview.variables as { input: { employment: { primaryGeographyId: unknown } } }).input
      .employment;
    expect(employment.primaryGeographyId).toBe(GEO_ID);
  });

  it("employment_update dry-run WITHOUT primaryGeographyId omits it (apply path merges from current state)", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-123", role: "New Title", dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    const employment = (parsed.preview.variables as { input: { employment: Record<string, unknown> } }).input
      .employment;
    // primaryGeographyId is not a merge placeholder; when omitted it is
    // simply absent from the preview (read-current+merge supplies it).
    expect(employment).not.toHaveProperty("primaryGeographyId");
  });
});
