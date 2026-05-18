// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// All engagements ops run against mobile-gateway via `stockTransport`.
vi.mock("../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport.js")>("../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { ENGAGEMENT_STATUS_GROUPS, breaks, list, show, stats } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-eng-123";

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

const ENGAGEMENT_LIST_ENTITY = {
  __typename: "TalentJobActivityItem",
  id: "act-eng-1",
  statusV2: { __typename: "JobActivityItemStatus", value: "ACTIVE", verbose: "Active" },
  statusGroupV2: { __typename: "JobActivityItemStatusGroup", value: "ACTIVE_ENGAGEMENT", verbose: "Active engagement" },
  statusColor: "#00ff00",
  lastUpdatedAt: "2026-04-01T12:00:00Z",
  job: {
    __typename: "TalentJob",
    id: "job-1",
    title: "Senior Engineer",
    url: "https://www.toptal.com/jobs/job-1",
    client: { __typename: "Client", id: "cli-1", fullName: "Acme Inc." },
  },
  engagement: {
    __typename: "TalentEngagement",
    id: "eng-1",
    startDate: "2026-02-01",
    endDate: null,
    expectedHours: 40,
    commitment: { __typename: "JobCommitment", slug: "full_time" },
  },
};

const ENGAGEMENT_DETAIL_ITEM = {
  ...ENGAGEMENT_LIST_ENTITY,
  job: {
    ...ENGAGEMENT_LIST_ENTITY.job,
    descriptionMd: "Some description",
    expectedHours: 40,
    startDate: "2026-01-01",
    commitment: { __typename: "JobCommitment", slug: "full_time" },
    workType: { __typename: "JobWorkType", slug: "remote" },
    specialization: { __typename: "TalentSpecialization", title: "Backend" },
    isCoaching: false,
    isToptalProject: false,
  },
  engagement: {
    __typename: "TalentEngagement",
    id: "eng-1",
    startDate: "2026-02-01",
    endDate: null,
    expectedHours: 40,
    commitment: { __typename: "JobCommitment", slug: "full_time" },
    eligibleForPayment: true,
    eligibleToViewTimesheets: true,
    eligibleToViewTimeOffs: true,
    billCycle: { __typename: "EngagementBillCycle", verbose: "Monthly" },
    currentAgreement: {
      __typename: "EngagementAgreement",
      applicationRate: "120.00",
      talentHourlyRate: "100.00",
      talentRate: "100.00",
      marketplaceMargin: "20.00",
      timePeriod: "Monthly",
      commitment: { __typename: "JobCommitment", slug: "full_time" },
    },
    earning: {
      __typename: "TalentEngagementEarning",
      paid: { __typename: "Money", decimal: "5000.00", currency: { __typename: "Currency", code: "USD" } },
    },
    proposedEnd: { __typename: "ProposedEngagementEnd", endDate: null, status: "NONE" },
    engagementBreaks: [],
  },
};

const BREAK_FIXTURE = {
  __typename: "TalentEngagementBreak",
  id: "br-1",
  startDate: "2026-06-01",
  endDate: "2026-06-08",
  comment: "Vacation",
  operations: {
    __typename: "EngagementBreakOperationsRefs",
    removeEngagementBreak: { __typename: "EngagementBreakOpsRef", callable: "true" },
    rescheduleEngagementBreak: { __typename: "EngagementBreakOpsRef", callable: "true" },
  },
};

beforeEach(() => {
  mockedStock.mockReset();
});

describe("engagements.list", () => {
  it("defaults to status active → ACTIVE_ENGAGEMENT filter", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityList: { entities: [ENGAGEMENT_LIST_ENTITY], totalCount: 1 },
          },
        },
      },
    });
    const items = await list(TOKEN);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("act-eng-1");
    expect(items[0]?.engagementId).toBe("eng-1");
    expect(items[0]?.startDate).toBe("2026-02-01");
    expect(items[0]?.expectedHours).toBe(40);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "JobActivityItems",
      variables: { keywords: null, onlyStatusGroupFilter: ["ACTIVE_ENGAGEMENT"] },
    });
  });

  it("status past → CLOSED_ENGAGEMENT filter", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [], totalCount: 0 } } } },
    });
    await list(TOKEN, { status: "past" });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      variables: { onlyStatusGroupFilter: ["CLOSED_ENGAGEMENT"] },
    });
  });

  it("status all → both ACTIVE_ENGAGEMENT and CLOSED_ENGAGEMENT", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [], totalCount: 0 } } } },
    });
    await list(TOKEN, { status: "all" });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      variables: { onlyStatusGroupFilter: ["ACTIVE_ENGAGEMENT", "CLOSED_ENGAGEMENT"] },
    });
  });

  it("passes keywords filter into variables when supplied", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [], totalCount: 0 } } } },
    });
    await list(TOKEN, { keywords: ["acme"] });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      variables: { keywords: ["acme"] },
    });
  });

  it("returns [] when jobActivityList is null", async () => {
    reply({ body: { data: { viewer: { id: "v1", jobActivityList: null } } } });
    const items = await list(TOKEN);
    expect(items).toEqual([]);
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError when GraphQL errors carry an UNAUTHORIZED extension code", async () => {
    reply({
      body: { errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHORIZED" } }] },
    });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws EngagementsError(NO_VIEWER) when viewer is null", async () => {
    reply({ body: { data: { viewer: null } } });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NO_VIEWER",
    });
  });

  it("throws EngagementsError(NETWORK_ERROR) when transport throws", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NETWORK_ERROR",
    });
  });
});

describe("engagements.show", () => {
  it("returns the detail item by id with full engagement projection", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: ENGAGEMENT_DETAIL_ITEM } } },
    });
    const item = await show(TOKEN, "act-eng-1");
    expect(item.id).toBe("act-eng-1");
    expect(item.engagementId).toBe("eng-1");
    expect(item.currentAgreement?.talentHourlyRate).toBe("100.00");
    expect(item.currentAgreement?.marketplaceMargin).toBe("20.00");
    expect(item.currentAgreement?.timePeriod).toBe("Monthly");
    expect(item.billCycle?.verbose).toBe("Monthly");
    expect(item.earning?.paid?.decimal).toBe("5000.00");
    expect(item.earning?.paid?.currency?.code).toBe("USD");
    expect(item.eligibleToViewTimesheets).toBe(true);
    expect(item.breaks).toEqual([]);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "JobActivityItem",
      variables: { id: "act-eng-1" },
    });
  });

  it("includes engagement breaks when present", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: {
              ...ENGAGEMENT_DETAIL_ITEM,
              engagement: { ...ENGAGEMENT_DETAIL_ITEM.engagement, engagementBreaks: [BREAK_FIXTURE] },
            },
          },
        },
      },
    });
    const item = await show(TOKEN, "act-eng-1");
    expect(item.breaks).toHaveLength(1);
    expect(item.breaks[0]?.id).toBe("br-1");
    expect(item.breaks[0]?.comment).toBe("Vacation");
  });

  it("throws EngagementsError(NOT_FOUND) when jobActivityItem is null", async () => {
    reply({ body: { data: { viewer: { id: "v1", jobActivityItem: null } } } });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NOT_FOUND",
    });
  });

  it('translates the gateway "Record not found" GraphQL error into NOT_FOUND', async () => {
    reply({ body: { errors: [{ message: "Record not found" }] } });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NOT_FOUND",
    });
  });

  it("throws EngagementsError(NO_ENGAGEMENT) when activity item exists but has no engagement", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: { ...ENGAGEMENT_DETAIL_ITEM, engagement: null },
          },
        },
      },
    });
    await expect(show(TOKEN, "act-no-eng")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NO_ENGAGEMENT",
    });
  });
});

describe("engagements.stats", () => {
  it("issues one call per engagement-status-group and aggregates", async () => {
    for (let i = 0; i < ENGAGEMENT_STATUS_GROUPS.length; i++) {
      reply({
        body: {
          data: {
            viewer: {
              id: "v1",
              jobActivityList: { entities: [], totalCount: i + 1 },
            },
          },
        },
      });
    }
    const result = await stats(TOKEN);
    expect(mockedStock).toHaveBeenCalledTimes(ENGAGEMENT_STATUS_GROUPS.length);
    expect(result.groups).toHaveLength(ENGAGEMENT_STATUS_GROUPS.length);
    // Sum of i+1 for i in [0, len)
    const expectedTotal = ENGAGEMENT_STATUS_GROUPS.reduce((sum, _, i) => sum + (i + 1), 0);
    expect(result.total).toBe(expectedTotal);
    const filtersSent = mockedStock.mock.calls.map((c) => {
      const body = c[0]?.body as { variables?: { onlyStatusGroupFilter?: string[] } };
      return body.variables?.onlyStatusGroupFilter?.[0];
    });
    expect(new Set(filtersSent)).toEqual(new Set(ENGAGEMENT_STATUS_GROUPS));
  });

  it("treats null jobActivityList as count 0", async () => {
    for (let i = 0; i < ENGAGEMENT_STATUS_GROUPS.length; i++) {
      reply({
        body: { data: { viewer: { id: "v1", jobActivityList: null } } },
      });
    }
    const result = await stats(TOKEN);
    expect(result.total).toBe(0);
    expect(result.groups.every((g) => g.count === 0)).toBe(true);
  });
});

describe("engagements.breaks.list", () => {
  it("returns the breaks array via the EngagementBreaks query", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: {
              id: "act-eng-1",
              engagement: { id: "eng-1", engagementBreaks: [BREAK_FIXTURE] },
            },
          },
        },
      },
    });
    const items = await breaks.list(TOKEN, "act-eng-1");
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("br-1");
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "EngagementBreaks",
      variables: { jobActivityItemId: "act-eng-1" },
    });
  });

  it("returns [] when engagementBreaks is null", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: {
              id: "act-eng-1",
              engagement: { id: "eng-1", engagementBreaks: null },
            },
          },
        },
      },
    });
    const items = await breaks.list(TOKEN, "act-eng-1");
    expect(items).toEqual([]);
  });

  it("throws NOT_FOUND when jobActivityItem is null", async () => {
    reply({ body: { data: { viewer: { id: "v1", jobActivityItem: null } } } });
    await expect(breaks.list(TOKEN, "missing")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NOT_FOUND",
    });
  });

  it("throws NO_ENGAGEMENT when engagement is null", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: { id: "act-eng-1", engagement: null },
          },
        },
      },
    });
    await expect(breaks.list(TOKEN, "act-eng-1")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NO_ENGAGEMENT",
    });
  });
});

describe("engagements.breaks.add", () => {
  it("issues EngagementBreaks first to resolve engagement.id, then CreateEngagementBreak", async () => {
    // First call: EngagementBreaks (resolve engagement.id)
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: {
              id: "act-eng-1",
              engagement: { id: "eng-1", engagementBreaks: [] },
            },
          },
        },
      },
    });
    // Second call: CreateEngagementBreak
    reply({
      body: {
        data: {
          engagement: {
            __typename: "EngagementOps",
            createBreak: {
              __typename: "EngagementCreateBreakPayload",
              success: true,
              errors: null,
              break: BREAK_FIXTURE,
            },
          },
        },
      },
    });
    const outcome = await breaks.add(TOKEN, "act-eng-1", {
      startDate: "2026-06-01",
      endDate: "2026-06-08",
      reasonIdentifier: "vacation",
      comment: "Vacation",
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.id).toBe("br-1");
    expect(mockedStock).toHaveBeenCalledTimes(2);
    expect(mockedStock.mock.calls[0]?.[0]?.body).toMatchObject({ operationName: "EngagementBreaks" });
    expect(mockedStock.mock.calls[1]?.[0]?.body).toMatchObject({
      operationName: "CreateEngagementBreak",
      variables: {
        engagementId: "eng-1",
        startDate: "2026-06-01",
        endDate: "2026-06-08",
        reasonIdentifier: "vacation",
        comment: "Vacation",
      },
    });
  });

  it("defaults comment to null when omitted; reasonIdentifier is required and forwarded verbatim", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: { id: "act-eng-1", engagement: { id: "eng-1", engagementBreaks: [] } },
          },
        },
      },
    });
    reply({
      body: {
        data: {
          engagement: {
            createBreak: { success: true, errors: null, break: BREAK_FIXTURE },
          },
        },
      },
    });
    await breaks.add(TOKEN, "act-eng-1", {
      startDate: "2026-06-01",
      endDate: "2026-06-08",
      reasonIdentifier: "other",
    });
    const mutationCall = mockedStock.mock.calls[1]?.[0];
    expect(mutationCall?.body).toMatchObject({
      variables: { reasonIdentifier: "other", comment: null },
    });
  });

  it("throws MUTATION_ERROR when success is false", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: { id: "act-eng-1", engagement: { id: "eng-1", engagementBreaks: [] } },
          },
        },
      },
    });
    reply({
      body: {
        data: {
          engagement: {
            createBreak: {
              success: false,
              errors: [{ key: "startDate", message: "Overlaps with another break", code: "OVERLAP" }],
              break: null,
            },
          },
        },
      },
    });
    await expect(
      breaks.add(TOKEN, "act-eng-1", { startDate: "2026-06-01", endDate: "2026-06-08" }),
    ).rejects.toMatchObject({
      name: "EngagementsError",
      code: "MUTATION_ERROR",
    });
  });

  it("throws NOT_FOUND when the activity item resolution fails first", async () => {
    reply({ body: { data: { viewer: { id: "v1", jobActivityItem: null } } } });
    await expect(
      breaks.add(TOKEN, "missing", { startDate: "2026-06-01", endDate: "2026-06-08" }),
    ).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NOT_FOUND",
    });
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });
});

describe("engagements.breaks.remove", () => {
  it("issues CancelEngagementBreak with the break id", async () => {
    reply({
      body: {
        data: {
          engagementBreak: {
            __typename: "EngagementBreakOps",
            cancel: {
              __typename: "EngagementBreakCancelPayload",
              success: true,
              errors: null,
              break: { id: "br-1", engagement: { id: "eng-1", engagementBreaks: [] } },
            },
          },
        },
      },
    });
    const outcome = await breaks.remove(TOKEN, "br-1");
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.id).toBe("br-1");
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "CancelEngagementBreak",
      variables: { engagementBreakId: "br-1" },
    });
  });

  it("throws MUTATION_ERROR when success is false", async () => {
    reply({
      body: {
        data: {
          engagementBreak: {
            cancel: {
              success: false,
              errors: [{ message: "Break already cancelled" }],
              break: null,
            },
          },
        },
      },
    });
    await expect(breaks.remove(TOKEN, "br-cancelled")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "MUTATION_ERROR",
    });
  });

  it("throws NOT_FOUND when the break id resolves to null engagementBreak", async () => {
    reply({ body: { data: { engagementBreak: null } } });
    await expect(breaks.remove(TOKEN, "br-missing")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NOT_FOUND",
    });
  });
});

describe("engagements.breaks.reschedule (#155)", () => {
  it("issues RescheduleEngagementBreak with engagementBreakId + startDate + endDate (no prefetch)", async () => {
    const RESCHEDULED_FIXTURE = {
      ...BREAK_FIXTURE,
      startDate: "2026-07-01",
      endDate: "2026-07-08",
    };
    reply({
      body: {
        data: {
          engagementBreak: {
            __typename: "EngagementBreakOps",
            reschedule: {
              __typename: "EngagementBreakReschedulePayload",
              success: true,
              errors: null,
              break: RESCHEDULED_FIXTURE,
            },
          },
        },
      },
    });
    const outcome = await breaks.reschedule(TOKEN, "br-1", {
      startDate: "2026-07-01",
      endDate: "2026-07-08",
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.id).toBe("br-1");
    expect(outcome.result.startDate).toBe("2026-07-01");
    expect(outcome.result.endDate).toBe("2026-07-08");
    // CRITICAL contract: only one transport call — NO prefetch, unlike add.
    expect(mockedStock).toHaveBeenCalledTimes(1);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "RescheduleEngagementBreak",
      variables: {
        engagementBreakId: "br-1",
        startDate: "2026-07-01",
        endDate: "2026-07-08",
      },
    });
    // Wire input shape — explicitly NO comment / NO reasonIdentifier
    // fields, per the captured operation.
    const variables = (call?.body as { variables?: Record<string, unknown> } | undefined)?.variables ?? {};
    expect(Object.keys(variables).sort()).toEqual(["endDate", "engagementBreakId", "startDate"]);
  });

  it("throws MUTATION_ERROR when success is false (e.g. overlapping window)", async () => {
    reply({
      body: {
        data: {
          engagementBreak: {
            reschedule: {
              success: false,
              errors: [{ key: "startDate", message: "Overlaps with another break", code: "OVERLAP" }],
              break: null,
            },
          },
        },
      },
    });
    await expect(
      breaks.reschedule(TOKEN, "br-1", { startDate: "2026-07-01", endDate: "2026-07-08" }),
    ).rejects.toMatchObject({
      name: "EngagementsError",
      code: "MUTATION_ERROR",
    });
  });

  it("throws NOT_FOUND when the break id resolves to null engagementBreak", async () => {
    reply({ body: { data: { engagementBreak: null } } });
    await expect(
      breaks.reschedule(TOKEN, "br-missing", { startDate: "2026-07-01", endDate: "2026-07-08" }),
    ).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NOT_FOUND",
    });
  });

  it("throws UNKNOWN when success is true but break payload is null", async () => {
    reply({
      body: {
        data: {
          engagementBreak: {
            reschedule: { success: true, errors: null, break: null },
          },
        },
      },
    });
    await expect(
      breaks.reschedule(TOKEN, "br-1", { startDate: "2026-07-01", endDate: "2026-07-08" }),
    ).rejects.toMatchObject({
      name: "EngagementsError",
      code: "UNKNOWN",
    });
  });
});

// ---------------------------------------------------------------------
// dry-run path (issue #163)
//
// Per the AC for #163, every engagement-breaks mutation invoked with
// `dryRun: true` must:
//   - SHORT-CIRCUIT — `stockTransport` is never called (transport-zero
//     AC; includes the prefetch `EngagementBreaks` query that `add`
//     normally issues to translate jobActivityItem.id → engagement.id)
//   - return `{ kind: "preview", preview: <DryRunPreview> }`
//   - the preview surfaces the operation name from the issue's mapping
//     table verbatim (`CreateEngagementBreak` / `CancelEngagementBreak`),
//     the mobile-gateway transport classification, the literal variables
//     payload, and a redacted Authorization header
//
// `breaks.add` placeholder semantics: because the prefetch is skipped,
// the preview's `variables.engagementId` carries the caller-supplied
// `jobActivityItemId` as a placeholder. The CLI envelope's `notice`
// field surfaces the deferred-resolution caveat to the user.
// ---------------------------------------------------------------------
describe("engagements.breaks dry-run path (issue #163)", () => {
  it("breaks.add({ dryRun: true }) returns preview without invoking transport (transport-zero AC, prefetch skipped)", async () => {
    const outcome = await breaks.add(
      TOKEN,
      "act-eng-1",
      {
        startDate: "2026-06-01",
        endDate: "2026-06-08",
        reasonIdentifier: "talent_on_vacation",
        comment: "Summer break",
      },
      { dryRun: true },
    );
    // The CRITICAL AC: zero transport calls in dry-run path — including
    // the prefetch that the apply path uses to resolve engagement.id.
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("CreateEngagementBreak");
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.transport).toBe("stock");
    // Wire-shape contract: variable field names match the captured op;
    // `engagementId` carries the jobActivityItemId placeholder.
    expect(outcome.preview.variables).toEqual({
      engagementId: "act-eng-1",
      startDate: "2026-06-01",
      endDate: "2026-06-08",
      reasonIdentifier: "talent_on_vacation",
      comment: "Summer break",
    });
    // Bearer redaction.
    expect(outcome.preview.headers["authorization"]).toBe("Token token=<redacted>");
    expect(outcome.preview.headers["authorization"]).not.toContain(TOKEN);
  });

  it("breaks.add({ dryRun: true }) preserves comment=null when comment is omitted", async () => {
    const outcome = await breaks.add(
      TOKEN,
      "act-eng-1",
      { startDate: "2026-06-01", endDate: "2026-06-08", reasonIdentifier: "other" },
      { dryRun: true },
    );
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.variables).toMatchObject({ reasonIdentifier: "other", comment: null });
  });

  it("breaks.remove({ dryRun: true }) returns preview without invoking transport", async () => {
    const outcome = await breaks.remove(TOKEN, "br-1", { dryRun: true });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("CancelEngagementBreak");
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.transport).toBe("stock");
    expect(outcome.preview.variables).toEqual({ engagementBreakId: "br-1" });
    expect(outcome.preview.headers["authorization"]).toBe("Token token=<redacted>");
    expect(outcome.preview.headers["authorization"]).not.toContain(TOKEN);
  });

  it("breaks.reschedule({ dryRun: true }) returns preview without invoking transport (#155)", async () => {
    const outcome = await breaks.reschedule(
      TOKEN,
      "br-1",
      { startDate: "2026-07-01", endDate: "2026-07-08" },
      { dryRun: true },
    );
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("RescheduleEngagementBreak");
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.transport).toBe("stock");
    expect(outcome.preview.variables).toEqual({
      engagementBreakId: "br-1",
      startDate: "2026-07-01",
      endDate: "2026-07-08",
    });
    expect(outcome.preview.headers["authorization"]).toBe("Token token=<redacted>");
    expect(outcome.preview.headers["authorization"]).not.toContain(TOKEN);
  });

  it("explicit `dryRun: false` is the apply path (ensures option does not invert)", async () => {
    // breaks.remove apply path — one transport call expected.
    reply({
      body: {
        data: {
          engagementBreak: {
            cancel: { success: true, errors: null, break: { id: "br-1" } },
          },
        },
      },
    });
    const outcome = await breaks.remove(TOKEN, "br-1", { dryRun: false });
    expect(mockedStock).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("applied");
  });

  it("omitting options entirely is the apply path (default behavior)", async () => {
    // breaks.remove apply path with no options arg — defaults to dryRun=false.
    reply({
      body: {
        data: {
          engagementBreak: {
            cancel: { success: true, errors: null, break: { id: "br-1" } },
          },
        },
      },
    });
    const outcome = await breaks.remove(TOKEN, "br-1");
    expect(mockedStock).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("applied");
  });
});

describe("engagements.breaks.reasonsList", () => {
  it("issues PlatformConfiguration and returns the catalog sorted by identifier", async () => {
    reply({
      body: {
        data: {
          platformConfiguration: {
            __typename: "PlatformConfiguration",
            id: "pc-1",
            engagementBreakReasons: [
              { __typename: "FeedbackReason", identifier: "talent_on_vacation", nameForRole: "On vacation" },
              { __typename: "FeedbackReason", identifier: "client_on_vacation", nameForRole: "Client on vacation" },
              { __typename: "FeedbackReason", identifier: "other", nameForRole: "Other" },
              {
                __typename: "FeedbackReason",
                identifier: "client_needs_preparation",
                nameForRole: "Client needs preparation",
              },
            ],
          },
        },
      },
    });
    const items = await breaks.reasonsList(TOKEN);
    expect(items.map((r) => r.identifier)).toEqual([
      "client_needs_preparation",
      "client_on_vacation",
      "other",
      "talent_on_vacation",
    ]);
    // Each entry projects only the two surface fields — no `__typename`,
    // no extras.
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["identifier", "nameForRole"]);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({ operationName: "PlatformConfiguration", variables: {} });
    expect(call?.surface).toBe("mobile-gateway");
  });

  it("returns [] when engagementBreakReasons is empty", async () => {
    reply({
      body: {
        data: {
          platformConfiguration: { __typename: "PlatformConfiguration", id: "pc-1", engagementBreakReasons: [] },
        },
      },
    });
    const items = await breaks.reasonsList(TOKEN);
    expect(items).toEqual([]);
  });

  it("filters null wire entries defensively", async () => {
    // `engagementBreakReasons: [FeedbackReason]!` — list non-null but
    // items nullable per Toptal SDL convention. Code must drop nulls
    // rather than coerce them into garbage entries.
    reply({
      body: {
        data: {
          platformConfiguration: {
            __typename: "PlatformConfiguration",
            id: "pc-1",
            engagementBreakReasons: [
              { __typename: "FeedbackReason", identifier: "other", nameForRole: "Other" },
              null,
              { __typename: "FeedbackReason", identifier: "talent_on_vacation", nameForRole: "On vacation" },
            ],
          },
        },
      },
    });
    const items = await breaks.reasonsList(TOKEN);
    expect(items).toEqual([
      { identifier: "other", nameForRole: "Other" },
      { identifier: "talent_on_vacation", nameForRole: "On vacation" },
    ]);
  });

  it("returns [] when platformConfiguration root is null (defensive)", async () => {
    reply({ body: { data: { platformConfiguration: null } } });
    const items = await breaks.reasonsList(TOKEN);
    expect(items).toEqual([]);
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(breaks.reasonsList(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("sort is case-insensitive (locale-base sensitivity)", async () => {
    reply({
      body: {
        data: {
          platformConfiguration: {
            __typename: "PlatformConfiguration",
            id: "pc-1",
            engagementBreakReasons: [
              { __typename: "FeedbackReason", identifier: "Beta", nameForRole: "Beta" },
              { __typename: "FeedbackReason", identifier: "alpha", nameForRole: "Alpha" },
              { __typename: "FeedbackReason", identifier: "Gamma", nameForRole: "Gamma" },
            ],
          },
        },
      },
    });
    const items = await breaks.reasonsList(TOKEN);
    expect(items.map((r) => r.identifier)).toEqual(["alpha", "Beta", "Gamma"]);
  });
});
