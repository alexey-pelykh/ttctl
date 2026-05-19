// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core — override only `profile.skills.add` so we
// can assert the MCP tool's input → service-fields mapping and the
// dry-run delegation. `buildDryRunPreview` and the real `add()` wire
// shaping are exercised separately in the core package's unit tests; here
// the focus is the MCP boundary.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    profile: {
      ...actual.profile,
      skills: {
        ...actual.profile.skills,
        add: vi.fn(),
      },
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerProfileSkillsAddTool } from "../profile_skills_add.js";

/**
 * MCP-boundary tests for `ttctl_profile_skills_add` after the #396
 * wire-shape rewrite.
 *
 * Asserts:
 *   - the tool maps its flat input schema to `AddSkillFields`
 *     (name + optional rating/experience/public/skillId), passing
 *     ONLY supplied fields (no `undefined` injection — defaults are the
 *     core service's job, verified in the core unit tests);
 *   - dry-run is delegated to the core service (`dryRun: true`) and the
 *     returned `{ kind: "preview" }` is rendered as the
 *     `{ ok, dryRun, preview }` envelope;
 *   - the apply path renders `{ kind: "created" }` as a JSON success;
 *   - a `ProfileError` (thrown by `extractProfileId` on the apply path —
 *     it lives in the `profile.basic` error namespace, NOT
 *     `SkillsError`) is surfaced as a domain-error envelope, not the
 *     generic fallback.
 */

const MOCKED_ADD = profile.skills.add as ReturnType<typeof vi.fn>;

function buildTokenSuccessCtx(token = "user_test_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn(() => {
      throw new Error("resolveToolAuth must not be called by this tool");
    }),
    resolveTokenForTool: vi.fn(() => {
      throw new Error("resolveTokenForTool must not be called by this tool");
    }),
  };
}

function getToolHandler(server: McpServer, name: string): (input: unknown, extra: unknown) => Promise<unknown> {
  const internals = server as unknown as { _registeredTools: Record<string, { handler: unknown }> };
  const entry = internals._registeredTools[name];
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry.handler as (input: unknown, extra: unknown) => Promise<unknown>;
}

interface ToolShape {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe("ttctl_profile_skills_add MCP boundary (#396)", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_ADD.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps name-only input to AddSkillFields and delegates dry-run to the service", async () => {
    MOCKED_ADD.mockResolvedValueOnce({
      kind: "preview",
      preview: {
        operationName: "ADD_PROFILE_SKILL_SET",
        surface: "talent-profile",
        transport: "impersonated",
        variables: { input: { profileId: "<placeholder>", skillSet: { name: "TypeScript" } } },
        headers: { authorization: "Token token=<redacted>" },
      },
    });

    registerProfileSkillsAddTool(server, buildTokenSuccessCtx("tok_a"));
    const handler = getToolHandler(server, "ttctl_profile_skills_add");
    const result = (await handler({ name: "TypeScript", dryRun: true }, {})) as ToolShape;

    // Service called with ONLY { name } in fields + { dryRun: true } in
    // options — no undefined rating/experience/public/skillId injected.
    expect(MOCKED_ADD).toHaveBeenCalledTimes(1);
    expect(MOCKED_ADD).toHaveBeenCalledWith("tok_a", { name: "TypeScript" }, { dryRun: true });

    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("ADD_PROFILE_SKILL_SET");
  });

  it("forwards explicit rating/experience/public/skillId to the service fields", async () => {
    MOCKED_ADD.mockResolvedValueOnce({
      kind: "created",
      result: {
        id: "V1-ProfileSkillSet-1",
        experience: 5,
        rating: "EXPERT",
        public: true,
        position: 1,
        skill: { id: "V1-Skill-278891", name: "PostgreSQL" },
        connectionsCount: 0,
      },
    });

    registerProfileSkillsAddTool(server, buildTokenSuccessCtx("tok_b"));
    const handler = getToolHandler(server, "ttctl_profile_skills_add");
    const result = (await handler(
      { name: "PostgreSQL", rating: "EXPERT", experience: 5, public: true, skillId: "V1-Skill-278891" },
      {},
    )) as ToolShape;

    expect(MOCKED_ADD).toHaveBeenCalledWith(
      "tok_b",
      { name: "PostgreSQL", rating: "EXPERT", experience: 5, public: true, skillId: "V1-Skill-278891" },
      { dryRun: false },
    );

    const parsed = JSON.parse(result.content[0]?.text ?? "") as { id: string; skill: { name: string } };
    expect(parsed.id).toBe("V1-ProfileSkillSet-1");
    expect(parsed.skill.name).toBe("PostgreSQL");
  });

  it("surfaces a ProfileError (from extractProfileId) as a domain-error envelope, not the generic fallback", async () => {
    MOCKED_ADD.mockRejectedValueOnce(
      new profile.basic.ProfileError("NO_VIEWER", "Cannot resolve profileId: viewer missing."),
    );

    registerProfileSkillsAddTool(server, buildTokenSuccessCtx("tok_c"));
    const handler = getToolHandler(server, "ttctl_profile_skills_add");
    const result = (await handler({ name: "Go" }, {})) as ToolShape;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    // domainErrorResponse renders `(<CODE>): <message>` + `(Code: <CODE>)`.
    // The generic fallback would render `(Code: UNKNOWN)` — assert we did
    // NOT take that path.
    expect(text).toContain("NO_VIEWER");
    expect(text).toContain("Cannot resolve profileId");
    expect(text).not.toContain("(Code: UNKNOWN)");
  });

  it("surfaces a SkillsError as a domain-error envelope", async () => {
    MOCKED_ADD.mockRejectedValueOnce(
      new profile.skills.SkillsError("USER_ERROR", "Skill add rejected (name): Skill already on profile"),
    );

    registerProfileSkillsAddTool(server, buildTokenSuccessCtx("tok_d"));
    const handler = getToolHandler(server, "ttctl_profile_skills_add");
    const result = (await handler({ name: "TypeScript" }, {})) as ToolShape;

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("USER_ERROR");
    expect(text).toContain("Skill already on profile");
  });
});
