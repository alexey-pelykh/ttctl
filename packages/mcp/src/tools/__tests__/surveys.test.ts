// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConsentRequiredError, surveys } from "@ttctl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerSurveysTools } from "../surveys.js";

/**
 * MCP-layer translator contract for `ttctl_surveys_submit` (#673), the
 * DESTRUCTIVE consent-gated write companion to `ttctl_surveys_list`. Live
 * wire-shape validation lands in the `TTCTL_E2E=1` suite + the T1 snapshot;
 * these tests pin the handler's threading, the zero-network dry-run, the
 * schema-side consent gate, and error rendering. Service-layer kind /
 * option-id resolution and the runtime consent gate are tested in core.
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

interface RegisteredTool {
  handler: unknown;
  description?: string;
  inputSchema?: { shape?: Record<string, unknown>; safeParse?: (input: unknown) => { success: boolean } };
}

function getRegisteredTool(server: McpServer, name: string): RegisteredTool {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredTool | undefined> };
  const tool = internal._registeredTools[name];
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
}

function getRegisteredHandler(server: McpServer, name: string): ToolHandler {
  return getRegisteredTool(server, name).handler as ToolHandler;
}

function buildStubCtx(): ToolRegistrationContext {
  const stubToken = "stub-bearer-for-tests";
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token: stubToken }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
  };
}

const RESULT: surveys.SubmitSurveyResult = { notice: "Thanks!", pendingSurveys: [{ id: "sv-next" }] };
const ANSWERS = [{ questionId: "q-1", value: "5" }];

// ---------------------------------------------------------------------
// Registration smoke
// ---------------------------------------------------------------------

describe("ttctl_surveys_submit — registration", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerSurveysTools(server, buildStubCtx());
  });

  it("registers both surveys tools", () => {
    const internal = server as unknown as { _registeredTools: Record<string, RegisteredTool | undefined> };
    expect(internal._registeredTools["ttctl_surveys_list"]).toBeDefined();
    expect(internal._registeredTools["ttctl_surveys_submit"]).toBeDefined();
  });

  it("registers the documented input fields", () => {
    const shape = getRegisteredTool(server, "ttctl_surveys_submit").inputSchema?.shape;
    expect(shape).toBeDefined();
    expect(shape).toHaveProperty("surveyId");
    expect(shape).toHaveProperty("answers");
    expect(shape).toHaveProperty("kind");
    expect(shape).toHaveProperty("surveySubmissionConsentIssued");
    expect(shape).toHaveProperty("dryRun");
  });

  it("description marks DESTRUCTIVE and documents the consent gate", () => {
    const { description } = getRegisteredTool(server, "ttctl_surveys_submit");
    expect(description).toContain("DESTRUCTIVE");
    expect(description).toContain("surveySubmissionConsentIssued");
    expect(description).toContain("ADR-009");
  });

  it("the read tool (list) does NOT contain DESTRUCTIVE", () => {
    expect(getRegisteredTool(server, "ttctl_surveys_list").description).not.toContain("DESTRUCTIVE");
  });
});

// ---------------------------------------------------------------------
// Handler — dry-run, apply, error mapping
// ---------------------------------------------------------------------

describe("ttctl_surveys_submit — handler", () => {
  let server: McpServer;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerSurveysTools(server, buildStubCtx());
    spy = vi.spyOn(surveys, "submit");
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("dryRun: emits the SubmitSurvey preview WITHOUT calling the core (zero-network)", async () => {
    const handler = getRegisteredHandler(server, "ttctl_surveys_submit");
    const result = await handler({
      surveyId: "sv-1",
      answers: ANSWERS,
      surveySubmissionConsentIssued: true,
      dryRun: true,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string; surface: string; variables: Record<string, unknown> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("SubmitSurvey");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    // Raw intent only — kind/option-id resolution is deferred to the real call.
    expect(parsed.preview.variables).toEqual({ surveyId: "sv-1", answers: ANSWERS });
    expect(spy).not.toHaveBeenCalled();
  });

  it("dryRun: includes kind in the preview variables when provided", async () => {
    const handler = getRegisteredHandler(server, "ttctl_surveys_submit");
    const result = await handler({
      surveyId: "sv-1",
      answers: ANSWERS,
      kind: "NPS",
      surveySubmissionConsentIssued: true,
      dryRun: true,
    });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as { preview: { variables: Record<string, unknown> } };
    expect(parsed.preview.variables).toEqual({ surveyId: "sv-1", answers: ANSWERS, kind: "NPS" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("apply path: threads args + consent into surveys.submit and returns the result JSON", async () => {
    spy.mockResolvedValue(RESULT);
    const handler = getRegisteredHandler(server, "ttctl_surveys_submit");
    const result = await handler({ surveyId: "sv-1", answers: ANSWERS, surveySubmissionConsentIssued: true });
    expect(spy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      { surveyId: "sv-1", answers: ANSWERS },
      { surveySubmissionConsentIssued: true },
    );
    const parsed = JSON.parse(result.content[0]?.text ?? "") as surveys.SubmitSurveyResult;
    expect(parsed.pendingSurveys).toEqual([{ id: "sv-next" }]);
  });

  it("apply path: threads the kind override into the service args", async () => {
    spy.mockResolvedValue(RESULT);
    const handler = getRegisteredHandler(server, "ttctl_surveys_submit");
    await handler({ surveyId: "sv-1", answers: ANSWERS, kind: "NPS", surveySubmissionConsentIssued: true });
    expect(spy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      { surveyId: "sv-1", answers: ANSWERS, kind: "NPS" },
      { surveySubmissionConsentIssued: true },
    );
  });

  it("maps SurveysError(NOT_FOUND) to a structured error envelope", async () => {
    spy.mockRejectedValue(new surveys.SurveysError("NOT_FOUND", 'No pending survey with id "sv-x".'));
    const handler = getRegisteredHandler(server, "ttctl_surveys_submit");
    const result = await handler({ surveyId: "sv-x", answers: ANSWERS, surveySubmissionConsentIssued: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("(Code: NOT_FOUND)");
  });

  it("maps ConsentRequiredError defensively (the Zod literal is the primary gate)", async () => {
    spy.mockRejectedValue(new ConsentRequiredError("SubmitSurvey", "survey-submission", "consent missing"));
    const handler = getRegisteredHandler(server, "ttctl_surveys_submit");
    const result = await handler({ surveyId: "sv-1", answers: ANSWERS, surveySubmissionConsentIssued: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("(Code: CONSENT_REQUIRED)");
  });
});

// ---------------------------------------------------------------------
// Consent gate — schema-side (the load-bearing defense)
// ---------------------------------------------------------------------

describe("ttctl_surveys_submit — consent gate (schema-side)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerSurveysTools(server, buildStubCtx());
  });

  function safeParse(input: unknown): { success: boolean } | undefined {
    return getRegisteredTool(server, "ttctl_surveys_submit").inputSchema?.safeParse?.(input);
  }

  it("rejects surveySubmissionConsentIssued: false", () => {
    expect(safeParse({ surveyId: "sv-1", answers: ANSWERS, surveySubmissionConsentIssued: false })?.success).toBe(
      false,
    );
  });

  it("rejects a missing surveySubmissionConsentIssued", () => {
    expect(safeParse({ surveyId: "sv-1", answers: ANSWERS })?.success).toBe(false);
  });

  it('rejects the string "true" (must be the boolean literal)', () => {
    expect(safeParse({ surveyId: "sv-1", answers: ANSWERS, surveySubmissionConsentIssued: "true" })?.success).toBe(
      false,
    );
  });

  it("accepts surveySubmissionConsentIssued: true", () => {
    expect(safeParse({ surveyId: "sv-1", answers: ANSWERS, surveySubmissionConsentIssued: true })?.success).toBe(true);
  });

  it("rejects an empty answers array (min 1)", () => {
    expect(safeParse({ surveyId: "sv-1", answers: [], surveySubmissionConsentIssued: true })?.success).toBe(false);
  });
});
