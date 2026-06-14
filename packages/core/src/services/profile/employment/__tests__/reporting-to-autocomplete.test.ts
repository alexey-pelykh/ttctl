// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../transport/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport/index.js")>(
    "../../../../transport/index.js",
  );
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
  };
});

import { reportingToAutocomplete } from "../index.js";
import { ProfileError } from "../../basic/index.js";
import { impersonatedTransport, stockTransport } from "../../../../transport/index.js";
import type { TransportRequest, TransportResponse } from "../../../../transport/index.js";
import { VIEWER_OK } from "../../__tests__/fixtures.js";

const mockedImpersonated = vi.mocked(impersonatedTransport);
const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-reporting-to-123";
const PROFILE_ID = "V1-Profile-fixture";

interface MockResponse {
  status?: number;
  body: unknown;
}

function replyImpersonated(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedImpersonated.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

function replyStock(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedStock.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

beforeEach(() => {
  mockedImpersonated.mockReset();
  mockedStock.mockReset();
});

describe("profile.employment.reportingToAutocomplete", () => {
  it("rejects a prefix shorter than 2 characters before any wire call", async () => {
    await expect(reportingToAutocomplete(TOKEN, "a", { profileId: PROFILE_ID })).rejects.toBeInstanceOf(ProfileError);
    await expect(reportingToAutocomplete(TOKEN, "", { profileId: PROFILE_ID })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects a prefix that becomes <2 characters after trimming whitespace", async () => {
    await expect(reportingToAutocomplete(TOKEN, "  x  ", { profileId: PROFILE_ID })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
    expect(mockedStock).not.toHaveBeenCalled();
  });

  // Gate must fire BEFORE extractProfileId — explicit-profileId tests above would pass if the order flipped.
  it("rejects a <2-char prefix without resolving profileId", async () => {
    await expect(reportingToAutocomplete(TOKEN, "a")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("sends the captured variables and returns the suggestion list", async () => {
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            reportingToAutocomplete: [
              { id: "V1-Person-1", name: "John Smith" },
              { id: "V1-Person-2", name: "Joanna Smith" },
            ],
          },
        },
      },
    });

    const result = await reportingToAutocomplete(TOKEN, "  Joh  ", { profileId: PROFILE_ID, limit: 5 });

    expect(result).toEqual([
      { id: "V1-Person-1", name: "John Smith" },
      { id: "V1-Person-2", name: "Joanna Smith" },
    ]);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("talent-profile");
    expect(call.body).toMatchObject({
      operationName: "GET_REPORTING_TO_AUTOCOMPLETE",
      variables: { name: "Joh", limit: 5, profileId: PROFILE_ID },
    });
  });

  it("defaults limit to 10 when not supplied", async () => {
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, reportingToAutocomplete: [] } } },
    });

    await reportingToAutocomplete(TOKEN, "An", { profileId: PROFILE_ID });

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body).toMatchObject({
      variables: { name: "An", limit: 10, profileId: PROFILE_ID },
    });
  });

  it("returns [] when the catalog has no matches", async () => {
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, reportingToAutocomplete: [] } } },
    });

    const result = await reportingToAutocomplete(TOKEN, "Zzz", { profileId: PROFILE_ID });
    expect(result).toEqual([]);
  });

  it("returns [] when the field is null", async () => {
    replyImpersonated({
      body: { data: { profile: { id: PROFILE_ID, reportingToAutocomplete: null } } },
    });

    const result = await reportingToAutocomplete(TOKEN, "Zzz", { profileId: PROFILE_ID });
    expect(result).toEqual([]);
  });

  it("normalises a single-object response into a one-element array", async () => {
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: PROFILE_ID,
            reportingToAutocomplete: { id: "V1-Person-1", name: "John Smith" },
          },
        },
      },
    });

    const result = await reportingToAutocomplete(TOKEN, "Joh", { profileId: PROFILE_ID });
    expect(result).toEqual([{ id: "V1-Person-1", name: "John Smith" }]);
  });

  it("throws on top-level GraphQL errors", async () => {
    replyImpersonated({
      body: {
        errors: [{ message: "internal server error" }],
      },
    });

    await expect(reportingToAutocomplete(TOKEN, "Joh", { profileId: PROFILE_ID })).rejects.toBeInstanceOf(ProfileError);
  });

  it("resolves profileId via extractProfileId when not supplied", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            reportingToAutocomplete: [{ id: "V1-Person-1", name: "John Smith" }],
          },
        },
      },
    });

    const result = await reportingToAutocomplete(TOKEN, "Joh");
    expect(result).toEqual([{ id: "V1-Person-1", name: "John Smith" }]);
    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    // Confirm the autocomplete used the extracted profileId.
    const autocompleteCall = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(autocompleteCall.body).toMatchObject({
      variables: { profileId: "p1" },
    });
  });
});
