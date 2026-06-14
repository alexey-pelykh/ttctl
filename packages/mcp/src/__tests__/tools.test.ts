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
 *
 * Post-#149: + 7 payments tools (payouts list/show + methods list/show +
 * rate show/questions/change) = 95 tools total.
 *
 * Post-#195: + 2 contracts tools (list/show against `viewer.contracts` on
 * the portal surface) = 97 tools total.
 *
 * Post-#342: + 1 industries.show tool (per-id read companion of
 * industries.list, closing the Class A surface-shape gap) = 98 tools total.
 *
 * Post-#343: + 1 profile.external.show tool (read side of external URLs)
 * = 99 tools total.
 *
 * Post-#341: + 3 list tools (employment.list / education.list /
 * certifications.list) closing the matching Class A surface-shape gaps =
 * 102 tools total.
 *
 * Post-#371: + 1 interest_requests.list tool (LLM-agent affordance over the
 * ON_RECRUITER_REVIEW projection of applications.list — no new wire op,
 * client-side staleness filter) = 103 tools total.
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

  it("registers exactly the cumulative tool set (130 tools)", () => {
    const server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerAllTools(server);
    const names = listRegisteredToolNames(server).sort();

    expect(names).toEqual([
      // #15 + #439 + #440 + #442 + #470 — applications (7, read-only top-level group + interview detail + interview notes + interview guide + availability-request detail)
      "ttctl_applications_availability_request_show",
      "ttctl_applications_interview_guide_show",
      "ttctl_applications_interview_notes_show",
      "ttctl_applications_interview_show",
      "ttctl_applications_list",
      "ttctl_applications_show",
      "ttctl_applications_stats",
      // #146 amended — availability (5, top-level show + working-hours show/set + allocated-hours show/set)
      "ttctl_availability_allocated_hours_set",
      "ttctl_availability_allocated_hours_show",
      "ttctl_availability_show",
      "ttctl_availability_working_hours_set",
      "ttctl_availability_working_hours_show",
      // #195 — contracts (2, list/show against viewer.contracts on the portal surface)
      "ttctl_contracts_list",
      "ttctl_contracts_show",
      // #147 + #155 + #156 — engagements (8, list/show/stats + breaks list/add/remove/reschedule + breaks reasons list)
      "ttctl_engagements_breaks_add",
      "ttctl_engagements_breaks_list",
      "ttctl_engagements_breaks_reasons_list",
      "ttctl_engagements_breaks_remove",
      "ttctl_engagements_breaks_reschedule",
      "ttctl_engagements_list",
      "ttctl_engagements_show",
      "ttctl_engagements_stats",
      // #371 + #411 — interest_requests (4):
      //   - list (#371): LLM-agent affordance over ON_RECRUITER_REVIEW
      //   - accept/reject/reject_reasons (#411): IR write surface
      // Order is alphabetical (the test sorts before comparing).
      "ttctl_interest_requests_accept",
      "ttctl_interest_requests_list",
      "ttctl_interest_requests_reject",
      "ttctl_interest_requests_reject_reasons",
      // #148 + #436 — jobs (17, 13 base + 4 #436 apply-funnel)
      "ttctl_jobs_apply",
      "ttctl_jobs_apply_data",
      "ttctl_jobs_apply_questions",
      "ttctl_jobs_apply_rate_insight",
      "ttctl_jobs_apply_similar_answers",
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
      // #149 + #447 + #448 — payments (9, summary + payouts list/show +
      // methods list/show + rate current/show/questions/change).
      // rate_change is destructive (compliance flow); LLM clients must
      // confirm with the user. rate_current (#447) is a lightweight read
      // via the trusted-catalog `GetTalentRate` op (T2 wire-validation);
      // summary (#448) is the aggregate `GetTalentPaymentSummary` read.
      "ttctl_payments_methods_list",
      "ttctl_payments_methods_show",
      "ttctl_payments_payouts_list",
      "ttctl_payments_payouts_show",
      "ttctl_payments_rate_change",
      "ttctl_payments_rate_current",
      "ttctl_payments_rate_questions",
      "ttctl_payments_rate_show",
      "ttctl_payments_summary",
      // #73 — profile.basic (4)
      "ttctl_profile_basic_photo_show",
      "ttctl_profile_basic_photo_upload",
      "ttctl_profile_basic_show",
      "ttctl_profile_basic_update",
      // #74 — profile.certifications (6, +list #341)
      "ttctl_profile_certifications_add",
      "ttctl_profile_certifications_highlight",
      "ttctl_profile_certifications_list",
      "ttctl_profile_certifications_remove",
      "ttctl_profile_certifications_show",
      "ttctl_profile_certifications_update",
      // #596 — profile.countries (1, Country/geography catalog lookup)
      "ttctl_profile_countries_list",
      // #74 — profile.education (6, +list #341)
      "ttctl_profile_education_add",
      "ttctl_profile_education_highlight",
      "ttctl_profile_education_list",
      "ttctl_profile_education_remove",
      "ttctl_profile_education_show",
      "ttctl_profile_education_update",
      // #74 — profile.employment (10, includes employer_autocomplete + reporting_to_autocomplete #468, +list #341, +skills add/remove #614)
      "ttctl_profile_employment_add",
      "ttctl_profile_employment_employer_autocomplete",
      "ttctl_profile_employment_highlight",
      "ttctl_profile_employment_list",
      "ttctl_profile_employment_remove",
      "ttctl_profile_employment_reporting_to_autocomplete",
      "ttctl_profile_employment_show",
      // #614 — additive merge ops over #541's full-replace `employment.update.skills`.
      "ttctl_profile_employment_skills_add",
      "ttctl_profile_employment_skills_remove",
      "ttctl_profile_employment_update",
      // #76 — profile.external (7; +show #343)
      "ttctl_profile_external_advanced_wizard_show",
      "ttctl_profile_external_custom_requirements_set",
      "ttctl_profile_external_custom_requirements_show",
      "ttctl_profile_external_readiness",
      "ttctl_profile_external_recommendations",
      "ttctl_profile_external_show",
      "ttctl_profile_external_update",
      // #74 — profile.industries (7, +show #342, +add_connections #465)
      "ttctl_profile_industries_add",
      "ttctl_profile_industries_add_connections",
      "ttctl_profile_industries_autocomplete",
      "ttctl_profile_industries_list",
      "ttctl_profile_industries_remove",
      "ttctl_profile_industries_show",
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
      // #76 − #544 — profile.reviews (3; submit_for_review removed in #544)
      "ttctl_profile_reviews_approve_item",
      "ttctl_profile_reviews_approve_section",
      "ttctl_profile_reviews_list",
      // #73 + #462 + #463 — profile.skills (9)
      "ttctl_profile_skills_add",
      "ttctl_profile_skills_add_connection",
      "ttctl_profile_skills_autocomplete",
      "ttctl_profile_skills_list",
      "ttctl_profile_skills_readiness",
      "ttctl_profile_skills_remove",
      "ttctl_profile_skills_remove_connection",
      "ttctl_profile_skills_show",
      "ttctl_profile_skills_update",
      // #466 + #467 — profile.specializations (2, read GetTalentSpecializations + DESTRUCTIVE ApplyForSpecialization)
      "ttctl_profile_specializations_apply",
      "ttctl_profile_specializations_show",
      // #75 — profile.visas (4)
      "ttctl_profile_visas_add",
      "ttctl_profile_visas_list",
      "ttctl_profile_visas_remove",
      "ttctl_profile_visas_update",
      // #672 + #673 + #674 — surveys (3, list pending + submit answers + add free-text feedback)
      "ttctl_surveys_feedback",
      "ttctl_surveys_list",
      "ttctl_surveys_submit",
      // timesheet (5) — #13 list/show/submit + #374 pending_list + #458 update.
      // Submit is destructive (one-way); LLM clients must confirm with
      // the user. pending_list (#374) exposes surface-honest `limit`
      // pagination — diverges from page/perPage other paginated tools
      // because the viewer-wide wire field is LimitPagination
      // (no offset, no cursor). See ADR-007 row 3.
      "ttctl_timesheet_list",
      "ttctl_timesheet_pending_list",
      "ttctl_timesheet_show",
      "ttctl_timesheet_submit",
      "ttctl_timesheet_update",
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
