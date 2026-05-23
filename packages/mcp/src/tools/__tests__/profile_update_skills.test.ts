// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentinel the transport primitives so any dry-run path that leaks a
// real transport call fails loudly. Both `employment_update` and
// `portfolio_update` dry-run branches are MCP-layer preview builders —
// they never hit `profile.employment.update(...)` / `profile.portfolio.update(...)`,
// so no live read query fires either.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error("profile_update_skills: transport fired during dry-run — dryRun branch is broken");
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
import { registerPortfolioTools } from "../profile/portfolio.js";

/**
 * Per-tool dry-run assertions for the #541 `skills` parameter on
 * `ttctl_profile_employment_update` / `ttctl_profile_portfolio_update`.
 *
 * Issue #541 closes a wrapper-layer gap: the core `update()` paths
 * already accept `skills` (via `EmploymentFields.skills` /
 * `PortfolioItemInput.skills`), but the MCP `_update` tools' input
 * schemas omitted the field. The replacement semantic is inherent to
 * the core merge (`{ ...merged, ...fields }` for employment,
 * `{ ...merged, ...changes }` for portfolio): caller-supplied set
 * REPLACES the entry's entire skill set; omitted preserves the
 * current set via the read-current+merge.
 *
 * These tests are the surface-threading proof: the catalog ids
 * supplied to the MCP tool must appear verbatim in the preview's
 * `variables.input.{employment,portfolioItem}.skills`, NOT the
 * `DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER` (employment) or omitted from
 * the variables (portfolio — buildPortfolioInput-driven shape).
 */

function buildCtx(token = "user_skills_token"): ToolRegistrationContext {
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

const SKILL_REFS = [
  { id: "skill_cat_ts", name: "TypeScript" },
  { id: "skill_cat_rust", name: "Rust" },
];

describe("profile.employment.update skills — dry-run threading (#541)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerEmploymentTools(server, buildCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dry-run preview shows supplied skills, overriding the merge placeholder", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-541", skills: SKILL_REFS, dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("UpdateEmployment");
    const employment = (parsed.preview.variables as { input: { employment: { skills: unknown } } }).input.employment;
    // User-supplied set wins over DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER.
    expect(employment.skills).toEqual(SKILL_REFS);
  });

  it("dry-run preview fills missing `name` with empty string (wrapper schema default)", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-541", skills: [{ id: "skill_cat_id_only" }], dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    const employment = (parsed.preview.variables as { input: { employment: { skills: unknown } } }).input.employment;
    expect(employment.skills).toEqual([{ id: "skill_cat_id_only", name: "" }]);
  });

  it("dry-run WITHOUT skills keeps the merge placeholder (preserve-on-omit)", async () => {
    const handler = getToolHandler(server, "ttctl_profile_employment_update");
    const result = (await handler(
      { id: "V1-Employment-541", role: "New Title", dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    const employment = (parsed.preview.variables as { input: { employment: { skills: unknown } } }).input.employment;
    // No override supplied → the apply path resolves skills from
    // current state; the preview surfaces the placeholder verbatim.
    expect(employment.skills).toBe("<resolved at send-time by reading current state>");
  });
});

describe("profile.portfolio.update skills — dry-run threading (#541)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerPortfolioTools(server, buildCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dry-run preview carries the user-supplied skills verbatim", async () => {
    const handler = getToolHandler(server, "ttctl_profile_portfolio_update");
    const result = (await handler(
      { id: "V1-PortfolioItem-541", skills: SKILL_REFS, dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("updatePortfolioItem");
    const portfolioItem = (parsed.preview.variables as { input: { portfolioItem: { skills: unknown } } }).input
      .portfolioItem;
    expect(portfolioItem.skills).toEqual(SKILL_REFS);
  });

  it("dry-run preview fills missing `name` with empty string (wrapper schema default)", async () => {
    const handler = getToolHandler(server, "ttctl_profile_portfolio_update");
    const result = (await handler(
      { id: "V1-PortfolioItem-541", skills: [{ id: "skill_cat_id_only" }], dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    const portfolioItem = (parsed.preview.variables as { input: { portfolioItem: { skills: unknown } } }).input
      .portfolioItem;
    expect(portfolioItem.skills).toEqual([{ id: "skill_cat_id_only", name: "" }]);
  });

  it("dry-run WITHOUT skills omits the field from the preview (buildPortfolioInput conditional)", async () => {
    const handler = getToolHandler(server, "ttctl_profile_portfolio_update");
    const result = (await handler(
      { id: "V1-PortfolioItem-541", title: "Updated", dryRun: true },
      {},
    )) as ToolSuccessShape;

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    const portfolioItem = (parsed.preview.variables as { input: { portfolioItem: Record<string, unknown> } }).input
      .portfolioItem;
    // `buildPortfolioInput` omits unsupplied fields; the apply path's
    // read-current+merge in `profile.portfolio.update()` injects
    // `current.skills` from the live state. The dry-run preview is
    // build-time-only (no read fires) so the field is simply absent
    // from the surfaced variables.
    expect(portfolioItem).not.toHaveProperty("skills");
  });
});
