// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applications } from "@ttctl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolRegistrationContext } from "../_shared.js";
import { projectRow, registerInterestRequestsTools } from "../interest_requests.js";

/**
 * Tests for `ttctl_interest_requests_list` (#371). The tool is a thin
 * MCP-layer projection over `applications.list({ statusGroups:
 * ["ON_RECRUITER_REVIEW"] })`. No new wire op is introduced — the live
 * shape of `JobActivityItems` is covered by
 * `packages/e2e/src/15-applications-list.e2e.test.ts`.
 *
 * The tests below pin three things:
 *
 *   1. The projection helper (`projectRow`) computes `daysPending`
 *      correctly and emits the documented shape.
 *   2. The `olderThan` filter accepts the documented duration suffixes
 *      and rejects malformed values with `VALIDATION`.
 *   3. The `dryRun` branch emits the canonical envelope carrying the
 *      `JobActivityItems` op restricted to `ON_RECRUITER_REVIEW`.
 */

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

function getRegisteredHandler(server: McpServer, name: string): ToolHandler {
  const internal = server as unknown as {
    _registeredTools: Record<string, { handler: unknown } | undefined>;
  };
  const tool = internal._registeredTools[name];
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool.handler as ToolHandler;
}

function buildStubCtx(): ToolRegistrationContext {
  const stubToken = "stub-bearer-for-tests";
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token: stubToken }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token: stubToken }),
  };
}

function buildRow(overrides: Partial<applications.JobActivityItem> = {}): applications.JobActivityItem {
  return {
    id: "ji_test_001",
    statusV2: { value: "AVAILABILITY_REQUEST_PENDING", verbose: "Job Interest Request" },
    statusGroupV2: { value: "ON_RECRUITER_REVIEW", verbose: "On Recruiter Review" },
    statusColor: null,
    lastUpdatedAt: "2026-05-01T00:00:00Z",
    job: {
      id: "job_001",
      title: "Senior TypeScript Engineer",
      url: "https://www.toptal.com/jobs/foo",
      client: { id: "client_001", fullName: "Acme Corp" },
    },
    jobApplication: null,
    engagement: null,
    // #539 widened `availabilityRequest` from `{ id }` to the
    // {@link applications.AvailabilityRequestEmbed} shape — the IR row
    // typically rides pre-response (talent-response triple null) but
    // carries the recruiter identity for personalisation.
    availabilityRequest: {
      id: "ar_001",
      talentComment: null,
      requestedHourlyRate: null,
      rejectReason: null,
      recruiter: null,
    },
    interview: null,
    mostRelevantApplication: null,
    fixedRate: null,
    ...overrides,
  };
}

/**
 * Wrap rows in the {@link applications.JobActivityListPage} envelope
 * `applications.list` returns post-#377. `ttctl_interest_requests_list`
 * unwraps `.items` (it does not surface pagination — see #372 / R1);
 * `totalCount` mirrors the slice here because the stub is the whole
 * (filtered) set.
 */
function listPage(items: applications.JobActivityItem[]): applications.JobActivityListPage {
  return { items, totalCount: items.length, page: 1, perPage: 20 };
}

describe("projectRow", () => {
  it("computes daysPending as the integer number of days between lastUpdatedAt and now", () => {
    const row = buildRow({ lastUpdatedAt: "2026-05-01T00:00:00Z" });
    // 2026-05-15 00:00 UTC ⇒ 14 days after 2026-05-01.
    const now = Date.parse("2026-05-15T00:00:00Z");
    expect(projectRow(row, now).daysPending).toBe(14);
  });

  it("clamps daysPending to 0 when lastUpdatedAt is in the future (clock skew)", () => {
    const row = buildRow({ lastUpdatedAt: "2026-06-01T00:00:00Z" });
    const now = Date.parse("2026-05-01T00:00:00Z");
    expect(projectRow(row, now).daysPending).toBe(0);
  });

  it("emits daysPending=null when lastUpdatedAt cannot be parsed", () => {
    const row = buildRow({ lastUpdatedAt: "not-a-timestamp" });
    expect(projectRow(row, Date.now()).daysPending).toBeNull();
  });

  it("surfaces statusVerbose, jobTitle, clientName, jobUrl, lastUpdatedAt verbatim", () => {
    const row = buildRow();
    const out = projectRow(row, Date.parse("2026-05-15T00:00:00Z"));
    expect(out.statusVerbose).toBe("Job Interest Request");
    expect(out.jobTitle).toBe("Senior TypeScript Engineer");
    expect(out.clientName).toBe("Acme Corp");
    expect(out.jobUrl).toBe("https://www.toptal.com/jobs/foo");
    expect(out.lastUpdatedAt).toBe("2026-05-01T00:00:00Z");
  });

  it("emits clientName=null when the row's client is null", () => {
    const row = buildRow({ job: { id: "j", title: null, url: null, client: null } });
    expect(projectRow(row, Date.now()).clientName).toBeNull();
  });

  it("surfaces fixedRate verbatim from the AR-side projection (#410)", () => {
    const row = buildRow({ fixedRate: { decimal: "77.00", verbose: "$77.00/hr" } });
    const out = projectRow(row, Date.parse("2026-05-15T00:00:00Z"));
    expect(out.fixedRate).toEqual({ decimal: "77.00", verbose: "$77.00/hr" });
  });

  it("surfaces fixedRate=null when the AR-side projection has no Fixed-rate offer (#410)", () => {
    const row = buildRow(); // default: fixedRate: null
    const out = projectRow(row, Date.parse("2026-05-15T00:00:00Z"));
    expect(out.fixedRate).toBeNull();
  });

  // ----- Recruiter projection from embedded AR (#539) ----------------
  it("lifts the recruiter from the embedded AR sub-projection into the IR row (#539)", () => {
    const row = buildRow({
      availabilityRequest: {
        id: "ar_001",
        talentComment: null,
        requestedHourlyRate: null,
        rejectReason: null,
        recruiter: { firstName: "Alex", lastName: "Recruiter", fullName: "Alex Recruiter" },
      },
    });
    const out = projectRow(row, Date.parse("2026-05-15T00:00:00Z"));
    expect(out.recruiter).toEqual({ firstName: "Alex", lastName: "Recruiter", fullName: "Alex Recruiter" });
  });

  it("emits recruiter=null when the embedded AR exists but the recruiter sub-field is null (#539)", () => {
    const row = buildRow();
    const out = projectRow(row, Date.parse("2026-05-15T00:00:00Z"));
    expect(out.recruiter).toBeNull();
  });

  it("emits recruiter=null when the row carries no embedded AR at all (#539)", () => {
    const row = buildRow({ availabilityRequest: null });
    const out = projectRow(row, Date.parse("2026-05-15T00:00:00Z"));
    expect(out.recruiter).toBeNull();
  });
});

describe("ttctl_interest_requests_list — handler", () => {
  let server: McpServer;
  let listSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerInterestRequestsTools(server, buildStubCtx());
    listSpy = vi.spyOn(applications, "list");
  });

  afterEach(() => {
    listSpy.mockRestore();
  });

  it("emits a dry-run envelope carrying the JobActivityItems op restricted to ON_RECRUITER_REVIEW", async () => {
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    const result = await handler({ dryRun: true });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text) as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string; variables: Record<string, unknown>; surface: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("JobActivityItems");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    expect(parsed.preview.variables).toEqual({ onlyStatusGroupFilter: ["ON_RECRUITER_REVIEW"] });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("calls applications.list with the ON_RECRUITER_REVIEW status-group filter on the apply path", async () => {
    listSpy.mockResolvedValue(listPage([]));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    await handler({});
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith("stub-bearer-for-tests", { statusGroups: ["ON_RECRUITER_REVIEW"] });
  });

  it("returns the projected rows as a JSON array", async () => {
    listSpy.mockResolvedValue(listPage([buildRow()]));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? "") as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    const firstRow = parsed[0] as { id: unknown; statusVerbose: unknown; jobTitle: unknown };
    expect(firstRow.id).toBe("ji_test_001");
    expect(firstRow.statusVerbose).toBe("Job Interest Request");
    expect(firstRow.jobTitle).toBe("Senior TypeScript Engineer");
  });

  it("accepts olderThan: `14d` and filters rows whose daysPending is below the threshold", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-20T00:00:00Z"));
    try {
      listSpy.mockResolvedValue(
        listPage([
          // 19 days old — keeps.
          buildRow({ id: "old", lastUpdatedAt: "2026-05-01T00:00:00Z" }),
          // 5 days old — drops.
          buildRow({ id: "fresh", lastUpdatedAt: "2026-05-15T00:00:00Z" }),
        ]),
      );
      const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
      const result = await handler({ olderThan: "14d" });
      const parsed = JSON.parse(result.content[0]?.text ?? "") as { id: string }[];
      expect(parsed.map((r) => r.id)).toEqual(["old"]);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("accepts olderThan: `2w` (weeks), `48h` (hours), and bare integer (days)", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-20T00:00:00Z"));
    try {
      const row = buildRow({ lastUpdatedAt: "2026-05-05T00:00:00Z" }); // 15 days / 360h old
      listSpy.mockResolvedValue(listPage([row]));
      const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");

      // 2w = 336h; row at 360h passes.
      const resultWeeks = await handler({ olderThan: "2w" });
      expect((JSON.parse(resultWeeks.content[0]?.text ?? "") as unknown[]).length).toBe(1);

      // 48h passes.
      const resultHours = await handler({ olderThan: "48h" });
      expect((JSON.parse(resultHours.content[0]?.text ?? "") as unknown[]).length).toBe(1);

      // Bare integer "15" = 15d = 360h; row exactly at threshold passes (>=).
      const resultBare = await handler({ olderThan: "15" });
      expect((JSON.parse(resultBare.content[0]?.text ?? "") as unknown[]).length).toBe(1);

      // 16d (= 384h) excludes the 360h-old row.
      const resultTighter = await handler({ olderThan: "16d" });
      expect((JSON.parse(resultTighter.content[0]?.text ?? "") as unknown[]).length).toBe(0);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("returns a VALIDATION error response for malformed olderThan values", async () => {
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    const result = await handler({ olderThan: "garbage" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: VALIDATION)");
    expect(text).toContain("garbage");
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("maps ApplicationsError thrown from applications.list into the error envelope", async () => {
    listSpy.mockRejectedValue(new applications.ApplicationsError("NETWORK_ERROR", "transport refused"));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_list");
    const result = await handler({});
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: NETWORK_ERROR)");
    expect(text).toContain("transport refused");
  });
});

// ---------------------------------------------------------------------
// #411 — IR write surface (accept / reject / reject-reasons).
//
// All three tools wrap their respective core service functions
// (`applications.confirm`, `.reject`, `.rejectReasons`) — the MCP layer
// is a thin translator over the service-shape inputs/outputs. The tests
// pin three things per tool:
//
//   1. The dry-run envelope is emitted without invoking the service.
//   2. The apply path calls the service with the right shaped input.
//   3. ApplicationsError thrown from the service maps to the canonical
//      structured error response.
// ---------------------------------------------------------------------

function applied<T>(result: T): { kind: "applied"; result: T } {
  return { kind: "applied", result };
}

const RESPOND_PAYLOAD_FIXTURE: applications.AvailabilityRequestRespondPayload = {
  id: "ar-1",
  answeredAt: "2026-05-20T00:00:00Z",
  statusV2: { value: "AVAILABILITY_REQUEST_CONFIRMED", verbose: "Confirmed" },
  talentComment: null,
  requestedHourlyRate: { decimal: "80.00", verbose: "$80.00/hr" },
  rejectReason: null,
};

/**
 * Canonical `PitchInput` fixture for #438 Stage-2 tests. The recovered
 * `PitchInputSchema` requires every nullable slot present (codegen emits
 * `.nullable()` for nullable fields, per `codegen.config.ts`'s
 * `nullishBehavior: "nullable"` — required-present, null tolerated).
 * Tests use this fixture rather than ad-hoc `{}` / `{ message: "..." }`
 * stubs (both reject under strict-mode Zod).
 */
function pitchInputFixture(): applications.PitchInput {
  return {
    certificationPitchItems: null,
    educationPitchItems: null,
    employmentPitchItems: null,
    industryPitchItems: null,
    mentorship: null,
    portfolioPitchItems: null,
    publicationPitchItems: null,
    skillPitchItems: null,
  };
}

describe("ttctl_interest_requests_accept — handler", () => {
  let server: McpServer;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerInterestRequestsTools(server, buildStubCtx());
    confirmSpy = vi.spyOn(applications, "confirm");
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it("dryRun: returns the ConfirmAvailabilityRequest preview envelope", async () => {
    confirmSpy.mockResolvedValue({
      kind: "preview",
      preview: {
        surface: "mobile-gateway",
        transport: "stock",
        endpoint: "https://example/gw",
        operationName: "ConfirmAvailabilityRequest",
        variables: { id: "ar-1", kind: "FIXED", requestedHourlyRate: "80.00" },
        headers: { authorization: "Token token=<redacted>" },
        body: {
          operationName: "ConfirmAvailabilityRequest",
          query: "<query>",
          variables: { id: "ar-1" },
        },
      },
    } satisfies applications.ConfirmOutcome);
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const result = await handler({ id: "ar-1", dryRun: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("ConfirmAvailabilityRequest");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // The MCP layer always threads dryRun:true into the service so the
    // service-layer dry-run path can compose placeholders correctly.
    expect(confirmSpy.mock.calls[0]?.[3]).toMatchObject({ dryRun: true });
  });

  it("apply path: threads message/rate/kind into the ConfirmInput shape", async () => {
    confirmSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    await handler({ id: "ar-1", message: "available Monday", rate: "90.00", kind: "FLEXIBLE" });
    expect(confirmSpy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      "ar-1",
      {
        comment: "available Monday",
        requestedHourlyRate: "90.00",
        kind: "FLEXIBLE",
      },
      { dryRun: false },
    );
  });

  it("apply path: returns the post-confirm AR projection as JSON", async () => {
    confirmSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const result = await handler({ id: "ar-1" });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as { id: string; statusV2: { value: string } };
    expect(parsed.id).toBe("ar-1");
    expect(parsed.statusV2.value).toBe("AVAILABILITY_REQUEST_CONFIRMED");
  });

  it("maps ApplicationsError(NOT_FOUND) to a structured error envelope", async () => {
    confirmSpy.mockRejectedValue(new applications.ApplicationsError("NOT_FOUND", "no such availability request"));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const result = await handler({ id: "missing" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("(Code: NOT_FOUND)");
    expect(text).toContain("no such availability request");
  });

  it("maps ApplicationsError(MUTATION_ERROR) to a structured error envelope", async () => {
    confirmSpy.mockRejectedValue(
      new applications.ApplicationsError("MUTATION_ERROR", "requestedHourlyRate is required for FLEXIBLE"),
    );
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const result = await handler({ id: "ar-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("(Code: MUTATION_ERROR)");
  });

  // -------------------------------------------------------------------
  // #429 — matcherAnswers / expertiseAnswers / pitchData answer payloads.
  //
  // The MCP layer is a thin pass-through: it accepts the three optional
  // fields under their user-facing names (matcherAnswers,
  // expertiseAnswers, pitchData) and forwards them to the core service
  // under the wire-side names (matcherQuestionsAnswers,
  // expertiseQuestionsAnswers, pitchInput).
  //
  // **#438 Stage-2**: the MCP server's inputSchema now constrains each
  // field to the recovered Zod shape (`JobPositionAnswerInputSchema()` /
  // `JobExpertiseAnswerInputSchema()` / `PitchInputSchema()`, all
  // `.strict()`). Validation runs at the MCP framework layer BEFORE
  // the handler executes; these tests invoke the handler directly to
  // pin forwarding behavior on the assumption the framework has already
  // validated the payload. The fixtures here therefore mirror the
  // tightened shape (matcher: `id`; expertise: `questionId`).
  // -------------------------------------------------------------------

  it("apply path: forwards matcherAnswers + expertiseAnswers + pitchData to ConfirmInput wire-side names", async () => {
    confirmSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const matcherAnswers = [
      { id: "MQ-1", answer: "matcher answer 1" },
      { id: "MQ-2", answer: "matcher answer 2" },
    ];
    const expertiseAnswers = [{ questionId: "EQ-1", other: null, subjectId: null }];
    const pitchData = pitchInputFixture();

    await handler({
      id: "ar-1",
      matcherAnswers,
      expertiseAnswers,
      pitchData,
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      "ar-1",
      {
        matcherQuestionsAnswers: matcherAnswers,
        expertiseQuestionsAnswers: expertiseAnswers,
        pitchInput: pitchData,
      },
      { dryRun: false },
    );
  });

  it("apply path: omitting matcherAnswers / expertiseAnswers / pitchData leaves them off the ConfirmInput (backward compat)", async () => {
    confirmSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    await handler({ id: "ar-1" });
    // The forwarded ConfirmInput must be empty when only `id` is passed;
    // the #411 regression guard pins this so the new pass-throughs do
    // not change the pre-#429 wire payload for callers who never supply
    // them.
    expect(confirmSpy).toHaveBeenCalledWith("stub-bearer-for-tests", "ar-1", {}, { dryRun: false });
  });

  it("apply path: forwards matcherAnswers alone (independent of expertiseAnswers / pitchData)", async () => {
    confirmSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const matcherAnswers = [{ id: "MQ-1", answer: "alone" }];
    await handler({ id: "ar-1", matcherAnswers });
    expect(confirmSpy.mock.calls[0]?.[2]).toEqual({ matcherQuestionsAnswers: matcherAnswers });
  });

  it("apply path: forwards pitchData alone (independent of matcher/expertise answers)", async () => {
    confirmSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const pitchData = pitchInputFixture();
    await handler({ id: "ar-1", pitchData });
    expect(confirmSpy.mock.calls[0]?.[2]).toEqual({ pitchInput: pitchData });
  });

  it("apply path: composes message + rate + kind + matcherAnswers + expertiseAnswers + pitchData on the same ConfirmInput", async () => {
    confirmSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const pitch = pitchInputFixture();
    await handler({
      id: "ar-1",
      message: "available Monday",
      rate: "90.00",
      kind: "FLEXIBLE",
      matcherAnswers: [{ id: "MQ-1", answer: "..." }],
      expertiseAnswers: [{ questionId: "EQ-1", other: null, subjectId: null }],
      pitchData: pitch,
    });
    expect(confirmSpy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      "ar-1",
      {
        comment: "available Monday",
        requestedHourlyRate: "90.00",
        kind: "FLEXIBLE",
        matcherQuestionsAnswers: [{ id: "MQ-1", answer: "..." }],
        expertiseQuestionsAnswers: [{ questionId: "EQ-1", other: null, subjectId: null }],
        pitchInput: pitch,
      },
      { dryRun: false },
    );
  });

  it("forwards arbitrary tightened-shape payloads without further introspection at the handler layer (#438 Stage-2)", async () => {
    confirmSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    // #438 Stage-2: payload shapes are constrained to the recovered
    // Zod schemas at the framework layer (`JobPositionAnswerInputSchema()`
    // / `JobExpertiseAnswerInputSchema()` / `PitchInputSchema()`, all
    // `.strict()`). At the handler level, no FURTHER introspection
    // occurs — the handler is a pure pass-through. This test pins the
    // pass-through contract: any payload that passes the schema is
    // forwarded character-for-character to the core service.
    const tightenedMatcher = [
      { id: "MQ-1", answer: "first" },
      { id: "MQ-2", answer: "second" },
      { id: "MQ-3", answer: "third" },
    ];
    const tightenedExpertise = [
      { questionId: "EQ-1", other: null, subjectId: "Skill:1" },
      { questionId: "EQ-2", other: "free text", subjectId: null },
    ];
    const tightenedPitch = pitchInputFixture();
    await handler({
      id: "ar-1",
      matcherAnswers: tightenedMatcher,
      expertiseAnswers: tightenedExpertise,
      pitchData: tightenedPitch,
    });
    expect(confirmSpy.mock.calls[0]?.[2]).toEqual({
      matcherQuestionsAnswers: tightenedMatcher,
      expertiseQuestionsAnswers: tightenedExpertise,
      pitchInput: tightenedPitch,
    });
  });

  it("registers the new matcherAnswers / expertiseAnswers / pitchData fields on the tool's inputSchema", () => {
    // The tool registration carries its zod schema in the internal
    // _registeredTools map. Pinning the field presence guards against
    // a refactor that accidentally drops one of the three new fields
    // from the surface (and likewise against an LLM client tool-listing
    // probe regressing).
    const internal = server as unknown as {
      _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } } | undefined>;
    };
    const acceptTool = internal._registeredTools["ttctl_interest_requests_accept"];
    expect(acceptTool).toBeDefined();
    const shape = acceptTool?.inputSchema?.shape;
    expect(shape).toBeDefined();
    expect(shape).toHaveProperty("matcherAnswers");
    expect(shape).toHaveProperty("expertiseAnswers");
    expect(shape).toHaveProperty("pitchData");
    // Pre-existing fields still present (regression guard for #411).
    expect(shape).toHaveProperty("id");
    expect(shape).toHaveProperty("message");
    expect(shape).toHaveProperty("rate");
    expect(shape).toHaveProperty("kind");
    expect(shape).toHaveProperty("dryRun");
  });

  it("dryRun: threads matcherAnswers / expertiseAnswers / pitchData through to the service so the preview reflects the wire payload", async () => {
    const pitch = pitchInputFixture();
    confirmSpy.mockResolvedValue({
      kind: "preview",
      preview: {
        surface: "mobile-gateway",
        transport: "stock",
        endpoint: "https://example/gw",
        operationName: "ConfirmAvailabilityRequest",
        variables: {
          id: "ar-1",
          kind: "FIXED",
          requestedHourlyRate: "80.00",
          matcherQuestionsAnswers: [{ id: "MQ-1", answer: "x" }],
          expertiseQuestionsAnswers: [],
          pitchInput: pitch,
        },
        headers: { authorization: "Token token=<redacted>" },
        body: {
          operationName: "ConfirmAvailabilityRequest",
          query: "<query>",
          variables: { id: "ar-1" },
        },
      },
    } satisfies applications.ConfirmOutcome);
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_accept");
    const result = await handler({
      id: "ar-1",
      matcherAnswers: [{ id: "MQ-1", answer: "x" }],
      expertiseAnswers: [],
      pitchData: pitch,
      dryRun: true,
    });
    expect(result.isError).toBeUndefined();
    // The MCP layer forwarded the user-facing names to the wire-side
    // names BEFORE the dry-run service call; the service-side preview
    // therefore carries the wire-side variable names.
    expect(confirmSpy.mock.calls[0]?.[2]).toEqual({
      matcherQuestionsAnswers: [{ id: "MQ-1", answer: "x" }],
      expertiseQuestionsAnswers: [],
      pitchInput: pitch,
    });
    expect(confirmSpy.mock.calls[0]?.[3]).toMatchObject({ dryRun: true });
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      preview: { variables: Record<string, unknown> };
    };
    expect(parsed.preview.variables).toMatchObject({
      matcherQuestionsAnswers: [{ id: "MQ-1", answer: "x" }],
      pitchInput: pitch,
    });
  });
});

describe("ttctl_interest_requests_reject — handler", () => {
  let server: McpServer;
  let rejectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerInterestRequestsTools(server, buildStubCtx());
    rejectSpy = vi.spyOn(applications, "reject");
  });

  afterEach(() => {
    rejectSpy.mockRestore();
  });

  it("dryRun: returns the RejectAvailabilityRequest preview envelope", async () => {
    rejectSpy.mockResolvedValue({
      kind: "preview",
      preview: {
        surface: "mobile-gateway",
        transport: "stock",
        endpoint: "https://example/gw",
        operationName: "RejectAvailabilityRequest",
        variables: { id: "ar-1", reason: "rate_too_low" },
        headers: { authorization: "Token token=<redacted>" },
        body: {
          operationName: "RejectAvailabilityRequest",
          query: "<query>",
          variables: { id: "ar-1" },
        },
      },
    } satisfies applications.RejectOutcome);
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_reject");
    const result = await handler({ id: "ar-1", reason: "rate_too_low", dryRun: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("RejectAvailabilityRequest");
    expect(rejectSpy.mock.calls[0]?.[3]).toMatchObject({ dryRun: true });
  });

  it("apply path: threads reason + comment into the RejectInput shape", async () => {
    rejectSpy.mockResolvedValue(
      applied({
        ...RESPOND_PAYLOAD_FIXTURE,
        rejectReason: "scope_mismatch",
        statusV2: { value: "AVAILABILITY_REQUEST_REJECTED", verbose: "Rejected" },
        requestedHourlyRate: null,
      }),
    );
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_reject");
    await handler({ id: "ar-1", reason: "scope_mismatch", comment: "not a fit" });
    expect(rejectSpy).toHaveBeenCalledWith(
      "stub-bearer-for-tests",
      "ar-1",
      { reason: "scope_mismatch", comment: "not a fit" },
      { dryRun: false },
    );
  });

  it("omits comment from the RejectInput when caller doesn't supply it", async () => {
    rejectSpy.mockResolvedValue(applied(RESPOND_PAYLOAD_FIXTURE));
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_reject");
    await handler({ id: "ar-1", reason: "rate_too_low" });
    expect(rejectSpy.mock.calls[0]?.[2]).toEqual({ reason: "rate_too_low" });
  });

  it("maps ApplicationsError(MUTATION_ERROR) — e.g. mandatory-comment-missing — to a structured error", async () => {
    rejectSpy.mockRejectedValue(
      new applications.ApplicationsError("MUTATION_ERROR", "RejectAvailabilityRequest failed: comment required"),
    );
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_reject");
    const result = await handler({ id: "ar-1", reason: "other" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("(Code: MUTATION_ERROR)");
  });
});

describe("ttctl_interest_requests_reject_reasons — handler", () => {
  let server: McpServer;
  let reasonsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    registerInterestRequestsTools(server, buildStubCtx());
    reasonsSpy = vi.spyOn(applications, "rejectReasons");
  });

  afterEach(() => {
    reasonsSpy.mockRestore();
  });

  it("dryRun: returns the AvailabilityRequestRejectReasons preview envelope", async () => {
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_reject_reasons");
    const result = await handler({ dryRun: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string; variables: Record<string, unknown> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("AvailabilityRequestRejectReasons");
    expect(parsed.preview.variables).toEqual({});
    expect(reasonsSpy).not.toHaveBeenCalled();
  });

  it("apply path: returns the fixed + flexible inventory as JSON", async () => {
    reasonsSpy.mockResolvedValue({
      fixed: [{ key: "rate_too_low", value: "Rate too low", customPlaceholder: null, isMandatory: false }],
      flexible: [
        {
          key: "other",
          value: "Other",
          customPlaceholder: "Please describe",
          isMandatory: true,
        },
      ],
    });
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_reject_reasons");
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      fixed: { key: string }[];
      flexible: { key: string }[];
    };
    expect(parsed.fixed[0]?.key).toBe("rate_too_low");
    expect(parsed.flexible[0]?.key).toBe("other");
    expect(reasonsSpy).toHaveBeenCalledWith("stub-bearer-for-tests");
  });

  it("maps ApplicationsError(WIRE_SHAPE_ERROR) to a structured error envelope", async () => {
    reasonsSpy.mockRejectedValue(
      new applications.ApplicationsError("WIRE_SHAPE_ERROR", "platformConfiguration was null"),
    );
    const handler = getRegisteredHandler(server, "ttctl_interest_requests_reject_reasons");
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("(Code: WIRE_SHAPE_ERROR)");
  });
});
