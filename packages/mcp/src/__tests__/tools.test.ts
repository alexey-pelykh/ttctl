// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerAllTools } from "../tools/index.js";

/**
 * Smoke-test the tool-registration surface — every tool should register
 * without throwing, every tool name follows the canonical
 * `ttctl_profile_<sub-domain>_<verb>` shape, and the count matches the
 * #73 AC (4 basic + 7 skills = 11 tools).
 *
 * The MCP SDK does not expose a public listing of registered tools, so
 * we approximate by listing the keys on the underlying `_registeredTools`
 * record. If a future SDK version renames that internal field, update
 * this test — the expectation is structural, not the access mechanism.
 */
describe("MCP tool registration (issue #73)", () => {
  function listRegisteredToolNames(server: McpServer): string[] {
    const internals = server as unknown as { _registeredTools: Record<string, unknown> };
    return Object.keys(internals._registeredTools);
  }

  it("registers every tool without throwing", () => {
    const server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    expect(() => {
      registerAllTools(server);
    }).not.toThrow();
  });

  it("registers exactly the eleven tools the issue specifies", () => {
    const server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerAllTools(server);
    const names = listRegisteredToolNames(server).sort();

    expect(names).toEqual([
      "ttctl_profile_basic_photo_show",
      "ttctl_profile_basic_photo_upload",
      "ttctl_profile_basic_show",
      "ttctl_profile_basic_update",
      "ttctl_profile_skills_add",
      "ttctl_profile_skills_autocomplete",
      "ttctl_profile_skills_list",
      "ttctl_profile_skills_readiness",
      "ttctl_profile_skills_remove",
      "ttctl_profile_skills_show",
      "ttctl_profile_skills_update",
    ]);
  });

  it("uses canonical sub-domain spellings only (no aliases like `rm` / `certs`)", () => {
    const server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerAllTools(server);
    const names = listRegisteredToolNames(server);

    // Aliases the issue/project policy specifically forbids on MCP names.
    expect(names).not.toContain("ttctl_profile_skills_rm");
    expect(names).not.toContain("ttctl_profile_skills_remove_alias");
  });
});
