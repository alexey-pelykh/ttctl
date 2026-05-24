// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentinel the transport primitives (mirrors `profile_employment_engagement_id`):
// the `employment_update` dry-run path builds its preview entirely in the MCP
// layer and must NOT touch any transport. If a regression makes the dry-run
// branch fall through to the apply path, the sentinel throws loudly rather
// than silently hitting the live API. `profile.employment.*` is intentionally
// NOT mocked — the real `DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER` constant is read
// through.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error(
      "profile_employment_dryrun_resolved_fields: transport fired during dry-run — dryRun branch is broken",
    );
  };
  return {
    ...actual,
    stockTransport: vi.fn(transportSentinel),
    impersonatedTransport: vi.fn(transportSentinel),
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerEmploymentTools } from "../profile/employment.js";

/**
 * Resolved-field completeness of the `ttctl_profile_employment_update`
 * dry-run preview (#589).
 *
 * The preview's `variables.input.employment` object must list EVERY field the
 * apply-path merge (`buildUpdateEmploymentInput`) echoes UNCONDITIONALLY from
 * current state — otherwise a caller reading the preview cannot confirm that an
 * omitted field is preserved (not dropped). Pre-#589 the list omitted
 * `endDate`, `toptalRelated`, and `managementExperience`; the headline gap was
 * `endDate` — a caller could not tell from the preview that a current role's
 * "Present" status (`endDate: null`) survives a partial update.
 *
 * Each unconditionally-merged field, when the caller omits it, must appear as
 * the `<resolved at send-time by reading current state>` placeholder; when the
 * caller supplies it, the supplied value must win verbatim (the `...fields`
 * override). The conditionally-merged fields (`engagementId`,
 * `primaryGeographyId`) stay covered by their own #586 / #587 absence tests.
 */

function buildCtx(token = "user_emp_resolved_fields_token"): ToolRegistrationContext {
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

const MERGE_PLACEHOLDER = profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER;

async function runUpdateDryRun(server: McpServer, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = getToolHandler(server, "ttctl_profile_employment_update");
  const result = (await handler({ ...input, dryRun: true }, {})) as ToolSuccessShape;
  const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
  expect(parsed.ok).toBe(true);
  expect(parsed.dryRun).toBe(true);
  expect(parsed.preview.operationName).toBe("UpdateEmployment");
  return (parsed.preview.variables as { input: { employment: Record<string, unknown> } }).input.employment;
}

describe("profile.employment update dry-run — resolved-field completeness (#589)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerEmploymentTools(server, buildCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- endDate: the headline gap (#589) ---

  it("a partial update (role only) shows endDate as a resolved-at-send-time placeholder", async () => {
    const employment = await runUpdateDryRun(server, { id: "V1-Employment-123", role: "New Title" });
    // The omitted endDate is force-echoed from current state by the apply path
    // (#487 three-state merge); the preview must say so rather than hide it.
    expect(employment).toHaveProperty("endDate");
    expect(employment["endDate"]).toBe(MERGE_PLACEHOLDER);
  });

  it("a `to` (end-year) update shows the supplied endDate year verbatim", async () => {
    const employment = await runUpdateDryRun(server, { id: "V1-Employment-123", to: "2020" });
    expect(employment["endDate"]).toBe(2020);
  });

  it("a `current: true` update shows endDate: null (the current-role marker)", async () => {
    const employment = await runUpdateDryRun(server, { id: "V1-Employment-123", current: true });
    // `current: true` maps to endDate: null — the override wins over the
    // placeholder, and the preview now surfaces the cleared end date.
    expect(employment).toHaveProperty("endDate");
    expect(employment["endDate"]).toBeNull();
  });

  // --- the other unconditionally-merged fields the preview also omitted ---

  it("a partial update shows toptalRelated as a resolved-at-send-time placeholder when omitted", async () => {
    const employment = await runUpdateDryRun(server, { id: "V1-Employment-123", role: "New Title" });
    expect(employment["toptalRelated"]).toBe(MERGE_PLACEHOLDER);
  });

  it("a partial update shows managementExperience as a resolved-at-send-time placeholder when omitted", async () => {
    const employment = await runUpdateDryRun(server, { id: "V1-Employment-123", role: "New Title" });
    expect(employment["managementExperience"]).toBe(MERGE_PLACEHOLDER);
  });

  it("a supplied toptalRelated wins over the placeholder verbatim", async () => {
    const employment = await runUpdateDryRun(server, { id: "V1-Employment-123", toptalRelated: true });
    expect(employment["toptalRelated"]).toBe(true);
  });
});
