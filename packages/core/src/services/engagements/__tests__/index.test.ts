// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// All engagements ops run against mobile-gateway via `stockTransport`.
vi.mock("../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport/index.js")>("../../../transport/index.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { ENGAGEMENT_STATUS_GROUPS, breaks, list, payments, show, stats } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport/index.js";
import type { TransportResponse } from "../../../transport/index.js";

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
    // #545 — counterparty identity. `contacts` carries a trailing null to
    // exercise the `[CompanyRepresentative]!`-nullable-item filter.
    contacts: [
      {
        __typename: "CompanyRepresentative",
        id: "rep-1",
        email: "jane@acme.com",
        fullName: "Jane Doe",
        phoneNumber: "+1-555-0100",
        position: "Hiring Manager",
        timeZone: {
          __typename: "TimeZone",
          location: "America/New_York",
          name: "Eastern Time (US & Canada)",
          value: "EST",
        },
      },
      null,
    ],
    pointsOfContact: {
      __typename: "PointsOfContact",
      current: {
        __typename: "Recruiter",
        id: "rec-1",
        fullName: "Alex Recruiter",
        contactFields: {
          __typename: "ContactFields",
          communitySlackId: "alex.slack",
          email: "alex@toptal.com",
          phoneNumber: "+1-555-0200",
          skype: "alex.skype",
        },
        photo: { __typename: "Photo", small: "https://cdn.example/alex-small.jpg" },
        vacation: { __typename: "Unknown", id: "vac-1", startDate: "2026-07-01", endDate: "2026-07-08" },
        timeZone: { __typename: "TimeZone", location: "Europe/London", name: "London", value: "GMT" },
      },
      handoff: {
        __typename: "Recruiter",
        id: "rec-2",
        fullName: "Sam Prior",
        contactFields: {
          __typename: "ContactFields",
          communitySlackId: null,
          email: "sam@toptal.com",
          phoneNumber: null,
          skype: null,
        },
        photo: null,
        vacation: null,
        timeZone: {
          __typename: "TimeZone",
          location: "America/Chicago",
          name: "Central Time (US & Canada)",
          value: "CST",
        },
      },
      kind: "standard",
    },
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
    const result = await list(TOKEN);
    // #375: list() now returns an EngagementListPage envelope.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("act-eng-1");
    expect(result.items[0]?.engagementId).toBe("eng-1");
    expect(result.items[0]?.startDate).toBe("2026-02-01");
    expect(result.items[0]?.expectedHours).toBe(40);
    expect(result.totalCount).toBe(1);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(20);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "JobActivityItems",
      // #375: default page/pageSize threaded to the wire.
      variables: { keywords: null, onlyStatusGroupFilter: ["ACTIVE_ENGAGEMENT"], page: 1, pageSize: 20 },
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

  it("returns an empty-items envelope when jobActivityList is null", async () => {
    reply({ body: { data: { viewer: { id: "v1", jobActivityList: null } } } });
    const result = await list(TOKEN);
    expect(result).toEqual({ items: [], totalCount: 0, page: 1, perPage: 20 });
  });

  it("threads explicit page/perPage verbatim to the wire and echoes them on the envelope (#375)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityList: { entities: [ENGAGEMENT_LIST_ENTITY], totalCount: 57 },
          },
        },
      },
    });
    const result = await list(TOKEN, { status: "all", page: 3, perPage: 15 });
    // INFERRED 1-indexed (no -1 subtraction), mirroring the eligibleJobs
    // sibling empirically verified in #138. Verbatim threading.
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      variables: {
        onlyStatusGroupFilter: ["ACTIVE_ENGAGEMENT", "CLOSED_ENGAGEMENT"],
        page: 3,
        pageSize: 15,
      },
    });
    expect(result.page).toBe(3);
    expect(result.perPage).toBe(15);
    expect(result.totalCount).toBe(57);
    expect(result.items).toHaveLength(1);
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

  it("projects counterparty identity: contacts + pointsOfContact (#545)", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: ENGAGEMENT_DETAIL_ITEM } } },
    });
    const item = await show(TOKEN, "act-eng-1");

    // contacts: trailing null filtered; __typename dropped; fields projected.
    expect(item.job.contacts).toHaveLength(1);
    expect(item.job.contacts[0]?.fullName).toBe("Jane Doe");
    expect(item.job.contacts[0]?.email).toBe("jane@acme.com");
    expect(item.job.contacts[0]?.position).toBe("Hiring Manager");
    expect(item.job.contacts[0]?.timeZone?.location).toBe("America/New_York");
    expect(item.job.contacts[0]?.timeZone?.name).toBe("Eastern Time (US & Canada)");
    expect(item.job.contacts[0]).not.toHaveProperty("__typename");

    // pointsOfContact.current — the Toptal-side recruiter.
    expect(item.job.pointsOfContact?.current?.fullName).toBe("Alex Recruiter");
    expect(item.job.pointsOfContact?.current?.contactFields?.email).toBe("alex@toptal.com");
    expect(item.job.pointsOfContact?.current?.contactFields?.communitySlackId).toBe("alex.slack");
    expect(item.job.pointsOfContact?.current?.photo?.small).toBe("https://cdn.example/alex-small.jpg");
    expect(item.job.pointsOfContact?.current?.vacation?.startDate).toBe("2026-07-01");
    expect(item.job.pointsOfContact?.current?.timeZone?.location).toBe("Europe/London");
    expect(item.job.pointsOfContact?.current?.timeZone?.name).toBe("London");

    // pointsOfContact.handoff (INFERRED Unknown on the wire) + kind.
    expect(item.job.pointsOfContact?.handoff?.fullName).toBe("Sam Prior");
    expect(item.job.pointsOfContact?.handoff?.contactFields?.phoneNumber).toBeNull();
    expect(item.job.pointsOfContact?.handoff?.photo).toBeNull();
    expect(item.job.pointsOfContact?.kind).toBe("standard");
  });

  it("projects empty contacts + null pointsOfContact when the wire elides them (#545)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityItem: {
              ...ENGAGEMENT_DETAIL_ITEM,
              job: { ...ENGAGEMENT_DETAIL_ITEM.job, contacts: [], pointsOfContact: null },
            },
          },
        },
      },
    });
    const item = await show(TOKEN, "act-eng-1");
    expect(item.job.contacts).toEqual([]);
    expect(item.job.pointsOfContact).toBeNull();
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

  it("pagination-safe: stats sends NO page/pageSize despite the shared query declaring them (#375)", async () => {
    for (let i = 0; i < ENGAGEMENT_STATUS_GROUPS.length; i++) {
      reply({
        body: { data: { viewer: { id: "v1", jobActivityList: { entities: [], totalCount: i + 5 } } } },
      });
    }
    const result = await stats(TOKEN);
    // totalCount is the full per-filter count, page-independent — the
    // aggregate is unaffected by the #375 pagination wiring.
    expect(result.total).toBe(ENGAGEMENT_STATUS_GROUPS.reduce((s, _, i) => s + (i + 5), 0));
    for (const call of mockedStock.mock.calls) {
      const body = call[0]?.body as { variables?: Record<string, unknown> };
      // stats intentionally passes neither — they are absent from the
      // variables object (server applies its default slice).
      expect(body.variables).not.toHaveProperty("page");
      expect(body.variables).not.toHaveProperty("pageSize");
    }
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

const PAYMENT_ENTITY = {
  id: "pay-1",
  amount: "1234.56",
  correctionAmount: "0.00",
  createdAt: "2026-03-01T00:00:00Z",
  downloadHtmlUrl: "https://www.toptal.com/pay/pay-1.html",
  downloadPdfUrl: "https://www.toptal.com/pay/pay-1.pdf",
  dueDate: "2026-03-15",
  kind: "regular",
  number: 42,
  paidAt: "2026-03-10T00:00:00Z",
  paymentGroupId: 7,
  paymentMethod: "PAYONEER",
  status: "PAID",
  billingCycle: {
    availability: "available",
    startDate: "2026-02-01",
    endDate: "2026-02-28",
    id: "bc-1",
    hours: "160.0",
    talentRate: "75.00",
  },
  memorandums: {
    nodes: [
      {
        amount: "10.00",
        balance: "5.00",
        downloadHtmlUrl: "https://www.toptal.com/memo/m1.html",
        effectiveDate: "2026-03-05",
        id: "memo-1",
      },
      null,
    ],
  },
};

function paymentsBody(
  nodes: unknown,
  totalCount: number,
  overrides: { job?: unknown; activityItem?: unknown; engagement?: unknown } = {},
): MockResponse {
  const engagement =
    "engagement" in overrides ? overrides.engagement : { id: "eng-1", payments: { nodes, totalCount } };
  const activityItem = "activityItem" in overrides ? overrides.activityItem : { id: "act-1", engagement };
  const job = "job" in overrides ? overrides.job : { id: "job-1", activityItem };
  return { body: { data: { viewer: { id: "v1", job } } } };
}

describe("engagements.payments.list (#388)", () => {
  it("projects the TalentPayment fragment, derives totalCount, and echoes pagination", async () => {
    reply(paymentsBody([PAYMENT_ENTITY], 3));
    const page = await payments.list(TOKEN, "job-1", { limit: 1 });

    expect(page.totalCount).toBe(3);
    expect(page.limit).toBe(1);
    expect(page.after).toBeNull();
    // Full page (items.length === limit) ⇒ last id is the forward cursor.
    expect(page.nextCursor).toBe("pay-1");
    expect(page.items).toHaveLength(1);

    const p = page.items[0];
    expect(p?.id).toBe("pay-1");
    expect(p?.number).toBe(42);
    expect(p?.amount).toBe("1234.56");
    expect(p?.paymentGroupId).toBe(7);
    expect(p?.kind).toBe("regular");
    expect(p?.paymentMethod).toBe("PAYONEER");
    expect(p?.downloadHtmlUrl).toBe("https://www.toptal.com/pay/pay-1.html");
    expect(p?.billingCycle?.hours).toBe("160.0");
    expect(p?.billingCycle?.availability).toBe("available");
    expect(p?.billingCycle?.talentRate).toBe("75.00");
    // null memorandum entry filtered; downloadHtmlUrl carried.
    expect(p?.memorandums).toHaveLength(1);
    expect(p?.memorandums[0]?.id).toBe("memo-1");
    expect(p?.memorandums[0]?.downloadHtmlUrl).toBe("https://www.toptal.com/memo/m1.html");
  });

  it("threads the JOB id and forward cursor into the wire variables verbatim", async () => {
    reply(paymentsBody([PAYMENT_ENTITY], 1));
    await payments.list(TOKEN, "job-9", { limit: 25, after: "pay-cursor" });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "GetEngagementPayments",
      variables: { jobId: "job-9", paginationLimit: 25, paginationCursor: "pay-cursor" },
    });
  });

  it("sends null limit/cursor when neither is supplied (server-default slice)", async () => {
    reply(paymentsBody([], 0));
    const page = await payments.list(TOKEN, "job-1");
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      variables: { jobId: "job-1", paginationLimit: null, paginationCursor: null },
    });
    expect(page).toEqual({ items: [], totalCount: 0, limit: null, after: null, nextCursor: null });
  });

  it("returns nextCursor null when the page is shorter than the requested limit (drained)", async () => {
    reply(paymentsBody([PAYMENT_ENTITY], 1));
    const page = await payments.list(TOKEN, "job-1", { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("falls back to items.length when the connection omits totalCount", async () => {
    reply(paymentsBody([PAYMENT_ENTITY], undefined as unknown as number));
    const page = await payments.list(TOKEN, "job-1");
    expect(page.totalCount).toBe(1);
  });

  it("returns nextCursor null when an uncapped page returns the full total (drained)", async () => {
    // No --limit: items.length === totalCount ⇒ the connection is fully
    // returned, so there is no next page to advertise.
    reply(paymentsBody([PAYMENT_ENTITY], 1));
    const page = await payments.list(TOKEN, "job-1");
    expect(page.limit).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("returns the last id as nextCursor when an uncapped page is server-truncated below total", async () => {
    // No --limit but the server returned fewer rows than totalCount ⇒ a
    // forward cursor (last id) lets the caller fetch the remainder.
    reply(paymentsBody([PAYMENT_ENTITY, { ...PAYMENT_ENTITY, id: "pay-2" }], 5));
    const page = await payments.list(TOKEN, "job-1");
    expect(page.limit).toBeNull();
    expect(page.nextCursor).toBe("pay-2");
  });

  it("returns an empty page when the payments connection is null", async () => {
    reply(paymentsBody(null, 0, { engagement: { id: "eng-1", payments: null } }));
    const page = await payments.list(TOKEN, "job-1");
    expect(page).toEqual({ items: [], totalCount: 0, limit: null, after: null, nextCursor: null });
  });

  it("throws NO_VIEWER when viewer is null", async () => {
    reply({ body: { data: { viewer: null } } });
    await expect(payments.list(TOKEN, "job-1")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NO_VIEWER",
    });
  });

  it("throws NOT_FOUND when the job id does not resolve (job null)", async () => {
    reply(paymentsBody(null, 0, { job: null }));
    await expect(payments.list(TOKEN, "missing")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NOT_FOUND",
    });
  });

  it.each(["Record not found", "Invalid ID", 'Node id "x" resolves to a TalentJob, not the expected type'])(
    'translates the gateway "%s" GraphQL error into NOT_FOUND',
    async (message) => {
      reply({ body: { errors: [{ message }] } });
      await expect(payments.list(TOKEN, "missing")).rejects.toMatchObject({
        name: "EngagementsError",
        code: "NOT_FOUND",
      });
    },
  );

  it("throws NO_ENGAGEMENT when the job has no activity item", async () => {
    reply(paymentsBody(null, 0, { activityItem: null }));
    await expect(payments.list(TOKEN, "job-1")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NO_ENGAGEMENT",
    });
  });

  it("throws NO_ENGAGEMENT when the activity item has no engagement", async () => {
    reply(paymentsBody(null, 0, { engagement: null }));
    await expect(payments.list(TOKEN, "job-1")).rejects.toMatchObject({
      name: "EngagementsError",
      code: "NO_ENGAGEMENT",
    });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(payments.list(TOKEN, "job-1")).rejects.toBeInstanceOf(AuthRevokedError);
  });
});
