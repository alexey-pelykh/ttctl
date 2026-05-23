// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../tools/_shared.js";
import { registerAllTools } from "../tools/index.js";

/**
 * Cross-cutting dry-run smoke test (issue #165 AC: "MCP integration test
 * — smoke-test that EVERY registered tool accepts `dryRun: true` and
 * produces a structurally-valid preview envelope. This is the
 * cross-cutting safety net").
 *
 * For each of the 118 registered tools:
 *   1. Invoke the handler with `dryRun: true` (plus minimal fixture
 *      input satisfying the zod schema).
 *   2. Assert the response is the uniform dry-run envelope —
 *      `{ ok: true, dryRun: true, preview }` (singular, most tools) OR
 *      `{ ok: true, dryRun: true, previews: DryRunPreview[] }` (plural,
 *      for the multi-mutation tools: `profile.skills.update`,
 *      `applications.stats`, `engagements.stats`).
 *   3. Assert the preview's `headers.authorization` is the redacted
 *      string `Token token=<redacted>` (the bearer-protection AC).
 *   4. Assert no underlying core function was called (vi.mock on the
 *      transport-fanout primitives in `@ttctl/core` proves zero-transport
 *      — the spies' `mock.calls` length stays at 0).
 *
 * Maintenance: when a new tool lands, append a fixture row to
 * `TOOL_INPUT_FIXTURES`. The smoke test will fail loudly on any tool
 * missing a fixture (the assertion path can't fabricate required input
 * values).
 */

// Module-level vi.mock for `@ttctl/core` transports. The mock ensures
// that if the dry-run branch is buggy and a transport call leaks, the
// stub throws — so the test fails LOUDLY rather than silently calling
// the live API. The dry-run path goes through `buildDryRunPreview`
// (a pure function), which is NOT stubbed — it remains real so the
// emitted preview's wire shape is verbatim.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  const transportSentinel = (): never => {
    throw new Error("smoke test: transport was called during dry-run — the tool's dryRun branch is broken");
  };
  return {
    ...actual,
    stockTransport: vi.fn(transportSentinel),
    impersonatedTransport: vi.fn(transportSentinel),
  };
});

interface ToolSuccessShape {
  content: { type: string; text: string }[];
}

interface DryRunSingleEnvelope {
  ok: true;
  dryRun: true;
  preview: {
    operationName: string;
    surface: string;
    transport: string;
    endpoint: string;
    variables: unknown;
    headers: Record<string, string>;
  };
}

interface DryRunMultiEnvelope {
  ok: true;
  dryRun: true;
  previews: DryRunSingleEnvelope["preview"][];
}

type DryRunEnvelope = DryRunSingleEnvelope | DryRunMultiEnvelope;

interface ToolEntry {
  handler: (input: unknown, extra: unknown) => Promise<ToolSuccessShape>;
}

function listRegisteredTools(server: McpServer): Record<string, ToolEntry> {
  const internals = server as unknown as { _registeredTools: Record<string, ToolEntry> };
  return internals._registeredTools;
}

/**
 * Build a `ToolRegistrationContext` whose three resolvers all succeed
 * with a stub token. The smoke test exercises the dry-run path of every
 * tool — none of these resolvers' error responses should fire.
 */
function buildSmokeCtx(token = "smoke_test_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token }),
  };
}

/**
 * Minimal input fixtures per tool. The `dryRun: true` flag is added
 * automatically — these fixtures only need to satisfy the zod schema's
 * non-dryRun required fields. Tools whose required fields are
 * `id: z.string()` get a single id; tools with no required fields get
 * an empty object.
 *
 * Order: alphabetical by tool name to keep diffs reviewable.
 */
const TOOL_INPUT_FIXTURES: Record<string, Record<string, unknown>> = {
  // applications (3 base + 1 interview_show #439 + 1 interview_notes_show #440 + 1 interview_guide_show #470 + 1 availability_request_show #442)
  ttctl_applications_list: {},
  ttctl_applications_show: { id: "act_123" },
  ttctl_applications_stats: {},
  ttctl_applications_interview_show: { id: "int_123" },
  ttctl_applications_interview_notes_show: { id: "job_123" },
  ttctl_applications_interview_guide_show: { id: "int_123" },
  ttctl_applications_availability_request_show: { id: "ar_123" },
  // availability (5)
  ttctl_availability_allocated_hours_set: { hours: 40 },
  ttctl_availability_allocated_hours_show: {},
  ttctl_availability_show: {},
  ttctl_availability_working_hours_set: { timeZone: "Europe/Berlin" },
  ttctl_availability_working_hours_show: {},
  // contracts (2 — #195)
  ttctl_contracts_list: {},
  ttctl_contracts_show: { id: "ct_123" },
  // engagements (7 — #147 + #155)
  ttctl_engagements_breaks_add: {
    id: "act_123",
    startDate: "2026-06-01",
    endDate: "2026-06-08",
    reasonIdentifier: "talent_on_vacation",
  },
  ttctl_engagements_breaks_list: { id: "act_123" },
  ttctl_engagements_breaks_reasons_list: {},
  ttctl_engagements_breaks_remove: { breakId: "br_abc" },
  ttctl_engagements_breaks_reschedule: {
    breakId: "br_abc",
    startDate: "2026-07-01",
    endDate: "2026-07-08",
  },
  ttctl_engagements_list: {},
  ttctl_engagements_show: { id: "act_123" },
  ttctl_engagements_stats: {},
  // interest_requests (4 — #371 list + #411 accept/reject/reject_reasons)
  ttctl_interest_requests_list: {},
  ttctl_interest_requests_accept: { id: "ar_123" },
  ttctl_interest_requests_reject: { id: "ar_123", reason: "rate_too_low" },
  ttctl_interest_requests_reject_reasons: {},
  // jobs (17 — 13 base + 4 apply-funnel #436)
  ttctl_jobs_apply: { id: "job_123", consentIssued: true, requestedHourlyRate: "95.00" },
  ttctl_jobs_apply_data: { id: "job_123" },
  ttctl_jobs_apply_questions: { id: "job_123" },
  ttctl_jobs_apply_rate_insight: { id: "job_123" },
  ttctl_jobs_apply_similar_answers: { id: "job_123" },
  ttctl_jobs_clear_interest: { id: "job_123" },
  ttctl_jobs_list: {},
  ttctl_jobs_mark_viewed: { id: "job_123" },
  ttctl_jobs_not_interested: { id: "job_123", reason: "schedule" },
  ttctl_jobs_not_interested_list: {},
  ttctl_jobs_save: { id: "job_123" },
  ttctl_jobs_saved: {},
  ttctl_jobs_search_list: {},
  ttctl_jobs_search_remove: {},
  ttctl_jobs_search_save: {},
  ttctl_jobs_show: { id: "job_123" },
  ttctl_jobs_unsave: { id: "job_123" },
  ttctl_jobs_viewed: {},
  // profile.basic (4)
  ttctl_profile_basic_photo_show: {},
  ttctl_profile_basic_photo_upload: { filePath: "/tmp/photo.jpg" },
  ttctl_profile_basic_show: {},
  ttctl_profile_basic_update: { bio: "smoke test bio" },
  // profile.certifications (6, +list #341)
  ttctl_profile_certifications_add: { name: "AWS Cert", issuer: "Amazon" },
  ttctl_profile_certifications_highlight: { id: "cert_123" },
  ttctl_profile_certifications_list: {},
  ttctl_profile_certifications_remove: { id: "cert_123" },
  ttctl_profile_certifications_show: { id: "cert_123" },
  ttctl_profile_certifications_update: { id: "cert_123", name: "AWS Pro" },
  // profile.education (6, +list #341)
  ttctl_profile_education_add: { institution: "MIT", degree: "BSc" },
  ttctl_profile_education_highlight: { id: "edu_123" },
  ttctl_profile_education_list: {},
  ttctl_profile_education_remove: { id: "edu_123" },
  ttctl_profile_education_show: { id: "edu_123" },
  ttctl_profile_education_update: { id: "edu_123", degree: "MSc" },
  // profile.employment (7, +list #341)
  // employerId bypass keeps the dry-run path zero-transport for the
  // smoke test (the autocomplete-resolution path is exercised in the
  // core service's unit tests). Per #395, the apply path now requires
  // employerId; dry-run without an explicit employerId fires the
  // `employersAutocomplete` read query, which is sentinel-rejected by
  // this test's transport mock. Per #403, industryIds is a required
  // parameter (mirrors portfolio_add) — supplied here so the fixture
  // exercises the new field path.
  ttctl_profile_employment_add: {
    company: "Toptal",
    role: "Engineer",
    employerId: "V1-Employer-stub",
    industryIds: ["V1-Industry-stub"],
  },
  ttctl_profile_employment_employer_autocomplete: { query: "Google" },
  ttctl_profile_employment_highlight: { id: "emp_123" },
  ttctl_profile_employment_list: {},
  ttctl_profile_employment_remove: { id: "emp_123" },
  ttctl_profile_employment_show: { id: "emp_123" },
  ttctl_profile_employment_update: { id: "emp_123", company: "Anthropic" },
  // profile.external (7; +show #343)
  ttctl_profile_external_show: {},
  ttctl_profile_external_advanced_wizard_show: {},
  ttctl_profile_external_custom_requirements_set: { backgroundCheck: true },
  ttctl_profile_external_custom_requirements_show: {},
  ttctl_profile_external_readiness: {},
  ttctl_profile_external_recommendations: {},
  ttctl_profile_external_update: { linkedin: "https://linkedin.com/in/jdoe" },
  // profile.industries (7, +show #342, +add_connections #465)
  ttctl_profile_industries_add: { name: "Healthcare" },
  ttctl_profile_industries_add_connections: {
    industryId: "V1-Industry-Fintech",
    employmentIds: ["V1-Employment-E1"],
    profileCapabilityConsentIssued: true,
  },
  ttctl_profile_industries_autocomplete: { query: "Health" },
  ttctl_profile_industries_list: {},
  ttctl_profile_industries_remove: { id: "ind_123" },
  ttctl_profile_industries_show: { id: "ind_123" },
  ttctl_profile_industries_update: { id: "ind_123", name: "Health Tech" },
  // profile.portfolio (8)
  ttctl_profile_portfolio_add: { title: "Smoke test item" },
  ttctl_profile_portfolio_highlight: { id: "pf_123" },
  ttctl_profile_portfolio_list: {},
  ttctl_profile_portfolio_remove: { id: "pf_123" },
  ttctl_profile_portfolio_reorder: { id: "pf_123", position: 0 },
  ttctl_profile_portfolio_update: { id: "pf_123", title: "Updated" },
  ttctl_profile_portfolio_upload_cover: { filePath: "/tmp/cover.jpg" },
  ttctl_profile_portfolio_upload_file: { filePath: "/tmp/attachment.pdf" },
  // profile.resume (2)
  ttctl_profile_resume_cancel_upload: {},
  ttctl_profile_resume_upload: { filePath: "/tmp/resume.pdf" },
  // profile.reviews (3; submit_for_review removed in #544)
  ttctl_profile_reviews_approve_item: { reviewId: "rv_1", itemId: "it_1", kind: "EDUCATION" },
  ttctl_profile_reviews_approve_section: { reviewId: "rv_1", section: "EDUCATION" },
  ttctl_profile_reviews_list: {},
  // profile.skills (7)
  // skillId bypass keeps the dry-run path zero-transport for the smoke
  // test. Per #405, dry-run without an explicit skillId fires the
  // `skillsAutocomplete` read query (mirroring #395 employment.add), which
  // is sentinel-rejected by this test's transport mock. The
  // autocomplete-resolution path is exercised in the core service's unit
  // tests.
  ttctl_profile_skills_add: { name: "TypeScript", skillId: "V1-Skill-stub" },
  ttctl_profile_skills_autocomplete: { query: "Type" },
  ttctl_profile_skills_list: {},
  ttctl_profile_skills_readiness: {},
  ttctl_profile_skills_remove: { id: "ss_123" },
  ttctl_profile_skills_show: { id: "ss_123" },
  ttctl_profile_skills_update: { id: "ss_123", rating: "EXPERT" },
  // profile.specializations (1, #466)
  ttctl_profile_specializations_show: {},
  ttctl_profile_specializations_apply: {
    specializationId: "spec-marketplace-uuid",
    profileCapabilityConsentIssued: true,
  },
  // profile.visas (4)
  ttctl_profile_visas_add: { countryId: "US", visaType: "B1/B2" },
  ttctl_profile_visas_list: {},
  ttctl_profile_visas_remove: { id: "vs_123" },
  ttctl_profile_visas_update: { id: "vs_123", visaType: "B1" },
  // timesheet (4 — #13 + #374 pending_list)
  ttctl_timesheet_list: {},
  ttctl_timesheet_pending_list: {},
  ttctl_timesheet_show: { id: "bc_123" },
  ttctl_timesheet_submit: { id: "bc_123" },
  // payments (9 — #149 + #447 rate_current + #448 summary)
  ttctl_payments_methods_list: {},
  ttctl_payments_methods_show: { id: "pm_123" },
  ttctl_payments_payouts_list: {},
  ttctl_payments_payouts_show: { id: "pmt_123" },
  ttctl_payments_rate_change: {
    kind: "future-engagements",
    desiredRate: "100",
    answers: [{ questionId: "q1", value: "smoke value" }],
  },
  ttctl_payments_rate_current: {},
  ttctl_payments_rate_questions: {},
  ttctl_payments_rate_show: {},
  ttctl_payments_summary: {},
};

/**
 * Tools whose dry-run path emits the PLURAL envelope (`previews: [...]`)
 * rather than the singular (`preview`). These tools fire multiple wire
 * operations per invocation; the plural envelope honestly reflects all
 * of them.
 */
const MULTI_PREVIEW_TOOLS = new Set([
  "ttctl_applications_stats", // 5 parallel JobActivityItems
  "ttctl_engagements_stats", // 2 parallel JobActivityItems
  "ttctl_profile_skills_update", // 1-3 sequential mutations based on fields
  "ttctl_payments_rate_show", // 2 parallel queries (LastRateChangeRequest + RateChangeFormDetails)
]);

describe("MCP tools — dryRun smoke test (#165)", () => {
  let server: McpServer;
  let tools: Record<string, ToolEntry>;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-smoke", version: "0.0.0" });
    registerAllTools(server, buildSmokeCtx());
    tools = listRegisteredTools(server);
  });

  it("registers exactly 120 tools (sanity for the smoke loop)", () => {
    // 104 pre-#411 + 3 new IR write-surface tools (#411): accept,
    // reject, reject_reasons + 4 new apply-funnel tools (#436):
    // apply, apply_data, apply_questions, apply_rate_insight + 1
    // new opt-in suggestion tool (#452): apply_similar_answers + 1
    // new lightweight rate read (#447): rate_current + 1 new
    // aggregate payment read (#448): summary + 1 new interview-detail
    // tool (#439): applications_interview_show + 1 new interview-notes
    // tool (#440): applications_interview_notes_show + 1 new
    // availability-request-detail tool (#442):
    // applications_availability_request_show + 1 new interview-guide
    // tool (#470): applications_interview_guide_show + 1 new
    // specializations read (#466): profile_specializations_show + 1
    // new DESTRUCTIVE specializations apply (#467):
    // profile_specializations_apply + 1 new Pattern-6 connection
    // helper (#465): profile_industries_add_connections −
    // 1 removed unusable profile_reviews_submit_for_review (#544).
    expect(Object.keys(tools)).toHaveLength(120);
  });

  it("every registered tool has a fixture", () => {
    const missing = Object.keys(tools).filter((name) => !(name in TOOL_INPUT_FIXTURES));
    expect(missing).toEqual([]);
  });

  it.each(Object.entries(TOOL_INPUT_FIXTURES))(
    "%s emits the dry-run envelope and skips transport",
    async (toolName, baseInput) => {
      const entry = tools[toolName];
      if (!entry) throw new Error(`tool not registered: ${toolName}`);

      const input = { ...baseInput, dryRun: true };
      const result = (await entry.handler(input, {})) as ToolSuccessShape;

      // The result body is a single JSON-text content slot per MCP convention.
      expect(result.content).toHaveLength(1);
      expect(result.content[0]?.type).toBe("text");

      const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;

      // Uniform envelope discriminators present.
      expect(parsed.ok).toBe(true);
      expect(parsed.dryRun).toBe(true);

      if (MULTI_PREVIEW_TOOLS.has(toolName)) {
        // Plural form — array of previews.
        const multi = parsed as DryRunMultiEnvelope;
        expect(Array.isArray(multi.previews)).toBe(true);
        expect(multi.previews.length).toBeGreaterThan(0);
        for (const preview of multi.previews) {
          assertPreviewShape(preview, toolName);
        }
      } else {
        // Singular form — one preview.
        const single = parsed as DryRunSingleEnvelope;
        expect(single.preview).toBeDefined();
        assertPreviewShape(single.preview, toolName);
      }
    },
  );
});

function assertPreviewShape(preview: DryRunSingleEnvelope["preview"], toolName: string): void {
  // Structural fields — all locked by the #128 envelope contract.
  expect(typeof preview.operationName).toBe("string");
  expect(preview.operationName.length).toBeGreaterThan(0);
  expect(["mobile-gateway", "talent-profile", "scheduler"]).toContain(preview.surface);
  expect(["stock", "impersonated"]).toContain(preview.transport);
  expect(typeof preview.endpoint).toBe("string");
  expect(preview.endpoint.startsWith("https://")).toBe(true);
  // Transport ↔ surface invariant.
  if (preview.surface === "mobile-gateway") {
    expect(preview.transport).toBe("stock");
  } else {
    expect(preview.transport).toBe("impersonated");
  }
  // Bearer redaction — the AC's headline guarantee.
  expect(preview.headers["authorization"]).toBe("Token token=<redacted>");
  // No `query` field on the locked envelope (per #128).
  expect("query" in preview).toBe(false);
  // Failure noise: include the tool name in any assertion message that
  // doesn't already (vitest's it.each does the prefix).
  expect(preview, `failure tool: ${toolName}`).toBeTruthy();
}
