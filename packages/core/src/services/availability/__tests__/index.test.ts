// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// All availability ops run against mobile-gateway via `stockTransport`.
vi.mock("../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport/index.js")>("../../../transport/index.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { allocatedHours, show, workingHours } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport/index.js";
import type { TransportResponse } from "../../../transport/index.js";

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
        utcOffset: 3600,
        stdOffset: 3600,
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
    utcOffset: 3600,
    stdOffset: 3600,
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
    const outcome = await workingHours.set(TOKEN, { workingTimeFrom: "10:00:00", workingTimeTo: "18:00:00" });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("unreachable");
    expect(outcome.result.workingTimeFrom).toBe("10:00:00");
    expect(outcome.result.workingTimeTo).toBe("18:00:00");

    // First call: GetAvailability (fetches profileId).
    const firstCall = mockedStock.mock.calls[0]?.[0];
    expect(firstCall?.body).toMatchObject({ operationName: "GetAvailability" });

    // Second call: UpdateWorkingHours with #608 merged shape.
    const mutationCall = mockedStock.mock.calls[1]?.[0];
    expect(mutationCall?.body).toMatchObject({
      operationName: "UpdateWorkingHours",
      variables: {
        input: {
          profileId: "prof-1",
          profile: {
            timeZone: "Europe/Berlin",
            workingTimeFrom: "10:00:00",
            workingTimeTo: "18:00:00",
            availableShiftRangeFrom: "07:00:00",
            availableShiftRangeTo: "19:00:00",
          },
        },
      },
    });
    const profile =
      (
        (mutationCall?.body ?? {}) as {
          variables?: { input?: { profile?: Record<string, unknown> } };
        }
      ).variables?.input?.profile ?? {};
    expect(Object.keys(profile).sort()).toEqual([
      "availableShiftRangeFrom",
      "availableShiftRangeTo",
      "timeZone",
      "workingTimeFrom",
      "workingTimeTo",
    ]);
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
    const outcome = await workingHours.set(TOKEN, {
      timeZone: "Europe/Berlin",
      availableShiftRangeFrom: "06:00:00",
      availableShiftRangeTo: "18:00:00",
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("unreachable");
    expect(outcome.result.notice).toBe("Working hours updated");
    expect(outcome.result.timeZone?.value).toBe("Europe/Berlin");

    const mutationCall = mockedStock.mock.calls[1]?.[0];
    const profile =
      (
        (mutationCall?.body ?? {}) as {
          variables?: { input?: { profile?: Record<string, unknown> } };
        }
      ).variables?.input?.profile ?? {};
    expect(Object.keys(profile).sort()).toEqual([
      "availableShiftRangeFrom",
      "availableShiftRangeTo",
      "timeZone",
      "workingTimeFrom",
      "workingTimeTo",
    ]);
  });

  // #608 — sibling to #604/#605/#607.

  it("#608 echoes unsent snap fields when caller supplies a partial input", async () => {
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
              profile: UPDATE_WH_PROFILE,
            },
          },
        },
      },
    );
    await workingHours.set(TOKEN, { workingTimeFrom: "08:00:00" });

    const mutationCall = mockedStock.mock.calls[1]?.[0];
    const profile =
      (
        (mutationCall?.body ?? {}) as {
          variables?: { input?: { profile?: Record<string, string> } };
        }
      ).variables?.input?.profile ?? {};
    expect(profile).toEqual({
      timeZone: "Europe/Berlin",
      workingTimeFrom: "08:00:00",
      workingTimeTo: "17:00:00",
      availableShiftRangeFrom: "07:00:00",
      availableShiftRangeTo: "19:00:00",
    });
  });

  it("#608 caller-supplied values override snap values", async () => {
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
              profile: UPDATE_WH_PROFILE,
            },
          },
        },
      },
    );
    await workingHours.set(TOKEN, { timeZone: "America/New_York", workingTimeFrom: "09:30:00" });

    const mutationCall = mockedStock.mock.calls[1]?.[0];
    const profile =
      (
        (mutationCall?.body ?? {}) as {
          variables?: { input?: { profile?: Record<string, string> } };
        }
      ).variables?.input?.profile ?? {};
    expect(profile.timeZone).toBe("America/New_York");
    expect(profile.workingTimeFrom).toBe("09:30:00");
  });

  it("#608 omits null snap fields from the merge when caller does not supply them", async () => {
    reply(
      {
        body: {
          data: {
            viewer: {
              ...SNAPSHOT_FIXTURE.viewer,
              viewerRole: {
                ...SNAPSHOT_FIXTURE.viewer.viewerRole,
                timeZone: null,
                workingTimeFrom: null,
                workingTimeTo: null,
              },
            },
          },
        },
      },
      {
        body: {
          data: {
            updateWorkingHours: {
              __typename: "UpdateWorkingHoursPayload",
              success: true,
              notice: null,
              errors: null,
              profile: UPDATE_WH_PROFILE,
            },
          },
        },
      },
    );
    await workingHours.set(TOKEN, { availableShiftRangeFrom: "08:00:00" });

    const mutationCall = mockedStock.mock.calls[1]?.[0];
    const profile =
      (
        (mutationCall?.body ?? {}) as {
          variables?: { input?: { profile?: Record<string, string> } };
        }
      ).variables?.input?.profile ?? {};
    expect(profile).toEqual({
      availableShiftRangeFrom: "08:00:00",
      availableShiftRangeTo: "19:00:00",
    });
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
    const outcome = await allocatedHours.set(TOKEN, 35);
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("unreachable");
    expect(outcome.result).toEqual({ allocatedHours: 35, hiredHours: 0, notice: "Allocated hours updated" });
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

describe("availability dry-run (issue #164)", () => {
  it("workingHours.set: { dryRun: true } returns a preview, no transport call (including the show() pre-fetch)", async () => {
    const outcome = await workingHours.set(
      TOKEN,
      { workingTimeFrom: "10:00:00", workingTimeTo: "18:00:00", timeZone: "Europe/Berlin" },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("unreachable");

    // Critical AC: NO transport call at all — neither the `show()`
    // profileId pre-fetch nor the `UpdateWorkingHours` mutation hit
    // the wire.
    expect(mockedStock).not.toHaveBeenCalled();

    expect(outcome.preview).toMatchObject({
      surface: "mobile-gateway",
      transport: "stock",
      operationName: "UpdateWorkingHours",
    });
    // Wire-shape: nested under input.{profileId, profile}, with the
    // placeholder profileId since the pre-fetch was skipped.
    const variables = outcome.preview.variables as {
      input: { profileId: string; profile: Record<string, string> };
    };
    expect(variables.input.profileId).toBe("<resolved at apply time>");
    expect(Object.keys(variables.input.profile).sort()).toEqual(["timeZone", "workingTimeFrom", "workingTimeTo"]);
    expect(variables.input.profile).toEqual({
      timeZone: "Europe/Berlin",
      workingTimeFrom: "10:00:00",
      workingTimeTo: "18:00:00",
    });
    // Bearer redacted (per DryRunPreview contract).
    expect(outcome.preview.headers["authorization"]).toBe("Token token=<redacted>");
    expect(outcome.preview.headers["authorization"]).not.toContain(TOKEN);
  });

  it("workingHours.set: { dryRun: true } still rejects empty input pre-flight (no transport call)", async () => {
    // Empty-input guard fires BEFORE the dry-run short-circuit — invalid
    // input must throw rather than emit a meaningless preview.
    await expect(workingHours.set(TOKEN, {}, { dryRun: true })).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "MUTATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("workingHours.set: default { dryRun: omitted } takes the apply path (transport called)", async () => {
    // Sanity: confirms the dry-run path is opt-in. The apply path issues
    // both the show() pre-fetch AND the UpdateWorkingHours mutation.
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
              profile: UPDATE_WH_PROFILE,
            },
          },
        },
      },
    );
    const outcome = await workingHours.set(TOKEN, { workingTimeFrom: "09:00:00" });
    expect(outcome.kind).toBe("applied");
    expect(mockedStock).toHaveBeenCalledTimes(2);
  });

  it("allocatedHours.set: { dryRun: true } returns a preview, no transport call", async () => {
    const outcome = await allocatedHours.set(TOKEN, 35, { dryRun: true });
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") throw new Error("unreachable");

    expect(mockedStock).not.toHaveBeenCalled();

    expect(outcome.preview).toMatchObject({
      surface: "mobile-gateway",
      transport: "stock",
      operationName: "UpdateAllocatedHours",
      variables: { hours: 35 },
    });
    expect(outcome.preview.headers["authorization"]).toBe("Token token=<redacted>");
    expect(outcome.preview.headers["authorization"]).not.toContain(TOKEN);
  });

  it("allocatedHours.set: { dryRun: true } still rejects negative hours pre-flight", async () => {
    // Integer-range guard fires BEFORE the dry-run short-circuit.
    await expect(allocatedHours.set(TOKEN, -1, { dryRun: true })).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "MUTATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("allocatedHours.set: { dryRun: true } still rejects non-integer hours pre-flight", async () => {
    await expect(allocatedHours.set(TOKEN, 3.5, { dryRun: true })).rejects.toMatchObject({
      name: "AvailabilityError",
      code: "MUTATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("allocatedHours.set: default { dryRun: omitted } takes the apply path (transport called)", async () => {
    reply({
      body: {
        data: {
          viewerRole: {
            __typename: "ViewerRoleOps",
            update: {
              __typename: "ViewerRoleUpdatePayload",
              success: true,
              notice: null,
              errors: null,
              viewer: UPDATE_ALLOC_VIEWER,
            },
          },
        },
      },
    });
    const outcome = await allocatedHours.set(TOKEN, 35);
    expect(outcome.kind).toBe("applied");
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });
});
