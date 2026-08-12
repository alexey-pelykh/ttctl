// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import {
  analyzeToolCatalog,
  formatReport,
  parseCatalog,
  type CatalogInputs,
  type RunReport,
} from "./check-mcp-tool-catalog.js";
import { type McpToolResolution } from "./check-readme-verbs.js";

// Drives the gate's pure core against in-memory fixtures. Runs under root vitest
// (`pnpm test:coverage`), NOT `turbo run test` (per-package, never sees scripts/).

function rosterOf(size: number): McpToolResolution {
  const names = new Set<string>();
  for (let i = 0; i < size; i++) names.add(`ttctl_tool_${String(i)}`);
  return { names, error: null };
}

interface AnalyzeOpts {
  readme: string;
  /** A resolution object, or a thunk (to assert resolution behaviour). */
  roster: McpToolResolution | (() => McpToolResolution);
}

function resolverFor(roster: AnalyzeOpts["roster"]): CatalogInputs["resolveRoster"] {
  return typeof roster === "function" ? roster : () => roster;
}

function analyze(opts: AnalyzeOpts): RunReport {
  return analyzeToolCatalog({ readme: opts.readme, resolveRoster: resolverFor(opts.roster) });
}

/**
 * A well-formed catalog section: total 6, bullets summing to 6. The trailing
 * `### Glossary` carries a decoy total that must stay out of scope.
 */
function catalog(
  opts: { total?: string; bullets?: readonly string[]; after?: readonly string[]; glossary?: boolean } = {},
): string {
  return [
    "## API Surface",
    "",
    "### Tool catalog",
    "",
    opts.total ?? "The server registers 6 tools spanning the surface (per-domain counts below sum to the total):",
    "",
    ...(opts.bullets ?? ["- **`profile.*`** (4 tools) — basic, skills", "- **`me`** (2 tools) — actions list"]),
    "",
    ...(opts.after ?? ["Prose tail naming no counts."]),
    "",
    ...(opts.glossary === false ? [] : ["### Glossary", "", "The server registers 999 tools — decoy outside."]),
  ].join("\n");
}

describe("check-mcp-tool-catalog — invariants", () => {
  it("passes when roster, stated total, and per-domain sum all agree", () => {
    const r = analyze({ readme: catalog(), roster: rosterOf(6) });
    expect(r.findings).toEqual([]);
    expect(r.structuralErrors).toEqual([]);
    expect(r.rosterCount).toBe(6);
    expect(r.statedTotal).toBe(6);
    expect(r.domainSum).toBe(6);
    expect(formatReport(r, true).exitCode).toBe(0);
  });

  it("flags a total that no longer matches the roster (the 88 → 129 drift class)", () => {
    const r = analyze({ readme: catalog(), roster: rosterOf(7) });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.kind).toBe("total");
    expect(r.findings[0]?.detail).toContain("README states 6 tools but EXPECTED_TOOLS holds 7");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("flags a per-domain count that drifted while the total stayed right", () => {
    const r = analyze({
      readme: catalog({ bullets: ["- **`profile.*`** (3 tools) — basic", "- **`me`** (2 tools) — actions list"] }),
      roster: rosterOf(6),
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.kind).toBe("sum");
    expect(r.findings[0]?.detail).toContain("sum to 5");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("reports both invariants independently when both break", () => {
    const r = analyze({
      readme: catalog({ bullets: ["- **`profile.*`** (3 tools) — basic", "- **`me`** (2 tools) — actions"] }),
      roster: rosterOf(9),
    });
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["sum", "total"]);
  });

  it("accepts the singular '(1 tool)' bullet form", () => {
    const r = analyze({
      readme: catalog({
        total: "The server registers 5 tools:",
        bullets: ["- **`profile.*`** (4 tools) — basic", "- **`me`** (1 tool) — actions list"],
      }),
      roster: rosterOf(5),
    });
    expect(r.findings).toEqual([]);
    expect(r.bulletCount).toBe(2);
  });

  it("excludes a later section's total BECAUSE of the heading boundary, not by luck", () => {
    // Same decoy, heading removed: it must now fall inside the scanned section
    // and trip the ambiguity guard. Proves the boundary is what excludes it.
    const r = analyze({
      readme: catalog({ glossary: false, after: ["It registers 999 tools."] }),
      roster: rosterOf(6),
    });
    expect(r.structuralErrors.join(" ")).toContain("2 tool totals stated");
    expect(analyze({ readme: catalog(), roster: rosterOf(6) }).structuralErrors).toEqual([]);
  });

  it("tries the bullet shape before the total shape — a bullet is never read as a total", () => {
    // Both regexes match "(4 tools)". If the order flipped, every bullet would
    // register as a total and the section would look hopelessly ambiguous.
    const parsed = parseCatalog(catalog());
    expect(parsed.bullets).toHaveLength(2);
    expect(parsed.total?.count).toBe(6);
    expect(parsed.structuralErrors).toEqual([]);
  });
});

describe("check-mcp-tool-catalog — structural integrity", () => {
  it("fails when the section heading is gone rather than passing vacuously", () => {
    const r = analyze({ readme: "# @ttctl/mcp\n\nNo catalog here.\n", roster: rosterOf(6) });
    expect(r.structuralErrors.join(" ")).toContain("### Tool catalog");
    expect(r.findings).toEqual([]);
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("fails when no total is stated", () => {
    const r = analyze({ readme: catalog({ total: "The server registers a lot of things:" }), roster: rosterOf(6) });
    expect(r.structuralErrors.join(" ")).toContain("no stated tool total");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("fails when the section states more than one total — ambiguous authority", () => {
    const r = analyze({ readme: catalog({ after: ["Historically it registered 3 tools."] }), roster: rosterOf(6) });
    expect(r.structuralErrors.join(" ")).toContain("tool totals stated");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("fails on two totals stated on ONE line rather than letting the first win", () => {
    const r = analyze({
      readme: catalog({ total: "The catalog groups 6 tools into 2 domains; the server registers 999 tools:" }),
      roster: rosterOf(6),
    });
    expect(r.structuralErrors.join(" ")).toContain("2 tool totals stated");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("fails when no domain bullets parse", () => {
    const r = analyze({ readme: catalog({ bullets: [] }), roster: rosterOf(6) });
    expect(r.structuralErrors.join(" ")).toContain("bullets found");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("reports a malformed bullet instead of silently dropping it from the sum", () => {
    const r = analyze({
      readme: catalog({ bullets: ["- **`profile.*`** (4 tools) — basic", "- **me** 2 tools — malformed"] }),
      roster: rosterOf(6),
    });
    expect(r.structuralErrors.join(" ")).toContain("bullet shape");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("fails on an unreadable roster rather than leaving the total unchecked", () => {
    const r = analyze({
      readme: catalog(),
      roster: { names: new Set(), error: "registration.test.ts not readable — cannot resolve the tool roster" },
    });
    expect(r.structuralErrors.join(" ")).toContain("not readable");
    // The total invariant is suppressed (no authority to compare against), but
    // the sum invariant is roster-independent and still holds.
    expect(r.findings).toEqual([]);
    expect(formatReport(r, true).exitCode).toBe(1);
  });
});

describe("check-mcp-tool-catalog — exemptions", () => {
  it("drops an exempted bullet from the sum and surfaces its reason", () => {
    const r = analyze({
      readme: catalog({
        bullets: [
          "- **`profile.*`** (4 tools) — basic",
          "- **`me`** (2 tools) — actions list",
          "<!-- mcp-catalog-exempt: aggregate row, already counted above -->",
          "- **`aliases`** (3 tools) — CLI-only aliases",
        ],
      }),
      roster: rosterOf(6),
    });
    expect(r.findings).toEqual([]);
    expect(r.domainSum).toBe(6);
    expect(r.exempted).toHaveLength(1);
    expect(r.exempted[0]?.reason).toBe("aggregate row, already counted above");
    expect(formatReport(r, true).text).toContain("aggregate row, already counted above");
  });

  it("exempts the total invariant when the marker sits above the total line", () => {
    const readme = [
      "### Tool catalog",
      "",
      "<!-- mcp-catalog-exempt: total deliberately excludes internal tools -->",
      "The server registers 6 tools:",
      "",
      "- **`profile.*`** (4 tools) — basic",
      "- **`me`** (2 tools) — actions list",
    ].join("\n");
    const r = analyze({ readme, roster: rosterOf(99) });
    expect(r.findings).toEqual([]);
    expect(r.exempted.map((e) => e.subject)).toContain("stated total");
    // Exempting the total does not disable the roster-independent sum check.
    expect(r.domainSum).toBe(6);
    // The header must not claim an equality the run never verified.
    const text = formatReport(r, true).text;
    expect(text).toContain("roster 99 comparison exempted");
    expect(text).not.toContain("roster 99 = stated total 6");
  });

  it("still fails the sum when every bullet is exempted — no wholesale off switch", () => {
    const readme = [
      "### Tool catalog",
      "",
      "The server registers 6 tools:",
      "",
      "<!-- mcp-catalog-exempt: first -->",
      "- **`profile.*`** (4 tools) — basic",
      "<!-- mcp-catalog-exempt: second -->",
      "- **`me`** (2 tools) — actions list",
    ].join("\n");
    const r = analyze({ readme, roster: rosterOf(6) });
    expect(r.findings.map((f) => f.kind)).toEqual(["sum"]);
    expect(r.findings[0]?.detail).toContain("excluding 2 exempted bullet(s)");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("does not honour a marker placed above the section heading", () => {
    const readme = [
      "<!-- mcp-catalog-exempt: outside the scanned section -->",
      "### Tool catalog",
      "",
      "The server registers 6 tools:",
      "",
      "- **`profile.*`** (4 tools) — basic",
      "- **`me`** (2 tools) — actions list",
    ].join("\n");
    const r = analyze({ readme, roster: rosterOf(99) });
    expect(r.exempted).toEqual([]);
    expect(r.findings.map((f) => f.kind)).toEqual(["total"]);
  });

  it("fails on a marker with an empty reason AND exempts nothing with it", () => {
    // An unusable marker must not suppress the invariant it sits above:
    // otherwise a real drift is reported as zero findings plus a syntax nit.
    const readme = [
      "### Tool catalog",
      "",
      "<!-- mcp-catalog-exempt: -->",
      "The server registers 6 tools:",
      "",
      "- **`profile.*`** (4 tools) — basic",
      "- **`me`** (2 tools) — actions list",
    ].join("\n");
    const r = analyze({ readme, roster: rosterOf(1) });
    expect(r.markerIssues.join(" ")).toContain("empty reason");
    expect(r.exempted).toEqual([]);
    expect(r.findings.map((f) => f.kind)).toEqual(["total"]);
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("fails on a marker followed by neither a total line nor a bullet", () => {
    const r = analyze({
      readme: catalog({ after: ["<!-- mcp-catalog-exempt: dangling -->", "Just prose."] }),
      roster: rosterOf(6),
    });
    expect(r.markerIssues.join(" ")).toContain("not followed by");
    expect(formatReport(r, true).exitCode).toBe(1);
  });
});

describe("check-mcp-tool-catalog — modes", () => {
  it("warn mode reports findings but always exits 0", () => {
    const r = analyze({ readme: catalog(), roster: rosterOf(7) });
    const warn = formatReport(r, false);
    expect(warn.exitCode).toBe(0);
    expect(warn.text).toContain("CATALOG DRIFT");
    expect(warn.text).toContain("[warn]");
    expect(formatReport(r, true).exitCode).toBe(1);
  });

  it("the clean-baseline header names all three agreeing numbers", () => {
    const text = formatReport(analyze({ readme: catalog(), roster: rosterOf(6) }), true).text;
    expect(text).toContain("roster 6 = stated total 6 = per-domain sum 6");
  });
});

describe("check-mcp-tool-catalog — parseCatalog", () => {
  it("locates the total and every bullet with 1-based line numbers", () => {
    const parsed = parseCatalog(catalog());
    expect(parsed.structuralErrors).toEqual([]);
    expect(parsed.total?.count).toBe(6);
    expect(parsed.bullets.map((b) => b.domain)).toEqual(["profile.*", "me"]);
    expect(parsed.bullets.map((b) => b.count)).toEqual([4, 2]);
    // Line 5 in the fixture: "## API Surface", "", "### Tool catalog", "", <total>.
    expect(parsed.total?.line).toBe(5);
  });
});
