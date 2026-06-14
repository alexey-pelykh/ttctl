// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerAllTools } from "../index.js";

/**
 * Verify the wave-3 tool registration:
 *
 * | Sub-domain          | Tools |
 * |---------------------|-------|
 * | basic (#73)         | 4 (show, update, photo_show, photo_upload) |
 * | skills (#73, +#462 add-connection, +#463 remove-connection) | 9 (add, remove, update, show, list, autocomplete, readiness, add-connection, remove-connection) |
 * | industries (#74, +show #342) | 6 (add, update, remove, show, list, autocomplete) |
 * | education (#74, +list #341)  | 6 (add, update, remove, show, highlight, list) |
 * | certifications (#74, +list #341) | 6 (add, update, remove, show, highlight, list) |
 * | employment (#74, +list #341) | 7 (add, update, remove, show, highlight, employer-autocomplete, list) |
 * | portfolio (#75)     | 8 (add, update, remove, list, reorder, highlight, upload_cover, upload_file) |
 * | visas (#75)         | 4 (add, update, remove, list) |
 * | resume (#75)        | 2 (upload, cancel_upload) |
 * | external (#76)      | 7 (show, update, custom_requirements_show/set, readiness, recommendations, advanced_wizard_show) |
 * | reviews (#76 − #544)| 3 (list, approve_item, approve_section) — `submit_for_review` removed in #544 (UX-trap: INFERRED-UNVERIFIED input + unnecessary) |
 * | countries (#596)    | 1 (list) — Country/geography catalog lookup (id-discovery for employment primaryGeographyId) |
 *
 * Total: 61 profile tools (was 58 before #341 added 3 list tools; #544 removed 1; #596 added 1).
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
  // profile.skills (#73 + #462 add-connection + #463 remove-connection)
  "ttctl_profile_skills_add",
  "ttctl_profile_skills_remove",
  "ttctl_profile_skills_remove_connection",
  "ttctl_profile_skills_update",
  "ttctl_profile_skills_show",
  "ttctl_profile_skills_list",
  "ttctl_profile_skills_autocomplete",
  "ttctl_profile_skills_readiness",
  "ttctl_profile_skills_add_connection",
  // industries (#74, +show #342, +add-connections #465)
  "ttctl_profile_industries_add",
  "ttctl_profile_industries_update",
  "ttctl_profile_industries_remove",
  "ttctl_profile_industries_show",
  "ttctl_profile_industries_list",
  "ttctl_profile_industries_add_connections",
  "ttctl_profile_industries_autocomplete",
  // education (#74, +list #341)
  "ttctl_profile_education_add",
  "ttctl_profile_education_update",
  "ttctl_profile_education_remove",
  "ttctl_profile_education_show",
  "ttctl_profile_education_highlight",
  "ttctl_profile_education_list",
  // certifications (#74, +list #341)
  "ttctl_profile_certifications_add",
  "ttctl_profile_certifications_update",
  "ttctl_profile_certifications_remove",
  "ttctl_profile_certifications_show",
  "ttctl_profile_certifications_highlight",
  "ttctl_profile_certifications_list",
  // employment (#74, +list #341, +reporting_to_autocomplete #468; 8 tools — includes employer_autocomplete + reporting_to_autocomplete catalog leaves)
  "ttctl_profile_employment_add",
  "ttctl_profile_employment_update",
  "ttctl_profile_employment_remove",
  "ttctl_profile_employment_show",
  "ttctl_profile_employment_highlight",
  "ttctl_profile_employment_employer_autocomplete",
  "ttctl_profile_employment_reporting_to_autocomplete",
  "ttctl_profile_employment_list",
  // #614 — additive merge ops over #541's full-replace `employment.update.skills`.
  "ttctl_profile_employment_skills_add",
  "ttctl_profile_employment_skills_remove",
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
  // external (#76; +show #343)
  "ttctl_profile_external_show",
  "ttctl_profile_external_update",
  "ttctl_profile_external_custom_requirements_show",
  "ttctl_profile_external_custom_requirements_set",
  "ttctl_profile_external_readiness",
  "ttctl_profile_external_recommendations",
  "ttctl_profile_external_advanced_wizard_show",
  // reviews (#76 − #544 removed unusable submit_for_review)
  "ttctl_profile_reviews_list",
  "ttctl_profile_reviews_approve_item",
  "ttctl_profile_reviews_approve_section",
  // specializations (#466 + #467) — 2 tools: read-only show + DESTRUCTIVE apply
  "ttctl_profile_specializations_show",
  "ttctl_profile_specializations_apply",
  // countries (#596) — 1 read-only tool: Country/geography catalog lookup
  // (id-discovery companion to employment `primaryGeographyId`, #586).
  "ttctl_profile_countries_list",
  // applications (#15, +#439, +#440, +#442, +#470) — 7 read-only tools at top-level
  // (#439 adds the interview-detail sub-namespace leaf; #440 adds the
  // interview-notes sub-sub-namespace leaf; #442 adds the
  // availability-request-detail sub-namespace leaf; #470 adds the
  // interview-prep-guide sub-sub-namespace leaf — sibling of notes).
  "ttctl_applications_availability_request_show",
  "ttctl_applications_interview_guide_show",
  "ttctl_applications_interview_notes_show",
  "ttctl_applications_interview_show",
  "ttctl_applications_list",
  "ttctl_applications_show",
  "ttctl_applications_stats",
  // interest_requests (#371, #411) — 4 affordances:
  // - list (#371): LLM-agent surface over ON_RECRUITER_REVIEW status group
  // - accept/reject/reject_reasons (#411): IR write surface
  "ttctl_interest_requests_list",
  "ttctl_interest_requests_accept",
  "ttctl_interest_requests_reject",
  "ttctl_interest_requests_reject_reasons",
  // contracts (#195) — 2 read-only tools at top-level (talent-level legal
  // documents via `viewer.contracts` on the portal surface; distinct from
  // the engagement-attached `EngagementAgreement` surfaced by engagements_show)
  "ttctl_contracts_list",
  "ttctl_contracts_show",
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
  // jobs (#148 + #436) — 17 tools (13 base: browse + interest + search
  // subscription) + 4 #436 apply-funnel: 1 DESTRUCTIVE mutation
  // (`apply`) + 3 read-only pre-apply tools (`apply_data`,
  // `apply_questions`, `apply_rate_insight`). Per AC: MCP names use
  // canonical `jobs_*` prefix only — no `opportunities_*` aliasing.
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
  "ttctl_jobs_apply",
  "ttctl_jobs_apply_data",
  "ttctl_jobs_apply_questions",
  "ttctl_jobs_apply_rate_insight",
  "ttctl_jobs_apply_similar_answers",
  // timesheet — 5 tools: list / show / submit (#13) + pending_list (#374) + update (#458).
  // Submit is destructive (one-way at the wire level); LLM clients must
  // confirm with the user. #374 pending_list exposes surface-honest
  // `limit` pagination (the viewer-wide wire field is LimitPagination,
  // no offset) — diverges from the offset-style page/perPage other
  // paginated tools use. See ADR-007 row 3.
  "ttctl_timesheet_list",
  "ttctl_timesheet_pending_list",
  "ttctl_timesheet_show",
  "ttctl_timesheet_submit",
  "ttctl_timesheet_update",
  // payments (#149, #447, #448) — 9 tools (summary + payouts list/show +
  // methods list/show + rate current/show/questions/change). rate_change
  // is destructive (compliance flow); LLM clients must confirm with the
  // user. rate_current (#447) is a lightweight read of the talent's
  // hourly rate via the trusted-catalog `GetTalentRate` op (T2
  // wire-validation). summary (#448) is the aggregate
  // `GetTalentPaymentSummary` read.
  "ttctl_payments_payouts_list",
  "ttctl_payments_payouts_show",
  "ttctl_payments_methods_list",
  "ttctl_payments_methods_show",
  "ttctl_payments_rate_current",
  "ttctl_payments_rate_show",
  "ttctl_payments_rate_questions",
  "ttctl_payments_rate_change",
  "ttctl_payments_summary",
  // surveys (#672/#673/#674) — 3 tools: list pending (`PendingSurveys`),
  // submit answers (`SubmitSurvey`) and add free-text feedback
  // (`AddSurveyFeedback`) — the two writes consent-gated + destructive.
  "ttctl_surveys_feedback",
  "ttctl_surveys_list",
  "ttctl_surveys_submit",
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

interface RegisteredToolInternal {
  outputSchema?: unknown;
}

function getRegisteredTools(server: McpServer): Record<string, RegisteredToolInternal> {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredToolInternal> };
  return internal._registeredTools;
}

function buildStubCtx(): ToolRegistrationContext {
  const stubToken = { token: "stub" };
  return {
    loadTokenForTool: vi.fn().mockResolvedValue(stubToken),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, ...stubToken }),
    resolveTokenForTool: vi.fn().mockResolvedValue(stubToken),
  };
}

describe("registerAllTools", () => {
  it("registers exactly the EXPECTED_TOOLS set (130 tools)", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server, buildStubCtx());
    const registered = getRegisteredToolNames(server);
    expect(registered.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("registers each expected tool name without throwing", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => {
      registerAllTools(server, buildStubCtx());
    }).not.toThrow();
  });

  it("never registers CLI-alias names (certs, experience) per #72 project policy", () => {
    // Verify against the actual server registry — not just the EXPECTED_TOOLS
    // constant — so a stray `ttctl_profile_certs_*` registration would fail.
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server, buildStubCtx());
    const registered = getRegisteredToolNames(server);
    const aliasNames = registered.filter((n) => /(_certs_|_experience_)/.test(n));
    expect(aliasNames).toEqual([]);
  });

  /**
   * #379 regression guard — assert NO registered tool declares an
   * `outputSchema`.
   *
   * Background: #226 added strict success-shape `outputSchema`s to the
   * write-capable tools. Every one of those tools ALSO supports
   * `dryRun: true`, which returns the uniform `{ ok, dryRun, preview }`
   * envelope (issue #165) — a shape that does NOT match the success
   * schema. MCP SDK ≥1.29 hard-throws
   * `Output validation error: … has an output schema but no structured
   * content was provided` when an `outputSchema` is declared and the
   * dry-run branch (correctly) omits `structuredContent`. That broke the
   * dry-run preview for every write tool (#379).
   *
   * The fix removes `outputSchema` from every tool (aligning with the
   * tools that never declared one — `industries_add`, `skills_add`, …).
   * This guard fails loudly if a future change re-introduces an
   * `outputSchema` on any tool: while EVERY current tool supports
   * `dryRun`, declaring an `outputSchema` re-opens the #379 failure.
   * A future tool that genuinely has no `dryRun` branch may declare one
   * — at which point this assertion should be narrowed to "no
   * dryRun-capable tool declares an outputSchema" rather than relaxed
   * away.
   */
  it("declares no outputSchema on any registered tool (#379 — dry-run/output-schema incompatibility)", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server, buildStubCtx());
    const tools = getRegisteredTools(server);
    const offenders = Object.entries(tools)
      .filter(([, tool]) => tool.outputSchema)
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
