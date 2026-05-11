// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// All availability ops run against mobile-gateway via `stockTransport`.
vi.mock("../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport.js")>("../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { allocatedHours, show, workingHours } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-av-123";

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

const SNAPSHOT_FIXTURE = {
  viewer: {
    __typename: "Viewer",
    id: "viewer-1",
    viewerRole: {
      __typename: "ViewerRole",
      allocatedHours: 40,
      timeZone: {
        __typename: "TimeZone",
        name: "Central European Time",
        value: "Europe/Berlin",
        location: "Berlin, Germany",
        utcOffset: "+01:00",
        stdOffset: "+01:00",
      },
      workingTimeFrom: "09:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: "07:00:00",
      availableShiftRangeTo: "19:00:00",
      profile: { __typename: "Profile", id: "prof-1" },
    },
  },
};

const UPDATE_WH_PROFILE = {
  __typename: "Profile",
  id: "prof-1",
  timeZone: {
    __typename: "TimeZone",
    name: "Central European Time",
    value: "Europe/Berlin",
    location: "Berlin, Germany",
    utcOffset: "+01:00",
    stdOffset: "+01:00",
  },
  workingTimeFrom: "08:00:00",
  workingTimeTo: "16:00:00",
  availableShiftRangeFrom: "06:00:00",
  availableShiftRangeTo: "18:00:00",
};

const UPDATE_ALLOC_VIEWER = {
  __typename: "Viewer",
  id: "viewer-1",
  viewerRole: {
    __typename: "ViewerRole",
    allocatedHours: 35,
    hiredHours: 0,
  },
};

beforeEach(() => {
  mockedStock.mockReset();
});

describe("availability.show", () => {
  it("returns the full snapshot when viewer + viewerRole are present", async () => {
    reply({ body: { data: SNAPSHOT_FIXTURE } });
    const snap = await show(TOKEN);
    expect(snap).toMatchObject({
      viewerId: "viewer-1",
      profileId: "prof-1",
      workingTimeFrom: "09:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: "07:00:00",
      availableShiftRangeTo: "19:00:00",
      allocatedHours: 40,
    });
    expect(snap.timeZone?.value).toBe("Europe/Berlin");
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "GetAvailability",
      variables: {},
    });
    expect(call?.surface).toBe("mobile-gateway");
  });

  it("throws AvailabilityError(NO_VIEWER) when viewer is null", async () => {
    reply({ body: { data: { viewer: null } } });
    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "NO_VIEWER",
    });
  });

  it("throws AvailabilityError(NO_VIEWER_ROLE) when viewerRole is null", async () => {
    reply({
      body: {
        data: { viewer: { id: "viewer-1", viewerRole: null } },
      },
    });
    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "NO_VIEWER_ROLE",
    });
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    reply({ status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    await expect(show(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError when GraphQL errors carry an UNAUTHORIZED extension code", async () => {
    reply({
      body: { errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHORIZED" } }] },
    });
    await expect(show(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AvailabilityError(GRAPHQL_ERROR) on a generic GraphQL error", async () => {
    reply({ body: { errors: [{ message: "Internal server error" }] } });
    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "GRAPHQL_ERROR",
    });
  });

  it("throws AvailabilityError(NETWORK_ERROR) when transport throws", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "NETWORK_ERROR",
    });
  });

  it("throws AvailabilityError(UNKNOWN) on non-2xx without GraphQL errors", async () => {
    reply({ status: 500, body: { data: null } });
    await expect(show(TOKEN)).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "UNKNOWN",
    });
  });
});

describe("availability.workingHours.show", () => {
  it("returns the working-hours subset (no allocatedHours)", async () => {
    reply({ body: { data: SNAPSHOT_FIXTURE } });
    const data = await workingHours.show(TOKEN);
    expect(data).toEqual({
      viewerId: "viewer-1",
      timeZone: SNAPSHOT_FIXTURE.viewer.viewerRole.timeZone,
      workingTimeFrom: "09:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: "07:00:00",
      availableShiftRangeTo: "19:00:00",
    });
    expect((data as Record<string, unknown>)["allocatedHours"]).toBeUndefined();
  });
});

describe("availability.workingHours.set", () => {
  it("wraps profile fields under profileId + profile, fetching profileId via GetAvailability first", async () => {
    reply(
      { body: { data: SNAPSHOT_FIXTURE } },
      {
        body: {
          data: {
            updateWorkingHours: {
              __typename: "UpdateWorkingHoursPayload",
              success: true,
              notice: null,
              errors: null,
              profile: { ...UPDATE_WH_PROFILE, workingTimeFrom: "10:00:00", workingTimeTo: "18:00:00" },
            },
          },
        },
      },
    );
    const result = await workingHours.set(TOKEN, { workingTimeFrom: "10:00:00", workingTimeTo: "18:00:00" });
    expect(result.workingTimeFrom).toBe("10:00:00");
    expect(result.workingTimeTo).toBe("18:00:00");

    // First call: GetAvailability (fetches profileId).
    const firstCall = mockedStock.mock.calls[0]?.[0];
    expect(firstCall?.body).toMatchObject({ operationName: "GetAvailability" });

    // Second call: UpdateWorkingHours with the nested wire shape.
    const mutationCall = mockedStock.mock.calls[1]?.[0];
    expect(mutationCall?.body).toMatchObject({
      operationName: "UpdateWorkingHours",
      variables: {
        input: {
          profileId: "prof-1",
          profile: { workingTimeFrom: "10:00:00", workingTimeTo: "18:00:00" },
        },
      },
    });
    // Profile sub-object only includes the supplied fields.
    const profile =
      (
        (mutationCall?.body ?? {}) as {
          variables?: { input?: { profile?: Record<string, unknown> } };
        }
      ).variables?.input?.profile ?? {};
    expect(Object.keys(profile).sort()).toEqual(["workingTimeFrom", "workingTimeTo"]);
  });

  it("includes timeZone + flex range when supplied (inside the nested `profile` object)", async () => {
    reply(
      { body: { data: SNAPSHOT_FIXTURE } },
      {
        body: {
          data: {
            updateWorkingHours: {
              __typename: "UpdateWorkingHoursPayload",
              success: true,
              notice: "Working hours updated",
              errors: null,
              profile: UPDATE_WH_PROFILE,
            },
          },
        },
      },
    );
    const result = await workingHours.set(TOKEN, {
      timeZone: "Europe/Berlin",
      availableShiftRangeFrom: "06:00:00",
      availableShiftRangeTo: "18:00:00",
    });
    expect(result.notice).toBe("Working hours updated");
    expect(result.timeZone?.value).toBe("Europe/Berlin");

    const mutationCall = mockedStock.mock.calls[1]?.[0];
    const profile =
      (
        (mutationCall?.body ?? {}) as {
          variables?: { input?: { profile?: Record<string, unknown> } };
        }
      ).variables?.input?.profile ?? {};
    expect(Object.keys(profile).sort()).toEqual(["availableShiftRangeFrom", "availableShiftRangeTo", "timeZone"]);
  });

  it("throws AvailabilityError(MUTATION_ERROR) on empty input, before the snapshot fetch", async () => {
    await expect(workingHours.set(TOKEN, {})).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "MUTATION_ERROR",
    });
    // Did NOT issue any transport call — empty-input gate fires synchronously.
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("throws AvailabilityError(MUTATION_ERROR) on success=false", async () => {
    reply(
      { body: { data: SNAPSHOT_FIXTURE } },
      {
        body: {
          data: {
            updateWorkingHours: {
              __typename: "UpdateWorkingHoursPayload",
              success: false,
              notice: null,
              errors: [{ code: "invalid", key: "workingTimeFrom", message: "Invalid time format" }],
              profile: null,
            },
          },
        },
      },
    );
    await expect(workingHours.set(TOKEN, { workingTimeFrom: "bad" })).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "MUTATION_ERROR",
    });
  });
});

describe("availability.allocatedHours.show", () => {
  it("returns just the allocatedHours value", async () => {
    reply({ body: { data: SNAPSHOT_FIXTURE } });
    const data = await allocatedHours.show(TOKEN);
    expect(data).toEqual({ allocatedHours: 40 });
  });
});

describe("availability.allocatedHours.set", () => {
  it("issues UpdateAllocatedHours with the supplied integer", async () => {
    reply({
      body: {
        data: {
          viewerRole: {
            __typename: "ViewerRoleOps",
            update: {
              __typename: "ViewerRoleUpdatePayload",
              success: true,
              notice: "Allocated hours updated",
              errors: null,
              viewer: UPDATE_ALLOC_VIEWER,
            },
          },
        },
      },
    });
    const result = await allocatedHours.set(TOKEN, 35);
    expect(result).toEqual({ allocatedHours: 35, hiredHours: 0, notice: "Allocated hours updated" });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body).toMatchObject({
      operationName: "UpdateAllocatedHours",
      variables: { hours: 35 },
    });
  });

  it("rejects non-integer hours synchronously (before transport)", async () => {
    await expect(allocatedHours.set(TOKEN, 3.5)).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "MUTATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects negative hours synchronously", async () => {
    await expect(allocatedHours.set(TOKEN, -1)).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "MUTATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("throws MUTATION_ERROR on success=false", async () => {
    reply({
      body: {
        data: {
          viewerRole: {
            __typename: "ViewerRoleOps",
            update: {
              __typename: "ViewerRoleUpdatePayload",
              success: false,
              notice: null,
              errors: [{ code: "out_of_range", key: "allocatedHours", message: "Must be ≤ 80" }],
              viewer: null,
            },
          },
        },
      },
    });
    await expect(allocatedHours.set(TOKEN, 100)).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "MUTATION_ERROR",
    });
  });
});
