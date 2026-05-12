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

describe("jobs.viewedList", () => {
  it("client-side filters on viewed=true; pagination metadata reflects underlying fetch", async () => {
    const viewedEntity = { ...JOB_LIST_ENTITY, id: "job-2", viewed: true };
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
    // totalCount reflects the UNDERLYING fetch (pre-filter), not the post-filter count.
    expect(page.totalCount).toBe(2);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(20);
  });

  it("threads --page / --per-page through to the underlying list() call", async () => {
    reply({
      body: { data: { viewer: { id: "v1", eligibleJobs: { entities: [], totalCount: 0 } } } },
    });
    await viewedList(TOKEN, { page: 3, perPage: 7 });
    const body = mockedStock.mock.calls[0]?.[0].body as { variables: Record<string, unknown> };
    expect(body.variables["page"]).toBe(3);
    expect(body.variables["pageSize"]).toBe(7);
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
