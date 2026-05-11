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
    const result = await breaks.add(TOKEN, "act-eng-1", {
      startDate: "2026-06-01",
      endDate: "2026-06-08",
      reasonIdentifier: "vacation",
      comment: "Vacation",
    });
    expect(result.id).toBe("br-1");
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
    const result = await breaks.remove(TOKEN, "br-1");
    expect(result.id).toBe("br-1");
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
