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

import { STATUS_GROUPS, list, show, stats } from "../index.js";
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
