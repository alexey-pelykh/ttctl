// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatPortfolioPretty, formatPortfolioTable } from "../list.js";

/**
 * Strip ANSI escape sequences (color codes) so test assertions can
 * measure the visible width of cli-table3 rows without worrying about
 * the surrounding control bytes. cli-table3 emits ANSI by default for
 * border colors; line-width assertions count visible characters only.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

const FULL_ITEM: profile.portfolio.PortfolioItem = {
  id: "po-1",
  title: "Analytical Engine Demo",
  description: "Designed the punch-card pipeline.\n\nValidated against Bernoulli sequences.",
  link: "https://example.com/analytical",
  highlight: true,
  coverImage: "https://cdn.example.com/cover.jpg",
  accomplishment: "Featured at the 1843 exhibition.",
  publicationPermit: true,
  clientOrCompanyName: "Babbage & Co",
  websiteUrl: null,
  toptalRelated: false,
  showViaToptal: false,
  kind: "classic",
  skills: [],
  industries: [],
  details: null,
  files: [],
  kpis: [],
  quotes: [],
  engagement: null,
};

const MINIMAL_ITEM: profile.portfolio.PortfolioItem = {
  id: "po-2",
  title: "Untitled Project",
  description: null,
  link: null,
  highlight: false,
  coverImage: null,
  accomplishment: null,
  publicationPermit: null,
  clientOrCompanyName: null,
  websiteUrl: null,
  toptalRelated: null,
  showViaToptal: null,
  kind: null,
  skills: [],
  industries: [],
  details: null,
  files: [],
  kpis: [],
  quotes: [],
  engagement: null,
};

const MULTI_PARAGRAPH_ITEM: profile.portfolio.PortfolioItem = {
  id: "po-3",
  title: "Difference Engine Notes",
  description: "Mechanical calculation prototypes.\n\nHand-crafted gear assemblies.\n\nObserved Bernoulli convergence.",
  link: null,
  highlight: false,
  coverImage: null,
  accomplishment: "Published as Note G.\n\nCorrected by Menabrea.",
  publicationPermit: null,
  clientOrCompanyName: null,
  websiteUrl: null,
  toptalRelated: null,
  showViaToptal: null,
  kind: null,
  skills: [],
  industries: [],
  details: null,
  files: [],
  kpis: [],
  quotes: [],
  engagement: null,
};

describe("formatPortfolioPretty", () => {
  it("renders every editable field for a fully-populated item", () => {
    const out = formatPortfolioPretty([FULL_ITEM]);
    const lines = out.split("\n");

    // Item header with id, ★ marker, title
    expect(lines).toContain("  po-1 ★ Analytical Engine Demo");
    // All sub-fields
    expect(lines).toContain("    Client: Babbage & Co");
    expect(lines).toContain("    URL: https://example.com/analytical");
    expect(lines).toContain("    Cover: https://cdn.example.com/cover.jpg");
    expect(lines).toContain("    Description:");
    expect(lines).toContain("      Designed the punch-card pipeline.");
    expect(lines).toContain("      Validated against Bernoulli sequences.");
    expect(lines).toContain("    Accomplishment:");
    expect(lines).toContain("      Featured at the 1843 exhibition.");
  });

  it("preserves multi-paragraph description breaks as actual blank lines", () => {
    const out = formatPortfolioPretty([MULTI_PARAGRAPH_ITEM]);
    expect(out).not.toContain("\\n\\n");
    expect(out).toContain(
      "    Description:\n      Mechanical calculation prototypes.\n\n      Hand-crafted gear assemblies.\n\n      Observed Bernoulli convergence.",
    );
    // Multi-paragraph accomplishment
    expect(out).toContain("    Accomplishment:\n      Published as Note G.\n\n      Corrected by Menabrea.");
  });

  it("renders `(unset)` for missing description and skips other null fields", () => {
    const out = formatPortfolioPretty([MINIMAL_ITEM]);
    const lines = out.split("\n");

    // ID + title (no star — highlight=false)
    expect(lines).toContain("  po-2 Untitled Project");
    // Description always renders, missing → (unset)
    expect(lines).toContain("    Description: (unset)");
    // Other fields skip-if-null
    expect(out).not.toContain("Client:");
    expect(out).not.toContain("URL:");
    expect(out).not.toContain("Cover:");
    expect(out).not.toContain("Accomplishment:");
  });

  it("falls back to `(untitled)` when title is null", () => {
    const noTitle: profile.portfolio.PortfolioItem = { ...MINIMAL_ITEM, title: null };
    const out = formatPortfolioPretty([noTitle]);
    expect(out).toContain("  po-2 (untitled)");
  });

  it("inserts a single blank line between items but not after the last item", () => {
    const out = formatPortfolioPretty([FULL_ITEM, MINIMAL_ITEM]);
    // Two items rendered, separated by an empty line
    expect(out).toContain("    Accomplishment:\n      Featured at the 1843 exhibition.\n\n  po-2 Untitled Project");
    // No trailing blank line
    expect(out.endsWith("\n\n")).toBe(false);
    expect(out.endsWith("(unset)")).toBe(true);
  });

  it("preserves server ordering (does not re-sort)", () => {
    const out = formatPortfolioPretty([MINIMAL_ITEM, FULL_ITEM]);
    const idxMinimal = out.indexOf("po-2");
    const idxFull = out.indexOf("po-1");
    expect(idxMinimal).toBeLessThan(idxFull);
  });

  it("renders the header line with correct singular/plural", () => {
    expect(formatPortfolioPretty([FULL_ITEM]).startsWith("1 portfolio item:")).toBe(true);
    expect(formatPortfolioPretty([FULL_ITEM, MINIMAL_ITEM]).startsWith("2 portfolio items:")).toBe(true);
  });

  it("does NOT truncate long URLs (pretty does not truncate)", () => {
    const longUrl = `https://example.com/${"x".repeat(200)}`;
    const longItem: profile.portfolio.PortfolioItem = { ...FULL_ITEM, link: longUrl };
    const out = formatPortfolioPretty([longItem]);
    expect(out).toContain(longUrl);
    expect(out).not.toContain("…");
  });

  it("returns a defensive empty marker when called with an empty array", () => {
    // Production callers route empty lists through the empty-state wrapper
    // before reaching the formatter; this branch is for direct callers.
    expect(formatPortfolioPretty([])).toBe("(no portfolio items)");
  });

  // #548: `details` body block rendering — one-line summary per variant.
  it("renders Image details with optimizedUrl preferred over thumbUrl", () => {
    const withImage: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      details: {
        kind: "image",
        id: "b-1",
        title: "Architecture",
        image: { thumbUrl: "https://cdn.example/thumb.png", optimizedUrl: "https://cdn.example/opt.png" },
      },
    };
    const out = formatPortfolioPretty([withImage]);
    expect(out).toContain("    Details: Image: https://cdn.example/opt.png — Architecture");
  });

  it("falls back to thumbUrl when optimizedUrl is null and omits title suffix when title is null", () => {
    const noOpt: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      details: {
        kind: "image",
        id: "b-1",
        title: null,
        image: { thumbUrl: "https://cdn.example/thumb.png", optimizedUrl: null },
      },
    };
    const out = formatPortfolioPretty([noOpt]);
    expect(out).toContain("    Details: Image: https://cdn.example/thumb.png");
    expect(out).not.toContain(" — ");
  });

  it("renders Text details with a `(rich body)` marker when contentHast is present", () => {
    const withText: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      details: { kind: "text", id: "b-2", title: "Project notes", contentHast: { type: "root", children: [] } },
    };
    const out = formatPortfolioPretty([withText]);
    expect(out).toContain("    Details: Text (rich body) — Project notes");
  });

  it("renders Video details with the videoUrl", () => {
    const withVideo: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      details: { kind: "video", id: "b-3", title: "Demo reel", videoUrl: "https://youtu.be/abc" },
    };
    const out = formatPortfolioPretty([withVideo]);
    expect(out).toContain("    Details: Video: https://youtu.be/abc — Demo reel");
  });

  it("renders Gallery details with an item-count summary (singular/plural)", () => {
    const oneItem: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      details: {
        kind: "gallery",
        id: "b-4",
        title: null,
        items: [{ id: "gi-1", contentType: "image/png", image: null }],
      },
    };
    const threeItems: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      id: "po-gallery-3",
      details: {
        kind: "gallery",
        id: "b-5",
        title: "Screens",
        items: [
          { id: "gi-1", contentType: null, image: null },
          { id: "gi-2", contentType: null, image: null },
          { id: "gi-3", contentType: null, image: null },
        ],
      },
    };
    expect(formatPortfolioPretty([oneItem])).toContain("    Details: Gallery (1 item)");
    expect(formatPortfolioPretty([threeItems])).toContain("    Details: Gallery (3 items) — Screens");
  });

  it("skips the Details line when the item has no body block (details=null)", () => {
    const out = formatPortfolioPretty([MINIMAL_ITEM]);
    expect(out).not.toContain("Details:");
  });

  // #549: `files` attachment rendering — a `Files (N):` header plus one
  // row per file with kind, URL, and optional title.
  it("renders attached files: PDF (fileUrl) and Image (optimized URL) rows", () => {
    const withFiles: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      files: [
        {
          kind: "pdf",
          id: "f-1",
          title: "Case study",
          description: null,
          contentType: "application/pdf",
          fileUrl: "https://cdn.example/case.pdf",
          primaryContentType: "pdf",
        },
        {
          kind: "image",
          id: "f-2",
          title: null,
          description: null,
          contentType: "image/png",
          image: { thumbUrl: "https://cdn.example/t.png", optimizedUrl: "https://cdn.example/o.png" },
        },
      ],
    };
    const out = formatPortfolioPretty([withFiles]);
    expect(out).toContain("    Files (2 files):");
    expect(out).toContain("      - PDF: https://cdn.example/case.pdf — Case study");
    expect(out).toContain("      - Image: https://cdn.example/o.png");
  });

  it("uses the singular `file` noun for a single attachment and falls back to thumbUrl", () => {
    const oneFile: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      files: [
        {
          kind: "image",
          id: "f-1",
          title: null,
          description: null,
          contentType: "image/png",
          image: { thumbUrl: "https://cdn.example/thumb.png", optimizedUrl: null },
        },
      ],
    };
    const out = formatPortfolioPretty([oneFile]);
    expect(out).toContain("    Files (1 file):");
    expect(out).toContain("      - Image: https://cdn.example/thumb.png");
  });

  it("renders `(no url)` when a PDF file has no fileUrl", () => {
    const noUrl: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      files: [
        {
          kind: "pdf",
          id: "f-1",
          title: null,
          description: null,
          contentType: null,
          fileUrl: null,
          primaryContentType: null,
        },
      ],
    };
    const out = formatPortfolioPretty([noUrl]);
    expect(out).toContain("      - PDF: (no url)");
  });

  it("skips the Files line when the item has no attachments (files=[])", () => {
    const out = formatPortfolioPretty([MINIMAL_ITEM]);
    expect(out).not.toContain("Files");
  });

  // #550: `kpis` rendering — talent-authored quantified outcomes.
  it("renders KPIs (N): block with value: description rows", () => {
    const withKpis: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      kpis: [
        { id: "k-1", value: "40%", description: "page load reduction" },
        { id: "k-2", value: "1M", description: "monthly active users" },
      ],
    };
    const out = formatPortfolioPretty([withKpis]);
    expect(out).toContain("    KPIs (2 KPIs):");
    expect(out).toContain("      - 40%: page load reduction");
    expect(out).toContain("      - 1M: monthly active users");
  });

  it("uses singular `KPI` noun for a single entry", () => {
    const oneKpi: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      kpis: [{ id: "k-1", value: "5x", description: "throughput improvement" }],
    };
    const out = formatPortfolioPretty([oneKpi]);
    expect(out).toContain("    KPIs (1 KPI):");
    expect(out).toContain("      - 5x: throughput improvement");
  });

  it("renders (unset) when KPI value or description is null/empty", () => {
    const partial: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      kpis: [
        { id: "k-1", value: null, description: "no value yet" },
        { id: "k-2", value: "75%", description: null },
        { id: "k-3", value: "", description: "" },
      ],
    };
    const out = formatPortfolioPretty([partial]);
    expect(out).toContain("      - (unset): no value yet");
    expect(out).toContain("      - 75%: (unset)");
    expect(out).toContain("      - (unset): (unset)");
  });

  it("skips the KPIs line when the item has no KPIs (kpis=[])", () => {
    const out = formatPortfolioPretty([MINIMAL_ITEM]);
    expect(out).not.toContain("KPIs");
  });

  // #551: `quotes` rendering — talent-authored client/stakeholder testimonials.
  it("renders Quotes (N): block with quoted text and full attribution rows", () => {
    const withQuotes: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      quotes: [
        { id: "q-1", text: "Shipped on time.", clientName: "Jane Doe", clientRole: "VP Engineering", company: "Acme" },
        { id: "q-2", text: "A pleasure to work with.", clientName: "John Roe", clientRole: null, company: "Globex" },
      ],
    };
    const out = formatPortfolioPretty([withQuotes]);
    expect(out).toContain("    Quotes (2 quotes):");
    expect(out).toContain('      - "Shipped on time." — Jane Doe, VP Engineering @ Acme');
    expect(out).toContain('      - "A pleasure to work with." — John Roe @ Globex');
  });

  it("uses singular `quote` noun for a single entry", () => {
    const oneQuote: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      quotes: [{ id: "q-1", text: "Excellent.", clientName: "Ada", clientRole: "Lead", company: "Eng" }],
    };
    const out = formatPortfolioPretty([oneQuote]);
    expect(out).toContain("    Quotes (1 quote):");
    expect(out).toContain('      - "Excellent." — Ada, Lead @ Eng');
  });

  it("renders (unset) when the quote text is null/empty", () => {
    const partial: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      quotes: [{ id: "q-1", text: null, clientName: "Jane", clientRole: "PM", company: "Acme" }],
    };
    const out = formatPortfolioPretty([partial]);
    expect(out).toContain("      - (unset) — Jane, PM @ Acme");
  });

  it("omits the attribution suffix when no client fields are present", () => {
    const noAttribution: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      quotes: [{ id: "q-1", text: "Solid delivery.", clientName: null, clientRole: null, company: null }],
    };
    const out = formatPortfolioPretty([noAttribution]);
    const line = out.split("\n").find((l) => l.includes("Solid delivery"));
    expect(line).toBe('      - "Solid delivery."');
  });

  it("interleaves partial attribution (name + company, no role)", () => {
    const partialAttr: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      quotes: [{ id: "q-1", text: "Great.", clientName: "Ada", clientRole: null, company: "Eng" }],
    };
    const out = formatPortfolioPretty([partialAttr]);
    expect(out).toContain('      - "Great." — Ada @ Eng');
  });

  it("skips the Quotes line when the item has no quotes (quotes=[])", () => {
    const out = formatPortfolioPretty([MINIMAL_ITEM]);
    expect(out).not.toContain("Quotes");
  });

  // Provenance: #552 — `engagement` discovery hint. The id is a
  // TalentEngagement.id (cross-references `engagements list`'s
  // `engagementId` column, NOT the `engagements show <id>` arg).
  it("renders an Engagement discovery-hint line pointing at engagements list", () => {
    const linked: profile.portfolio.PortfolioItem = {
      ...MINIMAL_ITEM,
      engagement: { id: "V1-TalentEngagement-238005" },
    };
    const out = formatPortfolioPretty([linked]);
    expect(out).toContain(
      "    Engagement: V1-TalentEngagement-238005 (TalentEngagement — see `ttctl engagements list`)",
    );
  });

  it("skips the Engagement line when the item is not engagement-linked (engagement=null)", () => {
    const out = formatPortfolioPretty([MINIMAL_ITEM]);
    expect(out).not.toContain("Engagement:");
  });
});

describe("formatPortfolioTable", () => {
  it("renders a cli-table3 table with id, title, highlight, client, link columns", () => {
    // 200-wide terminal so cli-table3 wordWrap doesn't truncate the URL —
    // the test asserts column presence + value rendering, not width
    // adaptation (covered by the dedicated terminal-width test).
    const out = formatPortfolioTable([FULL_ITEM, MINIMAL_ITEM], 200);
    expect(out).toMatch(/[┌┬┐├┼┤└┴┘─│]/);
    expect(out).toContain("id");
    expect(out).toContain("title");
    expect(out).toContain("highlight");
    expect(out).toContain("client");
    expect(out).toContain("link");
    // Values
    expect(out).toContain("po-1");
    expect(out).toContain("Analytical Engine Demo");
    expect(out).toContain("★");
    expect(out).toContain("Babbage & Co");
    expect(out).toContain("https://example.com/analytical");
  });

  it("respects the supplied terminal width", () => {
    const wide = formatPortfolioTable([FULL_ITEM], 200);
    const narrow = formatPortfolioTable([FULL_ITEM], 80);
    const wideLines = wide.split("\n").map(stripAnsi);
    const narrowLines = narrow.split("\n").map(stripAnsi);
    expect(Math.max(...wideLines.map((l) => l.length))).toBeLessThanOrEqual(200);
    expect(Math.max(...narrowLines.map((l) => l.length))).toBeLessThan(Math.max(...wideLines.map((l) => l.length)));
  });

  it("renders an empty header-only table when called with an empty array", () => {
    const out = formatPortfolioTable([]);
    expect(out).toContain("id");
    expect(out).toContain("client");
  });
});
