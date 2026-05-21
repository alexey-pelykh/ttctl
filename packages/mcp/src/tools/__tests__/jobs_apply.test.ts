// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applications } from "@ttctl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerJobsTools } from "../jobs.js";

/**
 * Tests for the four apply-funnel MCP tools registered alongside the
 * existing `ttctl_jobs_*` surface (#436):
 *
 *   - `ttctl_jobs_apply` — DESTRUCTIVE mutation; consent-gated via
 *     `z.literal(true)` on `consentIssued`.
 *   - `ttctl_jobs_apply_data` — read-only; wraps `applications.applyData`.
 *   - `ttctl_jobs_apply_questions` — read-only; wraps
 *     `applications.applyQuestions`.
 *   - `ttctl_jobs_apply_rate_insight` — read-only; wraps
 *     `applications.rateInsight`.
 *
 * Live wire-shape validation lands in #445 (TTCTL_E2E=1). The tests
 * below pin the MCP-layer translator contract:
 *
 *   1. Registration smoke — each tool appears in `_registeredTools`
 *      with the expected `inputSchema` shape.
 *   2. Dry-run envelope — emitted without invoking the core (for read
 *      tools) and threaded into the core (for `ttctl_jobs_apply`, which
 *      composes its preview at the service layer per the
 *      `applications.apply` pattern).
 *   3. Apply path — handler calls the core fn with the expected
 *      arguments and shape-matches the output.
 *   4. Consent gate — `consentIssued: false` rejects at the Zod
 *      boundary BEFORE the core path runs.
 *   5. Error mapping — `ApplicationsError` cases (NOT_FOUND,
 *      ALREADY_APPLIED, CONSENT_REQUIRED, WIRE_SHAPE_ERROR) map to
 *      the canonical structured envelope.
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

interface RegisteredTool {
  handler: unknown;
  inputSchema?: { shape?: Record<string, unknown>; safeParse?: (input: unknown) => { success: boolean } };
}

function getRegisteredHandler(server: McpServer, name: string): ToolHandler {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredTool | undefined> };
  const tool = internal._registeredTools[name];
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool.handler as ToolHandler;
}

function getRegisteredTool(server: McpServer, name: string): RegisteredTool {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredTool | undefined> };
  const tool = internal._registeredTools[name];
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
}

function buildStubCtx(): ToolRegistrationContext {
  const stubToken = "stub-bearer-for-tests";
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token: stubToken }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
  };
}

function applied<T>(result: T): { kind: "applied"; result: T } {
  return { kind: "applied", result };
}

const PRE_APPLY_DATA_FIXTURE: applications.PreApplyData = {
  job: { id: "job_001", isCoaching: false, hasRequiredApplicationPitch: false },
  applyErrors: [],
  canApply: true,
  suggestedRate: "85.00",
  rateValidation: { minRate: "20.00", rateStep: 1 },
};

const APPLICATION_QUESTIONS_FIXTURE: applications.ApplicationQuestions = {
  matcherQuestions: [{ identifier: "MQ-1", prompt: "Have you done X?", type: "matcher", isMandatory: true }],
  expertiseQuestions: [{ identifier: "EQ-1", prompt: "TypeScript", type: "expertise", isMandatory: true }],
};

const RATE_INSIGHT_FIXTURE: applications.RateInsight = {
  kind: "competitive",
  estimatedRevenue: "12000.00",
  estimatedRevenueExplanation: "Estimated based on a 6-month engagement at 30 hours/week.",
  longTermDisclaimer: "Long-term assumption applies.",
};

const APPLY_RECORD_FIXTURE: applications.JobApplicationRecord = {
  id: "app_001",
  statusV2: { value: "ON_CLIENT_REVIEW", verbose: "On Client Review" },
  requestedHourlyRate: { decimal: "95.00" },
  jobActivityItemId: "act_001",
};

// ---------------------------------------------------------------------
// Registration smoke
// ---------------------------------------------------------------------

describe("ttctl_jobs_apply* — registration", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerJobsTools(server, buildStubCtx());
  });

  it("registers all four apply-funnel tools", () => {
    const internal = server as unknown as { _registeredTools: Record<string, RegisteredTool | undefined> };
    expect(internal._registeredTools["ttctl_jobs_apply"]).toBeDefined();
    expect(internal._registeredTools["ttctl_jobs_apply_data"]).toBeDefined();
    expect(internal._registeredTools["ttctl_jobs_apply_questions"]).toBeDefined();
    expect(internal._registeredTools["ttctl_jobs_apply_rate_insight"]).toBeDefined();
  });

  it("ttctl_jobs_apply registers the documented input fields", () => {
    const tool = getRegisteredTool(server, "ttctl_jobs_apply");
    const shape = tool.inputSchema?.shape;
    expect(shape).toBeDefined();
    expect(shape).toHaveProperty("id");
    expect(shape).toHaveProperty("consentIssued");
    expect(shape).toHaveProperty("requestedHourlyRate");
    expect(shape).toHaveProperty("message");
    expect(shape).toHaveProperty("matcherAnswers");
    expect(shape).toHaveProperty("expertiseAnswers");
    expect(shape).toHaveProperty("pitchData");
    expect(shape).toHaveProperty("dryRun");
  });

  it("ttctl_jobs_apply_data / _questions / _rate_insight register `id` + `dryRun` only", () => {
    for (const toolName of ["ttctl_jobs_apply_data", "ttctl_jobs_apply_questions", "ttctl_jobs_apply_rate_insight"]) {
      const tool = getRegisteredTool(server, toolName);
      const shape = tool.inputSchema?.shape;
      expect(shape).toBeDefined();
      expect(shape).toHaveProperty("id");
      expect(shape).toHaveProperty("dryRun");
      // No write-side fields on the read tools.
      expect(shape).not.toHaveProperty("consentIssued");
      expect(shape).not.toHaveProperty("matcherAnswers");
    }
  });

  it("ttctl_jobs_apply description marks DESTRUCTIVE", () => {
    const internal = server as unknown as {
      _registeredTools: Record<string, (RegisteredTool & { description?: string }) | undefined>;
    };
    const tool = internal._registeredTools["ttctl_jobs_apply"];
    expect(tool?.description).toContain("DESTRUCTIVE");
  });

  it("ttctl_jobs_apply_data / _questions / _rate_insight descriptions do NOT contain DESTRUCTIVE", () => {
    const internal = server as unknown as {
      _registeredTools: Record<string, (RegisteredTool & { description?: string }) | undefined>;
    };
    for (const toolName of ["ttctl_jobs_apply_data", "ttctl_jobs_apply_questions", "ttctl_jobs_apply_rate_insight"]) {
      const tool = internal._registeredTools[toolName];
      expect(tool?.description).not.toContain("DESTRUCTIVE");
    }
  });

  it("ttctl_jobs_apply description documents the consent gate + FORBIDDEN-AUTO-FILL constraint", () => {
    const internal = server as unknown as {
      _registeredTools: Record<string, (RegisteredTool & { description?: string }) | undefined>;
    };
    const tool = internal._registeredTools["ttctl_jobs_apply"];
    expect(tool?.description).toContain("Consent gate");
    expect(tool?.description).toContain("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------
// ttctl_jobs_apply_data
// ---------------------------------------------------------------------

describe("ttctl_jobs_apply_data — handler", () => {
  let server: McpServer;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerJobsTools(server, buildStubCtx());
    spy = vi.spyOn(applications, "applyData");
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("dryRun: emits the JobApplyData preview envelope without calling the core", async () => {
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_data");
    const result = await handler({ id: "job_001", dryRun: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string; variables: Record<string, unknown>; surface: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("JobApplyData");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    expect(parsed.preview.variables).toEqual({ jobId: "job_001" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("apply path: calls applications.applyData(token, jobId)", async () => {
    spy.mockResolvedValue(PRE_APPLY_DATA_FIXTURE);
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_data");
    await handler({ id: "job_001" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("stub-bearer-for-tests", "job_001");
  });

  it("apply path: returns the pre-apply data as JSON", async () => {
    spy.mockResolvedValue(PRE_APPLY_DATA_FIXTURE);
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_data");
    const result = await handler({ id: "job_001" });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as applications.PreApplyData;
    expect(parsed.canApply).toBe(true);
    expect(parsed.suggestedRate).toBe("85.00");
  });

  it("maps ApplicationsError(NOT_FOUND) to a structured error envelope", async () => {
    spy.mockRejectedValue(new applications.ApplicationsError("NOT_FOUND", "no such job"));
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_data");
    const result = await handler({ id: "missing" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: NOT_FOUND)");
    expect(text).toContain("ttctl_jobs_list");
  });
});

// ---------------------------------------------------------------------
// ttctl_jobs_apply_questions
// ---------------------------------------------------------------------

describe("ttctl_jobs_apply_questions — handler", () => {
  let server: McpServer;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerJobsTools(server, buildStubCtx());
    spy = vi.spyOn(applications, "applyQuestions");
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("dryRun: emits the JobApplicationQuestions preview envelope without calling the core", async () => {
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_questions");
    const result = await handler({ id: "job_001", dryRun: true });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      preview: { operationName: string; variables: Record<string, unknown>; surface: string };
    };
    expect(parsed.preview.operationName).toBe("JobApplicationQuestions");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    expect(parsed.preview.variables).toEqual({ jobId: "job_001" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("apply path: calls applications.applyQuestions(token, jobId) and returns the inventory", async () => {
    spy.mockResolvedValue(APPLICATION_QUESTIONS_FIXTURE);
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_questions");
    const result = await handler({ id: "job_001" });
    expect(spy).toHaveBeenCalledWith("stub-bearer-for-tests", "job_001");
    const parsed = JSON.parse(result.content[0]?.text ?? "") as applications.ApplicationQuestions;
    expect(parsed.matcherQuestions[0]?.identifier).toBe("MQ-1");
    expect(parsed.expertiseQuestions[0]?.identifier).toBe("EQ-1");
  });
});

// ---------------------------------------------------------------------
// ttctl_jobs_apply_rate_insight
// ---------------------------------------------------------------------

describe("ttctl_jobs_apply_rate_insight — handler", () => {
  let server: McpServer;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerJobsTools(server, buildStubCtx());
    spy = vi.spyOn(applications, "rateInsight");
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("dryRun: emits the JobApplicationRateInsight preview envelope without calling the core", async () => {
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_rate_insight");
    const result = await handler({ id: "job_001", dryRun: true });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      preview: { operationName: string; variables: Record<string, unknown>; surface: string };
    };
    expect(parsed.preview.operationName).toBe("JobApplicationRateInsight");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    expect(parsed.preview.variables).toEqual({ jobId: "job_001" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("apply path: calls applications.rateInsight(token, jobId) and returns the insight", async () => {
    spy.mockResolvedValue(RATE_INSIGHT_FIXTURE);
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_rate_insight");
    const result = await handler({ id: "job_001" });
    expect(spy).toHaveBeenCalledWith("stub-bearer-for-tests", "job_001");
    const parsed = JSON.parse(result.content[0]?.text ?? "") as applications.RateInsight & { kind: string };
    expect(parsed.kind).toBe("competitive");
  });

  it("apply path: surfaces null when the platform omits the rate-insight payload", async () => {
    spy.mockResolvedValue(null);
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply_rate_insight");
    const result = await handler({ id: "job_001" });
    expect(JSON.parse(result.content[0]?.text ?? "")).toBeNull();
  });
});

// ---------------------------------------------------------------------
// ttctl_jobs_apply
// ---------------------------------------------------------------------

describe("ttctl_jobs_apply — handler", () => {
  let server: McpServer;
  let applySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerJobsTools(server, buildStubCtx());
    applySpy = vi.spyOn(applications, "apply");
  });

  afterEach(() => {
    applySpy.mockRestore();
  });

  it("dryRun: threads dryRun:true into the service so the service composes the preview", async () => {
    applySpy.mockResolvedValue({
      kind: "preview",
      preview: {
        surface: "mobile-gateway",
        transport: "stock",
        endpoint: "https://example/gw",
        operationName: "JobApply",
        variables: { id: "job_001", consentIssued: true, requestedHourlyRate: "95.00" },
        headers: { authorization: "Token token=<redacted>" },
        body: {
          operationName: "JobApply",
          query: "<query>",
          variables: { id: "job_001" },
        },
      },
    } satisfies applications.ApplyOutcome);
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    const result = await handler({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
      dryRun: true,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("JobApply");
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0]?.[3]).toMatchObject({ dryRun: true });
  });

  it("apply path: threads consentIssued + rate into the ApplyInput shape and returns the JobApplicationRecord", async () => {
    applySpy.mockResolvedValue(applied(APPLY_RECORD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    const result = await handler({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
    });
    expect(applySpy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      "job_001",
      { consentIssued: true, requestedHourlyRate: "95.00" },
      { dryRun: false },
    );
    const parsed = JSON.parse(result.content[0]?.text ?? "") as applications.JobApplicationRecord;
    expect(parsed.id).toBe("app_001");
    expect(parsed.jobActivityItemId).toBe("act_001");
  });

  it("apply path: composes message + matcherAnswers + expertiseAnswers + pitchData on the ApplyInput", async () => {
    applySpy.mockResolvedValue(applied(APPLY_RECORD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    const matcherAnswers = [{ questionId: "MQ-1", answer: "yes" }];
    const expertiseAnswers = [{ questionId: "EQ-1", answer: "5y" }];
    const pitchData = { message: "Pitch text" };

    await handler({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
      message: "Available Monday",
      matcherAnswers,
      expertiseAnswers,
      pitchData,
    });

    expect(applySpy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      "job_001",
      {
        consentIssued: true,
        requestedHourlyRate: "95.00",
        message: "Available Monday",
        matcherAnswers,
        expertiseAnswers,
        pitchData,
      },
      { dryRun: false },
    );
  });

  it("apply path: omitting message / matcherAnswers / expertiseAnswers / pitchData leaves them off the ApplyInput", async () => {
    applySpy.mockResolvedValue(applied(APPLY_RECORD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    await handler({ id: "job_001", consentIssued: true, requestedHourlyRate: "95.00" });
    expect(applySpy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      "job_001",
      { consentIssued: true, requestedHourlyRate: "95.00" },
      { dryRun: false },
    );
  });

  it("accepts opaque (Stage-1) shapes for matcherAnswers / expertiseAnswers / pitchData — no schema introspection at MCP layer", async () => {
    applySpy.mockResolvedValue(applied(APPLY_RECORD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    // The Stage-1 opaque grammar (ADR-008 § Decision Part 3) does NOT
    // introspect or validate inner shapes — `z.unknown()` accepts any
    // JSON. The MCP layer forwards whatever was supplied,
    // character-for-character, to the core service.
    const oddballMatcher = [
      "string answer (not the typical { questionId, answer } object)",
      42,
      null,
      { questionId: "MQ-future", answer: { nested: { deeply: ["yes"] } } },
    ];
    const oddballExpertise = [{ totallyDifferentShape: true }];
    const oddballPitch = { not_a_message: "yes", extraField: [1, 2, 3] };

    await handler({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
      matcherAnswers: oddballMatcher,
      expertiseAnswers: oddballExpertise,
      pitchData: oddballPitch,
    });
    expect(applySpy.mock.calls[0]?.[2]).toEqual({
      consentIssued: true,
      requestedHourlyRate: "95.00",
      matcherAnswers: oddballMatcher,
      expertiseAnswers: oddballExpertise,
      pitchData: oddballPitch,
    });
  });

  // -------------------------------------------------------------------
  // Consent gate — schema-side defense (the load-bearing one for the AC)
  // -------------------------------------------------------------------

  it("consent gate: input validation rejects `consentIssued: false` BEFORE the core path runs", () => {
    const tool = getRegisteredTool(server, "ttctl_jobs_apply");
    // The SDK constructs a Zod object from the registered shape and
    // `safeParse` is wired on the registered tool. Bypassing the
    // handler invocation lets us assert the boundary rejection
    // without depending on internal SDK error-rendering.
    const safeParse = tool.inputSchema?.safeParse;
    expect(safeParse).toBeDefined();
    const result = safeParse?.({ id: "job_001", consentIssued: false, requestedHourlyRate: "95.00" });
    expect(result?.success).toBe(false);
  });

  it("consent gate: input validation rejects missing `consentIssued`", () => {
    const tool = getRegisteredTool(server, "ttctl_jobs_apply");
    const safeParse = tool.inputSchema?.safeParse;
    const result = safeParse?.({ id: "job_001", requestedHourlyRate: "95.00" });
    expect(result?.success).toBe(false);
  });

  it("consent gate: input validation accepts `consentIssued: true`", () => {
    const tool = getRegisteredTool(server, "ttctl_jobs_apply");
    const safeParse = tool.inputSchema?.safeParse;
    const result = safeParse?.({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
    });
    expect(result?.success).toBe(true);
  });

  it("consent gate: input validation rejects `consentIssued: true` typed as a string instead of boolean", () => {
    const tool = getRegisteredTool(server, "ttctl_jobs_apply");
    const safeParse = tool.inputSchema?.safeParse;
    const result = safeParse?.({
      id: "job_001",
      consentIssued: "true",
      requestedHourlyRate: "95.00",
    });
    expect(result?.success).toBe(false);
  });

  // -------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------

  it("maps ApplicationsError(ALREADY_APPLIED) to a structured envelope with the apply-show hint", async () => {
    applySpy.mockRejectedValue(
      new applications.ApplicationsError(
        "ALREADY_APPLIED",
        'You have already applied to job "job_001". Run `ttctl applications show <activity-id>` to find your existing application.',
      ),
    );
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    const result = await handler({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: ALREADY_APPLIED)");
    expect(text).toContain("ttctl_applications_show");
  });

  it("maps ApplicationsError(NOT_FOUND) to a structured envelope with the jobs-list hint", async () => {
    applySpy.mockRejectedValue(new applications.ApplicationsError("NOT_FOUND", "no such job"));
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    const result = await handler({
      id: "missing",
      consentIssued: true,
      requestedHourlyRate: "95.00",
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: NOT_FOUND)");
    expect(text).toContain("ttctl_jobs_list");
  });

  it("maps ApplicationsError(CONSENT_REQUIRED) defensively (the Zod gate is the primary defense)", async () => {
    // The Zod gate catches `consentIssued !== true` at the input
    // boundary. The runtime CONSENT_REQUIRED case only fires when the
    // MCP-layer schema is bypassed (e.g. a programmatic caller passing
    // raw args), but the error mapping still needs to render it.
    applySpy.mockRejectedValue(
      new applications.ApplicationsError(
        "CONSENT_REQUIRED",
        "Apply requires explicit consent: `consentIssued: true` is mandatory before any wire call.",
      ),
    );
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    const result = await handler({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: CONSENT_REQUIRED)");
    expect(text).toContain("ADR-008");
  });

  it("maps ApplicationsError(WIRE_SHAPE_ERROR) to a structured envelope with the questions-refetch hint", async () => {
    applySpy.mockRejectedValue(
      new applications.ApplicationsError(
        "WIRE_SHAPE_ERROR",
        'matcherAnswers[0]: questionId "MQ-stale" does not match any question returned from applyQuestions().',
      ),
    );
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    const result = await handler({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
      matcherAnswers: [{ questionId: "MQ-stale", answer: "x" }],
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: WIRE_SHAPE_ERROR)");
    expect(text).toContain("ttctl_jobs_apply_questions");
  });

  it("maps ApplicationsError(MUTATION_ERROR) to a structured envelope", async () => {
    applySpy.mockRejectedValue(
      new applications.ApplicationsError("MUTATION_ERROR", "JobApply failed: requestedHourlyRate is required"),
    );
    const handler = getRegisteredHandler(server, "ttctl_jobs_apply");
    const result = await handler({
      id: "job_001",
      consentIssued: true,
      requestedHourlyRate: "95.00",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("(Code: MUTATION_ERROR)");
  });
});
