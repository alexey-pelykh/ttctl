// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentinel the transport primitives (mirrors `profile_employment_dryrun_resolved_fields`):
// both education dry-run paths build their preview entirely in the MCP layer and
// must NOT touch any transport. If a regression makes a dry-run branch fall
// through to the apply path, the sentinel throws loudly rather than silently
// hitting the live API. `profile.education.*` is intentionally NOT mocked — the
// real `DRY_RUN_EDUCATION_FIELD_PLACEHOLDER` + `toEducationWireInput` are read through.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error("profile_education_skills: transport fired during dry-run — dryRun branch is broken");
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
import { registerEducationTools } from "../profile/education.js";

/**
 * Coverage for the `skills` writable surface on the `ttctl_profile_education_add`
 * / `ttctl_profile_education_update` MCP tools (#633 — mirror of the employment
 * `skills` surface from #541). Validates the MCP-layer wiring with zero network:
 * the caller's `skills: [{ id, name? }]` must land on the dry-run preview's
 * `education.skills` (verbatim ids, `name` defaulted to "" when omitted), and an
 * omitted `skills` must leave `add` at `[]` (core default) and `update` at the
 * merge placeholder (resolved-at-send-time from current state). The end-to-end
 * live wire round-trip is covered by `81-profile-education-update-merge.e2e.test.ts`.
 */

const PLACEHOLDER = profile.education.DRY_RUN_EDUCATION_FIELD_PLACEHOLDER;

function buildCtx(token = "user_edu_skills_token"): ToolRegistrationContext {
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
  return (parsed.preview.variables as { input: { education: Record<string, unknown> } }).input.education;
}

describe("profile.education skills surface — MCP dry-run wiring (#633)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerEducationTools(server, buildCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- add ---

  it("add: supplied skills land on the preview verbatim (name defaulted to '')", async () => {
    const education = await runDryRun(server, "ttctl_profile_education_add", "CREATE_EDUCATION", {
      institution: "MIT",
      degree: "BSc",
      skills: [{ id: "V1-Skill-1", name: "Rust" }, { id: "V1-Skill-2" }],
    });
    expect(education["skills"]).toEqual([
      { id: "V1-Skill-1", name: "Rust" },
      { id: "V1-Skill-2", name: "" },
    ]);
  });

  it("add: omitted skills default to [] (mirrors core add())", async () => {
    const education = await runDryRun(server, "ttctl_profile_education_add", "CREATE_EDUCATION", {
      institution: "MIT",
      degree: "BSc",
    });
    expect(education["skills"]).toEqual([]);
  });

  // --- update ---

  it("update: supplied skills override the merge placeholder verbatim (name defaulted to '')", async () => {
    const education = await runDryRun(server, "ttctl_profile_education_update", "UPDATE_EDUCATION", {
      id: "V1-Education-123",
      skills: [{ id: "V1-Skill-9", name: "Go" }, { id: "V1-Skill-10" }],
    });
    expect(education["skills"]).toEqual([
      { id: "V1-Skill-9", name: "Go" },
      { id: "V1-Skill-10", name: "" },
    ]);
  });

  it("update: omitted skills stay as the resolved-at-send-time merge placeholder", async () => {
    const education = await runDryRun(server, "ttctl_profile_education_update", "UPDATE_EDUCATION", {
      id: "V1-Education-123",
      degree: "MSc",
    });
    expect(education["skills"]).toBe(PLACEHOLDER);
  });
});
