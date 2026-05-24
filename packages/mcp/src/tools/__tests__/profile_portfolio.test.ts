// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerPortfolioTools } from "../profile/portfolio.js";

/**
 * Portfolio MCP tool-surface contract tests.
 *
 * #542 — `ttctl_profile_portfolio_highlight` must surface the Toptal
 * 3-item highlight cap in its description so MCP clients learn the
 * constraint up-front, rather than discovering it via the generic
 * `USER_ERROR` ("Something went wrong. Please try again later.") the
 * server returns when a 4th item is highlighted. Mirrors the #492
 * precedent (employment `experienceItems` range documented in the tool
 * description) and the `jobs_apply` DESTRUCTIVE-marker test pattern of
 * asserting against the registered tool's `description` string.
 */

interface RegisteredTool {
  description?: string;
}

function buildStubCtx(): ToolRegistrationContext {
  const stubToken = { token: "stub" };
  return {
    loadTokenForTool: vi.fn().mockResolvedValue(stubToken),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, ...stubToken }),
    resolveTokenForTool: vi.fn().mockResolvedValue(stubToken),
  };
}

function getRegisteredTool(server: McpServer, name: string): RegisteredTool {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredTool | undefined> };
  const tool = internal._registeredTools[name];
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
}

describe("ttctl_profile_portfolio_highlight description", () => {
  it("documents the Toptal 3-item highlight cap (#542)", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerPortfolioTools(server, buildStubCtx());
    const tool = getRegisteredTool(server, "ttctl_profile_portfolio_highlight");

    expect(tool.description).toBeDefined();
    // Names the numeric cap and frames it as a cap/limit so an MCP client
    // can pre-flight instead of learning it from the generic server error.
    expect(tool.description).toContain("3");
    expect(tool.description?.toLowerCase()).toMatch(/cap|limit/);
    // Points at the list tool so callers can see which items are already
    // highlighted before attempting to set a new one.
    expect(tool.description).toContain("ttctl_profile_portfolio_list");
  });
});

/**
 * #543 — `ttctl_profile_portfolio_update`'s `description` field has a
 * 200-character server-side minimum (`description is too short (minimum
 * is 200 characters)`) that the tool surface did not relay. The
 * constraint is field-scoped (not tool-level like the #542 cap), so this
 * asserts against the `description` field's `.describe()` text on the
 * registered tool's input schema. Mirrors the #492 precedent (upstream
 * constraint documented in the schema describe string).
 */
describe("ttctl_profile_portfolio_update description field", () => {
  it("documents the 200-character minimum on `description` (#543)", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerPortfolioTools(server, buildStubCtx());
    const internal = server as unknown as {
      _registeredTools: Record<
        string,
        { inputSchema?: { shape?: Record<string, { description?: string } | undefined> } } | undefined
      >;
    };
    const tool = internal._registeredTools["ttctl_profile_portfolio_update"];
    expect(tool).toBeDefined();
    const descField = tool?.inputSchema?.shape?.["description"];
    expect(descField).toBeDefined();
    // Names the numeric minimum and frames it as a minimum so an MCP
    // client can pre-flight instead of learning it from the server's
    // "description is too short" rejection.
    expect(descField?.description).toContain("200");
    expect(descField?.description?.toLowerCase()).toContain("minimum");
  });
});
