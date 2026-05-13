// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport.js")>("../../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
  };
});

import { ProfileError, approveItem, approveSection, list, submitForReview } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { Cf403Error, impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-abc-123";
const PROFILE_ID = "p1";

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

function mockProfileIdResolver(profileId: string = PROFILE_ID): void {
  mockedStock.mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: {
      data: {
        viewer: {
          viewerRole: { profileId },
        },
      },
    } as unknown,
  } satisfies TransportResponse);
}

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("returns the section reviews with their items", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          sectionReviews: [
            {
              id: "sr1",
              section: "EDUCATION",
              requestedAt: "2026-05-01T10:00:00Z",
              items: [
                { id: "sri-1", itemId: "edu-100", requestedAt: "2026-05-01T10:00:00Z" },
                { id: "sri-2", itemId: "edu-200", requestedAt: null },
              ],
            },
            {
              id: "sr2",
              section: "EMPLOYMENT",
              requestedAt: null,
              items: [],
            },
          ],
        },
      },
    });

    const result = await list(TOKEN);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "sr1",
      section: "EDUCATION",
      requestedAt: "2026-05-01T10:00:00Z",
      items: [
        { id: "sri-1", itemId: "edu-100", requestedAt: "2026-05-01T10:00:00Z" },
        { id: "sri-2", itemId: "edu-200", requestedAt: null },
      ],
    });
    expect(result[1]?.items).toEqual([]);
  });

  it("returns an empty array when there are no pending reviews", async () => {
    mockProfileIdResolver();
    replyImpersonated({ body: { data: { sectionReviews: [] } } });

    const result = await list(TOKEN);
    expect(result).toEqual([]);
  });

  it("filters out rows / items without IDs (defensive coercion)", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          sectionReviews: [
            {
              id: "sr1",
              section: "EDUCATION",
              requestedAt: null,
              items: [
                { id: "sri-1", itemId: "edu-100", requestedAt: null },
                { id: null, itemId: "should-be-dropped", requestedAt: null },
                { itemId: "edu-300", requestedAt: null },
              ],
            },
            { id: null, section: "EMPLOYMENT", requestedAt: null, items: [] },
            null,
          ],
        },
      },
    });

    const result = await list(TOKEN);
    expect(result).toHaveLength(1);
    expect(result[0]?.items).toHaveLength(1);
    expect(result[0]?.items[0]?.id).toBe("sri-1");
  });

  it("throws AuthRevokedError on extensions.code='UNAUTHENTICATED'", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: { errors: [{ message: "Session invalid", extensions: { code: "UNAUTHENTICATED" } }] },
    });

    await expect(list(TOKEN)).rejects.toThrow(AuthRevokedError);
  });
});

// ---------------------------------------------------------------------------
// approveItem
// ---------------------------------------------------------------------------

describe("approveItem", () => {
  it("rejects calls with empty fields", async () => {
    await expect(approveItem(TOKEN, { reviewId: "", itemId: "x", itemKind: "EDUCATION" })).rejects.toMatchObject({
      name: "ProfileError",
      code: "VALIDATION_ERROR",
    });
    await expect(approveItem(TOKEN, { reviewId: "x", itemId: "", itemKind: "EDUCATION" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(approveItem(TOKEN, { reviewId: "x", itemId: "y", itemKind: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("forwards the three input fields verbatim and returns the post-approval reviews list", async () => {
    replyImpersonated({
      body: {
        data: {
          approveItemReview: {
            success: true,
            notice: "Approved.",
            errors: [],
            sectionReviews: [
              {
                id: "sr1",
                section: "EDUCATION",
                requestedAt: null,
                items: [{ id: "sri-other", itemId: "edu-other", requestedAt: null }],
              },
            ],
          },
        },
      },
    });

    const result = await approveItem(TOKEN, { reviewId: "sr1", itemId: "edu-100", itemKind: "EDUCATION" });

    expect(mockedImpersonated).toHaveBeenCalledOnce();
    expect(mockedImpersonated.mock.calls[0]?.[0]).toMatchObject({
      surface: "talent-profile",
      authToken: TOKEN,
      body: {
        operationName: "ApproveItemReview",
        variables: { input: { reviewId: "sr1", itemId: "edu-100", itemKind: "EDUCATION" } },
      },
    } satisfies Partial<TransportRequest>);
    expect(result.notice).toBe("Approved.");
    expect(result.sectionReviews).toHaveLength(1);
    expect(result.sectionReviews[0]?.items[0]?.id).toBe("sri-other");
  });

  it("throws USER_ERROR with the field hint when the server rejects", async () => {
    replyImpersonated({
      body: {
        data: {
          approveItemReview: {
            success: false,
            notice: null,
            errors: [{ message: "Item already approved", key: "itemId" }],
            sectionReviews: [],
          },
        },
      },
    });

    await expect(
      approveItem(TOKEN, { reviewId: "sr1", itemId: "edu-100", itemKind: "EDUCATION" }),
    ).rejects.toMatchObject({
      name: "ProfileError",
      code: "USER_ERROR",
      message: expect.stringContaining("itemId"),
    });
  });

  it("propagates Cf403Error from the impersonated transport", async () => {
    mockedImpersonated.mockRejectedValueOnce(new Cf403Error("talent-profile", "https://example/"));
    await expect(approveItem(TOKEN, { reviewId: "x", itemId: "y", itemKind: "EDUCATION" })).rejects.toThrow(Cf403Error);
  });
});

// ---------------------------------------------------------------------------
// approveSection
// ---------------------------------------------------------------------------

describe("approveSection", () => {
  it("rejects calls with empty fields", async () => {
    await expect(approveSection(TOKEN, { reviewId: "", section: "EDUCATION" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(approveSection(TOKEN, { reviewId: "x", section: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("forwards the two input fields and returns the post-approval list", async () => {
    replyImpersonated({
      body: {
        data: {
          approveSectionReview: {
            success: true,
            notice: null,
            errors: [],
            sectionReviews: [],
          },
        },
      },
    });

    const result = await approveSection(TOKEN, { reviewId: "sr1", section: "EDUCATION" });

    expect(mockedImpersonated.mock.calls[0]?.[0]).toMatchObject({
      body: {
        operationName: "ApproveSectionReview",
        variables: { input: { reviewId: "sr1", section: "EDUCATION" } },
      },
    });
    expect(result.sectionReviews).toEqual([]);
    expect(result.notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// submitForReview
// ---------------------------------------------------------------------------

describe("submitForReview", () => {
  it("issues the mutation with { profileId } and returns the notice", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          submitForReview: {
            success: true,
            notice: "Profile submitted for review.",
            errors: [],
          },
        },
      },
    });

    const result = await submitForReview(TOKEN);

    expect(mockedImpersonated.mock.calls[0]?.[0]).toMatchObject({
      body: {
        operationName: "submitForReview",
        variables: { input: { profileId: PROFILE_ID } },
      },
    });
    expect(result.notice).toBe("Profile submitted for review.");
  });

  it("throws USER_ERROR with the key hint when the server rejects (e.g. profile not ready)", async () => {
    mockProfileIdResolver();
    replyImpersonated({
      body: {
        data: {
          submitForReview: {
            success: false,
            notice: null,
            errors: [{ code: "validation", key: "submitAvailable", message: "Profile is not ready for submission" }],
          },
        },
      },
    });

    await expect(submitForReview(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "USER_ERROR",
      message: expect.stringContaining("submitAvailable"),
    });
  });

  it("propagates ProfileError NETWORK_ERROR on transport throw", async () => {
    mockProfileIdResolver();
    mockedImpersonated.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(submitForReview(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "NETWORK_ERROR",
    });
  });
});

describe("ProfileError export sanity", () => {
  it("re-exports ProfileError so callers can write profile.reviews.ProfileError", () => {
    // Sanity check on the re-export — not a runtime concern but cheap to verify.
    expect(typeof ProfileError).toBe("function");
    expect(new ProfileError("UNKNOWN", "test").code).toBe("UNKNOWN");
  });
});
