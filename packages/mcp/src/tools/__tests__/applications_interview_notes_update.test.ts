// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real and override
// only `applications.interviews.notes.update` so the tests can stub the
// service outcome (applied / preview / throw) without touching any
// transport. The spread preserves `INTERVIEW_NOTE_SECTIONS`,
// `ApplicationsError`, `ConsentRequiredError`, and `TtctlError`, which the
// tool's enum schema and error-mapping paths use.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    applications: {
      ...actual.applications,
      interviews: {
        ...actual.applications.interviews,
        notes: { ...actual.applications.interviews.notes, update: vi.fn() },
      },
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applications, ConsentRequiredError } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerApplicationsTools } from "../applications.js";

const TOOL = "ttctl_applications_interview_notes_update";
const mockedUpdate = vi.mocked(applications.interviews.notes.update);

const APPLIED_FIXTURE = {
  kind: "applied" as const,
  result: {
    interviewId: "int-1",
    notice: "Saved.",
    notes: [{ id: "n1", section: "STRENGTHS" as const, note: "Mention the AWS cert" }],
  },
};

const PREVIEW_FIXTURE = {
  kind: "preview" as const,
  preview: {
    operationName: "UpdateInterviewTalentNotes",
    surface: "mobile-gateway" as const,
    transport: "stock" as const,
    endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
    variables: { interviewId: "int-1", input: { talentNotes: [{ section: "GAPS", note: "a" }] } },
    headers: { authorization: "Token token=<redacted>" },
  },
};

function buildAuthSuccessCtx(token = "user_notes_update_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true as const, token }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token }),
  };
}

interface RegisteredToolInternal {
  annotations?: { destructiveHint?: boolean };
  inputSchema?: { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> };
  handler: (input: unknown, extra: unknown) => Promise<unknown>;
}

function getEntry(server: McpServer): RegisteredToolInternal {
  const internals = server as unknown as { _registeredTools: Record<string, RegisteredToolInternal> };
  const entry = internals._registeredTools[TOOL];
  if (!entry) throw new Error(`tool not registered: ${TOOL}`);
  return entry;
}

interface ToolResponseShape {
  isError?: boolean;
  content: { type: string; text: string }[];
}

function parseToolPayload<T>(result: ToolResponseShape): T {
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

describe(`${TOOL} MCP tool (#441)`, () => {
  let server: McpServer;

  beforeEach(() => {
    mockedUpdate.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
    registerApplicationsTools(server, buildAuthSuccessCtx());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a destructive tool whose consent field accepts ONLY the literal true", () => {
    const entry = getEntry(server);
    expect(entry.annotations?.destructiveHint).toBe(true);
    const consent = entry.inputSchema?.shape["interviewActionConsentIssued"];
    expect(consent).toBeDefined();
    expect(consent?.safeParse(true).success).toBe(true);
    expect(consent?.safeParse(false).success).toBe(false);
    expect(consent?.safeParse(undefined).success).toBe(false);
  });

  it("forwards mapped notes (omitted/null section → unsectioned) + consent, returns the applied result", async () => {
    mockedUpdate.mockResolvedValue(APPLIED_FIXTURE);
    const result = (await getEntry(server).handler(
      {
        interviewId: "int-1",
        notes: [{ section: "GAPS", note: "a" }, { note: "b" }, { section: null, note: "c" }],
        interviewActionConsentIssued: true,
      },
      {},
    )) as ToolResponseShape;

    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    const [token, interviewId, input, options] = mockedUpdate.mock.calls[0] ?? [];
    expect(token).toBe("user_notes_update_token");
    expect(interviewId).toBe("int-1");
    expect(input).toEqual({
      notes: [{ section: "GAPS", note: "a" }, { note: "b" }, { note: "c" }],
      interviewActionConsentIssued: true,
    });
    expect(options).toEqual({ dryRun: false });

    const payload = parseToolPayload<{ interviewId: string; notice: string }>(result);
    expect(payload.interviewId).toBe("int-1");
    expect(payload.notice).toBe("Saved.");
  });

  it("delegates dry-run to the service and returns the { ok, dryRun, preview } envelope", async () => {
    mockedUpdate.mockResolvedValue(PREVIEW_FIXTURE);
    const result = (await getEntry(server).handler(
      {
        interviewId: "int-1",
        notes: [{ section: "GAPS", note: "a" }],
        interviewActionConsentIssued: true,
        dryRun: true,
      },
      {},
    )) as ToolResponseShape;

    const [, , , options] = mockedUpdate.mock.calls[0] ?? [];
    expect(options).toEqual({ dryRun: true });

    const env = parseToolPayload<{ ok: boolean; dryRun: boolean; preview: { operationName: string } }>(result);
    expect(env.ok).toBe(true);
    expect(env.dryRun).toBe(true);
    expect(env.preview.operationName).toBe("UpdateInterviewTalentNotes");
  });

  it("maps a thrown ConsentRequiredError to a CONSENT_REQUIRED tool error", async () => {
    mockedUpdate.mockRejectedValue(
      new ConsentRequiredError("UpdateInterviewTalentNotes", "interview-action", "consent missing"),
    );
    const result = (await getEntry(server).handler(
      { interviewId: "int-1", notes: [{ note: "a" }], interviewActionConsentIssued: true },
      {},
    )) as ToolResponseShape;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("(Code: CONSENT_REQUIRED)");
  });
});
