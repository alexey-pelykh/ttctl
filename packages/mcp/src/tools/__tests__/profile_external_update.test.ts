// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real and override only
// `profile.external.update` so the twitter-rejection tests can assert the
// apply path is NEVER reached without touching any transport. Same pattern
// as `profile_basic_update.test.ts`.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    profile: {
      ...actual.profile,
      external: {
        ...actual.profile.external,
        update: vi.fn(),
      },
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerProfileExternalUpdateTool } from "../profile_external_update.js";

/**
 * Pin the #526 contract for the MCP `ttctl_profile_external_update` tool:
 * `twitter` is declared on the input schema ONLY so a supplied value
 * returns an actionable redirect to `ttctl_profile_basic_update` rather
 * than being silently stripped by Zod. The guard fires BEFORE the dry-run
 * branch and before any apply call, so `profile.external.update` is never
 * reached when twitter is present.
 *
 * The redirect WORDING lives in `profile.external.TWITTER_NOT_EXTERNAL_MESSAGE`
 * (shared with the core guard and the CLI surface); these tests assert the
 * message reaches the MCP error envelope, not its exact prose.
 */

const TOOL_NAME = "ttctl_profile_external_update";

const MOCKED_UPDATE = profile.external.update as ReturnType<typeof vi.fn>;

function buildTokenSuccessCtx(token = "user_test_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn(() => {
      throw new Error("resolveToolAuth must not be called by profile_external_update");
    }),
    resolveTokenForTool: vi.fn(() => {
      throw new Error("resolveTokenForTool must not be called by profile_external_update");
    }),
  };
}

function getToolHandler(server: McpServer, name: string): (input: unknown, extra: unknown) => Promise<unknown> {
  const internals = server as unknown as { _registeredTools: Record<string, { handler: unknown }> };
  const entry = internals._registeredTools[name];
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry.handler as (input: unknown, extra: unknown) => Promise<unknown>;
}

interface ToolErrorShape {
  isError: boolean;
  content: { type: string; text: string }[];
}

describe("ttctl_profile_external_update MCP tool — #526 twitter redirect", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_UPDATE.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares `twitter` on the input schema (so the value reaches the guard instead of being stripped)", () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileExternalUpdateTool(server, ctx);

    const internals = server as unknown as {
      _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
    };
    const shape = internals._registeredTools[TOOL_NAME]?.inputSchema?.shape;
    expect(shape).toBeDefined();
    expect(shape?.["twitter"]).toBeDefined();
    // The five genuinely-settable fields remain.
    expect(shape?.["linkedin"]).toBeDefined();
    expect(shape?.["dribbble"]).toBeDefined();
  });

  it("rejects a twitter value with a VALIDATION_ERROR redirect to basic update, without calling update()", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileExternalUpdateTool(server, ctx);

    const handler = getToolHandler(server, TOOL_NAME);
    const result = (await handler({ twitter: "alexey_pelykh" }, {})) as ToolErrorShape;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("VALIDATION_ERROR");
    // Names where twitter actually lives.
    expect(result.content[0]?.text).toMatch(/basic update|basic\.set|ttctl_profile_basic_update/);
    // The apply path was never reached.
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
  });

  it("rejects twitter even with dryRun: true (guard fires before the dry-run preview branch)", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileExternalUpdateTool(server, ctx);

    const handler = getToolHandler(server, TOOL_NAME);
    const result = (await handler({ twitter: "https://x.com/alexey_pelykh", dryRun: true }, {})) as ToolErrorShape;

    // NOT a dry-run preview ({ ok: true, dryRun: true, ... }) — the twitter
    // guard short-circuits to the redirect error first.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("VALIDATION_ERROR");
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
  });

  it("rejects twitter regardless of value (null also triggers the redirect)", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileExternalUpdateTool(server, ctx);

    const handler = getToolHandler(server, TOOL_NAME);
    const result = (await handler({ twitter: null }, {})) as ToolErrorShape;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("VALIDATION_ERROR");
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
  });

  it("does NOT reject when twitter is absent — a linkedin-only update reaches update()", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileExternalUpdateTool(server, ctx);
    MOCKED_UPDATE.mockResolvedValueOnce({
      profile: {
        id: "p1",
        updatedByTalentAt: null,
        linkedin: "https://linkedin.com/in/ada",
        github: null,
        website: null,
        twitter: null,
        behance: null,
        dribbble: null,
      },
      notice: null,
    });

    const handler = getToolHandler(server, TOOL_NAME);
    await handler({ linkedin: "https://linkedin.com/in/ada" }, {});

    expect(MOCKED_UPDATE).toHaveBeenCalledTimes(1);
    expect(MOCKED_UPDATE.mock.calls[0]?.[1]).toEqual({ linkedin: "https://linkedin.com/in/ada" });
  });
});
