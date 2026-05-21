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
  STATUS_GROUPS,
  ApplicationsError,
  applyData,
  applyQuestions,
  confirm,
  list,
  rateInsight,
  reject,
  rejectReasons,
  show,
  stats,
} from "../index.js";
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
    // The public availabilityRequest is narrowed to {id}; the Money
    // payload no longer rides on it.
    expect(res.items[0]?.availabilityRequest).toEqual({ id: "ar-1" });
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
    expect(item.availabilityRequest).toEqual({ id: "ar-9" });
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
  it("forwards matcher/expertise/pitch payloads verbatim into the mutation variables (#423)", async () => {
    reply({ body: confirmSuccessFixture() });
    const matcherQuestionsAnswers = [
      { questionId: "MQ-1", answer: "matcher answer one" },
      { questionId: "MQ-2", answer: "matcher answer two" },
    ];
    const expertiseQuestionsAnswers = [{ questionId: "EQ-1", answer: "expertise answer" }];
    const pitchInput = { message: "Pitch text" };
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
