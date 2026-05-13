// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport.js")>("../../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
    impersonatedMultipartTransport: vi.fn(),
  };
});

vi.mock("../../basic/index.js", () => ({
  show: vi.fn(),
}));

import { AuthRevokedError } from "../../../../auth/errors.js";
import { impersonatedMultipartTransport, impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";
import { show as showBasic } from "../../basic/index.js";
import {
  PortfolioError,
  add,
  highlight,
  list,
  positionAfter,
  positionBefore,
  remove,
  reorder,
  update,
  uploadCover,
  uploadFile,
} from "../index.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const mockedImpersonatedMultipart = vi.mocked(impersonatedMultipartTransport);
const mockedShowBasic = vi.mocked(showBasic);
const TOKEN = "tok-portfolio";

interface MockResponse {
  status?: number;
  body: unknown;
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

function replyImpersonated(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedImpersonated.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

function replyMultipart(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedImpersonatedMultipart.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

/**
 * Stub `show` (basic) to return a viewer with a stable profileId. The
 * portfolio service calls `show` only to extract the viewer's
 * `profileId`; we don't need a complete `ProfileShowQuery` shape.
 */
function stubProfileId(profileId: string = "p1"): void {
  mockedShowBasic.mockResolvedValueOnce({
    viewer: {
      viewerRole: { profileId } as never,
    } as never,
  } as never);
}

const PORTFOLIO_NODE = {
  id: "pi1",
  title: "Demo project",
  description: "A demo",
  link: "https://demo.example",
  highlight: false,
  coverImage: null,
  accomplishment: null,
  publicationPermit: true,
  clientOrCompanyName: "Acme",
  websiteUrl: null,
  toptalRelated: false,
  showViaToptal: true,
};

describe("portfolio.list", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
    mockedShowBasic.mockReset();
  });

  it("targets mobile-gateway with getPortfolioItems and the resolved profileId", async () => {
    stubProfileId("p1");
    replyStock({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [PORTFOLIO_NODE] } } } } });

    const items = await list(TOKEN);

    expect(mockedStock).toHaveBeenCalledTimes(1);
    const call = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("mobile-gateway");
    expect(call.body.operationName).toBe("getPortfolioItems");
    expect(call.body.variables).toEqual({ profileId: "p1" });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("pi1");
    expect(items[0]?.title).toBe("Demo project");
  });

  it("returns [] for an empty portfolio", async () => {
    stubProfileId("p1");
    replyStock({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [] } } } } });

    const items = await list(TOKEN);

    expect(items).toEqual([]);
  });

  it("translates HTTP 401 from the read into AuthRevokedError", async () => {
    stubProfileId("p1");
    replyStock({ status: 401, body: {} });

    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("translates GraphQL extensions.code=UNAUTHENTICATED into AuthRevokedError", async () => {
    stubProfileId("p1");
    replyStock({
      body: { errors: [{ message: "session expired", extensions: { code: "UNAUTHENTICATED" } }] },
    });

    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("portfolio.add", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
    mockedShowBasic.mockReset();
  });

  it("rejects an empty title with VALIDATION_ERROR before any network call", async () => {
    await expect(add(TOKEN, { title: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedShowBasic).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("targets talent-profile with createPortfolioItem and the inferred wrapper key", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          createPortfolioItem: {
            profile: { id: "p1", portfolioItems: { nodes: [PORTFOLIO_NODE] } },
            success: true,
            errors: null,
          },
        },
      },
    });

    const items = await add(TOKEN, { title: "Demo", description: "x" });

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("talent-profile");
    expect(call.body.operationName).toBe("createPortfolioItem");
    const variables = call.body.variables as { input: { profileId: string; portfolioItem: unknown } };
    expect(variables.input.profileId).toBe("p1");
    expect(variables.input.portfolioItem).toEqual({ title: "Demo", description: "x" });
    expect(items).toHaveLength(1);
  });

  it("surfaces user errors as USER_ERROR PortfolioError", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          createPortfolioItem: {
            profile: null,
            success: false,
            errors: [{ message: "title too long", key: "title" }],
          },
        },
      },
    });

    await expect(add(TOKEN, { title: "ok" })).rejects.toMatchObject({
      code: "USER_ERROR",
    });
  });
});

describe("portfolio.update", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
  });

  it("rejects an empty changes object with VALIDATION_ERROR", async () => {
    await expect(update(TOKEN, "pi1", {})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("issues updatePortfolioItem with the inferred wrapper key", async () => {
    replyImpersonated({
      body: {
        data: {
          updatePortfolioItem: {
            profile: { id: "p1", portfolioItems: { nodes: [PORTFOLIO_NODE] } },
            success: true,
            errors: null,
          },
        },
      },
    });

    await update(TOKEN, "pi1", { title: "New" });

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("updatePortfolioItem");
    const variables = call.body.variables as { input: { portfolioItemId: string; portfolioItem: unknown } };
    expect(variables.input.portfolioItemId).toBe("pi1");
    expect(variables.input.portfolioItem).toEqual({ title: "New" });
  });
});

describe("portfolio.remove", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
  });

  it("issues removePortfolioItem with portfolioItemId in input", async () => {
    replyImpersonated({
      body: {
        data: {
          removePortfolioItem: {
            profile: { id: "p1", portfolioItems: { nodes: [] } },
            errors: null,
          },
        },
      },
    });

    await remove(TOKEN, "pi1");

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("removePortfolioItem");
    expect(call.body.variables).toEqual({ input: { portfolioItemId: "pi1" } });
  });
});

describe("portfolio.reorder", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
  });

  it("rejects negative position with VALIDATION_ERROR", async () => {
    await expect(reorder(TOKEN, "pi1", -1)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects non-integer position with VALIDATION_ERROR", async () => {
    await expect(reorder(TOKEN, "pi1", 1.5)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("issues changePortfolioItemPosition with absolute integer position", async () => {
    replyImpersonated({
      body: {
        data: {
          changePortfolioItemPosition: {
            profile: { id: "p1", portfolioItems: { nodes: [] } },
            errors: null,
          },
        },
      },
    });

    await reorder(TOKEN, "pi1", 2);

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("changePortfolioItemPosition");
    expect(call.body.variables).toEqual({ input: { portfolioItemId: "pi1", position: 2 } });
  });
});

describe("portfolio.positionBefore / positionAfter", () => {
  const items = [
    { ...PORTFOLIO_NODE, id: "a" },
    { ...PORTFOLIO_NODE, id: "b" },
    { ...PORTFOLIO_NODE, id: "c" },
  ];

  it("positionBefore returns the index of the target item", () => {
    expect(positionBefore(items, "b")).toBe(1);
    expect(positionBefore(items, "a")).toBe(0);
  });

  it("positionBefore returns null for unknown ids", () => {
    expect(positionBefore(items, "missing")).toBeNull();
  });

  it("positionAfter returns the index after the target item", () => {
    expect(positionAfter(items, "a")).toBe(1);
    expect(positionAfter(items, "c")).toBe(3);
  });

  it("positionAfter returns null for unknown ids", () => {
    expect(positionAfter(items, "missing")).toBeNull();
  });
});

describe("portfolio.highlight", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
  });

  it("issues highlightPortfolioItem with id and highlight=true by default", async () => {
    replyImpersonated({
      body: {
        data: {
          highlightPortfolioItem: {
            portfolioItem: { id: "pi1", highlight: true },
            errors: null,
          },
        },
      },
    });

    const result = await highlight(TOKEN, "pi1");

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.variables).toEqual({ id: "pi1", highlight: true });
    expect(result).toEqual({ id: "pi1", highlight: true });
  });

  it("forwards an explicit `false` flag for un-highlighting", async () => {
    replyImpersonated({
      body: {
        data: {
          highlightPortfolioItem: {
            portfolioItem: { id: "pi1", highlight: false },
            errors: null,
          },
        },
      },
    });

    await highlight(TOKEN, "pi1", false);

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.variables).toEqual({ id: "pi1", highlight: false });
  });
});

describe("portfolio.uploadCover", () => {
  beforeEach(() => {
    mockedImpersonatedMultipart.mockReset();
    mockedShowBasic.mockReset();
  });

  it("accepts a buffer source and binds it to variables.file via the multipart map", async () => {
    stubProfileId("p1");
    replyMultipart({
      body: {
        data: {
          uploadPortfolioCover: {
            coverImageCacheName: "cache-abc",
            coverImageUrl: "https://cdn/cover.png",
            success: true,
            errors: null,
          },
        },
      },
    });

    const result = await uploadCover(TOKEN, {
      kind: "buffer",
      filename: "cover.png",
      content: Buffer.from("img"),
      contentType: "image/png",
    });

    expect(result.coverImageCacheName).toBe("cache-abc");
    expect(result.coverImageUrl).toBe("https://cdn/cover.png");
    const call = mockedImpersonatedMultipart.mock.calls[0]?.[0] as Parameters<typeof mockedImpersonatedMultipart>[0];
    expect(call.body.operationName).toBe("uploadPortfolioCover");
    expect(call.map).toEqual({ "0": ["variables.file"] });
    expect(call.files["0"]?.filename).toBe("cover.png");
    expect(call.files["0"]?.contentType).toBe("image/png");
  });

  it("translates ENOENT path errors into FILE_NOT_FOUND PortfolioError", async () => {
    stubProfileId("p1");

    await expect(
      uploadCover(TOKEN, { kind: "path", path: "/nonexistent/file/that/does/not/exist.png" }),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    expect(mockedImpersonatedMultipart).not.toHaveBeenCalled();
  });
});

describe("portfolio.uploadFile", () => {
  beforeEach(() => {
    mockedImpersonatedMultipart.mockReset();
    mockedShowBasic.mockReset();
  });

  it("issues uploadPortfolioFile via multipart and returns the cache name + url", async () => {
    stubProfileId("p1");
    replyMultipart({
      body: {
        data: {
          uploadPortfolioFile: {
            fileCacheName: "file-cache-xyz",
            fileUrl: "https://cdn/attachment.pdf",
            success: true,
            errors: null,
          },
        },
      },
    });

    const result = await uploadFile(TOKEN, {
      kind: "buffer",
      filename: "attachment.pdf",
      content: Buffer.from("x"),
      contentType: "application/pdf",
    });

    expect(result.fileCacheName).toBe("file-cache-xyz");
    const call = mockedImpersonatedMultipart.mock.calls[0]?.[0] as Parameters<typeof mockedImpersonatedMultipart>[0];
    expect(call.body.operationName).toBe("uploadPortfolioFile");
  });
});

describe("PortfolioError", () => {
  it("carries a stable `code` and `name`", () => {
    const err = new PortfolioError("USER_ERROR", "rejected");
    expect(err.name).toBe("PortfolioError");
    expect(err.code).toBe("USER_ERROR");
    expect(err.message).toBe("rejected");
  });
});
