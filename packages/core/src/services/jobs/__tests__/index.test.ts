// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// All jobs ops run against mobile-gateway via `stockTransport`.
vi.mock("../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport.js")>("../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import {
  JobsError,
  clearInterest,
  list,
  markViewed,
  notInterested,
  notInterestedList,
  save,
  saved,
  searchSubscriptionRemove,
  searchSubscriptionSave,
  searchSubscriptionShow,
  show,
  unsave,
  viewedList,
} from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-jobs-123";

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

const JOB_LIST_ENTITY = {
  __typename: "TalentJob",
  id: "job-1",
  title: "Senior React Engineer",
  url: "https://www.toptal.com/jobs/job-1",
  commitment: { __typename: "JobCommitment", slug: "full_time" },
  workType: { __typename: "JobWorkType", slug: "remote" },
  specialization: { __typename: "TalentSpecialization", title: "Frontend" },
  expectedHours: 40,
  maxRate: 100,
  startDate: "2026-06-01",
  postedWhen: "2 days ago",
  viewed: false,
  saved: false,
  notInterested: false,
  client: { __typename: "Client", id: "cli-1", fullName: "Acme Inc." },
};

const JOB_DETAIL_ENTITY = {
  ...JOB_LIST_ENTITY,
  descriptionMd: "We're hiring a React engineer.",
  minimumHoursPerBillingCycle: null,
  isCoaching: false,
  isToptalProject: false,
  semiMonthlyBilling: false,
  positionsCount: 1,
  jobTimeZone: {
    __typename: "JobTimeZone",
    verbose: "UTC",
    hoursOverlap: 4,
    workingTimeFrom: "09:00",
    workingTimeTo: "17:00",
  },
  client: {
    ...JOB_LIST_ENTITY.client,
    city: "San Francisco",
    countryName: "United States",
    industry: "Software",
    isEnterprise: false,
    website: "https://acme.example",
    linkedin: "https://linkedin.com/company/acme",
    teamSize: { __typename: "ClientTeamSize", value: "50-200" },
  },
  jobSkillSetsV2: {
    __typename: "JobSkillSetEdges",
    edges: [
      {
        __typename: "JobSkillSetEdge",
        node: {
          __typename: "JobSkillSet",
          rating: 5,
          isOptional: false,
          theSkill: { __typename: "Skill", id: "sk-1", name: "React" },
        },
      },
    ],
  },
  languages: [{ __typename: "Language", id: "lang-1", name: "English" }],
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
    handoff: null,
    kind: "standard",
  },
};

const INTEREST_STATE = {
  __typename: "TalentJob",
  id: "job-1",
  saved: true,
  notInterested: false,
  viewed: false,
};

beforeEach(() => {
  mockedStock.mockReset();
});

describe("jobs.list", () => {
  it("returns the projected entities in a JobListPage", async () => {
    reply({
      body: {
        data: {
          viewer: { __typename: "Viewer", id: "v1", eligibleJobs: { entities: [JOB_LIST_ENTITY], totalCount: 1 } },
        },
      },
    });
    const page = await list(TOKEN);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "job-1",
      title: "Senior React Engineer",
      saved: false,
      notInterested: false,
    });
    expect(page.totalCount).toBe(1);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(20);
  });

  it("passes filter variables through to the wire", async () => {
    reply({
      body: { data: { viewer: { id: "v1", eligibleJobs: { entities: [], totalCount: 0 } } } },
    });
    await list(TOKEN, { skills: ["React"], keywords: ["remote"] });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (call) {
      const body = call.body as { variables: Record<string, unknown> };
      expect(body.variables["skills"]).toEqual(["React"]);
      expect(body.variables["keywords"]).toEqual(["remote"]);
      expect(body.variables["saved"]).toBeNull();
      expect(body.variables["notInterested"]).toBeNull();
    }
  });

  it("returns empty JobListPage when eligibleJobs is null", async () => {
    reply({ body: { data: { viewer: { id: "v1", eligibleJobs: null } } } });
    const page = await list(TOKEN);
    expect(page).toEqual({ items: [], totalCount: 0, page: 1, perPage: 20 });
  });

  // ----- Pagination (issue #138) ------------------------------------

  it("no pagination opts: wire receives page=1, pageSize=20 (wire is 1-indexed)", async () => {
    reply({
      body: { data: { viewer: { id: "v1", eligibleJobs: { entities: [], totalCount: 0 } } } },
    });
    await list(TOKEN);
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    expect(body.variables["page"]).toBe(1);
    expect(body.variables["pageSize"]).toBe(20);
  });

  it("page=2 threads to wire page=2 (wire is 1-indexed; no translation needed)", async () => {
    reply({
      body: { data: { viewer: { id: "v1", eligibleJobs: { entities: [JOB_LIST_ENTITY], totalCount: 50 } } } },
    });
    const page = await list(TOKEN, { page: 2, perPage: 10 });
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    expect(body.variables["page"]).toBe(2);
    expect(body.variables["pageSize"]).toBe(10);
    expect(page.page).toBe(2);
    expect(page.perPage).toBe(10);
    expect(page.totalCount).toBe(50);
  });

  it("perPage=5 with no page: page defaults to 1 (wire 1), perPage threads", async () => {
    reply({
      body: { data: { viewer: { id: "v1", eligibleJobs: { entities: [], totalCount: 0 } } } },
    });
    const page = await list(TOKEN, { perPage: 5 });
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    expect(body.variables["page"]).toBe(1);
    expect(body.variables["pageSize"]).toBe(5);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(5);
  });
});

describe("jobs.saved / notInterestedList", () => {
  it("saved() sets filter.saved = {eq: true} and threads pagination", async () => {
    reply({
      body: { data: { viewer: { id: "v1", eligibleJobs: { entities: [JOB_LIST_ENTITY], totalCount: 1 } } } },
    });
    const page = await saved(TOKEN, { page: 2, perPage: 5 });
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    expect(body.variables["saved"]).toEqual({ eq: true });
    expect(body.variables["notInterested"]).toBeNull();
    expect(body.variables["page"]).toBe(2);
    expect(body.variables["pageSize"]).toBe(5);
    expect(page.page).toBe(2);
    expect(page.perPage).toBe(5);
  });

  it("notInterestedList() sets filter.notInterested = {eq: true}", async () => {
    reply({
      body: { data: { viewer: { id: "v1", eligibleJobs: { entities: [], totalCount: 0 } } } },
    });
    const page = await notInterestedList(TOKEN);
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    expect(body.variables["notInterested"]).toEqual({ eq: true });
    expect(body.variables["saved"]).toBeNull();
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
  });
});

describe("jobs.viewedList (#372: full-pool aggregation + client-side filter)", () => {
  it("filters on viewed=true and returns post-filter totalCount on a single-page pool", async () => {
    const viewedEntity = { ...JOB_LIST_ENTITY, id: "job-2", viewed: true };
    // Single-page pool: 2 items, of which 1 viewed; totalCount=2 (less than perPage=20 → final page).
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            eligibleJobs: { entities: [JOB_LIST_ENTITY, viewedEntity], totalCount: 2 },
          },
        },
      },
    });
    const page = await viewedList(TOKEN);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("job-2");
    // Post-#372: totalCount reflects the POST-FILTER count (the real number of viewed jobs).
    expect(page.totalCount).toBe(1);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(20);
    // Single underlying fetch — final page is detected via items.length < perPage.
    expect(mockedStock.mock.calls).toHaveLength(1);
  });

  it("aggregates across multiple underlying pages; dedups by job id", async () => {
    // 3 underlying pages: page 1 (20 items, 5 viewed + 1 dup of page 2),
    // page 2 (20 items, 3 viewed + 1 dup of page 1), page 3 (5 items, 2 viewed).
    // Expected post-filter: 5 + 3 + 2 = 10 candidates - 1 dup = 9 viewed jobs.
    const makePageEntities = (idPrefix: string, count: number, viewedIds: string[]): unknown[] => {
      return Array.from({ length: count }, (_, i) => ({
        ...JOB_LIST_ENTITY,
        id: `${idPrefix}-${(i + 1).toString()}`,
        viewed: viewedIds.includes(`${idPrefix}-${(i + 1).toString()}`),
      }));
    };
    // Page 1: ids p1-1..p1-20. Viewed: p1-2, p1-5, p1-10, p1-15, p1-20. Total pool: 45.
    const page1Entities = makePageEntities("p1", 20, ["p1-2", "p1-5", "p1-10", "p1-15", "p1-20"]);
    // Page 2: ids p2-1..p2-20 plus p1-20 dup (Toptal can repeat ids near sort boundary).
    // Viewed: p2-3, p2-7, p1-20 (dup, will be deduped).
    const page2Entities = [
      ...makePageEntities("p2", 19, ["p2-3", "p2-7"]),
      { ...JOB_LIST_ENTITY, id: "p1-20", viewed: true }, // duplicate already seen on page 1
    ];
    // Page 3: ids p3-1..p3-5. Viewed: p3-1, p3-4.
    const page3Entities = makePageEntities("p3", 5, ["p3-1", "p3-4"]);

    reply(
      {
        body: {
          data: {
            viewer: { id: "v1", eligibleJobs: { entities: page1Entities, totalCount: 45 } },
          },
        },
      },
      {
        body: {
          data: {
            viewer: { id: "v1", eligibleJobs: { entities: page2Entities, totalCount: 45 } },
          },
        },
      },
      {
        body: {
          data: {
            viewer: { id: "v1", eligibleJobs: { entities: page3Entities, totalCount: 45 } },
          },
        },
      },
    );

    const page = await viewedList(TOKEN);
    expect(mockedStock.mock.calls).toHaveLength(3);
    // 5 + 2 (post-dedup) + 2 = 9 distinct viewed jobs.
    expect(page.totalCount).toBe(9);
    // Default page=1, perPage=20 → all 9 returned (less than perPage).
    expect(page.items).toHaveLength(9);
    // Sanity: each id is distinct (dedup proof).
    expect(new Set(page.items.map((it) => it.id)).size).toBe(9);
    // Verify ordering: page 1 viewed items first (preserves wire ordering), then page 2's new viewed, then page 3's.
    expect(page.items.map((it) => it.id)).toEqual([
      "p1-2",
      "p1-5",
      "p1-10",
      "p1-15",
      "p1-20",
      "p2-3",
      "p2-7",
      "p3-1",
      "p3-4",
    ]);
  });

  it("opts.page / opts.perPage slice the POST-FILTER aggregated list", async () => {
    // Single page with 25 entities: but only 7 are viewed.
    // Caller asks for page 2 with perPage 3 → expect items 4-6 (0-indexed 3-5) of the 7 viewed.
    const entities: unknown[] = [];
    for (let i = 1; i <= 25; i++) {
      const isViewed = [2, 4, 7, 10, 13, 19, 25].includes(i);
      entities.push({ ...JOB_LIST_ENTITY, id: `job-${i.toString()}`, viewed: isViewed });
    }
    // Underlying fetch returns 25 items; totalCount=25 → first call's items.length=25 < perPage=20 is FALSE,
    // but scannedItemCount (1*20=20) < 25, so a second call happens.
    // We need to set up two replies. Both return the same "remaining" pool — but for testing simplicity,
    // we make page 1 return 20 items (first 20 of the 25) and page 2 return the remaining 5.
    const page1Entities = entities.slice(0, 20);
    const page2Entities = entities.slice(20);
    reply(
      {
        body: {
          data: { viewer: { id: "v1", eligibleJobs: { entities: page1Entities, totalCount: 25 } } },
        },
      },
      {
        body: {
          data: { viewer: { id: "v1", eligibleJobs: { entities: page2Entities, totalCount: 25 } } },
        },
      },
    );

    const page = await viewedList(TOKEN, { page: 2, perPage: 3 });
    // 7 viewed total; slice (page 2, perPage 3) = items at index 3, 4, 5 = job-10, job-13, job-19.
    expect(page.totalCount).toBe(7);
    expect(page.page).toBe(2);
    expect(page.perPage).toBe(3);
    expect(page.items.map((it) => it.id)).toEqual(["job-10", "job-13", "job-19"]);
  });

  it("threads filter inputs (skills, keywords, …) through the underlying list() call but ignores caller's page/perPage on the wire", async () => {
    // Single underlying page so we don't need multi-reply setup.
    reply({
      body: { data: { viewer: { id: "v1", eligibleJobs: { entities: [], totalCount: 0 } } } },
    });
    await viewedList(TOKEN, { skills: ["React"], keywords: ["remote"], page: 3, perPage: 7 });
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    // Filter inputs thread through verbatim.
    expect(body.variables["skills"]).toEqual(["React"]);
    expect(body.variables["keywords"]).toEqual(["remote"]);
    // The caller's page/perPage do NOT thread to the wire — the internal fetch always
    // uses page=1, pageSize=20 (the captured-and-verified wire values).
    expect(body.variables["page"]).toBe(1);
    expect(body.variables["pageSize"]).toBe(20);
  });

  it("returns empty post-filter list when no item has viewed=true", async () => {
    reply({
      body: {
        data: {
          viewer: { id: "v1", eligibleJobs: { entities: [JOB_LIST_ENTITY], totalCount: 1 } },
        },
      },
    });
    const page = await viewedList(TOKEN);
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(20);
  });
});

describe("jobs.show", () => {
  it("returns the projected detail", async () => {
    reply({
      body: { data: { viewer: { id: "v1", job: JOB_DETAIL_ENTITY } } },
    });
    const job = await show(TOKEN, "job-1");
    expect(job.id).toBe("job-1");
    expect(job.descriptionMd).toBe("We're hiring a React engineer.");
    expect(job.skills).toHaveLength(1);
    expect(job.skills[0]).toMatchObject({ id: "sk-1", name: "React", rating: 5 });
    expect(job.languages).toEqual([{ id: "lang-1", name: "English" }]);
  });

  it("projects counterparty identity: contacts + pointsOfContact (#545)", async () => {
    reply({
      body: { data: { viewer: { id: "v1", job: JOB_DETAIL_ENTITY } } },
    });
    const job = await show(TOKEN, "job-1");

    // contacts: trailing null filtered; __typename dropped; fields projected.
    expect(job.contacts).toHaveLength(1);
    expect(job.contacts[0]?.fullName).toBe("Jane Doe");
    expect(job.contacts[0]?.email).toBe("jane@acme.com");
    expect(job.contacts[0]?.position).toBe("Hiring Manager");
    expect(job.contacts[0]?.timeZone?.location).toBe("America/New_York");
    expect(job.contacts[0]?.timeZone?.name).toBe("Eastern Time (US & Canada)");
    expect(job.contacts[0]).not.toHaveProperty("__typename");

    // pointsOfContact.current — the Toptal-side recruiter; handoff null here.
    expect(job.pointsOfContact?.current?.fullName).toBe("Alex Recruiter");
    expect(job.pointsOfContact?.current?.contactFields?.email).toBe("alex@toptal.com");
    expect(job.pointsOfContact?.current?.photo?.small).toBe("https://cdn.example/alex-small.jpg");
    expect(job.pointsOfContact?.current?.vacation?.endDate).toBe("2026-07-08");
    expect(job.pointsOfContact?.current?.timeZone?.name).toBe("London");
    expect(job.pointsOfContact?.handoff).toBeNull();
    expect(job.pointsOfContact?.kind).toBe("standard");
  });

  it("projects empty contacts + null pointsOfContact when the wire elides them (#545)", async () => {
    reply({
      body: {
        data: {
          viewer: { id: "v1", job: { ...JOB_DETAIL_ENTITY, contacts: [], pointsOfContact: null } },
        },
      },
    });
    const job = await show(TOKEN, "job-1");
    expect(job.contacts).toEqual([]);
    expect(job.pointsOfContact).toBeNull();
  });

  it("translates `Record not found` GraphQL error to NOT_FOUND", async () => {
    reply({
      body: { data: null, errors: [{ message: "Record not found" }] },
    });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({
      name: "JobsError",
      code: "NOT_FOUND",
    });
  });

  it("translates `Invalid ID` GraphQL error to NOT_FOUND (#166)", async () => {
    // Live-observed: the mobile-gateway uses `Invalid ID` (NOT
    // `Record not found`) for malformed job IDs — verified against
    // `https://www.toptal.com/gateway/graphql/talent/graphql` during
    // #148 E2E. Both messages collapse to the same user-visible code.
    reply({
      body: { data: null, errors: [{ message: "JobShow failed: Invalid ID" }] },
    });
    await expect(show(TOKEN, "garbage")).rejects.toMatchObject({
      name: "JobsError",
      code: "NOT_FOUND",
    });
  });

  it("translates viewer.job=null to NOT_FOUND", async () => {
    reply({
      body: { data: { viewer: { id: "v1", job: null } } },
    });
    await expect(show(TOKEN, "missing")).rejects.toMatchObject({
      name: "JobsError",
      code: "NOT_FOUND",
    });
  });
});

// ----- Recruiter Fixed rate projection (issue #410) --------------------
//
// `viewer.{job(id), eligibleJobs.entities[]}.activityItem.availabilityRequest
// .metadata.offeredHourlyRate` is lifted into a row-level `fixedRate`
// projection field so callers can disambiguate "marketplace ceiling"
// (`maxRate`, often null) from "recruiter-pinned offer" (`fixedRate`,
// the portal's "Fixed" badge). Both list and show paths share the
// projection; both nullability branches (AR present, AR null) are
// covered here.

describe("jobs fixedRate projection (#410)", () => {
  it("lists projects fixedRate from activityItem.availabilityRequest.metadata", async () => {
    const fixedRateEntity = {
      ...JOB_LIST_ENTITY,
      id: "job-fixed",
      activityItem: {
        __typename: "TalentJobActivityItem",
        id: "act-1",
        availabilityRequest: {
          __typename: "AvailabilityRequest",
          id: "ar-1",
          metadata: {
            __typename: "AvailabilityRequestFixedMetadata",
            offeredHourlyRate: { __typename: "Money", decimal: "77.00", verbose: "$77.00/hr" },
          },
        },
      },
    };
    reply({
      body: {
        data: { viewer: { id: "v1", eligibleJobs: { entities: [fixedRateEntity], totalCount: 1 } } },
      },
    });
    const page = await list(TOKEN);
    expect(page.items[0]?.fixedRate).toEqual({ decimal: "77.00", verbose: "$77.00/hr" });
  });

  it("lists projects fixedRate=null when the row's activityItem has no availabilityRequest", async () => {
    // Common case for `eligibleJobs` browse rows the talent hasn't
    // engaged: `activityItem` exists but `availabilityRequest` is null.
    const noArEntity = {
      ...JOB_LIST_ENTITY,
      activityItem: {
        __typename: "TalentJobActivityItem",
        id: "act-2",
        availabilityRequest: null,
      },
    };
    reply({
      body: {
        data: { viewer: { id: "v1", eligibleJobs: { entities: [noArEntity], totalCount: 1 } } },
      },
    });
    const page = await list(TOKEN);
    expect(page.items[0]?.fixedRate).toBeNull();
  });

  it("lists projects fixedRate=null when the row carries no activityItem at all (defensive)", async () => {
    // The schema marks `TalentJob.activityItem: TalentJobActivityItem!`
    // non-null; this case is the defensive wire-drift branch covered by
    // the `undefined`-tolerant `projectFixedRate`.
    reply({
      body: {
        data: { viewer: { id: "v1", eligibleJobs: { entities: [JOB_LIST_ENTITY], totalCount: 1 } } },
      },
    });
    const page = await list(TOKEN);
    expect(page.items[0]?.fixedRate).toBeNull();
  });

  it("show projects fixedRate from activityItem.availabilityRequest.metadata", async () => {
    const fixedRateDetail = {
      ...JOB_DETAIL_ENTITY,
      activityItem: {
        __typename: "TalentJobActivityItem",
        id: "act-3",
        availabilityRequest: {
          __typename: "AvailabilityRequest",
          id: "ar-3",
          metadata: {
            __typename: "AvailabilityRequestFixedMetadata",
            offeredHourlyRate: { __typename: "Money", decimal: "109.00", verbose: "$109.00/hr" },
          },
        },
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", job: fixedRateDetail } } },
    });
    const job = await show(TOKEN, "job-1");
    expect(job.fixedRate).toEqual({ decimal: "109.00", verbose: "$109.00/hr" });
  });

  it("show projects fixedRate=null when the job's availabilityRequest is null", async () => {
    const noArDetail = {
      ...JOB_DETAIL_ENTITY,
      activityItem: {
        __typename: "TalentJobActivityItem",
        id: "act-4",
        availabilityRequest: null,
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", job: noArDetail } } },
    });
    const job = await show(TOKEN, "job-1");
    expect(job.fixedRate).toBeNull();
  });

  // Per the #530 schema split, `AvailabilityRequestMetadata` is a
  // polymorphic supertype and `offeredHourlyRate` is only selected on
  // the `AvailabilityRequestFixedMetadata` inline fragment. Non-Fixed
  // variants return `metadata.__typename` but no `offeredHourlyRate`,
  // so `fixedRate` must project to `null` for those rows on both the
  // list and show paths.
  it.each([["AvailabilityRequestFlexibleMetadata"], ["MarketplaceAvailabilityRequestFlexibleMetadata"]])(
    "lists projects fixedRate=null when metadata is non-Fixed variant %s (#530)",
    async (typename) => {
      const flexibleEntity = {
        ...JOB_LIST_ENTITY,
        id: "job-flex",
        activityItem: {
          __typename: "TalentJobActivityItem",
          id: "act-flex",
          availabilityRequest: {
            __typename: "AvailabilityRequest",
            id: "ar-flex",
            metadata: { __typename: typename },
          },
        },
      };
      reply({
        body: {
          data: { viewer: { id: "v1", eligibleJobs: { entities: [flexibleEntity], totalCount: 1 } } },
        },
      });
      const page = await list(TOKEN);
      expect(page.items[0]?.fixedRate).toBeNull();
    },
  );

  it("show projects fixedRate=null when metadata is non-Fixed variant (#530)", async () => {
    const flexibleDetail = {
      ...JOB_DETAIL_ENTITY,
      activityItem: {
        __typename: "TalentJobActivityItem",
        id: "act-flex-show",
        availabilityRequest: {
          __typename: "AvailabilityRequest",
          id: "ar-flex-show",
          metadata: { __typename: "AvailabilityRequestFlexibleMetadata" },
        },
      },
    };
    reply({
      body: { data: { viewer: { id: "v1", job: flexibleDetail } } },
    });
    const job = await show(TOKEN, "job-1");
    expect(job.fixedRate).toBeNull();
  });
});

describe("jobs interest mutations", () => {
  it("save() returns the post-mutation state wrapped in an applied outcome", async () => {
    reply({
      body: {
        data: {
          job: {
            __typename: "TalentJob",
            markSaved: {
              __typename: "JobMarkSavedPayload",
              success: true,
              errors: [],
              job: INTEREST_STATE,
            },
          },
        },
      },
    });
    const outcome = await save(TOKEN, "job-1");
    expect(outcome).toEqual({
      kind: "applied",
      result: { id: "job-1", saved: true, notInterested: false, viewed: false },
    });
  });

  it("unsave() routes to ClearJobInterestStatus", async () => {
    reply({
      body: {
        data: {
          job: {
            __typename: "TalentJob",
            clearInterestStatus: {
              __typename: "JobClearInterestPayload",
              success: true,
              errors: [],
              job: { ...INTEREST_STATE, saved: false },
            },
          },
        },
      },
    });
    const outcome = await unsave(TOKEN, "job-1");
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.saved).toBe(false);
    const body = mockedStock.mock.calls[0]?.[0].body as { operationName: string };
    expect(body.operationName).toBe("JobClearInterest");
  });

  it("notInterested() requires reason and surfaces it on the wire", async () => {
    reply({
      body: {
        data: {
          job: {
            markNotInterested: {
              success: true,
              errors: [],
              job: { ...INTEREST_STATE, saved: false, notInterested: true },
            },
          },
        },
      },
    });
    await notInterested(TOKEN, "job-1", { reason: "not_a_match" });
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    expect(body.variables["reason"]).toBe("not_a_match");
  });

  it("markViewed() returns the post-mutation state wrapped in an applied outcome", async () => {
    reply({
      body: {
        data: {
          job: {
            markViewed: {
              success: true,
              errors: [],
              job: { ...INTEREST_STATE, saved: false, viewed: true },
            },
          },
        },
      },
    });
    const outcome = await markViewed(TOKEN, "job-1");
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.viewed).toBe(true);
  });

  it("clearInterest() returns the post-mutation state wrapped in an applied outcome", async () => {
    reply({
      body: {
        data: {
          job: {
            clearInterestStatus: {
              success: true,
              errors: [],
              job: { id: "job-1", saved: false, notInterested: false, viewed: true },
            },
          },
        },
      },
    });
    const outcome = await clearInterest(TOKEN, "job-1");
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.saved).toBe(false);
    expect(outcome.result.notInterested).toBe(false);
  });

  it("translates success:false to MUTATION_ERROR with formatted errors", async () => {
    reply({
      body: {
        data: {
          job: {
            markSaved: {
              success: false,
              errors: [{ key: "jobID", message: "already saved", code: "conflict" }],
              job: null,
            },
          },
        },
      },
    });
    await expect(save(TOKEN, "job-1")).rejects.toMatchObject({
      name: "JobsError",
      code: "MUTATION_ERROR",
    });
  });

  it("translates job=null to NOT_FOUND", async () => {
    reply({ body: { data: { job: null } } });
    await expect(save(TOKEN, "missing")).rejects.toMatchObject({
      name: "JobsError",
      code: "NOT_FOUND",
    });
  });
});

describe("jobs.searchSubscription", () => {
  it("show returns active=false when subscription is null", async () => {
    reply({
      body: { data: { viewer: { id: "v1", searchSubscription: null } } },
    });
    const state = await searchSubscriptionShow(TOKEN);
    expect(state).toEqual({ active: false, filters: null });
  });

  it("show projects active subscription filters", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            searchSubscription: {
              __typename: "SearchSubscription",
              skills: ["React"],
              keywords: ["remote"],
              excludeSkills: null,
              excludeKeywords: null,
              commitmentsV2: ["FULL_TIME"],
              workTypesV2: null,
              estimatedLengths: null,
              excludeUnspecifiedBudget: false,
            },
          },
        },
      },
    });
    const state = await searchSubscriptionShow(TOKEN);
    expect(state.active).toBe(true);
    expect(state.filters).toEqual({
      skills: ["React"],
      keywords: ["remote"],
      commitments: ["FULL_TIME"],
      excludeUnspecifiedBudget: false,
    });
  });

  it("save passes filters through and returns projected state wrapped in an applied outcome", async () => {
    reply({
      body: {
        data: {
          searchSubscription: {
            start: {
              success: true,
              errors: [],
              viewer: {
                id: "v1",
                searchSubscription: {
                  skills: ["React"],
                  keywords: null,
                  excludeSkills: null,
                  excludeKeywords: null,
                  commitmentsV2: null,
                  workTypesV2: null,
                  estimatedLengths: null,
                  excludeUnspecifiedBudget: null,
                },
              },
            },
          },
        },
      },
    });
    const outcome = await searchSubscriptionSave(TOKEN, { skills: ["React"] });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied outcome");
    expect(outcome.result.active).toBe(true);
    expect(outcome.result.filters?.skills).toEqual(["React"]);
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    expect(body.variables["skills"]).toEqual(["React"]);
    expect(body.variables["keywords"]).toBeNull();
  });

  it("remove returns {terminated: true} wrapped in an applied outcome", async () => {
    reply({
      body: {
        data: {
          searchSubscription: {
            terminate: { success: true, errors: [] },
          },
        },
      },
    });
    const outcome = await searchSubscriptionRemove(TOKEN);
    expect(outcome).toEqual({ kind: "applied", result: { terminated: true } });
  });

  it("translates start success:false to MUTATION_ERROR", async () => {
    reply({
      body: {
        data: {
          searchSubscription: {
            start: {
              success: false,
              errors: [{ key: "skills", message: "invalid", code: "validation" }],
              viewer: null,
            },
          },
        },
      },
    });
    await expect(searchSubscriptionSave(TOKEN, {})).rejects.toMatchObject({
      name: "JobsError",
      code: "MUTATION_ERROR",
    });
  });
});

// ---------------------------------------------------------------------
// dry-run path (issue #162)
//
// Per the AC for #162, every mutation entry point with `dryRun: true`
// must:
//   - SHORT-CIRCUIT — `stockTransport` is never called (transport-zero AC)
//   - return `{ kind: "preview", preview: <DryRunPreview> }`
//   - the preview surfaces the operation name from the issue's mapping
//     table verbatim, the mobile-gateway transport classification,
//     the literal variables payload, and a redacted Authorization header
// Tests assert the wire-shape contract end-to-end.
// ---------------------------------------------------------------------
describe("jobs dry-run path (issue #162)", () => {
  it("save({ dryRun: true }) returns preview without invoking transport (transport-zero AC)", async () => {
    const outcome = await save(TOKEN, "job-1", { dryRun: true });
    // The CRITICAL AC: zero transport calls in dry-run path.
    expect(mockedStock).not.toHaveBeenCalled();
    // Discriminator + preview shape.
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("JobMarkSaved");
    expect(outcome.preview.surface).toBe("mobile-gateway");
    expect(outcome.preview.transport).toBe("stock");
    expect(outcome.preview.variables).toEqual({ jobID: "job-1" });
    // Bearer redaction.
    expect(outcome.preview.headers["authorization"]).toBe("Token token=<redacted>");
    expect(outcome.preview.headers["authorization"]).not.toContain(TOKEN);
  });

  it("unsave({ dryRun: true }) reports the JobClearInterest wire operation (delegated)", async () => {
    const outcome = await unsave(TOKEN, "job-1", { dryRun: true });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    // unsave delegates to clearInterest, so the wire op is JobClearInterest.
    expect(outcome.preview.operationName).toBe("JobClearInterest");
    expect(outcome.preview.variables).toEqual({ jobID: "job-1" });
  });

  it("markViewed({ dryRun: true }) returns preview without invoking transport", async () => {
    const outcome = await markViewed(TOKEN, "job-1", { dryRun: true });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("JobMarkViewed");
    expect(outcome.preview.variables).toEqual({ jobID: "job-1" });
  });

  it("notInterested({ dryRun: true }) preserves reason in preview variables", async () => {
    const outcome = await notInterested(TOKEN, "job-1", { reason: "low_rate" }, { dryRun: true });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("JobMarkNotInterested");
    expect(outcome.preview.variables).toEqual({ jobID: "job-1", reason: "low_rate" });
  });

  it("clearInterest({ dryRun: true }) returns preview without invoking transport", async () => {
    const outcome = await clearInterest(TOKEN, "job-1", { dryRun: true });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("JobClearInterest");
    expect(outcome.preview.variables).toEqual({ jobID: "job-1" });
  });

  it("searchSubscriptionSave({ dryRun: true }) normalises filters identically to the apply path", async () => {
    const outcome = await searchSubscriptionSave(
      TOKEN,
      { skills: ["React"], keywords: [], excludeUnspecifiedBudget: true },
      { dryRun: true },
    );
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("JobSearchSubscriptionStart");
    // Empty arrays normalised to null (matches apply path).
    expect(outcome.preview.variables["skills"]).toEqual(["React"]);
    expect(outcome.preview.variables["keywords"]).toBeNull();
    expect(outcome.preview.variables["excludeUnspecifiedBudget"]).toBe(true);
  });

  it("searchSubscriptionRemove({ dryRun: true }) returns preview with empty variables", async () => {
    const outcome = await searchSubscriptionRemove(TOKEN, { dryRun: true });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("expected preview outcome");
    expect(outcome.preview.operationName).toBe("JobSearchSubscriptionTerminate");
    expect(outcome.preview.variables).toEqual({});
  });

  it("explicit `dryRun: false` is the apply path (ensures option does not invert)", async () => {
    reply({
      body: {
        data: {
          job: {
            markSaved: { success: true, errors: [], job: INTEREST_STATE },
          },
        },
      },
    });
    const outcome = await save(TOKEN, "job-1", { dryRun: false });
    // Apply-path: transport was called once.
    expect(mockedStock).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("applied");
  });

  it("omitting options entirely is the apply path (default behavior)", async () => {
    reply({
      body: {
        data: {
          job: {
            markViewed: { success: true, errors: [], job: { ...INTEREST_STATE, viewed: true } },
          },
        },
      },
    });
    const outcome = await markViewed(TOKEN, "job-1");
    expect(mockedStock).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("applied");
  });
});

describe("jobs error handling", () => {
  it("translates HTTP 401 to AuthRevokedError", async () => {
    reply({ status: 401, body: {} });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("translates auth-revoked extension code to AuthRevokedError", async () => {
    reply({
      body: { data: null, errors: [{ message: "auth", extensions: { code: "UNAUTHENTICATED" } }] },
    });
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("translates transport throw to NETWORK_ERROR", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(list(TOKEN)).rejects.toMatchObject({ name: "JobsError", code: "NETWORK_ERROR" });
  });

  it("translates viewer=null to NO_VIEWER", async () => {
    reply({ body: { data: { viewer: null } } });
    await expect(list(TOKEN)).rejects.toMatchObject({ name: "JobsError", code: "NO_VIEWER" });
  });

  it("JobsError carries the code", () => {
    const err = new JobsError("MUTATION_ERROR", "test");
    expect(err.code).toBe("MUTATION_ERROR");
    expect(err.name).toBe("JobsError");
  });
});
