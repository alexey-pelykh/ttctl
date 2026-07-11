// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `TimesheetsByIDs` runs against mobile-gateway via `stockTransport`.
vi.mock("../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport/index.js")>("../../../transport/index.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { MAX_SHOW_MANY_IDS, showMany } from "../index.js";
import { stockTransport } from "../../../transport/index.js";
import type { TransportResponse } from "../../../transport/index.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-ts-by-ids";

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

function node(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "BillingCycle",
    id,
    startDate: "2026-04-01",
    endDate: "2026-04-15",
    hours: "80.0",
    minimumCommitment: {
      __typename: "MinimumCommitment",
      applicable: false,
      minimumHours: null,
      reasonNotApplicable: null,
    },
    timesheetOverdue: false,
    timesheetSubmissionOpenDatetime: "2026-04-16T00:00:00+00:00",
    timesheetSubmissionDeadlineDatetime: "2026-04-20T00:00:00+00:00",
    timesheetSubmitted: true,
    timesheetApproved: false,
    timesheetRequiresApproval: true,
    status: "SUBMITTED",
    engagement: {
      __typename: "TalentEngagement",
      id: "eng-1",
      job: {
        __typename: "Job",
        id: "job-1",
        title: "Senior Engineer",
        client: { __typename: "Client", id: "cli-1", fullName: "Acme" },
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockedStock.mockReset();
});

describe("timesheet.showMany (TimesheetsByIDs)", () => {
  it("returns the projected timesheets in INPUT order, regardless of wire order", async () => {
    // Wire returns bc-1 then bc-2; caller asked for [bc-2, bc-1].
    reply({ body: { data: { nodes: [node("bc-1"), node("bc-2", { hours: "40.0" })] } } });
    const out = await showMany(TOKEN, ["bc-2", "bc-1"]);
    expect(out.map((t) => t.id)).toEqual(["bc-2", "bc-1"]);
    expect(out[0]?.hours).toBe("40.0");
  });

  it("passes the id list through to the wire as TimesheetsByIDs", async () => {
    reply({ body: { data: { nodes: [node("bc-1")] } } });
    await showMany(TOKEN, ["bc-1"]);
    const body = mockedStock.mock.calls[0]?.[0].body as { operationName: string; variables: { ids: string[] } };
    expect(body.operationName).toBe("TimesheetsByIDs");
    expect(body.variables.ids).toEqual(["bc-1"]);
  });

  it("projects the full list-row shape including approval + engagement fields", async () => {
    reply({ body: { data: { nodes: [node("bc-1", { timesheetApproved: true, timesheetRequiresApproval: true })] } } });
    const out = await showMany(TOKEN, ["bc-1"]);
    expect(out[0]).toMatchObject({
      id: "bc-1",
      hours: "80.0",
      timesheetSubmitted: true,
      timesheetApproved: true,
      timesheetRequiresApproval: true,
      status: "SUBMITTED",
      engagement: {
        id: "eng-1",
        job: { id: "job-1", title: "Senior Engineer", client: { id: "cli-1", fullName: "Acme" } },
      },
    });
  });

  it("omits ids that resolve to no node (partial result)", async () => {
    reply({ body: { data: { nodes: [node("bc-1")] } } });
    const out = await showMany(TOKEN, ["bc-1", "bc-missing"]);
    expect(out.map((t) => t.id)).toEqual(["bc-1"]);
  });

  it("filters null nodes", async () => {
    reply({ body: { data: { nodes: [node("bc-1"), null] } } });
    const out = await showMany(TOKEN, ["bc-1", "bc-2"]);
    expect(out.map((t) => t.id)).toEqual(["bc-1"]);
  });

  it("returns [] when nodes is null", async () => {
    reply({ body: { data: { nodes: null } } });
    await expect(showMany(TOKEN, ["bc-1"])).resolves.toEqual([]);
  });

  it("rejects an empty id list without touching the wire", async () => {
    await expect(showMany(TOKEN, [])).rejects.toMatchObject({ name: "TimesheetError", code: "VALIDATION_ERROR" });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects more than MAX_SHOW_MANY_IDS ids without touching the wire", async () => {
    const tooMany = Array.from({ length: MAX_SHOW_MANY_IDS + 1 }, (_, i) => `bc-${i.toString()}`);
    await expect(showMany(TOKEN, tooMany)).rejects.toMatchObject({ name: "TimesheetError", code: "VALIDATION_ERROR" });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("propagates a GRAPHQL_ERROR when the wire rejects the whole batch on a bad id", async () => {
    reply({ body: { data: null, errors: [{ message: 'Node id "bogus" resolves to an unknown type Nonexistent.' }] } });
    await expect(showMany(TOKEN, ["bc-1", "bogus"])).rejects.toMatchObject({
      name: "TimesheetError",
      code: "GRAPHQL_ERROR",
    });
  });
});
