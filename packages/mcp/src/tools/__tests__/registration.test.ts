// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerAllTools } from "../index.js";

/**
 * Verify the wave-3 tool registration:
 *
 * | Sub-domain          | Tools |
 * |---------------------|-------|
 * | basic (#73)         | 4 (show, update, photo_show, photo_upload) |
 * | skills (#73)        | 7 (add, remove, update, show, list, autocomplete, readiness) |
 * | industries (#74)    | 5 (add, update, remove, list, autocomplete) |
 * | education (#74)     | 5 (add, update, remove, show, highlight) |
 * | certifications (#74)| 5 (add, update, remove, show, highlight) |
 * | employment (#74)    | 6 (add, update, remove, show, highlight, employer-autocomplete) |
 * | portfolio (#75)     | 8 (add, update, remove, list, reorder, highlight, upload_cover, upload_file) |
 * | visas (#75)         | 4 (add, update, remove, list) |
 * | resume (#75)        | 2 (upload, cancel_upload) |
 * | external (#76)      | 6 (update, custom_requirements_show/set, readiness, recommendations, advanced_wizard_show) |
 * | reviews (#76)       | 4 (list, approve_item, approve_section, submit_for_review) |
 *
 * Total: 56 tools.
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
  // portfolio (#75, 8 tools — `upload` exposed as two MCP tools)
  "ttctl_profile_portfolio_add",
  "ttctl_profile_portfolio_update",
  "ttctl_profile_portfolio_remove",
  "ttctl_profile_portfolio_list",
  "ttctl_profile_portfolio_reorder",
  "ttctl_profile_portfolio_highlight",
  "ttctl_profile_portfolio_upload_cover",
  "ttctl_profile_portfolio_upload_file",
  // visas (#75)
  "ttctl_profile_visas_add",
  "ttctl_profile_visas_update",
  "ttctl_profile_visas_remove",
  "ttctl_profile_visas_list",
  // resume (#75)
  "ttctl_profile_resume_upload",
  "ttctl_profile_resume_cancel_upload",
  // external (#76)
  "ttctl_profile_external_update",
  "ttctl_profile_external_custom_requirements_show",
  "ttctl_profile_external_custom_requirements_set",
  "ttctl_profile_external_readiness",
  "ttctl_profile_external_recommendations",
  "ttctl_profile_external_advanced_wizard_show",
  // reviews (#76)
  "ttctl_profile_reviews_list",
  "ttctl_profile_reviews_approve_item",
  "ttctl_profile_reviews_approve_section",
  "ttctl_profile_reviews_submit_for_review",
  // applications (#15) — 3 read-only tools at top-level
  "ttctl_applications_list",
  "ttctl_applications_show",
  "ttctl_applications_stats",
  // engagements (#147 + #155 + #156) — 8 tools (3 read + 5 break: list/add/remove/reschedule/reasons_list)
  "ttctl_engagements_list",
  "ttctl_engagements_show",
  "ttctl_engagements_stats",
  "ttctl_engagements_breaks_list",
  "ttctl_engagements_breaks_add",
  "ttctl_engagements_breaks_remove",
  "ttctl_engagements_breaks_reschedule",
  "ttctl_engagements_breaks_reasons_list",
  // availability (#146 amended) — 5 tools (snapshot show + working-hours
  // show/set + allocated-hours show/set; time-off lives on engagements)
  "ttctl_availability_show",
  "ttctl_availability_working_hours_show",
  "ttctl_availability_working_hours_set",
  "ttctl_availability_allocated_hours_show",
  "ttctl_availability_allocated_hours_set",
  // jobs (#148) — 13 tools (browse + interest + search subscription).
  // Per AC: MCP names use canonical `jobs_*` prefix only — no
  // `opportunities_*` aliasing.
  "ttctl_jobs_list",
  "ttctl_jobs_show",
  "ttctl_jobs_save",
  "ttctl_jobs_unsave",
  "ttctl_jobs_saved",
  "ttctl_jobs_viewed",
  "ttctl_jobs_mark_viewed",
  "ttctl_jobs_not_interested",
  "ttctl_jobs_not_interested_list",
  "ttctl_jobs_clear_interest",
  "ttctl_jobs_search_list",
  "ttctl_jobs_search_save",
  "ttctl_jobs_search_remove",
  // timesheet (#13) — 3 tools (list/show/submit). Submit is destructive
  // (one-way at the wire level); LLM clients must confirm with the user.
  "ttctl_timesheet_list",
  "ttctl_timesheet_show",
  "ttctl_timesheet_submit",
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
  it("registers exactly the EXPECTED_TOOLS set (88 tools = 56 wave-3 profile + 3 #15 applications + 8 #147/#155/#156 engagements + 5 #146 availability + 13 #148 jobs + 3 #13 timesheet)", () => {
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
