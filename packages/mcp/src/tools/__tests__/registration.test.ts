// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerAllTools } from "../index.js";

/**
 * Verify the wave-3 tool registration:
 *
 * | Sub-domain     | Tools |
 * |----------------|-------|
 * | basic (#73)    | 4 (show, update, photo_show, photo_upload) |
 * | skills (#73)   | 7 (add, remove, update, show, list, autocomplete, readiness) |
 * | industries     | 5 (add, update, remove, list, autocomplete) |
 * | education      | 5 (add, update, remove, show, highlight) |
 * | certifications | 5 (add, update, remove, show, highlight) |
 * | employment     | 6 (add, update, remove, show, highlight, employer-autocomplete) |
 *
 * Total: 32 tools.
 *
 * Per project policy (#72), MCP tool names use ONLY the canonical sub-domain
 * names — no `certs`, no `experience`. These tests assert exact tool name
 * coverage by comparing to a canonical list.
 */

const EXPECTED_TOOLS = [
  // profile.basic (#73)
  "ttctl_profile_basic_show",
  "ttctl_profile_basic_update",
  "ttctl_profile_basic_photo_show",
  "ttctl_profile_basic_photo_upload",
  // profile.skills (#73)
  "ttctl_profile_skills_add",
  "ttctl_profile_skills_remove",
  "ttctl_profile_skills_update",
  "ttctl_profile_skills_show",
  "ttctl_profile_skills_list",
  "ttctl_profile_skills_autocomplete",
  "ttctl_profile_skills_readiness",
  // industries (#74)
  "ttctl_profile_industries_add",
  "ttctl_profile_industries_update",
  "ttctl_profile_industries_remove",
  "ttctl_profile_industries_list",
  "ttctl_profile_industries_autocomplete",
  // education (#74)
  "ttctl_profile_education_add",
  "ttctl_profile_education_update",
  "ttctl_profile_education_remove",
  "ttctl_profile_education_show",
  "ttctl_profile_education_highlight",
  // certifications (#74)
  "ttctl_profile_certifications_add",
  "ttctl_profile_certifications_update",
  "ttctl_profile_certifications_remove",
  "ttctl_profile_certifications_show",
  "ttctl_profile_certifications_highlight",
  // employment (#74, note: 6 tools — adds employer_autocomplete catalog leaf)
  "ttctl_profile_employment_add",
  "ttctl_profile_employment_update",
  "ttctl_profile_employment_remove",
  "ttctl_profile_employment_show",
  "ttctl_profile_employment_highlight",
  "ttctl_profile_employment_employer_autocomplete",
];

/**
 * Inspect the McpServer's internal `_registeredTools` map. The SDK stores
 * registered tools in a plain Record<string, RegisteredTool> (see
 * `@modelcontextprotocol/sdk/dist/esm/server/mcp.js` line 19 — `this._registeredTools = {}`)
 * but the field is `private` in the .d.ts. Tests access it via a typed
 * cast — runtime structure is stable across SDK versions.
 */
function getRegisteredToolNames(server: McpServer): string[] {
  const internal = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internal._registeredTools);
}

describe("registerAllTools", () => {
  it("registers exactly the EXPECTED_TOOLS set (32 tools)", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server);
    const registered = getRegisteredToolNames(server);
    expect(registered.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("registers each expected tool name without throwing", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => {
      registerAllTools(server);
    }).not.toThrow();
  });

  it("never registers CLI-alias names (certs, experience) per #72 project policy", () => {
    // Verify against the actual server registry — not just the EXPECTED_TOOLS
    // constant — so a stray `ttctl_profile_certs_*` registration would fail.
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server);
    const registered = getRegisteredToolNames(server);
    const aliasNames = registered.filter((n) => /(_certs_|_experience_)/.test(n));
    expect(aliasNames).toEqual([]);
  });
});
