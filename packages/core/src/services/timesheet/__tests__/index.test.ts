// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// All timesheet ops run against mobile-gateway via `stockTransport`.
vi.mock("../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport/index.js")>("../../../transport/index.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { list, resolveCurrentCycle, show, submit, update, TimesheetError } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { ConsentRequiredError } from "../../../consent.js";
import { stockTransport } from "../../../transport/index.js";
import type { TransportResponse } from "../../../transport/index.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-ts-123";

interface MockResponse {
  status?: number;
  body: unknown;
}

function reply(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedStock.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

const LIST_WIRE_ITEM = {
  __typename: "BillingCycle",
  id: "bc-1",
  startDate: "2026-05-01",
  endDate: "2026-05-15",
  hours: "40.0",
  minimumCommitment: {
    __typename: "MinimumCommitment",
    applicable: true,
    minimumHours: 20,
    reasonNotApplicable: null,
  },
  timesheetOverdue: false,
  timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
  timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
  timesheetSubmitted: false,
  timesheetApproved: false,
  timesheetRequiresApproval: true,
  status: "open",
  engagement: {
    __typename: "TalentEngagement",
    id: "eng-1",
    job: {
      __typename: "TalentJob",
      id: "job-1",
      title: "Senior Backend Engineer",
      client: { __typename: "Client", id: "cli-1", fullName: "Acme Inc." },
    },
  },
};

const DETAIL_WIRE_ITEM = {
  ...LIST_WIRE_ITEM,
  timesheetUrl: "https://www.toptal.com/timesheet/bc-1",
  timesheetComment: "Worked on auth refactor",
  timesheetRecords: [
    // `duration` is string-minutes (480.0 = 8h); `hours` mirrors the
    // server-rendered hour form now selected by the op.
    {
      __typename: "TimesheetRecord",
      date: "2026-05-12",
      duration: "480.0",
      hours: "8.0",
      note: "auth refactor",
      isDayOff: false,
      persisted: true,
    },
    {
      __typename: "TimesheetRecord",
      date: "2026-05-13",
      duration: "0.0",
      hours: "0.0",
      note: null,
      isDayOff: true,
      persisted: true,
    },
  ],
  actualAgreement: {
    __typename: "EngagementAgreement",
    applicationRate: "120.00",
    talentHourlyRate: "100.00",
    marketplaceMargin: "20.00",
  },
  engagement: {
    ...LIST_WIRE_ITEM.engagement,
    expectedHours: 40,
  },
};

beforeEach(() => {
  mockedStock.mockReset();
});

describe("timesheet.list", () => {
  it("default scope → PendingTimesheets($limit=DEFAULT_PENDING_LIMIT), returns pending cycles", async () => {
    reply({
      body: {
        data: { viewer: { id: "v1", billingCycles: { nodes: [LIST_WIRE_ITEM] } } },
      },
    });
    const items = await list(TOKEN);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("bc-1");
    expect(items[0]?.timesheetSubmitted).toBe(false);
    // Approval state is projected onto every list row.
    expect(items[0]?.timesheetApproved).toBe(false);
    expect(items[0]?.timesheetRequiresApproval).toBe(true);
    expect(items[0]?.status).toBe("open");
    expect(items[0]?.engagement.job.client?.fullName).toBe("Acme Inc.");
    const call = mockedStock.mock.calls[0]?.[0];
    expect(JSON.stringify(call?.body)).toContain("timesheetApproved timesheetRequiresApproval status");
    expect(call?.body).toMatchObject({
      operationName: "PendingTimesheets",
      // #374: viewer-wide variant now threads `$limit` through
      // `pagination: { limit: $limit }`. The default value matches
      // the pre-#374 hardcoded `pagination: { limit: 50 }` so
      // flag-less callers see no behaviour change.
      variables: { limit: 50 },
    });
    expect(call?.surface).toBe("mobile-gateway");
    expect(call?.authToken).toBe(TOKEN);
  });

  it("with limit option → PendingTimesheets($limit=opts.limit), threads explicit value", async () => {
    // #374: surface-honest `--limit N` / `{ limit }` maps directly
    // to the wire `pagination: { limit: $limit }` input — no
    // translation layer, no inferred fields.
    reply({
      body: {
        data: { viewer: { id: "v1", billingCycles: { nodes: [LIST_WIRE_ITEM] } } },
      },
    });
    const items = await list(TOKEN, { limit: 5 });
    expect(items).toHaveLength(1);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "PendingTimesheets",
      variables: { limit: 5 },
    });
  });

  it("returns [] when PendingTimesheets has no nodes", async () => {
    reply({ body: { data: { viewer: { id: "v1", billingCycles: { nodes: [] } } } } });
    const items = await list(TOKEN);
    expect(items).toEqual([]);
  });

  it("returns [] when PendingTimesheets has null billingCycles container", async () => {
    reply({ body: { data: { viewer: { id: "v1", billingCycles: null } } } });
    const items = await list(TOKEN);
    expect(items).toEqual([]);
  });

  it("with engagement option → Timesheets(jobActivityItemId)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: {
              id: "act-1",
              engagement: {
                id: "eng-1",
                billingCycles: { ids: ["bc-1"], nodes: [LIST_WIRE_ITEM] },
              },
            },
          },
        },
      },
    });
    const items = await list(TOKEN, { engagement: "act-1" });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("bc-1");
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "Timesheets",
      variables: { jobActivityItemId: "act-1" },
    });
  });

  it("with engagement option, limit is ignored (per-engagement wire op has no pagination input)", async () => {
    // #374 OUT-OF-SCOPE: the per-engagement `TIMESHEETS_QUERY`
    // carries no pagination input; `limit` is silently dropped on
    // this path. Documented behaviour, not a wire constraint
    // bypass — `Timesheets` simply does not accept pagination.
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: {
              id: "act-1",
              engagement: {
                id: "eng-1",
                billingCycles: { ids: ["bc-1"], nodes: [LIST_WIRE_ITEM] },
              },
            },
          },
        },
      },
    });
    await list(TOKEN, { engagement: "act-1", limit: 999 });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "Timesheets",
      variables: { jobActivityItemId: "act-1" },
    });
    // No `limit` key in the variables — the per-engagement wire op
    // does not accept one.
    const variables = (call?.body as { variables?: Record<string, unknown> }).variables ?? {};
    expect("limit" in variables).toBe(false);
  });

  it("with engagement option, jobActivityItem null → NOT_FOUND", async () => {
    reply({ body: { data: { viewer: { id: "v1", jobActivityItem: null } } } });
    await expect(list(TOKEN, { engagement: "missing-act" })).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NOT_FOUND",
    });
  });

  it("with engagement option, engagement null → NO_ENGAGEMENT", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: { id: "act-1", engagement: null },
          },
        },
      },
    });
    await expect(list(TOKEN, { engagement: "act-1" })).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NO_ENGAGEMENT",
    });
  });

  it("translates GraphQL 'Record not found' on engagement-scoped list into NOT_FOUND", async () => {
    reply({
      body: { errors: [{ message: "Record not found" }] },
    });
    await expect(list(TOKEN, { engagement: "act-1" })).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NOT_FOUND",
    });
  });

  it("default-scope viewer null → NO_VIEWER", async () => {
    reply({ body: { data: { viewer: null } } });
    await expect(list(TOKEN)).rejects.toMatchObject({ name: "TimesheetError", code: "NO_VIEWER" });
  });

  it("HTTP 401 → AuthRevokedError", async () => {
    reply({ status: 401, body: {} });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("GraphQL UNAUTHENTICATED extension → AuthRevokedError", async () => {
    reply({
      body: { errors: [{ message: "Auth required", extensions: { code: "UNAUTHENTICATED" } }] },
    });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("non-401 HTTP error → UNKNOWN code", async () => {
    reply({ status: 502, body: "bad gateway" });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "TimesheetError",
      code: "UNKNOWN",
    });
  });
});

describe("timesheet.show", () => {
  it("returns the projected detail payload", async () => {
    reply({ body: { data: { node: DETAIL_WIRE_ITEM } } });
    const detail = await show(TOKEN, "bc-1");
    expect(detail.id).toBe("bc-1");
    expect(detail.timesheetUrl).toBe("https://www.toptal.com/timesheet/bc-1");
    expect(detail.timesheetRecords).toHaveLength(2);
    expect(detail.timesheetRecords[0]?.duration).toBe("480.0");
    expect(detail.timesheetRecords[0]?.hours).toBe("8.0");
    expect(detail.timesheetRecords[0]?.persisted).toBe(true);
    expect(detail.actualAgreement?.talentHourlyRate).toBe("100.00");
    expect(detail.engagement.expectedHours).toBe(40);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "TimesheetDetails",
      variables: { id: "bc-1" },
    });
  });

  it("null records → empty array", async () => {
    reply({
      body: { data: { node: { ...DETAIL_WIRE_ITEM, timesheetRecords: null } } },
    });
    const detail = await show(TOKEN, "bc-1");
    expect(detail.timesheetRecords).toEqual([]);
  });

  it("data.node === null → NOT_FOUND", async () => {
    reply({ body: { data: { node: null } } });
    await expect(show(TOKEN, "missing-id")).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NOT_FOUND",
    });
  });

  it("GraphQL 'Record not found' error → NOT_FOUND", async () => {
    reply({ body: { errors: [{ message: "Record not found" }] } });
    await expect(show(TOKEN, "missing-id")).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NOT_FOUND",
    });
  });
});

describe("timesheet.submit", () => {
  it("happy path → returns { kind: 'applied', result: detail }", async () => {
    reply({
      body: {
        data: {
          submitTimesheet: {
            __typename: "SubmitTimesheetPayload",
            success: true,
            errors: [],
            billingCycle: { ...DETAIL_WIRE_ITEM, timesheetSubmitted: true },
          },
        },
      },
    });
    const outcome = await submit(TOKEN, "bc-1");
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.timesheetSubmitted).toBe(true);
    expect(outcome.result.id).toBe("bc-1");
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "SubmitTimesheet",
      variables: { id: "bc-1" },
    });
  });

  it("dry-run: returns { kind: 'preview', preview } WITHOUT calling the transport", async () => {
    const outcome = await submit(TOKEN, "bc-1", { dryRun: true });
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("SubmitTimesheet");
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.variables).toEqual({ id: "bc-1" });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("dry-run with placeholder id: stamps the placeholder verbatim into variables", async () => {
    const outcome = await submit(TOKEN, "<auto-resolved-at-apply-time>", { dryRun: true });
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.variables).toEqual({ id: "<auto-resolved-at-apply-time>" });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("apply path (dryRun: false explicit) → calls transport and returns applied outcome", async () => {
    reply({
      body: {
        data: {
          submitTimesheet: {
            __typename: "SubmitTimesheetPayload",
            success: true,
            errors: [],
            billingCycle: { ...DETAIL_WIRE_ITEM, timesheetSubmitted: true },
          },
        },
      },
    });
    const outcome = await submit(TOKEN, "bc-1", { dryRun: false });
    expect(outcome.kind).toBe("applied");
    expect(mockedStock).toHaveBeenCalledOnce();
  });

  it("payload null → NOT_FOUND", async () => {
    reply({ body: { data: { submitTimesheet: null } } });
    await expect(submit(TOKEN, "missing-id")).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NOT_FOUND",
    });
  });

  it("Relay decode error (top-level errors[]) → remapped to NOT_FOUND", async () => {
    reply({
      body: {
        data: null,
        errors: [
          {
            message:
              "Node id 'VjEtTm9uZXhpc3RlbnQtMA' resolves to an unknown type Nonexistent. Please check if there is no typo and schemas are up to date.",
          },
        ],
      },
    });
    await expect(submit(TOKEN, "VjEtTm9uZXhpc3RlbnQtMA")).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NOT_FOUND",
    });
  });

  it("other top-level errors (e.g. 500) → flow through as GRAPHQL_ERROR (no spurious NOT_FOUND remap)", async () => {
    reply({
      body: {
        data: null,
        errors: [{ message: "500: Internal Server Error" }],
      },
    });
    await expect(submit(TOKEN, "bc-broken")).rejects.toMatchObject({
      name: "TimesheetError",
      code: "GRAPHQL_ERROR",
    });
  });

  it("server reports success: false → MUTATION_ERROR with formatted message", async () => {
    reply({
      body: {
        data: {
          submitTimesheet: {
            __typename: "SubmitTimesheetPayload",
            success: false,
            errors: [
              { code: "validation", key: "hours", message: "Missing required hours for 2026-05-13" },
              { code: "deadline", key: null, message: "Submission deadline has passed" },
            ],
            billingCycle: null,
          },
        },
      },
    });
    let captured: TimesheetError | undefined;
    try {
      await submit(TOKEN, "bc-1");
    } catch (err) {
      if (err instanceof TimesheetError) captured = err;
    }
    expect(captured?.code).toBe("MUTATION_ERROR");
    expect(captured?.message).toContain("Missing required hours");
    expect(captured?.message).toContain("Submission deadline has passed");
    expect(captured?.message).toContain("[code=validation, key=hours]");
  });

  it("success: true but billingCycle null → UNKNOWN", async () => {
    reply({
      body: {
        data: {
          submitTimesheet: {
            __typename: "SubmitTimesheetPayload",
            success: true,
            errors: [],
            billingCycle: null,
          },
        },
      },
    });
    await expect(submit(TOKEN, "bc-1")).rejects.toMatchObject({
      name: "TimesheetError",
      code: "UNKNOWN",
    });
  });
});

describe("timesheet.update", () => {
  // The apply path is read-modify-write: show() (TimesheetDetails) then the
  // UpdateTimesheet mutation. Queue both, in order.
  function replyReadThenUpdate(billingCycle: unknown, opts: { success?: boolean; errors?: unknown[] } = {}): void {
    reply(
      { body: { data: { node: DETAIL_WIRE_ITEM } } },
      {
        body: {
          data: {
            updateTimesheet: {
              __typename: "UpdateTimesheetPayload",
              success: opts.success ?? true,
              errors: opts.errors ?? [],
              billingCycle,
            },
          },
        },
      },
    );
  }

  // The two current records of DETAIL_WIRE_ITEM, projected onto the wire
  // input shape ({ date, duration, note }) — the read-modify-write baseline.
  const CURRENT_RECORDS_AS_INPUT = [
    { date: "2026-05-12", duration: "480.0", note: "auth refactor" },
    { date: "2026-05-13", duration: "0.0", note: null },
  ];

  it("comment-only change → resends the full current record set unchanged + new comment", async () => {
    replyReadThenUpdate({ ...DETAIL_WIRE_ITEM, timesheetComment: "reviewed with client" });
    const outcome = await update(TOKEN, "bc-1", {
      comment: "reviewed with client",
      timesheetBillingConsentIssued: true,
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.timesheetComment).toBe("reviewed with client");
    expect(mockedStock).toHaveBeenCalledTimes(2);
    expect(mockedStock.mock.calls[0]?.[0]?.body).toMatchObject({ operationName: "TimesheetDetails" });
    expect(mockedStock.mock.calls[1]?.[0]?.body).toMatchObject({
      operationName: "UpdateTimesheet",
      variables: { id: "bc-1", comment: "reviewed with client", timesheetRecords: CURRENT_RECORDS_AS_INPUT },
    });
  });

  it("record duration override merges by date, preserving the untouched day (no null-out)", async () => {
    replyReadThenUpdate(DETAIL_WIRE_ITEM);
    await update(TOKEN, "bc-1", {
      records: [{ date: "2026-05-12", duration: "240.0" }],
      timesheetBillingConsentIssued: true,
    });
    const sent = mockedStock.mock.calls[1]?.[0]?.body as {
      variables: { comment: string; timesheetRecords: unknown[] };
    };
    // comment unchanged (resent from current); 05-12 overridden; 05-13 preserved.
    expect(sent.variables.comment).toBe("Worked on auth refactor");
    expect(sent.variables.timesheetRecords).toEqual([
      { date: "2026-05-12", duration: "240.0", note: "auth refactor" },
      { date: "2026-05-13", duration: "0.0", note: null },
    ]);
  });

  it("note override (and explicit clear) merges without touching duration", async () => {
    replyReadThenUpdate(DETAIL_WIRE_ITEM);
    await update(TOKEN, "bc-1", {
      records: [
        { date: "2026-05-12", note: null },
        { date: "2026-05-13", note: "added a note" },
      ],
      timesheetBillingConsentIssued: true,
    });
    const sent = mockedStock.mock.calls[1]?.[0]?.body as { variables: { timesheetRecords: unknown[] } };
    expect(sent.variables.timesheetRecords).toEqual([
      { date: "2026-05-12", duration: "480.0", note: null },
      { date: "2026-05-13", duration: "0.0", note: "added a note" },
    ]);
  });

  it("override for an unknown date is appended as a new day", async () => {
    replyReadThenUpdate(DETAIL_WIRE_ITEM);
    await update(TOKEN, "bc-1", {
      records: [{ date: "2026-05-20", duration: "120.0", note: "extra" }],
      timesheetBillingConsentIssued: true,
    });
    const sent = mockedStock.mock.calls[1]?.[0]?.body as { variables: { timesheetRecords: unknown[] } };
    expect(sent.variables.timesheetRecords).toEqual([
      ...CURRENT_RECORDS_AS_INPUT,
      { date: "2026-05-20", duration: "120.0", note: "extra" },
    ]);
  });

  it("dry-run: returns a preview WITHOUT any wire call (not even the read)", async () => {
    const outcome = await update(
      TOKEN,
      "bc-1",
      { comment: "draft", records: [{ date: "2026-05-12", duration: "60.0" }] },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("UpdateTimesheet");
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.variables).toEqual({
      id: "bc-1",
      comment: "draft",
      timesheetRecords: [{ date: "2026-05-12", duration: "60.0", note: null }],
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("missing consent → ConsentRequiredError before any wire call", async () => {
    await expect(update(TOKEN, "bc-1", { comment: "x" })).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("env bypass (TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1) allows the apply path without the consent field", async () => {
    const prev = process.env["TTCTL_ALLOW_INFERRED_DESTRUCTIVE"];
    process.env["TTCTL_ALLOW_INFERRED_DESTRUCTIVE"] = "1";
    try {
      replyReadThenUpdate(DETAIL_WIRE_ITEM);
      const outcome = await update(TOKEN, "bc-1", { comment: "via env bypass" });
      expect(outcome.kind).toBe("applied");
      expect(mockedStock).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env["TTCTL_ALLOW_INFERRED_DESTRUCTIVE"];
      else process.env["TTCTL_ALLOW_INFERRED_DESTRUCTIVE"] = prev;
    }
  });

  it("nothing to update (no comment, no records) → VALIDATION_ERROR, no wire call", async () => {
    await expect(update(TOKEN, "bc-1", { timesheetBillingConsentIssued: true })).rejects.toMatchObject({
      name: "TimesheetError",
      code: "VALIDATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("payload null → NOT_FOUND", async () => {
    reply({ body: { data: { node: DETAIL_WIRE_ITEM } } }, { body: { data: { updateTimesheet: null } } });
    await expect(update(TOKEN, "bc-1", { comment: "x", timesheetBillingConsentIssued: true })).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NOT_FOUND",
    });
  });

  it("server reports success: false → MUTATION_ERROR with formatted message", async () => {
    replyReadThenUpdate(null, {
      success: false,
      errors: [{ code: "validation", key: "hours", message: "Duration exceeds cycle max" }],
    });
    let captured: TimesheetError | undefined;
    try {
      await update(TOKEN, "bc-1", { comment: "x", timesheetBillingConsentIssued: true });
    } catch (err) {
      if (err instanceof TimesheetError) captured = err;
    }
    expect(captured?.code).toBe("MUTATION_ERROR");
    expect(captured?.message).toContain("Duration exceeds cycle max");
  });

  it("success: true but billingCycle null → UNKNOWN", async () => {
    replyReadThenUpdate(null, { success: true });
    await expect(update(TOKEN, "bc-1", { comment: "x", timesheetBillingConsentIssued: true })).rejects.toMatchObject({
      name: "TimesheetError",
      code: "UNKNOWN",
    });
  });

  it("Relay decode error on the mutation → remapped to NOT_FOUND", async () => {
    reply(
      { body: { data: { node: DETAIL_WIRE_ITEM } } },
      {
        body: {
          data: null,
          errors: [{ message: "Node id 'VjEt' resolves to an unknown type Nonexistent." }],
        },
      },
    );
    await expect(update(TOKEN, "bc-1", { comment: "x", timesheetBillingConsentIssued: true })).rejects.toMatchObject({
      name: "TimesheetError",
      code: "NOT_FOUND",
    });
  });
});

describe("timesheet.resolveCurrentCycle", () => {
  const NOW = new Date("2026-05-12T12:00:00Z");

  const CYCLE_OPEN_NOW: typeof LIST_WIRE_ITEM = {
    ...LIST_WIRE_ITEM,
    id: "bc-current",
    timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
    timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
    timesheetSubmitted: false,
  };

  const CYCLE_BEFORE_WINDOW: typeof LIST_WIRE_ITEM = {
    ...LIST_WIRE_ITEM,
    id: "bc-future",
    timesheetSubmissionOpenDatetime: "2026-06-01T00:00:00+00:00",
    timesheetSubmissionDeadlineDatetime: "2026-06-30T23:59:59+00:00",
    timesheetSubmitted: false,
  };

  const CYCLE_AFTER_WINDOW: typeof LIST_WIRE_ITEM = {
    ...LIST_WIRE_ITEM,
    id: "bc-past",
    timesheetSubmissionOpenDatetime: "2026-04-01T00:00:00+00:00",
    timesheetSubmissionDeadlineDatetime: "2026-04-30T23:59:59+00:00",
    timesheetSubmitted: false,
  };

  const CYCLE_ALREADY_SUBMITTED: typeof LIST_WIRE_ITEM = {
    ...LIST_WIRE_ITEM,
    id: "bc-done",
    timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
    timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
    timesheetSubmitted: true,
  };

  it("found: exactly one cycle's window contains now", async () => {
    reply({
      body: {
        data: { viewer: { id: "v1", billingCycles: { nodes: [CYCLE_OPEN_NOW, CYCLE_BEFORE_WINDOW] } } },
      },
    });
    const result = await resolveCurrentCycle(TOKEN, { now: NOW });
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.cycle.id).toBe("bc-current");
    }
  });

  it("none: no cycles in window (all future or all past)", async () => {
    reply({
      body: {
        data: { viewer: { id: "v1", billingCycles: { nodes: [CYCLE_BEFORE_WINDOW, CYCLE_AFTER_WINDOW] } } },
      },
    });
    const result = await resolveCurrentCycle(TOKEN, { now: NOW });
    expect(result.kind).toBe("none");
  });

  it("none: cycle in window but already submitted", async () => {
    reply({
      body: {
        data: { viewer: { id: "v1", billingCycles: { nodes: [CYCLE_ALREADY_SUBMITTED] } } },
      },
    });
    const result = await resolveCurrentCycle(TOKEN, { now: NOW });
    expect(result.kind).toBe("none");
  });

  it("multiple: two cycles in window", async () => {
    const SECOND = { ...CYCLE_OPEN_NOW, id: "bc-current-2", engagement: { ...CYCLE_OPEN_NOW.engagement, id: "eng-2" } };
    reply({
      body: { data: { viewer: { id: "v1", billingCycles: { nodes: [CYCLE_OPEN_NOW, SECOND] } } } },
    });
    const result = await resolveCurrentCycle(TOKEN, { now: NOW });
    expect(result.kind).toBe("multiple");
    if (result.kind === "multiple") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.id)).toEqual(["bc-current", "bc-current-2"]);
    }
  });

  it("engagement-scoped: uses Timesheets query + filters to unsubmitted", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: {
              id: "act-1",
              engagement: {
                id: "eng-1",
                billingCycles: {
                  ids: ["bc-current", "bc-done"],
                  nodes: [CYCLE_OPEN_NOW, CYCLE_ALREADY_SUBMITTED],
                },
              },
            },
          },
        },
      },
    });
    const result = await resolveCurrentCycle(TOKEN, { now: NOW, engagement: "act-1" });
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.cycle.id).toBe("bc-current");
    }
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "Timesheets",
      variables: { jobActivityItemId: "act-1" },
    });
  });

  it("none when missing-date-bound: defensive guards against partial windows", async () => {
    const CYCLE_NO_OPEN = {
      ...CYCLE_OPEN_NOW,
      id: "bc-bare",
      timesheetSubmissionOpenDatetime: null,
    };
    reply({
      body: { data: { viewer: { id: "v1", billingCycles: { nodes: [CYCLE_NO_OPEN] } } } },
    });
    const result = await resolveCurrentCycle(TOKEN, { now: NOW });
    expect(result.kind).toBe("none");
  });
});
