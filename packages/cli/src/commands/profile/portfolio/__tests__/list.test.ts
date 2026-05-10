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
