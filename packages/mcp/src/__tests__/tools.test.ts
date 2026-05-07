// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerAllTools } from "../tools/index.js";

/**
 * Smoke-test the tool-registration surface — every tool should register
 * without throwing, every tool name follows the canonical
 * `ttctl_profile_<sub-domain>_<verb>` shape, and the registered set
 * tracks the cumulative Wave-3 sub-domain landing (#73 + #75 so far).
 *
 * The MCP SDK does not expose a public listing of registered tools, so
 * we approximate by listing the keys on the underlying `_registeredTools`
 * record. If a future SDK version renames that internal field, update
 * this test — the expectation is structural, not the access mechanism.
 */
describe("MCP tool registration (Wave 3)", () => {
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

  it("registers exactly the cumulative Wave-3 tool set (#73 basic+skills + #75 portfolio+visas+resume)", () => {
    const server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerAllTools(server);
    const names = listRegisteredToolNames(server).sort();

    expect(names).toEqual([
      // #73 — profile.basic (4)
      "ttctl_profile_basic_photo_show",
      "ttctl_profile_basic_photo_upload",
      "ttctl_profile_basic_show",
      "ttctl_profile_basic_update",
      // #75 — profile.portfolio (8 tools: 7 leaves with `upload` exposed as
      // two MCP tools per the dual `upload_cover` / `upload_file` flags)
      "ttctl_profile_portfolio_add",
      "ttctl_profile_portfolio_highlight",
      "ttctl_profile_portfolio_list",
      "ttctl_profile_portfolio_remove",
      "ttctl_profile_portfolio_reorder",
      "ttctl_profile_portfolio_update",
      "ttctl_profile_portfolio_upload_cover",
      "ttctl_profile_portfolio_upload_file",
      // #75 — profile.resume (2)
      "ttctl_profile_resume_cancel_upload",
      "ttctl_profile_resume_upload",
      // #73 — profile.skills (7)
      "ttctl_profile_skills_add",
      "ttctl_profile_skills_autocomplete",
      "ttctl_profile_skills_list",
      "ttctl_profile_skills_readiness",
      "ttctl_profile_skills_remove",
      "ttctl_profile_skills_show",
      "ttctl_profile_skills_update",
      // #75 — profile.visas (4)
      "ttctl_profile_visas_add",
      "ttctl_profile_visas_list",
      "ttctl_profile_visas_remove",
      "ttctl_profile_visas_update",
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
