// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real and override
// only `profile.basic.set` so the dry-run integration tests can stub a
// preview outcome without touching any transport. Same pattern as
// `packages/cli/.../basic/__tests__/set.test.ts` for #52 — see there for
// the rationale on partial-mock-via-importOriginal.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    profile: {
      ...actual.profile,
      basic: {
        ...actual.profile.basic,
        set: vi.fn(),
      },
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerProfileBasicUpdateTool } from "../profile_basic_update.js";

/**
 * Pin the MCP integration of the dry-run path (closes #52 spec item 5
 * — "MCP tool integration when #10 lands", harmonised under #165). The
 * CLI side is covered in `packages/cli/.../basic/__tests__/set.test.ts`.
 * These tests verify that the MCP `ttctl_profile_basic_update` tool:
 *
 *   1. accepts a `dryRun?: boolean` input,
 *   2. forwards it to `profile.basic.set(token, changes, { dryRun })`,
 *   3. emits the uniform #165 dry-run envelope on the preview branch:
 *      `{ ok: true, dryRun: true, preview: DryRunPreview }` — every #165
 *      tool emits this same shape,
 *   4. emits the bare `UpdateProfileResult` on the apply branch (the
 *      pre-#165 `{ kind: "applied", result }` wrapper is dropped — see
 *      the tool's JSDoc for the breaking-change rationale).
 *
 * Bearer token redaction in the preview's `headers.authorization`
 * is the responsibility of `buildDryRunPreview` in core (verified in
 * core's transport tests); the MCP tool is a thin pass-through and
 * does not re-validate redaction.
 */

const TOOL_NAME = "ttctl_profile_basic_update";

const MOCKED_SET = profile.basic.set as ReturnType<typeof vi.fn>;

const PREVIEW_FIXTURE: DryRunPreview = {
  surface: "talent-profile",
  transport: "impersonated",
  endpoint: "https://www.toptal.com/api/talent_profile/graphql",
  operationName: "UPDATE_BASIC_INFO",
  variables: {
    input: {
      profileId: "<resolved at send-time from session token>",
      profile: { about: "test bio" },
    },
  },
  headers: {
    accept: "*/*",
    authorization: "Token token=<redacted>",
    "content-type": "application/json",
  },
};

const APPLIED_FIXTURE: profile.basic.UpdateProfileResult = {
  profile: {
    id: "p1",
    about: "test bio",
    quote: null,
    twitter: null,
  },
  notice: null,
};

/**
 * Build a `ToolRegistrationContext` whose `loadTokenForTool` returns a
 * successful fixture token. The other resolver shapes
 * (`resolveToolAuth`, `resolveTokenForTool`) are unused by this tool but
 * required by the `ToolRegistrationContext` type — they're stubbed with
 * never-callable assertions so a regression that wires them in
 * accidentally would surface on first invocation.
 */
function buildTokenSuccessCtx(token = "user_test_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn(() => {
      throw new Error("resolveToolAuth must not be called by profile_basic_update");
    }),
    resolveTokenForTool: vi.fn(() => {
      throw new Error("resolveTokenForTool must not be called by profile_basic_update");
    }),
  };
}

/**
 * Pull the tool's handler closure from `McpServer`'s internal
 * `_registeredTools` map and return it as a callable. Mirrors the
 * access pattern in `tools.test.ts` / `registration.test.ts` —
 * `_registeredTools` is private in the .d.ts but stable at runtime.
 */
function getToolHandler(server: McpServer, name: string): (input: unknown, extra: unknown) => Promise<unknown> {
  const internals = server as unknown as { _registeredTools: Record<string, { handler: unknown }> };
  const entry = internals._registeredTools[name];
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry.handler as (input: unknown, extra: unknown) => Promise<unknown>;
}

interface ToolSuccessShape {
  content: { type: string; text: string }[];
}

describe("ttctl_profile_basic_update MCP tool — dry-run integration (#10 closes #52 item 5; envelope harmonised under #165)", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_SET.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a `dryRun` input field on the tool schema", () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileBasicUpdateTool(server, ctx);

    const internals = server as unknown as {
      _registeredTools: Record<string, { inputSchema?: { keyof?: () => { options: string[] } } }>;
    };
    const entry = internals._registeredTools[TOOL_NAME];
    expect(entry).toBeDefined();
    // `inputSchema` is the zod object built from the registerTool call.
    // We verify the `dryRun` key is present by inspecting the shape directly.
    const inputSchema = entry?.inputSchema as unknown as { shape: Record<string, unknown> } | undefined;
    expect(inputSchema?.shape).toBeDefined();
    expect(inputSchema?.shape["dryRun"]).toBeDefined();
    expect(inputSchema?.shape["bio"]).toBeDefined();
    expect(inputSchema?.shape["headline"]).toBeDefined();
    // #535 — twitter joined the basic-update input schema.
    expect(inputSchema?.shape["twitter"]).toBeDefined();
  });

  it("forwards `dryRun: true` to profile.basic.set() and emits the uniform #165 dry-run envelope", async () => {
    const ctx = buildTokenSuccessCtx("user_dryrun_token");
    registerProfileBasicUpdateTool(server, ctx);
    MOCKED_SET.mockResolvedValueOnce({ kind: "preview", preview: PREVIEW_FIXTURE });

    const handler = getToolHandler(server, TOOL_NAME);
    const result = (await handler({ bio: "test bio", dryRun: true }, {})) as ToolSuccessShape;

    // `set()` received the dry-run flag.
    expect(MOCKED_SET).toHaveBeenCalledTimes(1);
    const args = MOCKED_SET.mock.calls[0];
    expect(args?.[0]).toBe("user_dryrun_token");
    expect(args?.[1]).toEqual({ bio: "test bio" });
    expect(args?.[2]).toEqual({ dryRun: true });

    // Tool result is the uniform #165 envelope:
    //   { ok: true, dryRun: true, preview: DryRunPreview }
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text) as { ok: boolean; dryRun: boolean; preview?: DryRunPreview };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview?.operationName).toBe("UPDATE_BASIC_INFO");
    expect(parsed.preview?.headers["authorization"]).toBe("Token token=<redacted>");
    expect(parsed.preview?.variables).toEqual(PREVIEW_FIXTURE.variables);
  });

  it("forwards `dryRun: false` (the default when omitted) and emits the apply payload directly (no `kind` wrapper)", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileBasicUpdateTool(server, ctx);
    MOCKED_SET.mockResolvedValueOnce({ kind: "applied", result: APPLIED_FIXTURE });

    const handler = getToolHandler(server, TOOL_NAME);
    const result = (await handler({ bio: "test bio" }, {})) as ToolSuccessShape;

    expect(MOCKED_SET).toHaveBeenCalledTimes(1);
    expect(MOCKED_SET.mock.calls[0]?.[2]).toEqual({ dryRun: false });

    // Apply path returns `outcome.result` directly — the pre-#165
    // `{ kind: "applied", result }` wrapper is dropped (breaking change
    // documented on the tool's JSDoc).
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text) as profile.basic.UpdateProfileResult;
    expect(parsed.profile.id).toBe("p1");
    expect(parsed.profile.about).toBe("test bio");
  });

  it("forwards explicit `dryRun: false` the same way as omitted", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileBasicUpdateTool(server, ctx);
    MOCKED_SET.mockResolvedValueOnce({ kind: "applied", result: APPLIED_FIXTURE });

    const handler = getToolHandler(server, TOOL_NAME);
    await handler({ bio: "test bio", dryRun: false }, {});

    expect(MOCKED_SET.mock.calls[0]?.[2]).toEqual({ dryRun: false });
  });

  it("propagates ProfileError(VALIDATION_ERROR) as an MCP error response when none of bio/headline/twitter supplied", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileBasicUpdateTool(server, ctx);
    // Real `set()` would throw `ProfileError("VALIDATION_ERROR", ...)` on
    // empty changes. Mirror that here.
    MOCKED_SET.mockRejectedValueOnce(
      new profile.basic.ProfileError(
        "VALIDATION_ERROR",
        "Profile update requires at least one of `bio`, `headline`, or `twitter`.",
      ),
    );

    const handler = getToolHandler(server, TOOL_NAME);
    const result = (await handler({ dryRun: true }, {})) as { isError: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("VALIDATION_ERROR");
    expect(result.content[0]?.text).toContain("at least one of");
  });

  it("forwards `twitter` to profile.basic.set() (basic-owned write surface per #535)", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileBasicUpdateTool(server, ctx);
    MOCKED_SET.mockResolvedValueOnce({
      kind: "applied",
      result: {
        profile: { id: "p1", about: "current", quote: "current", twitter: "alexey_pelykh" },
        notice: null,
      },
    });

    const handler = getToolHandler(server, TOOL_NAME);
    await handler({ twitter: "alexey_pelykh" }, {});

    expect(MOCKED_SET).toHaveBeenCalledTimes(1);
    expect(MOCKED_SET.mock.calls[0]?.[1]).toEqual({ twitter: "alexey_pelykh" });
  });

  it("forwards a twitter URL verbatim to set() — normalisation is core's job, not the MCP layer's (#526)", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileBasicUpdateTool(server, ctx);
    MOCKED_SET.mockResolvedValueOnce({
      kind: "applied",
      result: {
        profile: { id: "p1", about: "current", quote: "current", twitter: "alexey_pelykh" },
        notice: null,
      },
    });

    const handler = getToolHandler(server, TOOL_NAME);
    await handler({ twitter: "https://x.com/alexey_pelykh" }, {});

    expect(MOCKED_SET).toHaveBeenCalledTimes(1);
    // The MCP tool is a thin pass-through: it forwards the raw URL and
    // `profile.basic.set` normalises it to the bare handle (verified in
    // core's unit tests). A regression that double-normalised or mangled
    // the value here would surface as a mismatch.
    expect(MOCKED_SET.mock.calls[0]?.[1]).toEqual({ twitter: "https://x.com/alexey_pelykh" });
  });

  it("forwards `twitter: null` (the explicit clear intent) verbatim", async () => {
    const ctx = buildTokenSuccessCtx();
    registerProfileBasicUpdateTool(server, ctx);
    MOCKED_SET.mockResolvedValueOnce({
      kind: "applied",
      result: {
        profile: { id: "p1", about: "current", quote: "current", twitter: null },
        notice: null,
      },
    });

    const handler = getToolHandler(server, TOOL_NAME);
    await handler({ twitter: null }, {});

    expect(MOCKED_SET).toHaveBeenCalledTimes(1);
    // null is a real intent per ProfileUpdate.twitter's `string | null`
    // typing — must propagate, not be coerced to undefined.
    expect(MOCKED_SET.mock.calls[0]?.[1]).toEqual({ twitter: null });
  });
});
