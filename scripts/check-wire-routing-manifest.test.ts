// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import {
  analyzeWireRouting,
  formatReport,
  parseManifest,
  type CoreFile,
  type RunReport,
} from "./check-wire-routing-manifest.js";

// Drives the gate's pure core against in-memory fixtures. Runs under root vitest
// (`pnpm test:coverage`), NOT `turbo run test` (per-package, never sees scripts/).

/** A manifest with one section per surface and the given rows. */
function manifestOf(sections: Record<string, readonly (readonly [string, string])[]>): string {
  const out: string[] = ["# Per-op wire-validation routing manifest", ""];
  for (const [surface, rows] of Object.entries(sections)) {
    out.push(`## \`${surface}\` (${String(rows.length)} ops)`, "");
    out.push("| Op | Track | Rationale |", "| -- | ----- | --------- |");
    for (const [op, track] of rows) out.push(`| ${op} | ${track} | because. |`);
    out.push("");
  }
  return out.join("\n");
}

/** A core source file invoking `op` through a direct transport call. */
function directCall(path: string, op: string, surface = "mobile-gateway", prefix: readonly string[] = []): CoreFile {
  return {
    path,
    content: [
      ...prefix,
      "const res = await stockTransport({",
      `  surface: "${surface}",`,
      "  authToken: token,",
      `  body: { operationName: "${op}", query: Q },`,
      "});",
    ].join("\n"),
  };
}

/** A core source file invoking `op` through the `callTalentProfile` helper. */
function helperCall(path: string, op: string, prefix: readonly string[] = []): CoreFile {
  return {
    path,
    content: [...prefix, `const res = await callTalentProfile(token, "${op}", QUERY, {}, "ctx");`].join("\n"),
  };
}

function analyze(manifest: string, coreFiles: readonly CoreFile[]): RunReport {
  return analyzeWireRouting({ manifest, coreFiles });
}

const ONE_ROW = manifestOf({ "mobile-gateway": [["GetViewer", "T1"]] });

describe("check-wire-routing-manifest — the invariant", () => {
  it("passes when every invoked op has a row", () => {
    const report = analyze(ONE_ROW, [directCall("packages/core/src/services/a.ts", "GetViewer")]);
    expect(report.findings).toEqual([]);
    expect(report.structuralErrors).toEqual([]);
    expect(report.invokedCount).toBe(1);
    expect(report.rowCount).toBe(1);
  });

  it("flags an invoked op with no row", () => {
    const report = analyze(ONE_ROW, [
      directCall("packages/core/src/services/a.ts", "GetViewer"),
      directCall("packages/core/src/services/b.ts", "UpdateTimesheet"),
    ]);
    expect(report.findings.map((f) => f.op)).toEqual(["UpdateTimesheet"]);
    expect(report.findings[0]?.file).toBe("packages/core/src/services/b.ts");
  });

  it("finds helper-wrapped invocations a literal scan would miss", () => {
    // The whole reason the extractor is imported rather than re-implemented:
    // `callTalentProfile(token, "X", …)` carries the name positionally.
    const report = analyze(ONE_ROW, [helperCall("packages/core/src/services/c.ts", "GET_REPORTING_TO_AUTOCOMPLETE")]);
    expect(report.findings.map((f) => f.op)).toEqual(["GET_REPORTING_TO_AUTOCOMPLETE"]);
    expect(report.findings[0]?.surface).toBe("talent-profile");
  });

  it("accepts a row filed under a different surface section than the call site", () => {
    // Documented granularity: the gate asserts PRESENCE, not section placement.
    const report = analyze(manifestOf({ "talent-profile": [["GetViewer", "T1"]] }), [
      directCall("packages/core/src/services/a.ts", "GetViewer", "mobile-gateway"),
    ]);
    expect(report.findings).toEqual([]);
  });

  it("accepts a row whose track contradicts codegen state", () => {
    // The other documented residual: derivation stays a review-time judgement.
    const report = analyze(manifestOf({ "mobile-gateway": [["GetViewer", "T2 (wired)"]] }), [
      directCall("packages/core/src/services/a.ts", "GetViewer"),
    ]);
    expect(report.findings).toEqual([]);
  });

  it("reports one finding for an op invoked from several files", () => {
    const report = analyze(ONE_ROW, [
      directCall("packages/core/src/services/a.ts", "JobsByIDs"),
      directCall("packages/core/src/services/b.ts", "JobsByIDs"),
    ]);
    expect(report.findings.map((f) => f.op)).toEqual(["JobsByIDs"]);
    expect(report.findings[0]?.file).toBe("packages/core/src/services/a.ts");
  });
});

describe("check-wire-routing-manifest — stale rows are reported, never gated", () => {
  it("surfaces a documented op nothing invokes without failing", () => {
    const report = analyze(
      manifestOf({
        "mobile-gateway": [
          ["GetViewer", "T1"],
          ["Removed", "T1"],
        ],
      }),
      [directCall("packages/core/src/services/a.ts", "GetViewer")],
    );
    expect(report.staleRows.map((s) => s.op)).toEqual(["Removed"]);
    expect(report.findings).toEqual([]);
    expect(formatReport(report, true).exitCode).toBe(0);
  });
});

describe("check-wire-routing-manifest — structural integrity", () => {
  it("fails when no surface section is found rather than passing vacuously", () => {
    const report = analyze("# Manifest\n\nProse only.\n", [directCall("packages/core/src/services/a.ts", "GetViewer")]);
    expect(report.structuralErrors.join("\n")).toMatch(/no "## `<surface>` \(N ops\)" sections found/);
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("fails when a section exists but no row parses", () => {
    const report = analyze("## `mobile-gateway` (0 ops)\n\nNo table here.\n", [
      directCall("packages/core/src/services/a.ts", "GetViewer"),
    ]);
    expect(report.structuralErrors.join("\n")).toMatch(/no op rows parsed/);
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("fails on a degenerate subject — zero ops extracted from a non-empty file set", () => {
    // A scan resolving nothing makes every op vacuously "documented".
    const report = analyze(ONE_ROW, [{ path: "packages/core/src/services/a.ts", content: "export const x = 1;\n" }]);
    expect(report.findings).toEqual([]);
    expect(report.structuralErrors.join("\n")).toMatch(/the scan resolved nothing/);
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("fails on an unreadable manifest rather than reporting every op as missing", () => {
    // `main` substitutes empty content for an unreadable file; the empty
    // manifest must land as a structural error, not 60 phantom findings.
    const report = analyze("", [directCall("packages/core/src/services/a.ts", "GetViewer")]);
    expect(report.structuralErrors.join("\n")).toMatch(/no "## `<surface>` \(N ops\)" sections found/);
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("reports a malformed table row instead of silently dropping it", () => {
    const manifest = [
      "## `mobile-gateway` (2 ops)",
      "",
      "| Op | Track |",
      "| -- | ----- |",
      "| GetViewer | T1 |",
      "| |",
    ].join("\n");
    const report = analyze(manifest, [directCall("packages/core/src/services/a.ts", "GetViewer")]);
    expect(report.structuralErrors.join("\n")).toMatch(/does not match the "\| OpName \| Track \| \.\.\." shape/);
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("fails on a track outside the canonical enum", () => {
    const report = analyze(manifestOf({ "mobile-gateway": [["GetViewer", "T3"]] }), [
      directCall("packages/core/src/services/a.ts", "GetViewer"),
    ]);
    expect(report.structuralErrors.join("\n")).toMatch(/track "T3" — not one of T1 \/ T2 \/ NEITHER/);
  });

  it("accepts the manifest's parenthetical wiring-state qualifiers", () => {
    const report = analyze(
      manifestOf({
        "mobile-gateway": [
          ["A", "T2 (wired)"],
          ["B", "T2 (ready)"],
          ["C", "NEITHER"],
        ],
      }),
      [directCall("packages/core/src/services/a.ts", "A")],
    );
    expect(report.structuralErrors).toEqual([]);
  });

  it("fails on a duplicated op row — ambiguous authority", () => {
    const report = analyze(
      manifestOf({
        "mobile-gateway": [
          ["GetViewer", "T1"],
          ["GetViewer", "T2 (ready)"],
        ],
      }),
      [directCall("packages/core/src/services/a.ts", "GetViewer")],
    );
    expect(report.structuralErrors.join("\n")).toMatch(/already has a row at line/);
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("stops reading rows at the next non-surface heading", () => {
    const manifest = `${manifestOf({ "mobile-gateway": [["GetViewer", "T1"]] })}\n## Schema-gap follow-up\n\n| Decoy | T1 | x |\n`;
    const report = parseManifest(manifest);
    expect(report.rows.map((r) => r.op)).toEqual(["GetViewer"]);
  });
});

describe("check-wire-routing-manifest — exemptions", () => {
  const exemptFile = (op: string, marker: string): CoreFile =>
    directCall("packages/core/src/services/a.ts", op, "mobile-gateway", [marker]);

  it("exempts an undocumented op and surfaces the reason", () => {
    const report = analyze(ONE_ROW, [exemptFile("UpdateTimesheet", "// wire-routing-exempt: dry-run preview only")]);
    expect(report.findings).toEqual([]);
    expect(report.exempted).toEqual([
      expect.objectContaining({ op: "UpdateTimesheet", reason: "dry-run preview only" }),
    ]);
    expect(formatReport(report, true).exitCode).toBe(0);
  });

  it("exempts NOTHING when the reason is empty, and reports the marker", () => {
    // An empty-reason marker that still exempted would hide a genuine
    // divergence behind a clean exit.
    const report = analyze(ONE_ROW, [exemptFile("UpdateTimesheet", "// wire-routing-exempt:")]);
    expect(report.exempted).toEqual([]);
    expect(report.findings.map((f) => f.op)).toEqual(["UpdateTimesheet"]);
    expect(report.markerIssues.join("\n")).toMatch(/exemption marker has an empty reason/);
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("ignores a marker further from the call site than the window", () => {
    const far = Array.from({ length: 8 }, () => "// filler");
    const report = analyze(ONE_ROW, [
      directCall("packages/core/src/services/a.ts", "UpdateTimesheet", "mobile-gateway", [
        "// wire-routing-exempt: too far away",
        ...far,
      ]),
    ]);
    expect(report.exempted).toEqual([]);
    expect(report.findings.map((f) => f.op)).toEqual(["UpdateTimesheet"]);
  });

  it("does not let one file's marker exempt another file's op", () => {
    const report = analyze(ONE_ROW, [
      exemptFile("UpdateTimesheet", "// wire-routing-exempt: intentional"),
      directCall("packages/core/src/services/b.ts", "JobsByIDs"),
    ]);
    expect(report.findings.map((f) => f.op)).toEqual(["JobsByIDs"]);
  });
});

describe("check-wire-routing-manifest — modes", () => {
  it("warn mode reports findings but always exits 0", () => {
    const report = analyze(ONE_ROW, [directCall("packages/core/src/services/b.ts", "UpdateTimesheet")]);
    const warn = formatReport(report, false);
    expect(warn.exitCode).toBe(0);
    expect(warn.text).toContain("MISSING MANIFEST ROW");
    expect(warn.text).toContain("[warn]");
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("the clean-baseline header names what was actually proven", () => {
    const report = analyze(ONE_ROW, [directCall("packages/core/src/services/a.ts", "GetViewer")]);
    expect(formatReport(report, true).text).toContain("all 1 invoked op(s) documented across 1 manifest row(s)");
  });

  it("names the derivation rule in the remedy so the track is not guessed", () => {
    const report = analyze(ONE_ROW, [directCall("packages/core/src/services/b.ts", "UpdateTimesheet")]);
    expect(formatReport(report, false).text).toMatch(
      /T2 iff codegen produced a <OpName>\(Query\|Mutation\|Subscription\) type/,
    );
  });
});

describe("check-wire-routing-manifest — parseManifest", () => {
  it("records op, surface, track, and 1-based line for each row", () => {
    const { rows } = parseManifest(
      manifestOf({ "mobile-gateway": [["GetViewer", "T1"]], "talent-profile": [["ProfileShow", "T2 (ready)"]] }),
    );
    // Lines derive from `manifestOf`: title, blank, heading, blank, header,
    // separator, then the first row — so 7, and 13 for the second section.
    expect(rows).toEqual([
      { op: "GetViewer", surface: "mobile-gateway", track: "T1", line: 7 },
      { op: "ProfileShow", surface: "talent-profile", track: "T2 (ready)", line: 13 },
    ]);
  });

  it("tolerates backticked op cells", () => {
    const manifest = "## `scheduler` (1 ops)\n\n| Op | Track |\n| -- | ----- |\n| `SomeOp` | NEITHER |\n";
    expect(parseManifest(manifest).rows.map((r) => r.op)).toEqual(["SomeOp"]);
  });
});
