// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `applications.list / show / stats` all run against mobile-gateway via
// `stockTransport` (no Cloudflare, no impersonation needed). Unit tests
// mock only `stockTransport`; the impersonated transport is left alone.
vi.mock("../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport.js")>("../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import {
  AVAILABILITY_REQUEST_KINDS,
  AVAILABILITY_REQUEST_STATUSES,
  INTERVIEW_GUIDE_SECTION_IDENTIFIERS,
  INTERVIEW_GUIDE_TIP_IDENTIFIERS,
  INTERVIEW_STATUSES,
  STATUS_GROUPS,
  ApplicationsError,
  apply,
  applyData,
  applyQuestions,
  availabilityRequests,
  confirm,
  interviews,
  list,
  rateInsight,
  reject,
  rejectReasons,
  show,
  similarAnswers,
  stats,
} from "../index.js";
import type { ApplyInput } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-abc-123";

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

const ITEM_FIXTURE = {
  __typename: "TalentJobActivityItem",
  id: "act-1",
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
  jobApplication: { __typename: "JobApplication", id: "app-1" },
  engagement: { __typename: "TalentEngagement", id: "eng-1" },
  availabilityRequest: null,
  interview: null,
};

beforeEach(() => {
  mockedStock.mockReset();
});

describe("applications.list", () => {
  it("returns a JobActivityListPage envelope on a successful response (#377)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            jobActivityList: { entities: [ITEM_FIXTURE], totalCount: 1 },
          },
        },
      },
    });
    const res = await list(TOKEN);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.id).toBe("act-1");
    expect(res.items[0]?.statusGroupV2.value).toBe("ACTIVE_ENGAGEMENT");
    expect(res.totalCount).toBe(1);
    expect(res.page).toBe(1);
    expect(res.perPage).toBe(20);
  });

  it("returns an empty page (items [], totalCount 0) when jobActivityList is null (#377)", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: null } } },
    });
    const res = await list(TOKEN);
    expect(res.items).toEqual([]);
    expect(res.totalCount).toBe(0);
    expect(res.page).toBe(1);
    expect(res.perPage).toBe(20);
  });

  it("passes keywords and statusGroups filters into the variables", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [], totalCount: 0 } } } },
    });
    await list(TOKEN, { keywords: ["python"], statusGroups: ["ARCHIVED"] });
    expect(mockedStock).toHaveBeenCalledTimes(1);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "JobActivityItems",
      variables: { keywords: ["python"], onlyStatusGroupFilter: ["ARCHIVED"], page: 1, pageSize: 20 },
    });
  });

  it("sends null filters when none supplied (matches captured operation behavior)", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [], totalCount: 0 } } } },
    });
    await list(TOKEN);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      variables: { keywords: null, onlyStatusGroupFilter: null, page: 1, pageSize: 20 },
    });
  });

  it("forwards explicit page / perPage into the wire variables (#377)", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [], totalCount: 0 } } } },
    });
    await list(TOKEN, { page: 3, perPage: 5 });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      variables: { keywords: null, onlyStatusGroupFilter: null, page: 3, pageSize: 5 },
    });
  });

  it("echoes the resolved page / perPage and server totalCount on the envelope (#377)", async () => {
    reply({
      body: {
        data: {
          viewer: { id: "v1", jobActivityList: { entities: [ITEM_FIXTURE], totalCount: 377 } },
        },
      },
    });
    const res = await list(TOKEN, { page: 2, perPage: 50 });
    expect(res.page).toBe(2);
    expect(res.perPage).toBe(50);
    expect(res.totalCount).toBe(377);
    expect(res.items).toHaveLength(1);
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError when GraphQL errors carry an UNAUTHORIZED extension code", async () => {
    reply({
      body: {
        errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHORIZED" } }],
      },
    });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ApplicationsError(GRAPHQL_ERROR) for other top-level errors", async () => {
    reply({ body: { errors: [{ message: "Boom" }] } });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "GRAPHQL_ERROR",
    });
  });

  it("throws ApplicationsError(NO_VIEWER) when viewer is null", async () => {
    reply({ body: { data: { viewer: null } } });
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NO_VIEWER",
    });
  });

  it("throws ApplicationsError(NETWORK_ERROR) when transport throws a non-typed error", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(list(TOKEN)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NETWORK_ERROR",
    });
  });

  // ----- Recruiter Fixed rate projection (#410) ---------------------
  //
  // `availabilityRequest.metadata.offeredHourlyRate` is lifted into a
  // row-level `fixedRate` projection field so callers can rate-triage
  // Interest Requests without crawling into the AR sub-shape. The
  // wire-shape interface narrows the public `availabilityRequest` to
  // its presence indicator `{ id }`; the Money payload moves to the
  // top-level `fixedRate`.

  it("projects fixedRate from availabilityRequest.metadata.offeredHourlyRate (#410)", async () => {
    const rowWithFixedRate = {
      ...ITEM_FIXTURE,
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        id: "ar-1",
        metadata: {
          __typename: "AvailabilityRequestFixedMetadata",
          offeredHourlyRate: { __typename: "Money", decimal: "77.00", verbose: "$77.00/hr" },
        },
      },
    };
    reply({
      body: {
        data: { viewer: { id: "v1", jobActivityList: { entities: [rowWithFixedRate], totalCount: 1 } } },
      },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.fixedRate).toEqual({ decimal: "77.00", verbose: "$77.00/hr" });
    // The public availabilityRequest carries the embed shape (#539):
    // id + talent-response fields (null pre-response) + recruiter (null
    // when wire-elided as in this fixture). The Money payload still
    // flattens to row-level `fixedRate` per the #410 contract.
    expect(res.items[0]?.availabilityRequest).toEqual({
      id: "ar-1",
      talentComment: null,
      requestedHourlyRate: null,
      rejectReason: null,
      recruiter: null,
    });
  });

  it("projects fixedRate=null when availabilityRequest is null (#410)", async () => {
    // ITEM_FIXTURE already carries `availabilityRequest: null` — the
    // typical row for engagement-only activity items.
    reply({
      body: {
        data: { viewer: { id: "v1", jobActivityList: { entities: [ITEM_FIXTURE], totalCount: 1 } } },
      },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.fixedRate).toBeNull();
    expect(res.items[0]?.availabilityRequest).toBeNull();
  });

  // Per the #530 schema split, `AvailabilityRequestMetadata` is a
  // polymorphic supertype and `offeredHourlyRate` is only selected on
  // the `AvailabilityRequestFixedMetadata` inline fragment. Non-Fixed
  // variants return `metadata.__typename` (used for kind discrimination
  // downstream) but no `offeredHourlyRate`, so `fixedRate` must project
  // to `null` for those rows.
  it.each([["AvailabilityRequestFlexibleMetadata"], ["MarketplaceAvailabilityRequestFlexibleMetadata"]])(
    "projects fixedRate=null when metadata is non-Fixed variant %s (#530)",
    async (typename) => {
      const rowWithFlexibleMetadata = {
        ...ITEM_FIXTURE,
        availabilityRequest: {
          __typename: "AvailabilityRequest",
          id: "ar-flex",
          metadata: { __typename: typename },
        },
      };
      reply({
        body: {
          data: {
            viewer: { id: "v1", jobActivityList: { entities: [rowWithFlexibleMetadata], totalCount: 1 } },
          },
        },
      });
      const res = await list(TOKEN);
      expect(res.items[0]?.fixedRate).toBeNull();
      // The AR embed still rides through — only the rate is null (#410)
      // and the #539 fields stay null when the wire elides them.
      expect(res.items[0]?.availabilityRequest).toEqual({
        id: "ar-flex",
        talentComment: null,
        requestedHourlyRate: null,
        rejectReason: null,
        recruiter: null,
      });
    },
  );

  // ----- AR embed projection (#539) ---------------------------------
  //
  // The `availabilityRequest { ... }` sub-selection on `JobActivityList`
  // now carries the talent-response triple (`talentComment`,
  // `requestedHourlyRate`, `rejectReason`) plus the `recruiter` contact
  // identity. The projection lifts those fields into the public
  // {@link AvailabilityRequestEmbed} shape, with defensive nullability
  // guards mirroring the {@link projectFixedRate} contract.

  it("projects the full AR embed (talentComment / requestedHourlyRate / rejectReason / recruiter) from the wire (#539)", async () => {
    const rowWithEmbed = {
      ...ITEM_FIXTURE,
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        id: "ar-resp",
        talentComment: "Sounds good — available next Monday.",
        requestedHourlyRate: { __typename: "Money", decimal: "85.00", verbose: "$85.00/hr" },
        rejectReason: null,
        recruiter: {
          __typename: "Recruiter",
          firstName: "Alex",
          lastName: "Recruiterson",
          fullName: "Alex Recruiterson",
        },
        metadata: {
          __typename: "AvailabilityRequestFixedMetadata",
          offeredHourlyRate: { __typename: "Money", decimal: "80.00", verbose: "$80.00/hr" },
        },
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [rowWithEmbed], totalCount: 1 } } } },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.availabilityRequest).toEqual({
      id: "ar-resp",
      talentComment: "Sounds good — available next Monday.",
      requestedHourlyRate: { decimal: "85.00", verbose: "$85.00/hr" },
      rejectReason: null,
      recruiter: { firstName: "Alex", lastName: "Recruiterson", fullName: "Alex Recruiterson" },
    });
    // fixedRate still flattens to the row level regardless (#410).
    expect(res.items[0]?.fixedRate).toEqual({ decimal: "80.00", verbose: "$80.00/hr" });
  });

  it("coerces requestedHourlyRate to null when the wire returns a partial Money (decimal-only) (#539)", async () => {
    const rowWithPartialRate = {
      ...ITEM_FIXTURE,
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        id: "ar-partial",
        talentComment: null,
        requestedHourlyRate: { __typename: "Money", decimal: "85.00" },
        rejectReason: null,
        recruiter: null,
        metadata: { __typename: "AvailabilityRequestFlexibleMetadata" },
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [rowWithPartialRate], totalCount: 1 } } } },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.availabilityRequest?.requestedHourlyRate).toBeNull();
  });

  it("projects a rejected-AR row (rejectReason populated, talentComment populated, requestedHourlyRate null) (#539)", async () => {
    const rowRejected = {
      ...ITEM_FIXTURE,
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        id: "ar-reject",
        talentComment: "Out of scope for me right now.",
        requestedHourlyRate: null,
        rejectReason: "scope_mismatch",
        recruiter: {
          __typename: "Recruiter",
          firstName: "Sam",
          lastName: null,
          fullName: "Sam",
        },
        metadata: { __typename: "AvailabilityRequestFixedMetadata" },
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [rowRejected], totalCount: 1 } } } },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.availabilityRequest).toEqual({
      id: "ar-reject",
      talentComment: "Out of scope for me right now.",
      requestedHourlyRate: null,
      rejectReason: "scope_mismatch",
      recruiter: { firstName: "Sam", lastName: null, fullName: "Sam" },
    });
  });

  it("coerces recruiter sub-fields to null when the wire returns a partial Recruiter (only fullName) (#539)", async () => {
    const rowPartialRecruiter = {
      ...ITEM_FIXTURE,
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        id: "ar-partial-recr",
        talentComment: null,
        requestedHourlyRate: null,
        rejectReason: null,
        recruiter: { __typename: "Recruiter", fullName: "Pat Recruiter" },
        metadata: { __typename: "AvailabilityRequestFlexibleMetadata" },
      },
    };
    reply({
      body: {
        data: { viewer: { id: "v1", jobActivityList: { entities: [rowPartialRecruiter], totalCount: 1 } } },
      },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.availabilityRequest?.recruiter).toEqual({
      firstName: null,
      lastName: null,
      fullName: "Pat Recruiter",
    });
  });

  // ----- mostRelevantApplication projection (#547) --------------------
  // `mostRelevantApplication { id }` is the platform's id-only pointer at
  // the AvailabilityRequest that matters most for the row. The projection
  // is presence-indicator-only (like jobApplication / interview), with a
  // defensive null coercion for the wire-elided / id-missing cases.

  it("projects mostRelevantApplication (id-only) from the wire (#547)", async () => {
    const rowWithMra = {
      ...ITEM_FIXTURE,
      mostRelevantApplication: { __typename: "AvailabilityRequest", id: "ar-relevant" },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [rowWithMra], totalCount: 1 } } } },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.mostRelevantApplication).toEqual({ id: "ar-relevant" });
  });

  it("projects mostRelevantApplication=null when the wire elides it (#547)", async () => {
    // ITEM_FIXTURE carries no mostRelevantApplication key — the projection
    // collapses the undefined to null.
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [ITEM_FIXTURE], totalCount: 1 } } } },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.mostRelevantApplication).toBeNull();
  });

  it("coerces mostRelevantApplication to null when the wire object lacks a string id (#547)", async () => {
    const rowBadMra = {
      ...ITEM_FIXTURE,
      mostRelevantApplication: { __typename: "AvailabilityRequest" },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityList: { entities: [rowBadMra], totalCount: 1 } } } },
    });
    const res = await list(TOKEN);
    expect(res.items[0]?.mostRelevantApplication).toBeNull();
  });
});

describe("applications.show", () => {
  const DETAIL_FIXTURE = {
    ...ITEM_FIXTURE,
    job: {
      ...ITEM_FIXTURE.job,
      descriptionMd: "Some description",
      expectedHours: 40,
      startDate: "2026-01-01",
      postedWhen: "1 month ago",
      commitment: { __typename: "JobCommitment", slug: "full_time" },
      workType: { __typename: "JobWorkType", slug: "remote" },
      specialization: { __typename: "TalentSpecialization", title: "Backend" },
      estimatedLength: { __typename: "JobEstimatedLength", enumValue: "LONG_TERM" },
      isCoaching: false,
      isToptalProject: false,
    },
    jobApplication: {
      __typename: "JobApplication",
      id: "app-1",
      requestedHourlyRate: { __typename: "Money", decimal: "100.00" },
    },
    engagement: {
      __typename: "TalentEngagement",
      id: "eng-1",
      startDate: "2026-02-01",
      endDate: null,
      commitment: { __typename: "JobCommitment", slug: "full_time" },
      expectedHours: 40,
    },
  };

  it("returns the detail item by id", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: DETAIL_FIXTURE } } },
    });
    const item = await show(TOKEN, "act-1");
    expect(item.id).toBe("act-1");
    expect(item.job.descriptionMd).toBe("Some description");
    expect(item.engagement?.startDate).toBe("2026-02-01");
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "JobActivityItem",
      variables: { id: "act-1" },
    });
  });

  it("throws ApplicationsError(NOT_FOUND) when jobActivityItem is null", async () => {
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: null } } },
    });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("projects fixedRate from availabilityRequest.metadata on show (#410)", async () => {
    const detailWithFixedRate = {
      ...DETAIL_FIXTURE,
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        id: "ar-9",
        metadata: {
          __typename: "AvailabilityRequestFixedMetadata",
          offeredHourlyRate: { __typename: "Money", decimal: "109.00", verbose: "$109.00/hr" },
        },
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: detailWithFixedRate } } },
    });
    const item = await show(TOKEN, "act-1");
    expect(item.fixedRate).toEqual({ decimal: "109.00", verbose: "$109.00/hr" });
    expect(item.availabilityRequest).toEqual({
      id: "ar-9",
      talentComment: null,
      requestedHourlyRate: null,
      rejectReason: null,
      recruiter: null,
    });
  });

  it("projects fixedRate=null on show when availabilityRequest is null (#410)", async () => {
    // DETAIL_FIXTURE inherits ITEM_FIXTURE's `availabilityRequest: null`.
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: DETAIL_FIXTURE } } },
    });
    const item = await show(TOKEN, "act-1");
    expect(item.fixedRate).toBeNull();
    expect(item.availabilityRequest).toBeNull();
  });

  it("projects fixedRate=null on show when metadata is non-Fixed variant (#530)", async () => {
    const detailWithFlexibleMetadata = {
      ...DETAIL_FIXTURE,
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        id: "ar-flex-detail",
        metadata: { __typename: "AvailabilityRequestFlexibleMetadata" },
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: detailWithFlexibleMetadata } } },
    });
    const item = await show(TOKEN, "act-1");
    expect(item.fixedRate).toBeNull();
    expect(item.availabilityRequest).toEqual({
      id: "ar-flex-detail",
      talentComment: null,
      requestedHourlyRate: null,
      rejectReason: null,
      recruiter: null,
    });
  });

  // ----- AR embed projection on show (#539) ---------------------------
  it("projects the full AR embed on show (talent-response triple + recruiter) (#539)", async () => {
    const detailWithEmbed = {
      ...DETAIL_FIXTURE,
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        id: "ar-show",
        talentComment: "Acceptance message.",
        requestedHourlyRate: { __typename: "Money", decimal: "120.00", verbose: "$120.00/hr" },
        rejectReason: null,
        recruiter: {
          __typename: "Recruiter",
          firstName: "Casey",
          lastName: "Recruiter",
          fullName: "Casey Recruiter",
        },
        metadata: {
          __typename: "AvailabilityRequestFixedMetadata",
          offeredHourlyRate: { __typename: "Money", decimal: "115.00", verbose: "$115.00/hr" },
        },
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: detailWithEmbed } } },
    });
    const item = await show(TOKEN, "act-1");
    expect(item.availabilityRequest).toEqual({
      id: "ar-show",
      talentComment: "Acceptance message.",
      requestedHourlyRate: { decimal: "120.00", verbose: "$120.00/hr" },
      rejectReason: null,
      recruiter: { firstName: "Casey", lastName: "Recruiter", fullName: "Casey Recruiter" },
    });
    expect(item.fixedRate).toEqual({ decimal: "115.00", verbose: "$115.00/hr" });
  });

  // ----- mostRelevantApplication projection on show (#547) ------------
  it("projects mostRelevantApplication (id-only) on show (#547)", async () => {
    const detailWithMra = {
      ...DETAIL_FIXTURE,
      mostRelevantApplication: { __typename: "AvailabilityRequest", id: "ar-show-relevant" },
    };
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: detailWithMra } } },
    });
    const item = await show(TOKEN, "act-1");
    expect(item.mostRelevantApplication).toEqual({ id: "ar-show-relevant" });
  });

  it("projects mostRelevantApplication=null on show when the wire elides it (#547)", async () => {
    // DETAIL_FIXTURE inherits ITEM_FIXTURE's absence of the key.
    reply({
      body: { data: { viewer: { id: "v1", jobActivityItem: DETAIL_FIXTURE } } },
    });
    const item = await show(TOKEN, "act-1");
    expect(item.mostRelevantApplication).toBeNull();
  });

  it('translates the gateway top-level "Record not found" GraphQL error into NOT_FOUND', async () => {
    // Empirical wire shape (verified live 2026-05-10): the gateway
    // short-circuits unknown ids with a top-level GraphQL error rather
    // than returning a `viewer.jobActivityItem: null` payload.
    reply({
      body: { errors: [{ message: "Record not found" }] },
    });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });
});

describe("applications.stats", () => {
  it("issues one call per status group and aggregates", async () => {
    // Five calls, each returning a different totalCount.
    for (let i = 0; i < STATUS_GROUPS.length; i++) {
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
    expect(mockedStock).toHaveBeenCalledTimes(STATUS_GROUPS.length);
    expect(result.groups).toHaveLength(STATUS_GROUPS.length);
    expect(result.total).toBe(1 + 2 + 3 + 4 + 5);
    // Each call's `onlyStatusGroupFilter` matches one of STATUS_GROUPS exactly.
    const filtersSent = mockedStock.mock.calls.map((c) => {
      const body = c[0]?.body as { variables?: { onlyStatusGroupFilter?: string[] } };
      return body.variables?.onlyStatusGroupFilter?.[0];
    });
    expect(new Set(filtersSent)).toEqual(new Set(STATUS_GROUPS));
    // #377: stats() shares the now-paginated JobActivityItems query;
    // every count call must pass page/pageSize as explicit null (the
    // grand-total `totalCount` is slice-independent).
    for (const c of mockedStock.mock.calls) {
      const body = c[0]?.body as { variables?: { page?: unknown; pageSize?: unknown } };
      expect(body.variables?.page).toBeNull();
      expect(body.variables?.pageSize).toBeNull();
    }
  });

  it("treats missing totalCount as 0", async () => {
    for (let i = 0; i < STATUS_GROUPS.length; i++) {
      reply({
        body: { data: { viewer: { id: "v1", jobActivityList: null } } },
      });
    }
    const result = await stats(TOKEN);
    expect(result.total).toBe(0);
    expect(result.groups.every((g) => g.count === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// IR write-side ops (#411).
//
// `confirm` and `reject` exercise the `callGatewayNoViewer` helper —
// the wire mutations root at `availabilityRequest.{confirm,reject}` and
// NOT at `viewer.*`. `rejectReasons` similarly roots at
// `platformConfiguration.availabilityRequestRejectReasonsV3`. The
// `requireViewer: true` check that gates the read-side ops is OFF for
// these three.
//
// `confirm` exercises one extra wire call when `kind`/`rate` are
// omitted: the `GetAvailabilityRequestKind` pre-fetch that resolves
// kind from the AR's metadata `__typename` (and the default rate from
// Fixed metadata's `offeredHourlyRate`). The fixtures below sequence
// the `reply()` mocks so the pre-fetch is responded to FIRST.
// ---------------------------------------------------------------------

const AR_ID = "ar-9";

function fixedKindFixture(rate = "80.00"): unknown {
  return {
    data: {
      viewer: {
        __typename: "TalentUser",
        id: "v1",
        availabilityRequest: {
          __typename: "AvailabilityRequest",
          id: AR_ID,
          metadata: {
            __typename: "AvailabilityRequestFixedMetadata",
            offeredHourlyRate: { __typename: "Money", decimal: rate, verbose: `$${rate}/hr` },
          },
        },
      },
    },
  };
}

function flexibleKindFixture(): unknown {
  return {
    data: {
      viewer: {
        __typename: "TalentUser",
        id: "v1",
        availabilityRequest: {
          __typename: "AvailabilityRequest",
          id: AR_ID,
          metadata: {
            __typename: "AvailabilityRequestFlexibleMetadata",
          },
        },
      },
    },
  };
}

function confirmSuccessFixture(rate = "80.00"): unknown {
  return {
    data: {
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        confirm: {
          __typename: "AvailabilityRequestRespondPayload",
          success: true,
          errors: null,
          availabilityRequest: {
            __typename: "AvailabilityRequest",
            id: AR_ID,
            answeredAt: "2026-05-20T00:00:00Z",
            statusV2: {
              __typename: "AvailabilityRequestStatus",
              value: "AVAILABILITY_REQUEST_CONFIRMED",
              verbose: "Confirmed",
            },
            talentComment: null,
            requestedHourlyRate: { __typename: "Money", decimal: rate, verbose: `$${rate}/hr` },
            rejectReason: null,
          },
        },
      },
    },
  };
}

function rejectSuccessFixture(reason = "rate_too_low"): unknown {
  return {
    data: {
      availabilityRequest: {
        __typename: "AvailabilityRequest",
        reject: {
          __typename: "AvailabilityRequestRespondPayload",
          success: true,
          errors: null,
          availabilityRequest: {
            __typename: "AvailabilityRequest",
            id: AR_ID,
            answeredAt: "2026-05-20T00:00:00Z",
            statusV2: {
              __typename: "AvailabilityRequestStatus",
              value: "AVAILABILITY_REQUEST_REJECTED",
              verbose: "Rejected",
            },
            talentComment: null,
            requestedHourlyRate: null,
            rejectReason: reason,
          },
        },
      },
    },
  };
}

describe("applications.confirm (#411)", () => {
  it("AVAILABILITY_REQUEST_KINDS exposes FIXED, FLEXIBLE, MARKETPLACE_FLEXIBLE in declaration order", () => {
    expect(AVAILABILITY_REQUEST_KINDS).toEqual(["FIXED", "FLEXIBLE", "MARKETPLACE_FLEXIBLE"]);
  });

  it("dryRun: short-circuits before any wire call and returns a preview envelope", async () => {
    const outcome = await confirm(TOKEN, AR_ID, { requestedHourlyRate: "80.00", kind: "FIXED" }, { dryRun: true });
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.operationName).toBe("ConfirmAvailabilityRequest");
    expect(outcome.preview.variables).toMatchObject({
      id: AR_ID,
      requestedHourlyRate: "80.00",
      kind: "FIXED",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("dryRun: substitutes placeholders when kind/rate are unresolved (zero pre-fetch calls)", async () => {
    const outcome = await confirm(TOKEN, AR_ID, {}, { dryRun: true });
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.preview.variables).toMatchObject({
      kind: "<resolved at apply time>",
      requestedHourlyRate: "<resolved at apply time>",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("auto-resolves Fixed-kind + default rate via GetAvailabilityRequestKind pre-fetch when both inputs omitted", async () => {
    reply({ body: fixedKindFixture("77.00") }, { body: confirmSuccessFixture("77.00") });
    const outcome = await confirm(TOKEN, AR_ID);
    expect(mockedStock).toHaveBeenCalledTimes(2);
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.result.id).toBe(AR_ID);
    expect(outcome.result.statusV2.value).toBe("AVAILABILITY_REQUEST_CONFIRMED");
    expect(outcome.result.requestedHourlyRate?.decimal).toBe("77.00");

    // Verify the pre-fetch operation name + the mutation kind/rate are
    // threaded through.
    const preFetchBody = mockedStock.mock.calls[0]?.[0]?.body as { operationName: string };
    const mutationBody = mockedStock.mock.calls[1]?.[0]?.body as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    expect(preFetchBody.operationName).toBe("GetAvailabilityRequestKind");
    expect(mutationBody.operationName).toBe("ConfirmAvailabilityRequest");
    expect(mutationBody.variables["kind"]).toBe("FIXED");
    expect(mutationBody.variables["requestedHourlyRate"]).toBe("77.00");
  });

  it("skips the pre-fetch when caller passes both kind and rate explicitly", async () => {
    reply({ body: confirmSuccessFixture("90.00") });
    const outcome = await confirm(TOKEN, AR_ID, { kind: "FIXED", requestedHourlyRate: "90.00" });
    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    const body = mockedStock.mock.calls[0]?.[0]?.body as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    expect(body.operationName).toBe("ConfirmAvailabilityRequest");
    expect(body.variables["requestedHourlyRate"]).toBe("90.00");
  });

  it("throws MUTATION_ERROR when AR is FLEXIBLE and rate is omitted (no default to pick)", async () => {
    reply({ body: flexibleKindFixture() });
    await expect(confirm(TOKEN, AR_ID)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "MUTATION_ERROR",
    });
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });

  it("auto-resolves kind=FLEXIBLE and uses caller-supplied rate (no pre-fetch rate default needed)", async () => {
    reply({ body: flexibleKindFixture() }, { body: confirmSuccessFixture("100.00") });
    const outcome = await confirm(TOKEN, AR_ID, { requestedHourlyRate: "100.00" });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    const body = mockedStock.mock.calls[1]?.[0]?.body as { variables: Record<string, unknown> };
    expect(body.variables["kind"]).toBe("FLEXIBLE");
  });

  it("throws NOT_FOUND when the pre-fetch surfaces 'Record not found' GraphQL error", async () => {
    reply({ body: { errors: [{ message: "Record not found" }] } });
    await expect(confirm(TOKEN, "missing-ar")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("throws NOT_FOUND when the pre-fetch viewer or AR is null", async () => {
    reply({
      body: {
        data: {
          viewer: { __typename: "TalentUser", id: "v1", availabilityRequest: null },
        },
      },
    });
    await expect(confirm(TOKEN, "missing-ar")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("throws WIRE_SHAPE_ERROR when the pre-fetch returns an unrecognized metadata typename", async () => {
    reply({
      body: {
        data: {
          viewer: {
            __typename: "TalentUser",
            id: "v1",
            availabilityRequest: {
              __typename: "AvailabilityRequest",
              id: AR_ID,
              metadata: { __typename: "FutureMetadataVariant" },
            },
          },
        },
      },
    });
    await expect(confirm(TOKEN, AR_ID)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "WIRE_SHAPE_ERROR",
    });
  });

  it("throws MUTATION_ERROR with formatted error details on success:false", async () => {
    reply({ body: confirmSuccessFixture() }); // not used; overridden below
    mockedStock.mockReset();
    reply({
      body: {
        data: {
          availabilityRequest: {
            __typename: "AvailabilityRequest",
            confirm: {
              __typename: "AvailabilityRequestRespondPayload",
              success: false,
              errors: [
                {
                  __typename: "MutationResultError",
                  code: "INVALID_KIND",
                  key: "kind",
                  message: "Unknown enum value",
                },
              ],
              availabilityRequest: null,
            },
          },
        },
      },
    });
    await expect(confirm(TOKEN, AR_ID, { kind: "FIXED", requestedHourlyRate: "80.00" })).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "MUTATION_ERROR",
    });
  });

  it("throws UNKNOWN when success:true but availabilityRequest echo is null (wire violation)", async () => {
    reply({
      body: {
        data: {
          availabilityRequest: {
            __typename: "AvailabilityRequest",
            confirm: {
              __typename: "AvailabilityRequestRespondPayload",
              success: true,
              errors: null,
              availabilityRequest: null,
            },
          },
        },
      },
    });
    await expect(confirm(TOKEN, AR_ID, { kind: "FIXED", requestedHourlyRate: "80.00" })).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "UNKNOWN",
    });
  });

  it("threads comment into the wire variables as `comment` (mapped to talentComment in the document)", async () => {
    reply({ body: confirmSuccessFixture() });
    await confirm(TOKEN, AR_ID, { kind: "FIXED", requestedHourlyRate: "80.00", comment: "Hello recruiter" });
    const body = mockedStock.mock.calls[0]?.[0]?.body as { variables: Record<string, unknown> };
    expect(body.variables["comment"]).toBe("Hello recruiter");
  });

  // #423 — #411 shipped the matcher / expertise / pitch forwarding in
  // confirm()'s variables map but without dedicated coverage. These two
  // tests pin the Stage-1 opaque pass-through contract (ADR-008 § Decision
  // Part 3): confirm() forwards the three payloads verbatim and `?? null`-
  // coalesces each when omitted, never introspecting the wire shape.
  it("forwards matcher/expertise/pitch payloads verbatim into the mutation variables (#423 / #438)", async () => {
    reply({ body: confirmSuccessFixture() });
    // #438: matcher answers carry `id` (NOT `questionId`) per the
    // recovered `JobPositionAnswerInput` shape; expertise answers
    // carry `questionId` per `JobExpertiseAnswerInput`.
    const matcherQuestionsAnswers = [
      { id: "MQ-1", answer: "matcher answer one" },
      { id: "MQ-2", answer: "matcher answer two" },
    ];
    const expertiseQuestionsAnswers = [{ questionId: "EQ-1", other: null, subjectId: null }];
    const pitchInput = {};
    await confirm(TOKEN, AR_ID, {
      kind: "FIXED",
      requestedHourlyRate: "80.00",
      matcherQuestionsAnswers,
      expertiseQuestionsAnswers,
      pitchInput,
    });
    const body = mockedStock.mock.calls[0]?.[0]?.body as { variables: Record<string, unknown> };
    expect(body.variables["matcherQuestionsAnswers"]).toEqual(matcherQuestionsAnswers);
    expect(body.variables["expertiseQuestionsAnswers"]).toEqual(expertiseQuestionsAnswers);
    expect(body.variables["pitchInput"]).toEqual(pitchInput);
  });

  it("sends null for matcher/expertise/pitch payloads when omitted (#411 regression, #423)", async () => {
    reply({ body: confirmSuccessFixture() });
    await confirm(TOKEN, AR_ID, { kind: "FIXED", requestedHourlyRate: "80.00" });
    const body = mockedStock.mock.calls[0]?.[0]?.body as { variables: Record<string, unknown> };
    expect(body.variables["matcherQuestionsAnswers"]).toBeNull();
    expect(body.variables["expertiseQuestionsAnswers"]).toBeNull();
    expect(body.variables["pitchInput"]).toBeNull();
  });
});

describe("applications.reject (#411)", () => {
  it("dryRun: short-circuits before any wire call and returns a preview envelope", async () => {
    const outcome = await reject(TOKEN, AR_ID, { reason: "rate_too_low" }, { dryRun: true });
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.preview.operationName).toBe("RejectAvailabilityRequest");
    expect(outcome.preview.variables).toMatchObject({
      id: AR_ID,
      reason: "rate_too_low",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("apply path: sends reason + (optional) comment to the mutation and projects the echo payload", async () => {
    reply({ body: rejectSuccessFixture("scope_mismatch") });
    const outcome = await reject(TOKEN, AR_ID, { reason: "scope_mismatch", comment: "not a fit" });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.result.rejectReason).toBe("scope_mismatch");
    expect(outcome.result.statusV2.value).toBe("AVAILABILITY_REQUEST_REJECTED");

    const body = mockedStock.mock.calls[0]?.[0]?.body as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    expect(body.operationName).toBe("RejectAvailabilityRequest");
    expect(body.variables).toMatchObject({ id: AR_ID, reason: "scope_mismatch", comment: "not a fit" });
  });

  it("sends comment=null when caller omits it", async () => {
    reply({ body: rejectSuccessFixture() });
    await reject(TOKEN, AR_ID, { reason: "rate_too_low" });
    const body = mockedStock.mock.calls[0]?.[0]?.body as { variables: Record<string, unknown> };
    expect(body.variables["comment"]).toBeNull();
  });

  it("throws MUTATION_ERROR with the formatted message on success:false", async () => {
    reply({
      body: {
        data: {
          availabilityRequest: {
            __typename: "AvailabilityRequest",
            reject: {
              __typename: "AvailabilityRequestRespondPayload",
              success: false,
              errors: [
                {
                  __typename: "MutationResultError",
                  code: "MANDATORY_COMMENT_MISSING",
                  key: "comment",
                  message: "comment required for this reason",
                },
              ],
              availabilityRequest: null,
            },
          },
        },
      },
    });
    await expect(reject(TOKEN, AR_ID, { reason: "other" })).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "MUTATION_ERROR",
    });
  });

  it("throws UNKNOWN when the wire response is null (defensive)", async () => {
    reply({ body: { data: { availabilityRequest: null } } });
    await expect(reject(TOKEN, AR_ID, { reason: "rate_too_low" })).rejects.toBeInstanceOf(ApplicationsError);
  });
});

describe("applications.rejectReasons (#411)", () => {
  it("returns the fixed + flexible inventory verbatim", async () => {
    reply({
      body: {
        data: {
          platformConfiguration: {
            __typename: "PlatformConfiguration",
            id: "pc-1",
            availabilityRequestRejectReasonsV3: {
              __typename: "AvailabilityRequestRejectReasonsV3",
              fixed: [
                {
                  __typename: "AvailabilityRequestRejectReason",
                  key: "rate_too_low",
                  value: "Rate too low",
                  customPlaceholder: null,
                  isMandatory: false,
                },
              ],
              flexible: [
                {
                  __typename: "AvailabilityRequestRejectReason",
                  key: "other",
                  value: "Other",
                  customPlaceholder: "Please describe",
                  isMandatory: true,
                },
              ],
            },
          },
        },
      },
    });
    const reasons = await rejectReasons(TOKEN);
    expect(reasons.fixed).toHaveLength(1);
    expect(reasons.flexible).toHaveLength(1);
    expect(reasons.fixed[0]?.key).toBe("rate_too_low");
    expect(reasons.fixed[0]?.isMandatory).toBe(false);
    expect(reasons.flexible[0]?.key).toBe("other");
    expect(reasons.flexible[0]?.isMandatory).toBe(true);
    expect(reasons.flexible[0]?.customPlaceholder).toBe("Please describe");
  });

  it("treats missing fixed/flexible arrays as empty (defensive)", async () => {
    reply({
      body: {
        data: {
          platformConfiguration: {
            __typename: "PlatformConfiguration",
            id: "pc-1",
            availabilityRequestRejectReasonsV3: {
              __typename: "AvailabilityRequestRejectReasonsV3",
              fixed: null,
              flexible: null,
            },
          },
        },
      },
    });
    const reasons = await rejectReasons(TOKEN);
    expect(reasons.fixed).toEqual([]);
    expect(reasons.flexible).toEqual([]);
  });

  it("throws WIRE_SHAPE_ERROR when platformConfiguration is null", async () => {
    reply({ body: { data: { platformConfiguration: null } } });
    await expect(rejectReasons(TOKEN)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "WIRE_SHAPE_ERROR",
    });
  });

  it("throws WIRE_SHAPE_ERROR when availabilityRequestRejectReasonsV3 is null", async () => {
    reply({
      body: {
        data: {
          platformConfiguration: {
            __typename: "PlatformConfiguration",
            id: "pc-1",
            availabilityRequestRejectReasonsV3: null,
          },
        },
      },
    });
    await expect(rejectReasons(TOKEN)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "WIRE_SHAPE_ERROR",
    });
  });

  it("operationName is AvailabilityRequestRejectReasons", async () => {
    reply({
      body: {
        data: {
          platformConfiguration: {
            __typename: "PlatformConfiguration",
            id: "pc-1",
            availabilityRequestRejectReasonsV3: {
              __typename: "AvailabilityRequestRejectReasonsV3",
              fixed: [],
              flexible: [],
            },
          },
        },
      },
    });
    await rejectReasons(TOKEN);
    const body = mockedStock.mock.calls[0]?.[0]?.body as { operationName: string };
    expect(body.operationName).toBe("AvailabilityRequestRejectReasons");
  });
});

// ---------------------------------------------------------------------
// Pre-apply read suite (#424). All three fns exercise the
// `callGateway` wrapper (mobile-gateway, requireViewer:true) and the
// shared widened `NOT_FOUND_MESSAGE_PATTERN`. Fixtures below mock the
// captured wire shape (selection set trimmed to what each public
// projection surfaces).
// ---------------------------------------------------------------------

const JOB_ID = "job-456";

function applyDataFixture(
  opts: {
    applyErrors?: { code: string; message: string }[] | null;
    hourlyRate?: string | null;
    rateValidation?: { minRate: string; rateStep: number } | null;
    isCoaching?: boolean | null;
    hasRequiredApplicationPitch?: boolean | null;
  } = {},
): unknown {
  return {
    data: {
      viewer: {
        __typename: "Viewer",
        id: "v1",
        viewerRole:
          opts.hourlyRate === null
            ? null
            : {
                __typename: "ViewerRole",
                rates: { __typename: "TalentRate", hourly: opts.hourlyRate ?? "85.00" },
              },
        job: {
          __typename: "TalentJob",
          id: JOB_ID,
          isCoaching: opts.isCoaching ?? false,
          hasRequiredApplicationPitch: opts.hasRequiredApplicationPitch ?? false,
          operations: {
            __typename: "JobOperations",
            apply: {
              __typename: "JobOperationsApply",
              errors: (opts.applyErrors ?? []).map((e) => ({
                __typename: "JobOperationsApplyError",
                ...e,
              })),
            },
          },
        },
      },
      platformConfiguration:
        opts.rateValidation === null
          ? null
          : {
              __typename: "PlatformConfiguration",
              id: "pc-1",
              rateValidationRules: {
                __typename: "TalentRateValidationRules",
                hourly: {
                  __typename: "TalentRateValidationRule",
                  minRate: opts.rateValidation?.minRate ?? "5.00",
                  rateStep: opts.rateValidation?.rateStep ?? 1,
                },
              },
            },
    },
  };
}

describe("applications.applyData (#424)", () => {
  it("returns the projected PreApplyData on a successful response", async () => {
    reply({
      body: applyDataFixture({
        hourlyRate: "100.00",
        isCoaching: true,
        hasRequiredApplicationPitch: true,
      }),
    });
    const out = await applyData(TOKEN, JOB_ID);
    expect(out.job).toEqual({ id: JOB_ID, isCoaching: true, hasRequiredApplicationPitch: true });
    expect(out.suggestedRate).toBe("100.00");
    expect(out.rateValidation).toEqual({ minRate: "5.00", rateStep: 1 });
    expect(out.applyErrors).toEqual([]);
    expect(out.canApply).toBe(true);
  });

  it("returns canApply:false and the populated applyErrors when wire reports apply errors", async () => {
    reply({
      body: applyDataFixture({
        applyErrors: [
          { code: "ALREADY_APPLIED", message: "You already applied to this job." },
          { code: "JOB_CLOSED", message: "This job is no longer accepting applications." },
        ],
      }),
    });
    const out = await applyData(TOKEN, JOB_ID);
    expect(out.canApply).toBe(false);
    expect(out.applyErrors).toEqual([
      { code: "ALREADY_APPLIED", message: "You already applied to this job." },
      { code: "JOB_CLOSED", message: "This job is no longer accepting applications." },
    ]);
  });

  it("filters out null entries from operations.apply.errors (defensive — list-of-nullable per schema)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            __typename: "Viewer",
            id: "v1",
            viewerRole: { __typename: "ViewerRole", rates: { __typename: "TalentRate", hourly: "80.00" } },
            job: {
              __typename: "TalentJob",
              id: JOB_ID,
              isCoaching: false,
              hasRequiredApplicationPitch: false,
              operations: {
                __typename: "JobOperations",
                apply: {
                  __typename: "JobOperationsApply",
                  errors: [null, { __typename: "JobOperationsApplyError", code: "X", message: "msg" }, null],
                },
              },
            },
          },
          platformConfiguration: null,
        },
      },
    });
    const out = await applyData(TOKEN, JOB_ID);
    expect(out.applyErrors).toEqual([{ code: "X", message: "msg" }]);
    expect(out.canApply).toBe(false);
  });

  it("returns suggestedRate:null when viewerRole is null", async () => {
    reply({ body: applyDataFixture({ hourlyRate: null }) });
    const out = await applyData(TOKEN, JOB_ID);
    expect(out.suggestedRate).toBeNull();
  });

  it("returns rateValidation:null when platformConfiguration is null", async () => {
    reply({ body: applyDataFixture({ rateValidation: null }) });
    const out = await applyData(TOKEN, JOB_ID);
    expect(out.rateValidation).toBeNull();
  });

  it("threads jobId + operationName into the wire variables", async () => {
    reply({ body: applyDataFixture() });
    await applyData(TOKEN, JOB_ID);
    const body = mockedStock.mock.calls[0]?.[0]?.body as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    expect(body.operationName).toBe("JobApplyData");
    expect(body.variables).toEqual({ jobId: JOB_ID });
  });

  it("maps top-level 'Record not found' GraphQL error to NOT_FOUND (legacy pattern preserved)", async () => {
    reply({ body: { errors: [{ message: "Record not found" }] } });
    await expect(applyData(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps top-level 'Invalid ID' GraphQL error to NOT_FOUND (#424 widened pattern, jobs-service precedent)", async () => {
    reply({ body: { errors: [{ message: 'Invalid ID "abc"' }] } });
    await expect(applyData(TOKEN, "abc")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps top-level Relay decode error 'Node id ... resolves to ...' to NOT_FOUND (#424 widened pattern)", async () => {
    reply({
      body: {
        errors: [{ message: "Node id 'bogus' resolves to an unknown type Job. Please check ..." }],
      },
    });
    await expect(applyData(TOKEN, "bogus")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps successful response with viewer.job === null to NOT_FOUND (defensive)", async () => {
    reply({
      body: {
        data: {
          viewer: { __typename: "Viewer", id: "v1", viewerRole: null, job: null },
          platformConfiguration: null,
        },
      },
    });
    await expect(applyData(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(applyData(TOKEN, JOB_ID)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("propagates non-NOT_FOUND GraphQL errors verbatim (not auth-revoked, not Record-not-found)", async () => {
    reply({ body: { errors: [{ message: "Some other server error" }] } });
    await expect(applyData(TOKEN, JOB_ID)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "GRAPHQL_ERROR",
    });
  });
});

function questionsFixture(
  opts: {
    matcher?: { id: string; question: string; isRequired: boolean | null }[];
    expertise?: {
      id: string;
      subject: { __typename: "Industry" | "Skill" | string; id?: string; name?: string } | null;
    }[];
  } = {},
): unknown {
  return {
    data: {
      viewer: {
        __typename: "Viewer",
        id: "v1",
        job: {
          __typename: "TalentJob",
          id: JOB_ID,
          questions: (opts.matcher ?? []).map((q) => ({ __typename: "JobPositionQuestion", ...q })),
          expertiseQuestions: (opts.expertise ?? []).map((q) => ({
            __typename: "JobExpertiseQuestion",
            ...q,
          })),
        },
      },
    },
  };
}

describe("applications.applyQuestions (#424)", () => {
  it("projects matcher + expertise questions in the four-field shape", async () => {
    reply({
      body: questionsFixture({
        matcher: [
          { id: "m1", question: "How many years of experience?", isRequired: true },
          { id: "m2", question: "Are you a citizen?", isRequired: false },
        ],
        expertise: [
          { id: "e1", subject: { __typename: "Industry", id: "ind-1", name: "FinTech" } },
          { id: "e2", subject: { __typename: "Skill", id: "sk-1", name: "TypeScript" } },
        ],
      }),
    });
    const out = await applyQuestions(TOKEN, JOB_ID);
    expect(out.matcherQuestions).toEqual([
      { identifier: "m1", prompt: "How many years of experience?", type: "matcher", isMandatory: true },
      { identifier: "m2", prompt: "Are you a citizen?", type: "matcher", isMandatory: false },
    ]);
    expect(out.expertiseQuestions).toEqual([
      { identifier: "e1", prompt: "FinTech", type: "expertise", isMandatory: true },
      { identifier: "e2", prompt: "TypeScript", type: "expertise", isMandatory: true },
    ]);
  });

  it("returns empty arrays when the job has no matcher or expertise questions (REQ-Q1 empty-path)", async () => {
    reply({ body: questionsFixture({ matcher: [], expertise: [] }) });
    const out = await applyQuestions(TOKEN, JOB_ID);
    expect(out.matcherQuestions).toEqual([]);
    expect(out.expertiseQuestions).toEqual([]);
  });

  it("treats null `questions` / `expertiseQuestions` lists as empty (defensive)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            __typename: "Viewer",
            id: "v1",
            job: {
              __typename: "TalentJob",
              id: JOB_ID,
              questions: null,
              expertiseQuestions: null,
            },
          },
        },
      },
    });
    const out = await applyQuestions(TOKEN, JOB_ID);
    expect(out.matcherQuestions).toEqual([]);
    expect(out.expertiseQuestions).toEqual([]);
  });

  it("projects matcher isRequired:null as isMandatory:false (defensive default)", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m1", question: "Q?", isRequired: null }],
      }),
    });
    const out = await applyQuestions(TOKEN, JOB_ID);
    expect(out.matcherQuestions[0]?.isMandatory).toBe(false);
  });

  it("filters out null wire entries from both arrays (defensive)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            __typename: "Viewer",
            id: "v1",
            job: {
              __typename: "TalentJob",
              id: JOB_ID,
              questions: [null, { __typename: "JobPositionQuestion", id: "m1", question: "Q", isRequired: true }],
              expertiseQuestions: [
                {
                  __typename: "JobExpertiseQuestion",
                  id: "e1",
                  subject: { __typename: "Skill", id: "s1", name: "Go" },
                },
                null,
              ],
            },
          },
        },
      },
    });
    const out = await applyQuestions(TOKEN, JOB_ID);
    expect(out.matcherQuestions).toHaveLength(1);
    expect(out.expertiseQuestions).toHaveLength(1);
  });

  it("projects expertise prompt as empty string when subject is null (defensive)", async () => {
    reply({
      body: questionsFixture({
        expertise: [{ id: "e1", subject: null }],
      }),
    });
    const out = await applyQuestions(TOKEN, JOB_ID);
    expect(out.expertiseQuestions[0]?.prompt).toBe("");
    // Expertise isMandatory stays `true` even when subject is null —
    // the projection's mandatory-ness inference is driven by apply-
    // flow semantics, not subject content (see ApplicationQuestion
    // JSDoc).
    expect(out.expertiseQuestions[0]?.isMandatory).toBe(true);
  });

  it("threads jobId + operationName into the wire variables", async () => {
    reply({ body: questionsFixture() });
    await applyQuestions(TOKEN, JOB_ID);
    const body = mockedStock.mock.calls[0]?.[0]?.body as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    expect(body.operationName).toBe("JobApplicationQuestions");
    expect(body.variables).toEqual({ jobId: JOB_ID });
  });

  it("maps top-level 'Record not found' GraphQL error to NOT_FOUND (shared NOT_FOUND_MESSAGE_PATTERN coverage symmetry)", async () => {
    reply({ body: { errors: [{ message: "Record not found" }] } });
    await expect(applyQuestions(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps top-level 'Invalid ID' GraphQL error to NOT_FOUND (shared NOT_FOUND_MESSAGE_PATTERN coverage symmetry)", async () => {
    reply({ body: { errors: [{ message: 'Invalid ID "abc"' }] } });
    await expect(applyQuestions(TOKEN, "abc")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps top-level Relay decode error to NOT_FOUND (#424 widened pattern)", async () => {
    reply({
      body: {
        errors: [{ message: "Node id 'bogus' resolves to an unknown type Job. Please check ..." }],
      },
    });
    await expect(applyQuestions(TOKEN, "bogus")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps viewer.job === null to NOT_FOUND (defensive)", async () => {
    reply({
      body: { data: { viewer: { __typename: "Viewer", id: "v1", job: null } } },
    });
    await expect(applyQuestions(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(applyQuestions(TOKEN, JOB_ID)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

function rateInsightCompetitiveFixture(): unknown {
  return {
    data: {
      viewer: {
        __typename: "Viewer",
        id: "v1",
        job: {
          __typename: "TalentJob",
          id: JOB_ID,
          hourlyRateInsights: {
            __typename: "TalentJobRateInsightCompetitive",
            estimatedRevenue: "12500.00",
            estimatedRevenueExplanation: "Estimated revenue per month at the proposed rate.",
            longTermDisclaimer: "Long-term engagements assume sustained availability.",
          },
        },
      },
    },
  };
}

function rateInsightUncompetitiveFixture(): unknown {
  return {
    data: {
      viewer: {
        __typename: "Viewer",
        id: "v1",
        job: {
          __typename: "TalentJob",
          id: JOB_ID,
          hourlyRateInsights: {
            __typename: "TalentJobRateInsightUncompetitive",
            estimatedRevenue: "8800.00",
            estimatedRevenueExplanation: "Below the recent-applicant median.",
            recentApplicationRate: "95.00",
            recommendedRate: "100.00",
          },
        },
      },
    },
  };
}

describe("applications.rateInsight (#424)", () => {
  it("returns the competitive variant with the right kind + fields", async () => {
    reply({ body: rateInsightCompetitiveFixture() });
    const out = await rateInsight(TOKEN, JOB_ID);
    expect(out).toEqual({
      kind: "competitive",
      estimatedRevenue: "12500.00",
      estimatedRevenueExplanation: "Estimated revenue per month at the proposed rate.",
      longTermDisclaimer: "Long-term engagements assume sustained availability.",
    });
  });

  it("returns the uncompetitive variant with the right kind + range-guidance fields", async () => {
    reply({ body: rateInsightUncompetitiveFixture() });
    const out = await rateInsight(TOKEN, JOB_ID);
    expect(out).toEqual({
      kind: "uncompetitive",
      estimatedRevenue: "8800.00",
      estimatedRevenueExplanation: "Below the recent-applicant median.",
      recentApplicationRate: "95.00",
      recommendedRate: "100.00",
    });
  });

  it("returns null when the gateway omits the rateInsight payload (hourlyRateInsights:null)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            __typename: "Viewer",
            id: "v1",
            job: { __typename: "TalentJob", id: JOB_ID, hourlyRateInsights: null },
          },
        },
      },
    });
    const out = await rateInsight(TOKEN, JOB_ID);
    expect(out).toBeNull();
  });

  it("threads $requestedRate:null + jobId + operationName into the wire variables", async () => {
    reply({ body: rateInsightCompetitiveFixture() });
    await rateInsight(TOKEN, JOB_ID);
    const body = mockedStock.mock.calls[0]?.[0]?.body as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    expect(body.operationName).toBe("JobApplicationRateInsight");
    expect(body.variables).toEqual({ jobId: JOB_ID, requestedRate: null });
  });

  it("maps top-level 'Record not found' GraphQL error to NOT_FOUND (shared NOT_FOUND_MESSAGE_PATTERN coverage symmetry)", async () => {
    reply({ body: { errors: [{ message: "Record not found" }] } });
    await expect(rateInsight(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps top-level 'Invalid ID' GraphQL error to NOT_FOUND (shared NOT_FOUND_MESSAGE_PATTERN coverage symmetry)", async () => {
    reply({ body: { errors: [{ message: 'Invalid ID "abc"' }] } });
    await expect(rateInsight(TOKEN, "abc")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps top-level Relay decode error to NOT_FOUND (#424 widened pattern)", async () => {
    reply({
      body: {
        errors: [{ message: "Node id 'bogus' resolves to an unknown type Job. Please check ..." }],
      },
    });
    await expect(rateInsight(TOKEN, "bogus")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("maps viewer.job === null to NOT_FOUND (defensive)", async () => {
    reply({
      body: { data: { viewer: { __typename: "Viewer", id: "v1", job: null } } },
    });
    await expect(rateInsight(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(rateInsight(TOKEN, JOB_ID)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws WIRE_SHAPE_ERROR with the offending typename echoed when the wire returns an unknown rate-insight variant (defends against future union extension on a GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS surface)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            __typename: "Viewer",
            id: "v1",
            job: {
              __typename: "TalentJob",
              id: JOB_ID,
              hourlyRateInsights: {
                __typename: "TalentJobRateInsightUnknownVariantV2",
                estimatedRevenue: "5000.00",
              },
            },
          },
        },
      },
    });
    await expect(rateInsight(TOKEN, JOB_ID)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "WIRE_SHAPE_ERROR",
      message: expect.stringContaining("TalentJobRateInsightUnknownVariantV2"),
    });
  });
});

// ---------------------------------------------------------------------
// Direct-apply core fn (#426). `apply` orchestrates a 3-call pre-fetch
// (`applyData` + `applyQuestions` + `rateInsight`) via Promise.all,
// validates answer ids against the question inventory, defaults the
// rate from PreApplyData.suggestedRate, then issues the JobApply
// mutation. The mocks below sequence `reply()` calls in pre-fetch
// order: applyData → applyQuestions → rateInsight → JobApply (4 wire
// calls total in the happy path).
// ---------------------------------------------------------------------

function jobApplySuccessFixture(
  opts: { applicationId?: string; activityItemId?: string; rate?: string } = {},
): unknown {
  return {
    data: {
      job: {
        __typename: "TalentJob",
        apply: {
          __typename: "JobApplyPayload",
          success: true,
          errors: null,
          job: {
            __typename: "TalentJob",
            id: JOB_ID,
            activityItem: {
              __typename: "TalentJobActivityItem",
              id: opts.activityItemId ?? "act-99",
              statusV2: {
                __typename: "JobActivityItemStatus",
                value: "ON_RECRUITER_REVIEW",
                verbose: "On recruiter review",
              },
              jobApplication: {
                __typename: "JobApplication",
                id: opts.applicationId ?? "app-77",
                requestedHourlyRate: { __typename: "Money", decimal: opts.rate ?? "85.00" },
              },
            },
          },
        },
      },
    },
  };
}

function jobApplyAlreadyAppliedFixture(): unknown {
  return {
    data: {
      job: {
        __typename: "TalentJob",
        apply: {
          __typename: "JobApplyPayload",
          success: false,
          errors: [
            {
              __typename: "MutationResultError",
              code: "VALIDATION_ERROR",
              key: "already_applied",
              message: "You already applied to this job.",
            },
          ],
          job: null,
        },
      },
    },
  };
}

// Reply sequence for the 3-call pre-fetch. Mocks are popped in the
// order Promise.all() initializes the awaits: applyData first, then
// applyQuestions, then rateInsight.
function replyPreApplySuccess(
  opts: { suggestedRate?: string | null; matcherIds?: string[]; expertiseIds?: string[] } = {},
): void {
  reply({
    body: applyDataFixture({
      hourlyRate: opts.suggestedRate === undefined ? "85.00" : opts.suggestedRate,
    }),
  });
  reply({
    body: questionsFixture({
      matcher: (opts.matcherIds ?? []).map((id) => ({ id, question: `Matcher ${id}?`, isRequired: true })),
      expertise: (opts.expertiseIds ?? []).map((id) => ({
        id,
        subject: { __typename: "Skill", id: `subj-${id}`, name: `Subject ${id}` },
      })),
    }),
  });
  reply({ body: rateInsightCompetitiveFixture() });
}

describe("applications.apply (#426)", () => {
  it("happy path: pre-fetches, validates ids, threads rate default, projects the JobApplicationRecord", async () => {
    replyPreApplySuccess({
      suggestedRate: "95.00",
      matcherIds: ["m1", "m2"],
      expertiseIds: ["e1"],
    });
    reply({ body: jobApplySuccessFixture({ rate: "95.00" }) });

    const outcome = await apply(TOKEN, JOB_ID, {
      consentIssued: true,
      // #438: matcher answers carry the question identifier at `id`
      // (NOT `questionId`) per the recovered `JobPositionAnswerInput`
      // shape; expertise answers carry it at `questionId` per the
      // recovered `JobExpertiseAnswerInput` shape (asymmetric).
      matcherAnswers: [
        { id: "m1", answer: "5 years" },
        { id: "m2", answer: "yes" },
      ],
      expertiseAnswers: [{ questionId: "e1", other: null, subjectId: null }],
      message: "I'm a great fit for this job.",
      // The service forwards `pitchData` to the wire opaquely (validateAnswerIds
      // covers structural validation of answers only). The Zod-strictness gate
      // lives at the CLI / MCP boundary (#438) — core accepts any
      // `PitchInput`-shaped object; the empty-but-valid shape is enough for the
      // happy-path round trip here.
      pitchData: {},
    });

    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.result.id).toBe("app-77");
    expect(outcome.result.jobActivityItemId).toBe("act-99");
    expect(outcome.result.requestedHourlyRate?.decimal).toBe("95.00");
    expect(outcome.result.statusV2.value).toBe("ON_RECRUITER_REVIEW");

    // 4 calls in total: 3 pre-fetch + 1 mutation.
    expect(mockedStock).toHaveBeenCalledTimes(4);
    const mutationBody = mockedStock.mock.calls[3]?.[0]?.body as {
      operationName: string;
      variables: Record<string, unknown>;
    };
    expect(mutationBody.operationName).toBe("JobApply");
    expect(mutationBody.variables).toMatchObject({
      id: JOB_ID,
      consentIssued: true,
      requestedHourlyRate: "95.00",
      comment: "I'm a great fit for this job.",
      talentCard: {},
    });
    expect(mutationBody.variables["matcherQuestionsAnswers"]).toEqual([
      { id: "m1", answer: "5 years" },
      { id: "m2", answer: "yes" },
    ]);
    expect(mutationBody.variables["expertiseQuestionsAnswers"]).toEqual([
      { questionId: "e1", other: null, subjectId: null },
    ]);
  });

  it("uses caller-supplied requestedHourlyRate when provided (overrides PreApplyData.suggestedRate)", async () => {
    replyPreApplySuccess({ suggestedRate: "85.00" });
    reply({ body: jobApplySuccessFixture({ rate: "120.00" }) });

    await apply(TOKEN, JOB_ID, { consentIssued: true, requestedHourlyRate: "120.00" });
    const mutationBody = mockedStock.mock.calls[3]?.[0]?.body as { variables: Record<string, unknown> };
    expect(mutationBody.variables["requestedHourlyRate"]).toBe("120.00");
  });

  it("CONSENT_REQUIRED: refuses BEFORE any wire call when consentIssued is omitted (runtime gate covers as-cast bypass)", async () => {
    // Cast simulates an unsafe caller (CLI/MCP layer with JSON input).
    await expect(apply(TOKEN, JOB_ID, {} as ApplyInput)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "CONSENT_REQUIRED",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("CONSENT_REQUIRED: refuses when consentIssued is the literal `false` (as-cast bypass)", async () => {
    await expect(apply(TOKEN, JOB_ID, { consentIssued: false as unknown as true })).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "CONSENT_REQUIRED",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it('ALREADY_APPLIED: maps wire `errors[].key === "already_applied"` to the typed code with show-hint message', async () => {
    replyPreApplySuccess();
    reply({ body: jobApplyAlreadyAppliedFixture() });

    await expect(apply(TOKEN, JOB_ID, { consentIssued: true })).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "ALREADY_APPLIED",
      message: expect.stringContaining("ttctl applications show"),
    });
    expect(mockedStock).toHaveBeenCalledTimes(4);
  });

  it("dryRun: short-circuits BEFORE any wire call (no pre-fetch either) and returns a preview envelope", async () => {
    const outcome = await apply(
      TOKEN,
      JOB_ID,
      {
        consentIssued: true,
        requestedHourlyRate: "100.00",
        message: "Hi",
        matcherAnswers: [{ id: "m1", answer: "5y" }],
      },
      { dryRun: true },
    );

    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.operationName).toBe("JobApply");
    expect(outcome.preview.variables).toMatchObject({
      id: JOB_ID,
      consentIssued: true,
      requestedHourlyRate: "100.00",
      comment: "Hi",
      matcherQuestionsAnswers: [{ id: "m1", answer: "5y" }],
    });
    // Critical: zero wire calls under dry-run, including no pre-fetch.
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("dryRun: substitutes <resolved at apply time> placeholder when rate is unresolved", async () => {
    const outcome = await apply(TOKEN, JOB_ID, { consentIssued: true }, { dryRun: true });
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.preview.variables).toMatchObject({
      requestedHourlyRate: "<resolved at apply time>",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("dryRun: STILL refuses with CONSENT_REQUIRED when consent is omitted (no preview for a call that would have been refused)", async () => {
    await expect(apply(TOKEN, JOB_ID, {} as ApplyInput, { dryRun: true })).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("WIRE_SHAPE_ERROR: rejects a matcherAnswers entry with an unknown id (the recovered field name for matcher answers, NOT questionId)", async () => {
    replyPreApplySuccess({ matcherIds: ["m1"] });
    await expect(
      apply(TOKEN, JOB_ID, {
        consentIssued: true,
        matcherAnswers: [{ id: "BOGUS", answer: "x" }],
      }),
    ).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "WIRE_SHAPE_ERROR",
      message: expect.stringContaining("matcherAnswers[0]"),
    });
    // Pre-fetch ran (3 calls) but the mutation did NOT.
    expect(mockedStock).toHaveBeenCalledTimes(3);
  });

  it("WIRE_SHAPE_ERROR: rejects an expertiseAnswers entry missing questionId entirely (expertise still uses `questionId` per the asymmetric recovered SDL)", async () => {
    replyPreApplySuccess({ expertiseIds: ["e1"] });
    await expect(
      apply(TOKEN, JOB_ID, {
        consentIssued: true,
        // `as never` widens the structurally-incomplete object past
        // the now-tightened `JobExpertiseAnswerInput` type. The runtime
        // validateAnswerIds check is the path under test — at the type
        // level a missing `questionId` would already be a static error.
        expertiseAnswers: [{ other: null, subjectId: null } as never],
      }),
    ).rejects.toMatchObject({
      code: "WIRE_SHAPE_ERROR",
      message: expect.stringContaining("expertiseAnswers[0]"),
    });
    expect(mockedStock).toHaveBeenCalledTimes(3);
  });

  it("WIRE_SHAPE_ERROR: rejects a matcherAnswers entry missing `id` entirely (NOT `questionId` — that's the expertise side)", async () => {
    replyPreApplySuccess({ matcherIds: ["m1"] });
    await expect(
      apply(TOKEN, JOB_ID, {
        consentIssued: true,
        // Missing `id` — the structurally-incomplete shape past the
        // tightened `JobPositionAnswerInput` type. Test the runtime
        // validateAnswerIds branch covering "missing id" specifically.
        matcherAnswers: [{ answer: "no id field" } as never],
      }),
    ).rejects.toMatchObject({
      code: "WIRE_SHAPE_ERROR",
      message: expect.stringContaining(`matcherAnswers[0]: missing or non-string "id" property.`),
    });
    expect(mockedStock).toHaveBeenCalledTimes(3);
  });

  it("WIRE_SHAPE_ERROR: rejects a non-object answer entry (defensive — runtime check past the type system)", async () => {
    replyPreApplySuccess({ matcherIds: ["m1"] });
    await expect(
      apply(TOKEN, JOB_ID, {
        consentIssued: true,
        matcherAnswers: ["string-instead-of-object" as never],
      }),
    ).rejects.toMatchObject({
      code: "WIRE_SHAPE_ERROR",
      message: expect.stringContaining("matcherAnswers[0]"),
    });
  });

  it("MUTATION_ERROR: throws when rate is omitted AND PreApplyData.suggestedRate is null (no default to pick)", async () => {
    replyPreApplySuccess({ suggestedRate: null });
    await expect(apply(TOKEN, JOB_ID, { consentIssued: true })).rejects.toMatchObject({
      code: "MUTATION_ERROR",
      message: expect.stringContaining("requestedHourlyRate"),
    });
    // Pre-fetch ran but mutation did not.
    expect(mockedStock).toHaveBeenCalledTimes(3);
  });

  it("MUTATION_ERROR: maps non-`already_applied` wire failures verbatim via formatMutationErrors", async () => {
    replyPreApplySuccess();
    reply({
      body: {
        data: {
          job: {
            __typename: "TalentJob",
            apply: {
              __typename: "JobApplyPayload",
              success: false,
              errors: [
                {
                  __typename: "MutationResultError",
                  code: "VALIDATION_ERROR",
                  key: "requestedHourlyRate",
                  message: "rate below platform minimum",
                },
              ],
              job: null,
            },
          },
        },
      },
    });
    await expect(apply(TOKEN, JOB_ID, { consentIssued: true })).rejects.toMatchObject({
      code: "MUTATION_ERROR",
      message: expect.stringContaining("rate below platform minimum"),
    });
  });

  it("UNKNOWN: throws when JobApply returns a null root payload (defensive)", async () => {
    replyPreApplySuccess();
    reply({ body: { data: { job: null } } });
    await expect(apply(TOKEN, JOB_ID, { consentIssued: true })).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("UNKNOWN: throws when success:true but the activityItem echo is null (wire violation)", async () => {
    replyPreApplySuccess();
    reply({
      body: {
        data: {
          job: {
            __typename: "TalentJob",
            apply: {
              __typename: "JobApplyPayload",
              success: true,
              errors: null,
              job: { __typename: "TalentJob", id: JOB_ID, activityItem: null },
            },
          },
        },
      },
    });
    await expect(apply(TOKEN, JOB_ID, { consentIssued: true })).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("threads null defaults into matcher/expertise/pitch/comment variables when caller omits them", async () => {
    replyPreApplySuccess();
    reply({ body: jobApplySuccessFixture() });
    await apply(TOKEN, JOB_ID, { consentIssued: true });
    const mutationBody = mockedStock.mock.calls[3]?.[0]?.body as { variables: Record<string, unknown> };
    expect(mutationBody.variables["comment"]).toBeNull();
    expect(mutationBody.variables["matcherQuestionsAnswers"]).toBeNull();
    expect(mutationBody.variables["expertiseQuestionsAnswers"]).toBeNull();
    expect(mutationBody.variables["talentCard"]).toBeNull();
  });

  it("propagates pre-fetch NOT_FOUND from applyData up the stack (Promise.all rejects-on-first)", async () => {
    // First mock (applyData) returns the Relay decode error → NOT_FOUND.
    // Subsequent mocks for applyQuestions / rateInsight never get
    // consumed because Promise.all rejects on the first failure.
    reply({ body: { errors: [{ message: "Record not found" }] } });
    reply({ body: questionsFixture() });
    reply({ body: rateInsightCompetitiveFixture() });
    await expect(apply(TOKEN, JOB_ID, { consentIssued: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("propagates AuthRevokedError from any pre-fetch call", async () => {
    reply({ body: applyDataFixture() });
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    reply({ body: rateInsightCompetitiveFixture() });
    await expect(apply(TOKEN, JOB_ID, { consentIssued: true })).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

// ---------------------------------------------------------------------
// `similarAnswers` (#452) — opt-in autocomplete suggestion fetcher.
// Wraps SimilarJobQuestionAnswers($id) and fans out across the full
// question inventory of a job (matcher + expertise) via N parallel
// calls. Tests cover the happy path (suggestions returned), the
// empty-inventory short-circuit (no per-question calls), the empty-
// suggestions case (zero similar-job history), error mapping, and
// the question-inventory pre-fetch failure path.
// ---------------------------------------------------------------------

interface SimilarAnswerFixtureEntry {
  id: string;
  answer: string;
  createdAt: string;
}

function similarAnswersFixture(entries: SimilarAnswerFixtureEntry[]): unknown {
  return {
    data: {
      viewer: {
        __typename: "Viewer",
        id: "v1",
        jobPositionAnswers: {
          __typename: "JobPositionAnswersConnection",
          nodes: entries.map((e) => ({ __typename: "JobPositionAnswer", ...e })),
        },
      },
    },
  };
}

describe("applications.similarAnswers (#452)", () => {
  it("returns [] without issuing any SimilarJobQuestionAnswers calls when the job has no questions", async () => {
    reply({ body: questionsFixture({ matcher: [], expertise: [] }) });
    const out = await similarAnswers(TOKEN, JOB_ID);
    expect(out).toEqual([]);
    // Only ONE call (applyQuestions) — no per-question fan-out.
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });

  it("returns one SimilarJobAnswerGroup per question with server-supplied suggestions (matcher + expertise interleave)", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m1", question: "Years?", isRequired: true }],
        expertise: [{ id: "e1", subject: { __typename: "Skill", id: "s1", name: "TypeScript" } }],
      }),
    });
    reply({
      body: similarAnswersFixture([
        { id: "ans-m1-a", answer: "5 years", createdAt: "2025-01-01T00:00:00Z" },
        { id: "ans-m1-b", answer: "7 years", createdAt: "2025-03-15T00:00:00Z" },
      ]),
    });
    reply({
      body: similarAnswersFixture([{ id: "ans-e1-a", answer: "Strong daily use", createdAt: "2025-02-10T00:00:00Z" }]),
    });
    const out = await similarAnswers(TOKEN, JOB_ID);
    expect(out).toEqual([
      {
        questionId: "m1",
        suggestions: [
          { id: "ans-m1-a", answer: "5 years", createdAt: "2025-01-01T00:00:00Z" },
          { id: "ans-m1-b", answer: "7 years", createdAt: "2025-03-15T00:00:00Z" },
        ],
      },
      {
        questionId: "e1",
        suggestions: [{ id: "ans-e1-a", answer: "Strong daily use", createdAt: "2025-02-10T00:00:00Z" }],
      },
    ]);
    // applyQuestions + 2 per-question calls = 3 wire calls.
    expect(mockedStock).toHaveBeenCalledTimes(3);
  });

  it("threads the question identifier into the wire as `id` (variable name = $id)", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m-only-1", question: "Q?", isRequired: false }],
      }),
    });
    reply({ body: similarAnswersFixture([]) });
    await similarAnswers(TOKEN, JOB_ID);
    // call 0 = applyQuestions; call 1 = similar for m-only-1
    const body = mockedStock.mock.calls[1]?.[0]?.body as { operationName: string; variables: Record<string, unknown> };
    expect(body.operationName).toBe("SimilarJobQuestionAnswers");
    expect(body.variables).toEqual({ id: "m-only-1" });
  });

  it("returns empty `suggestions` arrays per question when the talent has no similar-job history", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m1", question: "Years?", isRequired: false }],
      }),
    });
    reply({ body: similarAnswersFixture([]) });
    const out = await similarAnswers(TOKEN, JOB_ID);
    expect(out).toEqual([{ questionId: "m1", suggestions: [] }]);
  });

  it("treats null wire `jobPositionAnswers` connection as zero suggestions (no NOT_FOUND)", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m1", question: "Q?", isRequired: false }],
      }),
    });
    reply({
      body: {
        data: {
          viewer: { __typename: "Viewer", id: "v1", jobPositionAnswers: null },
        },
      },
    });
    const out = await similarAnswers(TOKEN, JOB_ID);
    expect(out).toEqual([{ questionId: "m1", suggestions: [] }]);
  });

  it("filters null wire entries out of the projected `suggestions` array (defensive)", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m1", question: "Q?", isRequired: false }],
      }),
    });
    reply({
      body: {
        data: {
          viewer: {
            __typename: "Viewer",
            id: "v1",
            jobPositionAnswers: {
              __typename: "JobPositionAnswersConnection",
              nodes: [
                null,
                { __typename: "JobPositionAnswer", id: "ans-1", answer: "Yes", createdAt: "2025-01-01T00:00:00Z" },
                null,
              ],
            },
          },
        },
      },
    });
    const out = await similarAnswers(TOKEN, JOB_ID);
    expect(out[0]?.suggestions).toHaveLength(1);
    expect(out[0]?.suggestions[0]?.id).toBe("ans-1");
  });

  it("propagates NOT_FOUND from applyQuestions for a bad jobId (no per-question fan-out attempted)", async () => {
    reply({ body: { errors: [{ message: "Record not found" }] } });
    await expect(similarAnswers(TOKEN, "missing-job")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });

  it("maps Relay decode error on a per-question call to NOT_FOUND (wire returns the decode error for unknown question ids)", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m1", question: "Q?", isRequired: false }],
      }),
    });
    reply({
      body: {
        errors: [{ message: "Node id 'bogus' resolves to an unknown type JobPositionQuestion. Please check ..." }],
      },
    });
    await expect(similarAnswers(TOKEN, JOB_ID)).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("throws AuthRevokedError when a per-question call returns HTTP 401", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m1", question: "Q?", isRequired: false }],
      }),
    });
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(similarAnswers(TOKEN, JOB_ID)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("issues per-question calls in parallel (Promise.all — all per-question requests are in-flight before the first resolves)", async () => {
    reply({
      body: questionsFixture({
        matcher: [
          { id: "m1", question: "Q1?", isRequired: false },
          { id: "m2", question: "Q2?", isRequired: false },
        ],
      }),
    });
    // Reply order is deterministic via mockResolvedValueOnce; the
    // assertion below verifies the WIRE ORDER matches the question
    // order from applyQuestions — the helper does not re-shuffle.
    reply({ body: similarAnswersFixture([{ id: "a1", answer: "A", createdAt: "2025-01-01T00:00:00Z" }]) });
    reply({ body: similarAnswersFixture([{ id: "a2", answer: "B", createdAt: "2025-02-01T00:00:00Z" }]) });
    const out = await similarAnswers(TOKEN, JOB_ID);
    expect(out.map((g) => g.questionId)).toEqual(["m1", "m2"]);
    expect(out[0]?.suggestions[0]?.id).toBe("a1");
    expect(out[1]?.suggestions[0]?.id).toBe("a2");
  });

  it("orders the response: matcher questions FIRST, then expertise (matches the ApplicationQuestion inventory order)", async () => {
    reply({
      body: questionsFixture({
        matcher: [{ id: "m-first", question: "M?", isRequired: false }],
        expertise: [{ id: "e-after", subject: { __typename: "Industry", id: "ind-1", name: "FinTech" } }],
      }),
    });
    reply({ body: similarAnswersFixture([]) });
    reply({ body: similarAnswersFixture([]) });
    const out = await similarAnswers(TOKEN, JOB_ID);
    expect(out.map((g) => g.questionId)).toEqual(["m-first", "e-after"]);
  });
});

// ---------------------------------------------------------------------
// `applications.interviews.show` (#439)
// ---------------------------------------------------------------------

describe("applications.interviews.show (#439)", () => {
  const INTERVIEW_ID = "int-1";

  function interviewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      __typename: "TalentInterview",
      id: INTERVIEW_ID,
      interviewStatus: { __typename: "TalentInterviewStatus", value: "SCHEDULED" },
      kind: "EXTERNAL",
      interviewType: "Technical",
      interviewTime: "60 minutes",
      information: "Recruiter brief markdown",
      initiator: "Recruiter Recruiterson",
      scheduledAtTimes: ["2026-06-01T10:00:00Z", "2026-06-02T15:30:00Z"],
      schedulingComment: "Pick whichever slot works.",
      interviewMethod: {
        __typename: "TalentInterviewMethod",
        typeV2: "ZOOM",
        conferenceUrl: "https://zoom.us/j/12345",
        resource: null,
      },
      interviewContacts: [
        {
          __typename: "TalentInterviewContact",
          id: "ctc-1",
          fullName: "Recruiter Recruiterson",
          email: "recruiter@example.com",
          phoneNumber: null,
          main: true,
          position: "Recruiter",
          timeZone: { __typename: "TimeZone", value: "America/New_York", location: "New York, NY" },
        },
      ],
      guide: { __typename: "TalentInterviewGuide", id: "gui-1" },
      talentNotes: [
        {
          __typename: "TalentInterviewNote",
          id: "note-1",
          section: "GAPS",
          note: "Ask about scaling.",
        },
      ],
      job: {
        __typename: "TalentJob",
        id: "job-1",
        activityItem: { __typename: "TalentJobActivityItem", id: "act-1" },
      },
      updatedAt: "2026-05-15T08:00:00Z",
      ...overrides,
    };
  }

  it("projects the interview detail and dispatches Interview op with the id variable", async () => {
    reply({
      body: { data: { viewer: { id: "v1", interview: interviewFixture() } } },
    });
    const item = await interviews.show(TOKEN, INTERVIEW_ID);
    expect(item.id).toBe(INTERVIEW_ID);
    expect(item.status).toBe("SCHEDULED");
    expect(item.kind).toBe("EXTERNAL");
    expect(item.interviewType).toBe("Technical");
    expect(item.interviewTime).toBe("60 minutes");
    expect(item.information).toBe("Recruiter brief markdown");
    expect(item.initiator).toBe("Recruiter Recruiterson");
    expect(item.scheduledAtTimes).toEqual(["2026-06-01T10:00:00Z", "2026-06-02T15:30:00Z"]);
    expect(item.schedulingComment).toBe("Pick whichever slot works.");
    expect(item.method).toEqual({ typeV2: "ZOOM", conferenceUrl: "https://zoom.us/j/12345", resource: null });
    expect(item.contacts).toHaveLength(1);
    expect(item.contacts[0]).toEqual({
      id: "ctc-1",
      fullName: "Recruiter Recruiterson",
      email: "recruiter@example.com",
      phoneNumber: null,
      position: "Recruiter",
      main: true,
      timeZone: { value: "America/New_York", location: "New York, NY" },
    });
    expect(item.guideId).toBe("gui-1");
    expect(item.talentNotes).toEqual([{ id: "note-1", section: "GAPS", note: "Ask about scaling." }]);
    expect(item.job).toEqual({ id: "job-1", activityItemId: "act-1" });
    expect(item.updatedAt).toBe("2026-05-15T08:00:00Z");

    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "Interview",
      variables: { id: INTERVIEW_ID },
    });
  });

  it("returns sparse projection (status null, kind null, empty arrays) when wire omits fields", async () => {
    const sparseFixture = {
      __typename: "TalentInterview",
      id: INTERVIEW_ID,
      // interviewStatus omitted entirely (vs `{value: null}` — both must coerce to status: null)
      // kind omitted
      // interviewType omitted
      // interviewTime omitted
      // information omitted
      // initiator omitted
      scheduledAtTimes: null,
      // schedulingComment omitted
      interviewMethod: null,
      interviewContacts: null,
      guide: null,
      talentNotes: null,
      job: null,
      updatedAt: null,
    };
    reply({
      body: { data: { viewer: { id: "v1", interview: sparseFixture } } },
    });
    const item = await interviews.show(TOKEN, INTERVIEW_ID);
    expect(item).toEqual({
      id: INTERVIEW_ID,
      status: null,
      kind: null,
      interviewType: null,
      interviewTime: null,
      information: null,
      initiator: null,
      scheduledAtTimes: [],
      schedulingComment: null,
      method: null,
      contacts: [],
      guideId: null,
      talentNotes: [],
      job: null,
      updatedAt: null,
    });
  });

  it("drops null entries from contacts and talentNotes arrays (defensive against wire sparseness)", async () => {
    const fixtureWithNulls = interviewFixture({
      interviewContacts: [
        null,
        {
          __typename: "TalentInterviewContact",
          id: "ctc-keep",
          fullName: "Real Contact",
          email: null,
          phoneNumber: null,
          main: false,
          position: null,
          timeZone: null,
        },
        null,
      ],
      talentNotes: [null, { __typename: "TalentInterviewNote", id: "note-keep", section: null, note: "Kept note" }],
    });
    reply({
      body: { data: { viewer: { id: "v1", interview: fixtureWithNulls } } },
    });
    const item = await interviews.show(TOKEN, INTERVIEW_ID);
    expect(item.contacts).toHaveLength(1);
    expect(item.contacts[0]?.id).toBe("ctc-keep");
    expect(item.talentNotes).toHaveLength(1);
    expect(item.talentNotes[0]).toEqual({ id: "note-keep", section: null, note: "Kept note" });
  });

  it("filters non-string entries from scheduledAtTimes (defensive)", async () => {
    const fixtureWithNullSlot = interviewFixture({
      scheduledAtTimes: ["2026-06-01T10:00:00Z", null, "2026-06-02T15:30:00Z"],
    });
    reply({
      body: { data: { viewer: { id: "v1", interview: fixtureWithNullSlot } } },
    });
    const item = await interviews.show(TOKEN, INTERVIEW_ID);
    expect(item.scheduledAtTimes).toEqual(["2026-06-01T10:00:00Z", "2026-06-02T15:30:00Z"]);
  });

  it("throws ApplicationsError(NOT_FOUND) when viewer.interview is null on the wire", async () => {
    reply({
      body: { data: { viewer: { id: "v1", interview: null } } },
    });
    await expect(interviews.show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it('translates the gateway top-level "Record not found" GraphQL error into NOT_FOUND', async () => {
    // Same shared NOT_FOUND_MESSAGE_PATTERN as applications.show — covers
    // `Record not found` / `Invalid ID` / Relay `Node id ... resolves to`
    // per the per-op-specific behavior memory `project_toptal_wire_quirks`.
    reply({
      body: { errors: [{ message: "Record not found" }] },
    });
    await expect(interviews.show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("propagates AuthRevokedError for sessions whose bearer was revoked", async () => {
    reply({
      status: 401,
      body: { errors: [{ message: "auth revoked", extensions: { code: "UNAUTHENTICATED" } }] },
    });
    await expect(interviews.show(TOKEN, INTERVIEW_ID)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("exports the InterviewStatusEnum vocabulary (sanity for callers)", () => {
    expect(INTERVIEW_STATUSES).toEqual([
      "ACCEPTED",
      "MISSED",
      "PENDING",
      "REJECTED",
      "SCHEDULED",
      "TIME_ACCEPTED",
      "TIME_REJECTED",
    ]);
  });
});

// ---------------------------------------------------------------------
// `applications.interviews.notes.show` (#440)
// ---------------------------------------------------------------------

describe("applications.interviews.notes.show (#440)", () => {
  const JOB_ID = "job-1";

  function notesFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      __typename: "TalentJob",
      activityItem: {
        __typename: "TalentJobActivityItem",
        interview: {
          __typename: "TalentInterview",
          id: "int-1",
          kind: "EXTERNAL",
          talentNotes: [
            { __typename: "TalentInterviewNote", id: "note-1", section: "GAPS", note: "Ask about scaling." },
            {
              __typename: "TalentInterviewNote",
              id: "note-2",
              section: "STRENGTHS",
              note: "Highlight prior client wins.",
            },
          ],
        },
      },
      ...overrides,
    };
  }

  it("projects the talent notes and dispatches GetInterviewNotes with the jobId variable", async () => {
    reply({
      body: { data: { viewer: { id: "v1", job: notesFixture() } } },
    });
    const item = await interviews.notes.show(TOKEN, JOB_ID);
    expect(item.jobId).toBe(JOB_ID);
    expect(item.interviewId).toBe("int-1");
    expect(item.interviewKind).toBe("EXTERNAL");
    expect(item.notes).toEqual([
      { id: "note-1", section: "GAPS", note: "Ask about scaling." },
      { id: "note-2", section: "STRENGTHS", note: "Highlight prior client wins." },
    ]);

    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "GetInterviewNotes",
      variables: { jobId: JOB_ID },
    });
  });

  it("returns empty notes + null interviewId/interviewKind when the job has no attached interview", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            job: { __typename: "TalentJob", activityItem: { __typename: "TalentJobActivityItem", interview: null } },
          },
        },
      },
    });
    const item = await interviews.notes.show(TOKEN, JOB_ID);
    expect(item).toEqual({ jobId: JOB_ID, interviewId: null, interviewKind: null, notes: [] });
  });

  it("returns empty notes + null fields when the activityItem itself is null", async () => {
    // Defensive sparse-wire path: some jobs may have no activityItem
    // (e.g. eligible-but-not-yet-acted-on jobs). The projection must
    // not crash — sub-namespace is read-only and forgiving.
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            job: { __typename: "TalentJob", activityItem: null },
          },
        },
      },
    });
    const item = await interviews.notes.show(TOKEN, JOB_ID);
    expect(item).toEqual({ jobId: JOB_ID, interviewId: null, interviewKind: null, notes: [] });
  });

  it("drops null entries from the talentNotes array (defensive against wire sparseness)", async () => {
    const fixtureWithNulls = notesFixture({
      activityItem: {
        __typename: "TalentJobActivityItem",
        interview: {
          __typename: "TalentInterview",
          id: "int-1",
          kind: null,
          talentNotes: [
            null,
            { __typename: "TalentInterviewNote", id: "note-keep", section: null, note: "Kept note" },
            null,
          ],
        },
      },
    });
    reply({
      body: { data: { viewer: { id: "v1", job: fixtureWithNulls } } },
    });
    const item = await interviews.notes.show(TOKEN, JOB_ID);
    expect(item.interviewKind).toBeNull();
    expect(item.notes).toHaveLength(1);
    expect(item.notes[0]).toEqual({ id: "note-keep", section: null, note: "Kept note" });
  });

  it("throws ApplicationsError(NOT_FOUND) when viewer.job is null on the wire", async () => {
    reply({
      body: { data: { viewer: { id: "v1", job: null } } },
    });
    await expect(interviews.notes.show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it('translates the gateway top-level "Record not found" GraphQL error into NOT_FOUND', async () => {
    // Same shared NOT_FOUND_MESSAGE_PATTERN as applications.show — covers
    // `Record not found` / `Invalid ID` / Relay `Node id ... resolves to`
    // per the per-op-specific behavior memory `project_toptal_wire_quirks`.
    reply({
      body: { errors: [{ message: "Record not found" }] },
    });
    await expect(interviews.notes.show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("propagates AuthRevokedError for sessions whose bearer was revoked", async () => {
    reply({
      status: 401,
      body: { errors: [{ message: "auth revoked", extensions: { code: "UNAUTHENTICATED" } }] },
    });
    await expect(interviews.notes.show(TOKEN, JOB_ID)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

// ---------------------------------------------------------------------
// `applications.interviews.guide.show` (#470)
// ---------------------------------------------------------------------

describe("applications.interviews.guide.show (#470)", () => {
  const INTERVIEW_ID = "int-guide-1";
  const GUIDE_ID = "gui-1";

  function guideFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      __typename: "TalentInterview",
      id: INTERVIEW_ID,
      guide: {
        __typename: "TalentInterviewGuide",
        id: GUIDE_ID,
        sections: [
          {
            __typename: "TalentInterviewGuideSection",
            identifier: "STRENGTHS",
            title: "Your strengths",
            subtitle: "Match between your profile and the role",
            tips: [
              {
                __typename: "TalentInterviewGuideTip",
                identifier: "STRENGTHS_OVERLAP",
                title: "Profile overlap",
                content: "You have 5 years in TypeScript matching the requirement.",
                hardcodedContent: "Highlight overlapping experience.",
              },
            ],
          },
          {
            __typename: "TalentInterviewGuideSection",
            identifier: "PRO_TIPS",
            title: "Toptal interview tips",
            subtitle: null,
            tips: [
              {
                __typename: "TalentInterviewGuideTip",
                identifier: "BE_PRESENTABLE",
                title: "Dress professionally",
                content: null,
                hardcodedContent: "Wear business-casual attire.",
              },
              {
                __typename: "TalentInterviewGuideTip",
                identifier: "CAMERA_ON",
                title: "Camera on",
                content: null,
                hardcodedContent: "Keep your camera on for the entire interview.",
              },
            ],
          },
        ],
      },
      ...overrides,
    };
  }

  it("projects the guide content and dispatches InterviewGuide with the id variable", async () => {
    reply({
      body: { data: { viewer: { id: "v1", interview: guideFixture() } } },
    });
    const item = await interviews.guide.show(TOKEN, INTERVIEW_ID);
    expect(item.interviewId).toBe(INTERVIEW_ID);
    expect(item.guideId).toBe(GUIDE_ID);
    expect(item.sections).toHaveLength(2);

    expect(item.sections[0]).toEqual({
      identifier: "STRENGTHS",
      title: "Your strengths",
      subtitle: "Match between your profile and the role",
      tips: [
        {
          identifier: "STRENGTHS_OVERLAP",
          title: "Profile overlap",
          content: "You have 5 years in TypeScript matching the requirement.",
          hardcodedContent: "Highlight overlapping experience.",
        },
      ],
    });

    expect(item.sections[1]?.identifier).toBe("PRO_TIPS");
    expect(item.sections[1]?.tips).toHaveLength(2);
    expect(item.sections[1]?.tips[0]?.identifier).toBe("BE_PRESENTABLE");
    expect(item.sections[1]?.tips[1]?.identifier).toBe("CAMERA_ON");

    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "InterviewGuide",
      variables: { id: INTERVIEW_ID },
    });
  });

  it("returns guideId: null and sections: [] when no guide is attached to the interview", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            interview: { __typename: "TalentInterview", id: INTERVIEW_ID, guide: null },
          },
        },
      },
    });
    const item = await interviews.guide.show(TOKEN, INTERVIEW_ID);
    expect(item).toEqual({
      interviewId: INTERVIEW_ID,
      guideId: null,
      sections: [],
    });
  });

  it("returns guideId set + sections: [] when the guide exists but has no sections", async () => {
    // Defensive coverage for the sparse-guide wire shape (guide row
    // exists but the server returned no sections — e.g. an interview
    // type whose guide template hasn't been provisioned yet).
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            interview: {
              __typename: "TalentInterview",
              id: INTERVIEW_ID,
              guide: { __typename: "TalentInterviewGuide", id: GUIDE_ID, sections: null },
            },
          },
        },
      },
    });
    const item = await interviews.guide.show(TOKEN, INTERVIEW_ID);
    expect(item).toEqual({
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      sections: [],
    });
  });

  it("projects sparse sections (all-null fields coerce to null) without dropping them", async () => {
    const sparseSection = {
      __typename: "TalentInterviewGuideSection",
      // identifier omitted
      // title omitted
      // subtitle omitted
      tips: null,
    };
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            interview: {
              __typename: "TalentInterview",
              id: INTERVIEW_ID,
              guide: { __typename: "TalentInterviewGuide", id: GUIDE_ID, sections: [sparseSection] },
            },
          },
        },
      },
    });
    const item = await interviews.guide.show(TOKEN, INTERVIEW_ID);
    expect(item.sections).toHaveLength(1);
    expect(item.sections[0]).toEqual({
      identifier: null,
      title: null,
      subtitle: null,
      tips: [],
    });
  });

  it("drops null entries from sections and tips arrays (defensive against wire sparseness)", async () => {
    const fixtureWithNulls = guideFixture({
      guide: {
        __typename: "TalentInterviewGuide",
        id: GUIDE_ID,
        sections: [
          null,
          {
            __typename: "TalentInterviewGuideSection",
            identifier: "GAPS",
            title: "Gaps",
            subtitle: null,
            tips: [
              null,
              {
                __typename: "TalentInterviewGuideTip",
                identifier: "GAP_ANALYSIS",
                title: "Likely follow-ups",
                content: null,
                hardcodedContent: "Be ready to address gaps.",
              },
              null,
            ],
          },
          null,
        ],
      },
    });
    reply({
      body: { data: { viewer: { id: "v1", interview: fixtureWithNulls } } },
    });
    const item = await interviews.guide.show(TOKEN, INTERVIEW_ID);
    expect(item.sections).toHaveLength(1);
    expect(item.sections[0]?.identifier).toBe("GAPS");
    expect(item.sections[0]?.tips).toHaveLength(1);
    expect(item.sections[0]?.tips[0]?.identifier).toBe("GAP_ANALYSIS");
  });

  it("throws ApplicationsError(NOT_FOUND) when viewer.interview is null on the wire", async () => {
    reply({
      body: { data: { viewer: { id: "v1", interview: null } } },
    });
    await expect(interviews.guide.show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it('translates the gateway top-level "Record not found" GraphQL error into NOT_FOUND', async () => {
    // Same shared NOT_FOUND_MESSAGE_PATTERN as siblings — covers
    // `Record not found` / `Invalid ID` / Relay `Node id ... resolves to`
    // per the per-op-specific behavior memory `project_toptal_wire_quirks`.
    reply({
      body: { errors: [{ message: "Record not found" }] },
    });
    await expect(interviews.guide.show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("propagates AuthRevokedError for sessions whose bearer was revoked", async () => {
    reply({
      status: 401,
      body: { errors: [{ message: "auth revoked", extensions: { code: "UNAUTHENTICATED" } }] },
    });
    await expect(interviews.guide.show(TOKEN, INTERVIEW_ID)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("exports the InterviewGuideSectionIdentifierEnum vocabulary (sanity for callers)", () => {
    expect(INTERVIEW_GUIDE_SECTION_IDENTIFIERS).toEqual([
      "ASK_YOUR_CLIENT",
      "GAPS",
      "JOB_HIGHLIGHTS",
      "POTENTIAL_QUESTIONS",
      "PRO_TIPS",
      "STRENGTHS",
    ]);
  });

  it("exports the InterviewGuideTipIdentifierEnum vocabulary (sanity for callers)", () => {
    expect(INTERVIEW_GUIDE_TIP_IDENTIFIERS).toEqual([
      "BE_PRESENTABLE",
      "CAMERA_ON",
      "DONT_DISCUSS_RATE",
      "GAP_ANALYSIS",
      "HIRING_FACTORS",
      "JOB_SUMMARY",
      "PROFILE_REFERENCES",
      "QUESTIONS_TO_ASK",
      "QUESTIONS_TO_PREPARE_FOR",
      "SMALL_TALK",
      "STANDARD_QUESTIONS",
      "STRENGTHS_OVERLAP",
    ]);
  });
});

// ---------------------------------------------------------------------
// `applications.availabilityRequests.show` (#442)
// ---------------------------------------------------------------------

describe("applications.availabilityRequests.show (#442)", () => {
  const AR_ID = "ar-1";

  function arFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      __typename: "AvailabilityRequest",
      id: AR_ID,
      createdAt: "2026-05-01T09:00:00Z",
      updatedAt: "2026-05-15T08:00:00Z",
      answeredAt: "2026-05-16T10:00:00Z",
      comment: "Recruiter is keen — strong fit.",
      jirStatus: { __typename: "AvailabilityRequestStatus", value: "CONFIRMED" },
      metadata: {
        __typename: "AvailabilityRequestFixedMetadata",
        offeredHourlyRate: { __typename: "Money", decimal: "95.00", verbose: "$95.00/hr" },
      },
      job: {
        __typename: "TalentJob",
        id: "job-1",
        title: "Senior Engineer",
        url: "https://www.toptal.com/jobs/job-1",
        client: { __typename: "Client", id: "cli-1", fullName: "Acme Inc." },
      },
      ...overrides,
    };
  }

  it("projects the AR detail and dispatches AvailabilityRequest op with the id variable", async () => {
    reply({
      body: { data: { viewer: { id: "v1", availabilityRequest: arFixture() } } },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item.id).toBe(AR_ID);
    expect(item.status).toBe("CONFIRMED");
    expect(item.kind).toBe("FIXED");
    expect(item.fixedRate).toEqual({ decimal: "95.00", verbose: "$95.00/hr" });
    expect(item.comment).toBe("Recruiter is keen — strong fit.");
    expect(item.createdAt).toBe("2026-05-01T09:00:00Z");
    expect(item.updatedAt).toBe("2026-05-15T08:00:00Z");
    expect(item.answeredAt).toBe("2026-05-16T10:00:00Z");
    expect(item.job).toEqual({
      id: "job-1",
      title: "Senior Engineer",
      url: "https://www.toptal.com/jobs/job-1",
      client: { id: "cli-1", fullName: "Acme Inc." },
    });

    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "AvailabilityRequest",
      variables: { id: AR_ID },
    });
  });

  it("projects FLEXIBLE kind with null fixedRate (metadata carries no offered rate)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            availabilityRequest: arFixture({ metadata: { __typename: "AvailabilityRequestFlexibleMetadata" } }),
          },
        },
      },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item.kind).toBe("FLEXIBLE");
    expect(item.fixedRate).toBeNull();
  });

  it("projects MARKETPLACE_FLEXIBLE kind", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            availabilityRequest: arFixture({
              metadata: { __typename: "MarketplaceAvailabilityRequestFlexibleMetadata" },
            }),
          },
        },
      },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item.kind).toBe("MARKETPLACE_FLEXIBLE");
    expect(item.fixedRate).toBeNull();
  });

  it("returns sparse projection (all nullable fields null) when wire omits fields", async () => {
    const sparseFixture = {
      __typename: "AvailabilityRequest",
      id: AR_ID,
      // createdAt / updatedAt / answeredAt omitted
      // comment omitted
      // jirStatus omitted entirely (vs `{value: null}` — both coerce to status: null)
      // #539 fields omitted entirely
      metadata: null,
      job: null,
    };
    reply({
      body: { data: { viewer: { id: "v1", availabilityRequest: sparseFixture } } },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item).toEqual({
      id: AR_ID,
      status: null,
      kind: null,
      fixedRate: null,
      comment: null,
      talentComment: null,
      requestedHourlyRate: null,
      rejectReason: null,
      recruiter: null,
      createdAt: null,
      updatedAt: null,
      answeredAt: null,
      job: null,
    });
  });

  // ----- New fields on the standalone AR detail (#539) ---------------
  it("projects talentComment / requestedHourlyRate / rejectReason / recruiter from the wire (#539)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            availabilityRequest: {
              ...arFixture({
                jirStatus: { __typename: "AvailabilityRequestStatus", value: "REJECTED" },
              }),
              talentComment: "Out of scope for now — thanks.",
              requestedHourlyRate: null,
              rejectReason: "scope_mismatch",
              recruiter: {
                __typename: "Recruiter",
                firstName: "Casey",
                lastName: "Recruiter",
                fullName: "Casey Recruiter",
              },
            },
          },
        },
      },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item.status).toBe("REJECTED");
    expect(item.talentComment).toBe("Out of scope for now — thanks.");
    expect(item.requestedHourlyRate).toBeNull();
    expect(item.rejectReason).toBe("scope_mismatch");
    expect(item.recruiter).toEqual({
      firstName: "Casey",
      lastName: "Recruiter",
      fullName: "Casey Recruiter",
    });
  });

  it("projects requestedHourlyRate (Money) on a confirmed-AR detail (#539)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            availabilityRequest: {
              ...arFixture(),
              talentComment: "Available starting Monday.",
              requestedHourlyRate: { __typename: "Money", decimal: "90.00", verbose: "$90.00/hr" },
              rejectReason: null,
            },
          },
        },
      },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item.requestedHourlyRate).toEqual({ decimal: "90.00", verbose: "$90.00/hr" });
    expect(item.talentComment).toBe("Available starting Monday.");
    expect(item.rejectReason).toBeNull();
  });

  it("coerces requestedHourlyRate to null on partial-Money wire shape (decimal-only) (#539)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            availabilityRequest: {
              ...arFixture(),
              requestedHourlyRate: { __typename: "Money", decimal: "90.00" },
            },
          },
        },
      },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item.requestedHourlyRate).toBeNull();
  });

  it("coerces recruiter sub-fields to null when wire returns a partial Recruiter (only fullName) (#539)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            availabilityRequest: {
              ...arFixture(),
              recruiter: { __typename: "Recruiter", fullName: "Pat Recruiter" },
            },
          },
        },
      },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item.recruiter).toEqual({ firstName: null, lastName: null, fullName: "Pat Recruiter" });
  });

  it("coerces fixedRate to null when offeredHourlyRate is partial (decimal present, verbose absent)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            availabilityRequest: arFixture({
              metadata: {
                __typename: "AvailabilityRequestFixedMetadata",
                offeredHourlyRate: { __typename: "Money", decimal: "80.00" },
              },
            }),
          },
        },
      },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    // kind still resolves from __typename; fixedRate guards on both Money fields.
    expect(item.kind).toBe("FIXED");
    expect(item.fixedRate).toBeNull();
  });

  it("projects job with null title/url/client (defensive against a sparse job)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            availabilityRequest: arFixture({
              job: { __typename: "TalentJob", id: "job-bare", title: null, url: null, client: null },
            }),
          },
        },
      },
    });
    const item = await availabilityRequests.show(TOKEN, AR_ID);
    expect(item.job).toEqual({ id: "job-bare", title: null, url: null, client: null });
  });

  it("throws ApplicationsError(NOT_FOUND) when viewer.availabilityRequest is null on the wire", async () => {
    reply({
      body: { data: { viewer: { id: "v1", availabilityRequest: null } } },
    });
    await expect(availabilityRequests.show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it('translates the gateway top-level "Record not found" GraphQL error into NOT_FOUND', async () => {
    // Same shared NOT_FOUND_MESSAGE_PATTERN as applications.show — covers
    // `Record not found` / `Invalid ID` / Relay `Node id ... resolves to`
    // per the per-op-specific behavior memory `project_toptal_wire_quirks`.
    reply({
      body: { errors: [{ message: "Record not found" }] },
    });
    await expect(availabilityRequests.show(TOKEN, "missing")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });

  it("propagates AuthRevokedError for sessions whose bearer was revoked", async () => {
    reply({
      status: 401,
      body: { errors: [{ message: "auth revoked", extensions: { code: "UNAUTHENTICATED" } }] },
    });
    await expect(availabilityRequests.show(TOKEN, AR_ID)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("exports the AvailabilityRequestStatusEnum vocabulary (sanity for callers)", () => {
    expect(AVAILABILITY_REQUEST_STATUSES).toEqual([
      "CANCELLED",
      "CONFIRMED",
      "EXPIRED",
      "PENDING",
      "REJECTED",
      "WITHDRAWN",
    ]);
  });
});
