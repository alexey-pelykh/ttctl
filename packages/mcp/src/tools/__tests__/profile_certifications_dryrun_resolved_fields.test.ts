// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentinel the transport primitives (mirrors
// `profile_employment_dryrun_resolved_fields`): the certifications dry-run
// paths build their preview entirely in the MCP layer and must NOT touch any
// transport. If a regression makes a dry-run branch fall through to the apply
// path, the sentinel throws loudly rather than silently hitting the live API.
// `profile.certifications.*` is intentionally NOT mocked — the real
// `DRY_RUN_CERTIFICATION_FIELD_PLACEHOLDER` constant is read through.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error(
      "profile_certifications_dryrun_resolved_fields: transport fired during dry-run — dryRun branch is broken",
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
import { registerCertificationsTools } from "../profile/certifications.js";

/**
 * Resolved-field completeness of the `ttctl_profile_certifications_*` dry-run
 * previews (#605 — the certifications sibling of the employment #589 guard).
 *
 * The update preview's `variables.input.certification` object must list EVERY
 * field `buildUpdateCertificationInput` echoes UNCONDITIONALLY from current
 * state — otherwise a caller reading the preview cannot confirm that an omitted
 * field is preserved (not nulled), which is the exact #605 bug class. `skills`
 * is the field at risk here: it is wire-required non-null and force-echoed by
 * both `add()` (defaults `[]`) and `update()` (echoes `current.skills`), so
 * both previews must surface it. The conditionally-echoed fields (`link`,
 * `number`, `validFromMonth`, `validFromYear`) are intentionally NOT
 * placeholders — the zero-transport preview cannot read the current row to know
 * which are non-null, so they surface only when the caller supplies them.
 */

function buildCtx(token = "user_cert_resolved_fields_token"): ToolRegistrationContext {
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

const PLACEHOLDER = profile.certifications.DRY_RUN_CERTIFICATION_FIELD_PLACEHOLDER;

async function runDryRun(
  server: McpServer,
  tool: string,
  operationName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = getToolHandler(server, tool);
  const result = (await handler({ ...input, dryRun: true }, {})) as ToolSuccessShape;
  const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
  expect(parsed.ok).toBe(true);
  expect(parsed.dryRun).toBe(true);
  expect(parsed.preview.operationName).toBe(operationName);
  return (parsed.preview.variables as { input: { certification: Record<string, unknown> } }).input.certification;
}

describe("profile.certifications dry-run — resolved-field completeness (#605)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerCertificationsTools(server, buildCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- update: skills is the headline gap (the #605 sibling of #589's endDate) ---

  it("a partial update (name only) shows skills as a resolved-at-send-time placeholder", async () => {
    const certification = await runDryRun(server, "ttctl_profile_certifications_update", "UPDATE_CERTIFICATION", {
      id: "V1-Certification-123",
      name: "New Cert Name",
    });
    // skills is force-echoed from current state by the apply path (wire requires
    // non-null); the preview must say so rather than hide it.
    expect(certification).toHaveProperty("skills");
    expect(certification["skills"]).toBe(PLACEHOLDER);
  });

  // --- update: the other unconditionally-echoed fields ---

  it("a partial update shows every other unconditional echo as a placeholder when omitted", async () => {
    const certification = await runDryRun(server, "ttctl_profile_certifications_update", "UPDATE_CERTIFICATION", {
      id: "V1-Certification-123",
      name: "New Cert Name",
    });
    expect(certification["institution"]).toBe(PLACEHOLDER);
    expect(certification["highlight"]).toBe(PLACEHOLDER);
    expect(certification["validToMonth"]).toBe(PLACEHOLDER);
    expect(certification["validToYear"]).toBe(PLACEHOLDER);
  });

  it("a supplied field wins over the placeholder verbatim", async () => {
    const certification = await runDryRun(server, "ttctl_profile_certifications_update", "UPDATE_CERTIFICATION", {
      id: "V1-Certification-123",
      name: "Supplied Name",
      highlight: false,
    });
    // The override wins over the placeholder for fields the caller supplies.
    expect(certification["certificate"]).toBe("Supplied Name");
    expect(certification["highlight"]).toBe(false);
    // …while an omitted unconditional echo stays a placeholder.
    expect(certification["skills"]).toBe(PLACEHOLDER);
  });

  // --- add: skills is a concrete [] (no current row to resolve from) ---

  it("an add shows skills as the concrete [] the apply path always sends", async () => {
    const certification = await runDryRun(server, "ttctl_profile_certifications_add", "CREATE_CERTIFICATION", {
      name: "Some Cert",
      issuer: "Some Issuer",
    });
    // core add() defaults skills to [] (wire requires non-null) and the MCP tool
    // has no skills input — the preview must surface that literal, not omit it.
    expect(certification["skills"]).toEqual([]);
    expect(certification["certificate"]).toBe("Some Cert");
    expect(certification["institution"]).toBe("Some Issuer");
  });
});
