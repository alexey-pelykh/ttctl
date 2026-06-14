// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import {
  analyzeReadmeVerbs,
  formatReport,
  parseExpectedToolNames,
  type McpToolResolution,
  type ReadmeVerbsInputs,
  type RunReport,
} from "./check-readme-verbs.js";

// Drives the gate's pure core against in-memory fixtures. Runs under root vitest
// (`pnpm test:coverage`), NOT `turbo run test` (per-package, never sees scripts/).
// Focus: the #765 MCP tool-name claim resolution; a regression case guards the
// pre-existing CLI command/verb paths through the refactored core.

// Mirrors DOMAIN_MAP's CLI target dirs. Production passes every dir under
// `packages/cli/src/commands`, so the in-core "DOMAIN_MAP target … does not
// exist" staleness check never fires; fixtures include the full set so it
// stays quiet here too. A bullet testing an unknown domain still works — that
// path keys off DOMAIN_MAP membership, not this set.
const ALL_DOMAINS = [
  "profile",
  "applications",
  "engagements",
  "jobs",
  "timesheet",
  "availability",
  "contracts",
  "payments",
  "surveys",
  "auth",
];

interface AnalyzeOpts {
  readme: string;
  domains?: string[];
  tokens?: Record<string, readonly string[]>;
  /** A resolution object, or a thunk (to assert lazy resolution / throw-if-called). */
  mcp?: McpToolResolution | (() => McpToolResolution);
}

// Early-return narrowing (vs an inline ternary on `opts.mcp`) so the thunk's
// return type stays `McpToolResolution`, not the wider input union — strict tsc.
function resolverFor(mcp: AnalyzeOpts["mcp"]): ReadmeVerbsInputs["resolveMcpTools"] {
  if (typeof mcp === "function") return mcp;
  const resolution: McpToolResolution = mcp ?? { names: new Set<string>(), error: null };
  return () => resolution;
}

function analyze(opts: AnalyzeOpts): RunReport {
  const tokens = opts.tokens ?? {};
  return analyzeReadmeVerbs({
    readme: opts.readme,
    domains: new Set([...ALL_DOMAINS, ...(opts.domains ?? [])]),
    tokensOf: (d) => new Set(tokens[d] ?? []),
    resolveMcpTools: resolverFor(opts.mcp),
  });
}

/** Wrap a bullet in the minimal `## What It Does` … `### Out of scope` section the parser scans. */
function readmeWith(...bullets: string[]): string {
  return ["## What It Does", "", ...bullets, "", "### Out of scope", ""].join("\n");
}

const registered = (...names: string[]): McpToolResolution => ({ names: new Set(names), error: null });

describe("parseExpectedToolNames — EXPECTED_TOOLS roster extraction", () => {
  it("extracts every ttctl_* literal from the array body", () => {
    const source = [
      `const EXPECTED_TOOLS = [`,
      `  // jobs`,
      `  "ttctl_jobs_list",`,
      `  "ttctl_jobs_apply_similar_answers",`,
      `];`,
    ].join("\n");
    const { names, error } = parseExpectedToolNames(source);
    expect(error).toBeNull();
    expect([...names].sort()).toEqual(["ttctl_jobs_apply_similar_answers", "ttctl_jobs_list"]);
  });

  it("masks comments so a tool name mentioned in a comment is not counted", () => {
    const source = [`const EXPECTED_TOOLS = [`, `  "ttctl_real",`, `  // renamed from "ttctl_ghost"`, `];`].join("\n");
    const { names, error } = parseExpectedToolNames(source);
    expect(error).toBeNull();
    expect([...names]).toEqual(["ttctl_real"]);
  });

  it("errors (never silently empty) when the array is absent", () => {
    const { names, error } = parseExpectedToolNames(`const SOMETHING_ELSE = 1;`);
    expect(names.size).toBe(0);
    expect(error).toMatch(/EXPECTED_TOOLS array not found/);
  });

  it("errors when the array is present but holds no ttctl_* names", () => {
    const { error } = parseExpectedToolNames(`const EXPECTED_TOOLS = [];`);
    expect(error).toMatch(/no ttctl_\* names/);
  });
});

describe("analyzeReadmeVerbs — #765 MCP tool-name claims", () => {
  const jobsBullet = "- **Jobs** — `ttctl_jobs_apply_similar_answers` exposes the apply surface to agents.";

  it("treats a registered ttctl_* claim as checked, not unchecked", () => {
    const report = analyze({
      readme: readmeWith(jobsBullet),
      mcp: registered("ttctl_jobs_apply_similar_answers"),
    });
    expect(report.findings).toEqual([]);
    // Counted among checked claims; the span is no longer routed to an
    // unchecked backtick row (the pre-#765 "MCP tool name — not a CLI path").
    expect(report.claimCount).toBeGreaterThanOrEqual(1);
    expect(report.unchecked.some((u) => u.detail.startsWith("backtick `ttctl_"))).toBe(false);
  });

  it("flags an unregistered ttctl_* claim as a finding (the renamed/removed-tool drift)", () => {
    const report = analyze({
      readme: readmeWith(jobsBullet),
      mcp: registered("ttctl_jobs_apply"), // roster present, but not this name
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.detail).toContain("ttctl_jobs_apply_similar_answers");
    expect(report.findings[0]?.detail).toMatch(/not registered/);
    // A finding fails strict, passes warn.
    expect(formatReport(report, true).exitCode).toBe(1);
    expect(formatReport(report, false).exitCode).toBe(0);
  });

  it("records a single structural error when the roster cannot be resolved but a claim needs it", () => {
    const report = analyze({
      readme: readmeWith(jobsBullet, "- **Auth** — `ttctl_auth_whoami` reports identity."),
      mcp: { names: new Set(), error: "registration test not readable" },
    });
    // Both ttctl_* claims hit the error; it is de-duplicated to one structural error.
    expect(report.structuralErrors).toEqual(["registration test not readable"]);
    expect(report.findings).toEqual([]);
    expect(formatReport(report, true).exitCode).toBe(1);
  });

  it("never resolves the roster when no ttctl_* claim is present (lazy)", () => {
    const report = analyze({
      readme: readmeWith("- **Contracts** — view talent-level contracts."),
      tokens: { contracts: ["show", "list"] },
      mcp: () => {
        throw new Error("resolveMcpTools must not be called without a ttctl_* claim");
      },
    });
    expect(report.structuralErrors).toEqual([]);
    expect(report.findings).toEqual([]);
  });
});

describe("analyzeReadmeVerbs — CLI command/verb paths survive the refactor", () => {
  it("passes a registered command path + verb, flags an unregistered command token", () => {
    const clean = analyze({
      readme: readmeWith("- **Payments** — view payout history via `payments rate show`."),
      tokens: { payments: ["rate", "show"] },
    });
    expect(clean.findings).toEqual([]);

    const broken = analyze({
      readme: readmeWith("- **Payments** — view payout history via `payments rate bogus`."),
      tokens: { payments: ["rate", "show"] },
    });
    expect(broken.findings).toHaveLength(1);
    expect(broken.findings[0]?.detail).toContain("bogus");
  });
});
