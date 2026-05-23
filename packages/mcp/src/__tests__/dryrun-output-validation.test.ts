// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../tools/_shared.js";
import { registerAllTools } from "../tools/index.js";

/**
 * Regression test for issue #379 — dry-run preview failed MCP output
 * validation on every write-capable tool.
 *
 * **Why this test exists separately from `dryrun-smoke.test.ts`**: the
 * smoke test invokes each tool's `handler(input)` callback DIRECTLY. The
 * SDK runs `validateToolOutput` AFTER the handler returns, in the
 * `tools/call` JSON-RPC request handler — a layer the smoke test never
 * reaches. That blind spot is exactly why #379 shipped: the smoke test
 * was green while real MCP clients (Claude Desktop / Claude Code) hit
 * `MCP error -32602: Output validation error: Tool <name> has an output
 * schema but no structured content was provided` on every `dryRun: true`
 * call against a #226 tool.
 *
 * This test drives a real {@link Client} over an in-memory transport
 * pair, so `tools/list` + `tools/call` round-trip through the full
 * server pipeline INCLUDING the SDK's server-side `validateToolOutput`.
 * It is the cross-cutting net the issue's AC #5 asks for
 * ("Output-schema test fixture added covering the dryRun shape across
 * all write tools").
 *
 * Pre-fix failure mechanism (MCP SDK ≥1.29): when a tool declares an
 * `outputSchema` and its result omits `structuredContent`, the SERVER's
 * `validateToolOutput` (`mcp.js`) throws an `McpError`. The server's
 * `tools/call` handler catches that throw and converts it to a tool
 * result with `isError: true` (`mcp.js` catch → `createToolError`). The
 * client-side `callTool` post-result check (`client/index.js`) is a
 * second guard, but it is SUPPRESSED here by its own
 * `&& !result.isError` condition (the server already produced an
 * `isError` result), so the server-side path is the one that fires in
 * this scenario. The dry-run branch correctly omits `structuredContent`
 * (the `{ ok, dryRun, preview }` envelope does not match any tool's
 * success-shape schema). The #379 fix removes `outputSchema` from every
 * tool, so the throw site is never reached; this test asserts the
 * dry-run path is reachable end-to-end as a result (and would catch a
 * regression via the `expect(result.isError ?? false).toBe(false)`
 * assertion detecting the converted `isError` result).
 */

// Transport sentinel — if a dry-run path leaks a real transport call the
// stub throws, so the failure is loud rather than a silent live-API hit.
// `buildDryRunPreview` (pure) stays real so the emitted preview is verbatim.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error(
      "dryrun-output-validation: transport was called during dry-run — the tool's dryRun branch is broken",
    );
  };
  return {
    ...actual,
    stockTransport: vi.fn(transportSentinel),
    impersonatedTransport: vi.fn(transportSentinel),
  };
});

function buildSmokeCtx(token = "dryrun_output_validation_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token }),
  };
}

/**
 * The write-capable tools that carried a strict success-shape
 * `outputSchema` before #379 (the former `TOOLS_WITH_OUTPUT_SCHEMA`
 * set). Every one of these is a dry-run-capable tool whose
 * `dryRun: true` branch returns the `{ ok, dryRun, preview }` envelope —
 * the exact combination that tripped the SDK ≥1.29 validation throw.
 *
 * Plus the two "working comparison" tools the issue cites
 * (`industries_add`, `skills_add`) that never declared an outputSchema
 * — AC #4 ("Existing successful tools continue working").
 */
const FORMERLY_AFFECTED_FIXTURES: Record<string, Record<string, unknown>> = {
  ttctl_profile_basic_update: { bio: "regression bio", headline: "regression headline" },
  ttctl_profile_basic_photo_upload: { file: "/tmp/photo.jpg" },
  ttctl_profile_resume_upload: { filePath: "/tmp/resume.pdf" },
  ttctl_profile_education_add: { institution: "MIT", degree: "BSc" },
  ttctl_profile_education_update: { id: "edu_123", degree: "MSc" },
  ttctl_profile_education_remove: { id: "edu_123" },
  // employerId bypass keeps dry-run zero-transport — see sibling
  // dryrun-smoke.test.ts fixture comment for the #395 rationale.
  // #403: industryIds is a required (zod `.min(1)`) parameter on
  // employment_add (mirrors portfolio_add). This test drives a real
  // zod-validated Client, so the field MUST be present.
  ttctl_profile_employment_add: {
    company: "Toptal",
    role: "Engineer",
    employerId: "V1-Employer-stub",
    industryIds: ["V1-Industry-stub"],
  },
  ttctl_profile_employment_update: { id: "emp_123", company: "Anthropic" },
  ttctl_profile_employment_remove: { id: "emp_123" },
  ttctl_profile_industries_update: { id: "ind_123", name: "Health Tech" },
  ttctl_profile_industries_show: { id: "ind_123" },
  // Working-comparison tools (issue § "Working comparison") — never had
  // an outputSchema; must keep working.
  ttctl_profile_industries_add: { name: "Healthcare" },
  // #405: dry-run without skillId fires skillsAutocomplete (the
  // transport sentinel would reject); pass skillId to bypass.
  ttctl_profile_skills_add: { name: "TypeScript", skillId: "V1-Skill-stub" },
};

interface DryRunEnvelope {
  ok: true;
  dryRun: true;
  preview: { operationName: string; headers: Record<string, string> };
}

describe("MCP tools — dry-run output-schema validation round-trip (#379)", () => {
  let client: Client;

  beforeEach(async () => {
    const server = new McpServer({ name: "ttctl-379", version: "0.0.0" });
    registerAllTools(server, buildSmokeCtx());

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "ttctl-379-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Mirror a real MCP client session: list tools first (this also
    // primes the client-side structured-output validator cache, so
    // BOTH the server-side and client-side #379 throw sites are
    // exercised by the subsequent callTool round-trips).
    await client.listTools();
  });

  it.each(Object.entries(FORMERLY_AFFECTED_FIXTURES))(
    "%s dryRun: true round-trips through tools/call without an output-validation error",
    async (toolName, baseArgs) => {
      // Before the #379 fix the server's validateToolOutput threw, and
      // the tools/call handler converted it to a tool result with
      //   isError: true, text:
      //   "Output validation error: Tool <name> has an output schema
      //    but no structured content was provided"
      // (surfaced to MCP hosts as `MCP error -32602`). After the fix the
      // throw site is unreachable.
      const result = await client.callTool({
        name: toolName,
        arguments: { ...baseArgs, dryRun: true },
      });

      expect(result.isError ?? false).toBe(false);

      const content = result.content as { type: string; text: string }[];
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");

      const parsed = JSON.parse(content[0]?.text ?? "") as DryRunEnvelope;
      expect(parsed.ok).toBe(true);
      expect(parsed.dryRun).toBe(true);
      expect(typeof parsed.preview.operationName).toBe("string");
      expect(parsed.preview.operationName.length).toBeGreaterThan(0);
      // Bearer redaction is preserved through the full round-trip.
      expect(parsed.preview.headers["authorization"]).toBe("Token token=<redacted>");
    },
  );
});
