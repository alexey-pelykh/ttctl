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

import { AuthRevokedError } from "../../../../auth/errors.js";
import { impersonatedMultipartTransport, impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";
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
const TOKEN = "tok-portfolio";

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
 * Stub the stock-transport reply consumed by `extractProfileId`'s internal
 * `basic.show()` round-trip. Only `data.viewer.viewerRole.profileId` is
 * inspected by `extractProfileId`; we don't need a complete
 * `ProfileShowQuery` shape on the wire.
 */
function stubProfileId(profileId: string = "p1"): void {
  mockedStock.mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: {
      data: {
        viewer: {
          viewerRole: { profileId } as never,
        } as never,
      },
    },
  } satisfies TransportResponse);
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

/**
 * Wire-shape skill set node returned by the `getSkillSetsWithConnectionsWithConnectionsCount`
 * query (talent-profile surface, impersonatedTransport). The `add()`
 * write-side path falls back to this query to default `skills` to the
 * user's first profile skill when the caller did not supply one — see
 * #314. Tests that exercise the create path with no `skills` input must
 * mock this response BEFORE the `createPortfolioItem` reply.
 */
function defaultSkillSetsReply(): MockResponse {
  return {
    body: {
      data: {
        profile: {
          id: "p1",
          skillSets: {
            nodes: [
              {
                id: "ss-default-1",
                experience: 60,
                rating: "STRONG",
                public: true,
                position: 0,
                skill: { id: "sk-default-1", name: "TypeScript" },
                connections: { totalCount: 0 },
              },
            ],
          },
        },
      },
    },
  };
}

describe("portfolio.list", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
  });

  it("targets talent-profile with getPortfolioItems and the resolved profileId", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [PORTFOLIO_NODE] } } } } });

    const items = await list(TOKEN);

    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.surface).toBe("talent-profile");
    expect(call.body.operationName).toBe("getPortfolioItems");
    expect(call.body.variables).toEqual({ profileId: "p1" });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("pi1");
    expect(items[0]?.title).toBe("Demo project");
  });

  it("returns [] for an empty portfolio", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [] } } } } });

    const items = await list(TOKEN);

    expect(items).toEqual([]);
  });

  it("translates HTTP 401 from the read into AuthRevokedError", async () => {
    stubProfileId("p1");
    replyImpersonated({ status: 401, body: {} });

    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("translates GraphQL extensions.code=UNAUTHENTICATED into AuthRevokedError", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: { errors: [{ message: "session expired", extensions: { code: "UNAUTHENTICATED" } }] },
    });

    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("selects details with inline fragments for all four block variants (#548)", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [] } } } } });

    await list(TOKEN);

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const query = call.body.query;
    // Top-level `details` selector and __typename discriminator are
    // load-bearing — without them the projection cannot tell variants
    // apart and collapses every body block to null.
    expect(query).toMatch(/details\s*\{/);
    expect(query).toMatch(/__typename/);
    expect(query).toMatch(/\.\.\.\s*on\s+PortfolioItemImageBlock/);
    expect(query).toMatch(/\.\.\.\s*on\s+PortfolioItemTextBlock/);
    expect(query).toMatch(/\.\.\.\s*on\s+PortfolioItemVideoBlock/);
    expect(query).toMatch(/\.\.\.\s*on\s+PortfolioItemGalleryBlock/);
  });

  it("projects details=null when the wire returns null body (item has no block)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: { data: { profile: { id: "p1", portfolioItems: { nodes: [{ ...PORTFOLIO_NODE, details: null }] } } } },
    });

    const items = await list(TOKEN);

    expect(items[0]?.details).toBeNull();
  });

  it("projects details as an image block (kind=image, with thumb/optimized URLs)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  details: {
                    __typename: "PortfolioItemImageBlock",
                    id: "block-img-1",
                    title: "Architecture diagram",
                    image: { thumbUrl: "https://cdn.example/thumb.png", optimizedUrl: "https://cdn.example/opt.png" },
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);
    const details = items[0]?.details;

    expect(details).toEqual({
      kind: "image",
      id: "block-img-1",
      title: "Architecture diagram",
      image: { thumbUrl: "https://cdn.example/thumb.png", optimizedUrl: "https://cdn.example/opt.png" },
    });
  });

  it("projects details as a text block (kind=text, contentHast preserved as opaque object)", async () => {
    stubProfileId("p1");
    const hast = { type: "root", children: [{ type: "element", tagName: "p", children: [] }] };
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  details: {
                    __typename: "PortfolioItemTextBlock",
                    id: "block-txt-1",
                    title: null,
                    contentHast: hast,
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);
    const details = items[0]?.details;

    expect(details).toEqual({ kind: "text", id: "block-txt-1", title: null, contentHast: hast });
  });

  it("projects details as a video block (kind=video, with videoUrl)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  details: {
                    __typename: "PortfolioItemVideoBlock",
                    id: "block-vid-1",
                    title: "Demo reel",
                    videoUrl: "https://youtu.be/abc",
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.details).toEqual({
      kind: "video",
      id: "block-vid-1",
      title: "Demo reel",
      videoUrl: "https://youtu.be/abc",
    });
  });

  it("projects details as a gallery block (kind=gallery, with items[])", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  details: {
                    __typename: "PortfolioItemGalleryBlock",
                    id: "block-gal-1",
                    title: "Screens",
                    items: [
                      {
                        id: "gi-1",
                        contentType: "image/png",
                        image: { thumbUrl: "https://cdn.example/t1.png", optimizedUrl: "https://cdn.example/o1.png" },
                      },
                      { id: "gi-2", contentType: null, image: null },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);
    const details = items[0]?.details;

    expect(details).toEqual({
      kind: "gallery",
      id: "block-gal-1",
      title: "Screens",
      items: [
        {
          id: "gi-1",
          contentType: "image/png",
          image: { thumbUrl: "https://cdn.example/t1.png", optimizedUrl: "https://cdn.example/o1.png" },
        },
        { id: "gi-2", contentType: null, image: null },
      ],
    });
  });

  it("collapses details to null when __typename is unknown (forward-compat with new server variants)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  details: { __typename: "PortfolioItemFutureVariant", id: "block-x", title: "x" },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.details).toBeNull();
  });

  it("collapses details to null when __typename is missing or id is non-string", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                { ...PORTFOLIO_NODE, id: "p-missing-typename", details: { id: "x", title: "no __typename" } },
                {
                  ...PORTFOLIO_NODE,
                  id: "p-non-string-id",
                  details: { __typename: "PortfolioItemImageBlock", id: 42, title: "bad id" },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items.find((it) => it.id === "p-missing-typename")?.details).toBeNull();
    expect(items.find((it) => it.id === "p-non-string-id")?.details).toBeNull();
  });

  it("selects files connection with inline fragments for both variants (#549)", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [] } } } } });

    await list(TOKEN);

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const query = call.body.query;
    // The `files { nodes { __typename ... } }` connection selector and the
    // __typename discriminator are load-bearing — without them the
    // projection cannot tell PDF from image and drops every node.
    expect(query).toMatch(/files\s*\{\s*nodes\s*\{/);
    expect(query).toMatch(/\.\.\.\s*on\s+PortfolioItemFilePdf/);
    expect(query).toMatch(/\.\.\.\s*on\s+PortfolioItemFileImage/);
  });

  it("projects files=[] when the wire returns null files (item has no attachments)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: { data: { profile: { id: "p1", portfolioItems: { nodes: [{ ...PORTFOLIO_NODE, files: null }] } } } },
    });

    const items = await list(TOKEN);

    expect(items[0]?.files).toEqual([]);
  });

  it("projects files=[] when the connection has empty nodes", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: { profile: { id: "p1", portfolioItems: { nodes: [{ ...PORTFOLIO_NODE, files: { nodes: [] } }] } } },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.files).toEqual([]);
  });

  it("projects a pdf file (kind=pdf, with fileUrl + primaryContentType)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  files: {
                    nodes: [
                      {
                        __typename: "PortfolioItemFilePdf",
                        id: "file-pdf-1",
                        title: "Case study",
                        description: "A deep dive",
                        contentType: "application/pdf",
                        fileUrl: "https://cdn.example/case-study.pdf",
                        primaryContentType: "pdf",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.files).toEqual([
      {
        kind: "pdf",
        id: "file-pdf-1",
        title: "Case study",
        description: "A deep dive",
        contentType: "application/pdf",
        fileUrl: "https://cdn.example/case-study.pdf",
        primaryContentType: "pdf",
      },
    ]);
  });

  it("projects an image file (kind=image, with thumb/optimized URLs)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  files: {
                    nodes: [
                      {
                        __typename: "PortfolioItemFileImage",
                        id: "file-img-1",
                        title: "Screenshot",
                        description: null,
                        contentType: "image/png",
                        image: { thumbUrl: "https://cdn.example/t.png", optimizedUrl: "https://cdn.example/o.png" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.files).toEqual([
      {
        kind: "image",
        id: "file-img-1",
        title: "Screenshot",
        description: null,
        contentType: "image/png",
        image: { thumbUrl: "https://cdn.example/t.png", optimizedUrl: "https://cdn.example/o.png" },
      },
    ]);
  });

  it("projects a mixed pdf + image connection preserving wire order", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  files: {
                    nodes: [
                      {
                        __typename: "PortfolioItemFilePdf",
                        id: "f-pdf",
                        title: null,
                        description: null,
                        contentType: "application/pdf",
                        fileUrl: "https://cdn.example/a.pdf",
                        primaryContentType: "pdf",
                      },
                      {
                        __typename: "PortfolioItemFileImage",
                        id: "f-img",
                        title: null,
                        description: null,
                        contentType: "image/jpeg",
                        image: { thumbUrl: null, optimizedUrl: "https://cdn.example/b.jpg" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);
    const files = items[0]?.files ?? [];

    expect(files.map((f) => f.kind)).toEqual(["pdf", "image"]);
    expect(files[0]?.id).toBe("f-pdf");
    expect(files[1]?.id).toBe("f-img");
  });

  it("drops file nodes with unknown __typename (forward-compat with new server variants)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  files: {
                    nodes: [
                      { __typename: "PortfolioItemFileVideo", id: "f-future", title: "x" },
                      {
                        __typename: "PortfolioItemFilePdf",
                        id: "f-keep",
                        title: null,
                        description: null,
                        contentType: null,
                        fileUrl: null,
                        primaryContentType: null,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);
    const files = items[0]?.files ?? [];

    // The unknown variant is dropped; the known PDF node survives.
    expect(files).toHaveLength(1);
    expect(files[0]?.id).toBe("f-keep");
  });

  it("drops file nodes with missing __typename or non-string id", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  files: {
                    nodes: [
                      { id: "no-typename", title: "missing __typename" },
                      { __typename: "PortfolioItemFilePdf", id: 42, title: "non-string id" },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.files).toEqual([]);
  });

  // #550: `kpis` direct-list selection — talent-authored quantified outcomes
  // for the project. Wire shape verified by probe 2026-05-23:
  // `kpis { id value description }` (direct list, NOT a connection).
  it("selects kpis as a direct list with id/value/description (#550)", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [] } } } } });

    await list(TOKEN);

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const query = call.body.query;
    // kpis is a direct list, NOT a connection — the live probe confirmed
    // `kpis { nodes }` errors with "Field 'nodes' doesn't exist on type
    // 'PortfolioItemKpi'". The selection must use the direct shape.
    expect(query).toMatch(/kpis\s*\{\s*id\s+value\s+description\s*\}/);
    expect(query).not.toMatch(/kpis\s*\{\s*nodes\s*\{/);
  });

  it("projects kpis=[] when the wire returns null kpis (item has no KPIs)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: { data: { profile: { id: "p1", portfolioItems: { nodes: [{ ...PORTFOLIO_NODE, kpis: null }] } } } },
    });

    const items = await list(TOKEN);

    expect(items[0]?.kpis).toEqual([]);
  });

  it("projects kpis=[] when the wire returns an empty list", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: { data: { profile: { id: "p1", portfolioItems: { nodes: [{ ...PORTFOLIO_NODE, kpis: [] }] } } } },
    });

    const items = await list(TOKEN);

    expect(items[0]?.kpis).toEqual([]);
  });

  it("projects a populated kpi entry preserving id/value/description", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  kpis: [
                    { id: "kpi-1", value: "40%", description: "page load reduction" },
                    { id: "kpi-2", value: "1M", description: "monthly active users" },
                  ],
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.kpis).toEqual([
      { id: "kpi-1", value: "40%", description: "page load reduction" },
      { id: "kpi-2", value: "1M", description: "monthly active users" },
    ]);
  });

  it("projects kpi entries with nullable value/description", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  kpis: [
                    { id: "kpi-1", value: null, description: "no value yet" },
                    { id: "kpi-2", value: "5x", description: null },
                    { id: "kpi-3", value: null, description: null },
                  ],
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.kpis).toEqual([
      { id: "kpi-1", value: null, description: "no value yet" },
      { id: "kpi-2", value: "5x", description: null },
      { id: "kpi-3", value: null, description: null },
    ]);
  });

  it("drops kpi entries with missing or non-string id (siblings preserved)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  kpis: [
                    { id: 42, value: "x", description: "non-string id" },
                    { value: "y", description: "missing id" },
                    { id: "kpi-keep", value: "z", description: "good entry" },
                  ],
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.kpis).toEqual([{ id: "kpi-keep", value: "z", description: "good entry" }]);
  });

  it("projects kpis=[] when the wire returns a non-array (defensive)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                { ...PORTFOLIO_NODE, kpis: { unexpected: "shape" } },
                { ...PORTFOLIO_NODE, id: "pi2", kpis: "string-not-array" },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.kpis).toEqual([]);
    expect(items[1]?.kpis).toEqual([]);
  });

  // #551: `quotes` direct-list selection — talent-authored client /
  // stakeholder testimonials. Wire shape verified by live probe 2026-05-23:
  // `quotes { id text clientName clientRole company }` (direct list, NOT a
  // connection; element type `PortfolioItemQuote`; the issue's guessed
  // `quote`/`attribution`/`role` were rejected on the wire).
  it("selects quotes as a direct list with id/text/clientName/clientRole/company (#551)", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [] } } } } });

    await list(TOKEN);

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const query = call.body.query;
    // quotes is a direct list, NOT a connection — the live probe confirmed
    // `quotes { nodes }` errors with "Field 'nodes' doesn't exist on type
    // 'PortfolioItemQuote'". The selection must use the direct shape.
    expect(query).toMatch(/quotes\s*\{\s*id\s+text\s+clientName\s+clientRole\s+company\s*\}/);
    expect(query).not.toMatch(/quotes\s*\{\s*nodes\s*\{/);
  });

  it("projects quotes=[] when the wire returns null quotes (item has no quotes)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: { data: { profile: { id: "p1", portfolioItems: { nodes: [{ ...PORTFOLIO_NODE, quotes: null }] } } } },
    });

    const items = await list(TOKEN);

    expect(items[0]?.quotes).toEqual([]);
  });

  it("projects quotes=[] when the wire returns an empty list", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: { data: { profile: { id: "p1", portfolioItems: { nodes: [{ ...PORTFOLIO_NODE, quotes: [] }] } } } },
    });

    const items = await list(TOKEN);

    expect(items[0]?.quotes).toEqual([]);
  });

  it("projects a populated quote entry preserving all fields", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  quotes: [
                    {
                      id: "q-1",
                      text: "Shipped on time and under budget.",
                      clientName: "Jane Doe",
                      clientRole: "VP Engineering",
                      company: "Acme",
                    },
                    {
                      id: "q-2",
                      text: "A pleasure to work with.",
                      clientName: "John Roe",
                      clientRole: "CTO",
                      company: "Globex",
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.quotes).toEqual([
      {
        id: "q-1",
        text: "Shipped on time and under budget.",
        clientName: "Jane Doe",
        clientRole: "VP Engineering",
        company: "Acme",
      },
      {
        id: "q-2",
        text: "A pleasure to work with.",
        clientName: "John Roe",
        clientRole: "CTO",
        company: "Globex",
      },
    ]);
  });

  it("projects quote entries with nullable text/clientName/clientRole/company", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  quotes: [
                    { id: "q-1", text: null, clientName: "Jane Doe", clientRole: null, company: null },
                    { id: "q-2", text: "Great work", clientName: null, clientRole: "CTO", company: null },
                    { id: "q-3", text: null, clientName: null, clientRole: null, company: null },
                  ],
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.quotes).toEqual([
      { id: "q-1", text: null, clientName: "Jane Doe", clientRole: null, company: null },
      { id: "q-2", text: "Great work", clientName: null, clientRole: "CTO", company: null },
      { id: "q-3", text: null, clientName: null, clientRole: null, company: null },
    ]);
  });

  it("drops quote entries with missing or non-string id (siblings preserved)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                {
                  ...PORTFOLIO_NODE,
                  quotes: [
                    { id: 42, text: "non-string id", clientName: null, clientRole: null, company: null },
                    { text: "missing id", clientName: null, clientRole: null, company: null },
                    { id: "q-keep", text: "good entry", clientName: "Jane", clientRole: "PM", company: "Acme" },
                  ],
                },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.quotes).toEqual([
      { id: "q-keep", text: "good entry", clientName: "Jane", clientRole: "PM", company: "Acme" },
    ]);
  });

  it("projects quotes=[] when the wire returns a non-array (defensive)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                { ...PORTFOLIO_NODE, quotes: { unexpected: "shape" } },
                { ...PORTFOLIO_NODE, id: "pi2", quotes: "string-not-array" },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.quotes).toEqual([]);
    expect(items[1]?.quotes).toEqual([]);
  });

  // Provenance: #552 — `engagement` link to the underlying TalentEngagement.
  // Wire shape verified by live elimination probe 2026-05-24:
  // `engagement { id }` (single nullable object ref of type
  // `TalentEngagement`, NOT a connection — `engagement { nodes }` errors
  // "Field 'nodes' doesn't exist on type 'TalentEngagement'"; 26/32 items
  // null, 6 populated `{ id }`).
  it("selects engagement as a single object reference with id (not a connection)", async () => {
    stubProfileId("p1");
    replyImpersonated({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [] } } } } });

    await list(TOKEN);

    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    const query = call.body.query;
    // engagement is a single object reference, NOT a connection — the live
    // probe confirmed `engagement { nodes }` errors "Field 'nodes' doesn't
    // exist on type 'TalentEngagement'". The selection must be the direct
    // `{ id }` shape.
    expect(query).toMatch(/engagement\s*\{\s*id\s*\}/);
    expect(query).not.toMatch(/engagement\s*\{\s*nodes\s*\{/);
  });

  it("projects engagement=null when the wire returns null engagement (item not linked)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: { data: { profile: { id: "p1", portfolioItems: { nodes: [{ ...PORTFOLIO_NODE, engagement: null }] } } } },
    });

    const items = await list(TOKEN);

    expect(items[0]?.engagement).toBeNull();
  });

  it("projects engagement=null when the wire omits the engagement field", async () => {
    stubProfileId("p1");
    // PORTFOLIO_NODE has no `engagement` key — the projector must default
    // a missing field to null rather than throw or surface undefined.
    replyImpersonated({ body: { data: { profile: { id: "p1", portfolioItems: { nodes: [PORTFOLIO_NODE] } } } } });

    const items = await list(TOKEN);

    expect(items[0]?.engagement).toBeNull();
  });

  it("projects a populated engagement preserving the TalentEngagement id", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [{ ...PORTFOLIO_NODE, engagement: { id: "V1-TalentEngagement-238005" } }],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.engagement).toEqual({ id: "V1-TalentEngagement-238005" });
  });

  it("projects engagement=null when the wire object has a missing or non-string id (defensive)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                { ...PORTFOLIO_NODE, engagement: { id: 42 } },
                { ...PORTFOLIO_NODE, id: "pi2", engagement: { notId: "x" } },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.engagement).toBeNull();
    expect(items[1]?.engagement).toBeNull();
  });

  it("projects engagement=null when the wire returns a non-object engagement (defensive)", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            portfolioItems: {
              nodes: [
                { ...PORTFOLIO_NODE, engagement: "string-not-object" },
                { ...PORTFOLIO_NODE, id: "pi2", engagement: ["array-not-object"] },
              ],
            },
          },
        },
      },
    });

    const items = await list(TOKEN);

    expect(items[0]?.engagement).toBeNull();
    // An array IS typeof "object" — guard must still reject it (no string id).
    expect(items[1]?.engagement).toBeNull();
  });
});

describe("portfolio.add", () => {
  beforeEach(() => {
    mockedStock.mockReset();
    mockedImpersonated.mockReset();
  });

  it("rejects an empty title with VALIDATION_ERROR before any network call", async () => {
    await expect(add(TOKEN, { title: "", industryIds: ["i-1"] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("rejects missing/empty industryIds with VALIDATION_ERROR before any network call", async () => {
    await expect(add(TOKEN, { title: "ok" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/industryIds|industry id/i),
    });
    await expect(add(TOKEN, { title: "ok", industryIds: [] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });

  it("targets talent-profile with createPortfolioItem and the inferred wrapper key", async () => {
    stubProfileId("p1");
    // First impersonated call: skills list (default-skill fallback for #314);
    // second: createPortfolioItem.
    replyImpersonated(defaultSkillSetsReply(), {
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

    const items = await add(TOKEN, { title: "Demo", description: "x", industryIds: ["ind-1"] });

    // Last impersonated call is createPortfolioItem (skills list is first).
    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(createCall.surface).toBe("talent-profile");
    expect(createCall.body.operationName).toBe("createPortfolioItem");
    const variables = createCall.body.variables as { input: { profileId: string; portfolioItem: unknown } };
    expect(variables.input.profileId).toBe("p1");
    // Defaults projected for fields empirically required by the server
    // (issue #314, refined 2026-05-16): `kind` (lowercase!), `showViaToptal`,
    // `skills`, `description`, `publicationPermit`. Caller-supplied
    // `industryIds` / `title` / `description` pass through; missing
    // `skills` is filled from the first profile skill.
    expect(variables.input.portfolioItem).toEqual({
      kind: "basic",
      showViaToptal: true,
      publicationPermit: true,
      skills: [{ id: "sk-default-1", name: "TypeScript" }],
      title: "Demo",
      description: "x",
      industryIds: ["ind-1"],
    });
    expect(items).toHaveLength(1);
  });

  it("defaults description to a ≥200-char placeholder when caller omits it", async () => {
    stubProfileId("p1");
    replyImpersonated(defaultSkillSetsReply(), {
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

    await add(TOKEN, { title: "Just a title", industryIds: ["ind-1"] });

    const createCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    const variables = createCall.body.variables as {
      input: { portfolioItem: { description?: string; title?: string; kind?: string } };
    };
    const item = variables.input.portfolioItem;
    expect(item.title).toBe("Just a title");
    expect(item.kind).toBe("basic");
    // Server requires description >= 200 chars (empirical, issue #314).
    expect(item.description).toBeDefined();
    expect((item.description ?? "").length).toBeGreaterThanOrEqual(200);
    expect(item.description).toMatch(/ttctl profile portfolio update/);
  });

  it("preserves caller-supplied kind / showViaToptal / skills over defaults", async () => {
    stubProfileId("p1");
    // When caller supplies non-empty `skills`, the skills-list fallback
    // is skipped — only one impersonated call (createPortfolioItem).
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

    await add(TOKEN, {
      title: "Override",
      description: "explicit",
      kind: "code_base",
      showViaToptal: false,
      skills: [{ id: "sk-1", name: "TypeScript" }],
      industryIds: ["ind-1", "ind-2"],
    });

    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("createPortfolioItem");
    const variables = call.body.variables as { input: { portfolioItem: unknown } };
    expect(variables.input.portfolioItem).toEqual({
      title: "Override",
      description: "explicit",
      kind: "code_base",
      showViaToptal: false,
      publicationPermit: true,
      skills: [{ id: "sk-1", name: "TypeScript" }],
      industryIds: ["ind-1", "ind-2"],
    });
  });

  it("surfaces VALIDATION_ERROR when no skills supplied and profile has zero skills", async () => {
    stubProfileId("p1");
    replyImpersonated({
      body: {
        data: {
          profile: { id: "p1", skillSets: { nodes: [] } },
        },
      },
    });

    await expect(add(TOKEN, { title: "No-skills", industryIds: ["ind-1"] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    // Skills list was called but createPortfolioItem was NOT — the
    // service short-circuits on the empty-skills path.
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
  });

  it("surfaces user errors as USER_ERROR PortfolioError", async () => {
    stubProfileId("p1");
    // Skills list fallback fires first; createPortfolioItem rejects second.
    replyImpersonated(defaultSkillSetsReply(), {
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

    await expect(add(TOKEN, { title: "ok", industryIds: ["ind-1"] })).rejects.toMatchObject({
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
    // `update()` does read-modify-write: it first calls `list()` (which
    // resolves profileId + queries getPortfolioItems) so it can satisfy
    // the server's non-null requirements on `updatePortfolioItem`'s
    // full-replace shape (`skills`, `industryIds`, `kind`,
    // `publicationPermit`, `description`, `showViaToptal`). Mock the
    // list response first, then the actual updatePortfolioItem.
    stubProfileId("p1");
    replyImpersonated(
      {
        body: {
          data: {
            profile: {
              id: "p1",
              portfolioItems: {
                nodes: [
                  {
                    ...PORTFOLIO_NODE,
                    kind: "basic",
                    skills: { nodes: [{ id: "sk-1", name: "TypeScript" }] },
                    industries: { nodes: [{ id: "ind-1", name: "Software" }] },
                  },
                ],
              },
            },
          },
        },
      },
      {
        body: {
          data: {
            updatePortfolioItem: {
              profile: { id: "p1", portfolioItems: { nodes: [PORTFOLIO_NODE] } },
              success: true,
              errors: null,
            },
          },
        },
      },
    );

    await update(TOKEN, "pi1", { title: "New" });

    // Last impersonated call is updatePortfolioItem (list is first).
    const updateCall = mockedImpersonated.mock.calls[1]?.[0] as TransportRequest;
    expect(updateCall.body.operationName).toBe("updatePortfolioItem");
    const variables = updateCall.body.variables as { input: { portfolioItemId: string; portfolioItem: unknown } };
    expect(variables.input.portfolioItemId).toBe("pi1");
    // Wrapper key matches the inferred Pattern 1 shape; caller's `title`
    // override is present and the read-modify-write merge preserves
    // non-null required fields from the current state.
    expect(variables.input.portfolioItem).toMatchObject({
      title: "New",
      description: "A demo",
      skills: [{ id: "sk-1", name: "TypeScript" }],
      industryIds: ["ind-1"],
      publicationPermit: true,
      showViaToptal: true,
    });
    // `kind` is NOT defined on `PortfolioItemUpdateInput` (verified live
    // 2026-05-16, see service-layer doc comment). Even though the current
    // read state carries `kind: "basic"`, the merged payload must strip
    // it before sending — otherwise the server returns "Field is not
    // defined on PortfolioItemUpdateInput".
    expect(variables.input.portfolioItem).not.toHaveProperty("kind");
    expect(variables.input.portfolioItem).not.toHaveProperty("coverImage");
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
    // Position lives INSIDE `portfolioItem` per the wire shape verified
    // 2026-05-16 — see service-layer comment for the probe reference.
    expect(call.body.variables).toEqual({ input: { portfolioItemId: "pi1", portfolioItem: { position: 2 } } });
  });
});

describe("portfolio.positionBefore / positionAfter", () => {
  const items = [
    { ...PORTFOLIO_NODE, id: "a" },
    { ...PORTFOLIO_NODE, id: "b" },
    { ...PORTFOLIO_NODE, id: "c" },
  ];

  it("positionBefore returns the index of the target item (without movingId)", () => {
    expect(positionBefore(items, "b")).toBe(1);
    expect(positionBefore(items, "a")).toBe(0);
  });

  it("positionBefore filters out movingId before computing target index", () => {
    // Move A before B: in [A, B, C], remove A → [B, C], B is at 0,
    // we want X at B's spot → position 0.
    expect(positionBefore(items, "b", "a")).toBe(0);
    // Move C before B: in [A, B, C], remove C → [A, B], B is at 1,
    // we want X at B's spot → position 1.
    expect(positionBefore(items, "b", "c")).toBe(1);
  });

  it("positionBefore returns null for unknown ids", () => {
    expect(positionBefore(items, "missing")).toBeNull();
    expect(positionBefore(items, "missing", "a")).toBeNull();
  });

  it("positionAfter returns the index after the target item (without movingId)", () => {
    expect(positionAfter(items, "a")).toBe(1);
    expect(positionAfter(items, "c")).toBe(3);
  });

  it("positionAfter filters out movingId before computing target index", () => {
    // Move A after C: in [A, B, C], remove A → [B, C], C is at 1,
    // we want X at index 2 → position 2 (= N-1 of original list, valid).
    expect(positionAfter(items, "c", "a")).toBe(2);
    // Move B after C: in [A, B, C], remove B → [A, C], C is at 1,
    // we want X at index 2 → position 2.
    expect(positionAfter(items, "c", "b")).toBe(2);
    // Move C after A: in [A, B, C], remove C → [A, B], A is at 0,
    // we want X at index 1 → position 1.
    expect(positionAfter(items, "a", "c")).toBe(1);
  });

  it("positionAfter returns null for unknown ids", () => {
    expect(positionAfter(items, "missing")).toBeNull();
    expect(positionAfter(items, "missing", "a")).toBeNull();
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
    mockedStock.mockReset();
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
    mockedStock.mockReset();
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
