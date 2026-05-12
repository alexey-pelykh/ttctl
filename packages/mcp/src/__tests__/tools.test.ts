// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerAllTools } from "../tools/index.js";

/**
 * Smoke-test the tool-registration surface — every tool should register
 * without throwing, every tool name follows the canonical
 * `ttctl_profile_<sub-domain>_<verb>` shape, and the registered set
 * tracks the cumulative Wave-3 sub-domain landing (#73 basic+skills,
 * #74 industries+education+certifications+employment, #75
 * portfolio+visas+resume, #76 external+reviews = 56 tools, plus the
 * #15 applications top-level group (3 tools) = 59 tools, plus the
 * #147 engagements top-level group (6 tools) = 65 tools, plus the #146
 * availability top-level group (5 tools) = 70 tools total).
 *
 * The MCP SDK does not expose a public listing of registered tools, so
 * we approximate by listing the keys on the underlying `_registeredTools`
 * record. If a future SDK version renames that internal field, update
 * this test — the expectation is structural, not the access mechanism.
 *
 * Post-#148: + 13 jobs tools (browse + interest + search subscription)
 * = 83 tools total.
 *
 * Post-#13: + 3 timesheet tools = 86 tools total.
 *
 * Post-#155: + 1 engagements.breaks.reschedule tool = 87 tools total.
 *
 * Post-#156: + 1 engagements.breaks.reasons.list tool = 88 tools total.
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

  it("registers exactly the cumulative tool set (88 tools = 56 wave-3 profile + 3 #15 applications + 8 #147/#155/#156 engagements + 5 #146 availability + 13 #148 jobs + 3 #13 timesheet)", () => {
    const server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerAllTools(server);
    const names = listRegisteredToolNames(server).sort();

    expect(names).toEqual([
      // #15 — applications (3, read-only top-level group)
      "ttctl_applications_list",
      "ttctl_applications_show",
      "ttctl_applications_stats",
      // #146 amended — availability (5, top-level show + working-hours show/set + allocated-hours show/set)
      "ttctl_availability_allocated_hours_set",
      "ttctl_availability_allocated_hours_show",
      "ttctl_availability_show",
      "ttctl_availability_working_hours_set",
      "ttctl_availability_working_hours_show",
      // #147 + #155 + #156 — engagements (8, list/show/stats + breaks list/add/remove/reschedule + breaks reasons list)
      "ttctl_engagements_breaks_add",
      "ttctl_engagements_breaks_list",
      "ttctl_engagements_breaks_reasons_list",
      "ttctl_engagements_breaks_remove",
      "ttctl_engagements_breaks_reschedule",
      "ttctl_engagements_list",
      "ttctl_engagements_show",
      "ttctl_engagements_stats",
      // #148 — jobs (13, browse + interest + search subscription)
      "ttctl_jobs_clear_interest",
      "ttctl_jobs_list",
      "ttctl_jobs_mark_viewed",
      "ttctl_jobs_not_interested",
      "ttctl_jobs_not_interested_list",
      "ttctl_jobs_save",
      "ttctl_jobs_saved",
      "ttctl_jobs_search_list",
      "ttctl_jobs_search_remove",
      "ttctl_jobs_search_save",
      "ttctl_jobs_show",
      "ttctl_jobs_unsave",
      "ttctl_jobs_viewed",
      // #73 — profile.basic (4)
      "ttctl_profile_basic_photo_show",
      "ttctl_profile_basic_photo_upload",
      "ttctl_profile_basic_show",
      "ttctl_profile_basic_update",
      // #74 — profile.certifications (5)
      "ttctl_profile_certifications_add",
      "ttctl_profile_certifications_highlight",
      "ttctl_profile_certifications_remove",
      "ttctl_profile_certifications_show",
      "ttctl_profile_certifications_update",
      // #74 — profile.education (5)
      "ttctl_profile_education_add",
      "ttctl_profile_education_highlight",
      "ttctl_profile_education_remove",
      "ttctl_profile_education_show",
      "ttctl_profile_education_update",
      // #74 — profile.employment (6, includes employer_autocomplete)
      "ttctl_profile_employment_add",
      "ttctl_profile_employment_employer_autocomplete",
      "ttctl_profile_employment_highlight",
      "ttctl_profile_employment_remove",
      "ttctl_profile_employment_show",
      "ttctl_profile_employment_update",
      // #76 — profile.external (6)
      "ttctl_profile_external_advanced_wizard_show",
      "ttctl_profile_external_custom_requirements_set",
      "ttctl_profile_external_custom_requirements_show",
      "ttctl_profile_external_readiness",
      "ttctl_profile_external_recommendations",
      "ttctl_profile_external_update",
      // #74 — profile.industries (5)
      "ttctl_profile_industries_add",
      "ttctl_profile_industries_autocomplete",
      "ttctl_profile_industries_list",
      "ttctl_profile_industries_remove",
      "ttctl_profile_industries_update",
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
      // #76 — profile.reviews (4)
      "ttctl_profile_reviews_approve_item",
      "ttctl_profile_reviews_approve_section",
      "ttctl_profile_reviews_list",
      "ttctl_profile_reviews_submit_for_review",
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
      // #13 — timesheet (3, list/show/submit). Submit is destructive
      // (one-way); LLM clients must confirm with the user.
      "ttctl_timesheet_list",
      "ttctl_timesheet_show",
      "ttctl_timesheet_submit",
    ]);
  });

  it("uses canonical sub-domain spellings only (no aliases like `rm` / `certs`)", () => {
    const server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerAllTools(server);
    const names = listRegisteredToolNames(server);

    // Aliases the issue/project policy specifically forbids on MCP names.
    expect(names).not.toContain("ttctl_profile_skills_rm");
    expect(names).not.toContain("ttctl_profile_skills_remove_alias");
    // External & reviews aliases the project policy forbids on MCP names
    // (CLI-only ergonomics — see #72 vocab table).
    expect(names).not.toContain("ttctl_profile_external_links_update");
    expect(names).not.toContain("ttctl_profile_reviews_approve");
  });
});
