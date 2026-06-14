// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { me } from "@ttctl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerMeTools } from "../me.js";

/**
 * MCP-layer translator contract for `ttctl_me_actions_list` (#389), the
 * row-5 (bare bidirectional cursor) read. Live wire-shape validation lands
 * in the `TTCTL_E2E=1` suite + the T1 snapshot; these tests pin the
 * handler's arg threading, the zero-network dry-run, and error rendering.
 * The projection itself is tested in core.
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

interface RegisteredTool {
  handler: unknown;
  description?: string;
  inputSchema?: { shape?: Record<string, unknown> };
}

function getRegisteredTool(server: McpServer, name: string): RegisteredTool {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredTool | undefined> };
  const tool = internal._registeredTools[name];
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
}

function getRegisteredHandler(server: McpServer, name: string): ToolHandler {
  return getRegisteredTool(server, name).handler as ToolHandler;
}

function buildStubCtx(): ToolRegistrationContext {
  const stubToken = "stub-bearer-for-tests";
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token: stubToken }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
  };
}

const ACTION: me.PerformedAction = {
  id: "act-1",
  category: "APPLICATION",
  description: { template: "You applied to {{job}}", variables: [{ name: "job", text: "Eng" }] },
  occurredAt: "2026-05-01T12:34:56Z",
};

describe("ttctl_me_actions_list — registration", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerMeTools(server, buildStubCtx());
  });

  it("registers the tool with the row-5 input fields", () => {
    const shape = getRegisteredTool(server, "ttctl_me_actions_list").inputSchema?.shape;
    expect(shape).toBeDefined();
    expect(shape).toHaveProperty("before");
    expect(shape).toHaveProperty("after");
    expect(shape).toHaveProperty("limit");
    expect(shape).toHaveProperty("dryRun");
  });

  it("the read tool does NOT mark itself DESTRUCTIVE", () => {
    expect(getRegisteredTool(server, "ttctl_me_actions_list").description).not.toContain("DESTRUCTIVE");
  });
});

describe("ttctl_me_actions_list — handler", () => {
  let server: McpServer;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerMeTools(server, buildStubCtx());
    spy = vi.spyOn(me.actions, "list");
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("dryRun: emits the GetPerformedActions preview WITHOUT calling the core (zero-network)", async () => {
    const handler = getRegisteredHandler(server, "ttctl_me_actions_list");
    const result = await handler({ dryRun: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string; surface: string; variables: Record<string, unknown> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("GetPerformedActions");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    // Bare bidirectional cursor: all three keys present, nulled when omitted.
    expect(parsed.preview.variables).toEqual({ before: null, after: null, limit: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it("dryRun: reflects passed before/after/limit in the preview variables", async () => {
    const handler = getRegisteredHandler(server, "ttctl_me_actions_list");
    const result = await handler({ before: "cur-b", after: "cur-a", limit: 25, dryRun: true });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as { preview: { variables: Record<string, unknown> } };
    expect(parsed.preview.variables).toEqual({ before: "cur-b", after: "cur-a", limit: 25 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("apply path: threads only the supplied args into me.actions.list and returns the result JSON", async () => {
    spy.mockResolvedValue([ACTION]);
    const handler = getRegisteredHandler(server, "ttctl_me_actions_list");
    const result = await handler({ limit: 10 });
    expect(spy).toHaveBeenCalledWith("stub-bearer-for-tests", { limit: 10 });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as me.PerformedAction[];
    expect(parsed).toEqual([ACTION]);
  });

  it("apply path: empty input threads an empty options object", async () => {
    spy.mockResolvedValue([]);
    const handler = getRegisteredHandler(server, "ttctl_me_actions_list");
    await handler({});
    expect(spy).toHaveBeenCalledWith("stub-bearer-for-tests", {});
  });

  it("maps MeError(NO_VIEWER) to a structured error envelope", async () => {
    spy.mockRejectedValue(new me.MeError("NO_VIEWER", "Session is valid but no viewer is bound to it."));
    const handler = getRegisteredHandler(server, "ttctl_me_actions_list");
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("(Code: NO_VIEWER)");
  });
});
