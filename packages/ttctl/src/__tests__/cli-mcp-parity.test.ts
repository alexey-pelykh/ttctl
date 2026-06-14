// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProgram } from "@ttctl/cli";
import { listRegisteredMcpToolNames } from "@ttctl/mcp";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * CLI ↔ MCP tool-registry parity contract (#151).
 *
 * The CLI and MCP surfaces are committed to be coupled: every CLI leaf command
 * `ttctl <group> <sub-domain> <verb>` should have a matching MCP tool named
 * `ttctl_<group>_<sub-domain>_<verb>`, and every `ttctl_…` MCP tool should have
 * a CLI counterpart. Per-PR human vigilance ("MCP mirror exists") is the only
 * thing enforcing this today; this gate catches drift structurally.
 *
 * This umbrella package is the natural home: it already depends on BOTH
 * `@ttctl/cli` and `@ttctl/mcp` (the composition point), so the check needs no
 * new dependency and introduces no cli→mcp coupling.
 *
 * Discovery is RUNTIME, not source-scan:
 *   - CLI: walk the live Commander tree from `buildProgram()`.
 *   - MCP: `listRegisteredMcpToolNames()` reads a constructed server's tool
 *     registry. Runtime is mandatory for correctness — some tools register
 *     computed names (e.g. `ttctl_profile_employment_skills_${op}`) that a
 *     source scan of the tool files cannot resolve.
 *
 * Modes (mirrors the `scripts/check-*` gate family):
 *   - WARN (default): reports parity gaps via `console.warn`, never fails. Only
 *     the already-clean invariants are hard-asserted (naming convention, no
 *     stale/ambiguous exemptions, the curated known-good pairs, the auth
 *     exemption). This keeps the build green on day one despite the existing
 *     surface gaps below.
 *   - STRICT (`CLI_MCP_PARITY_STRICT=1`): additionally fails on ANY non-exempt
 *     missing-MCP or orphan-MCP. Flip on once the warn-mode baseline is triaged.
 *
 * Warn-mode baseline at introduction (the first-run audit): missing-MCP —
 * `profile portfolio upload` (split into upload_cover/upload_file at MCP),
 * `profile reviews submit-for-review` (MCP tool dropped in #544), `applications
 * confirm/reject/reject-reasons` (MCP names these `interest_requests_*`);
 * orphan-MCP — `interest_requests_*`, `jobs_apply_*` read affordances,
 * `portfolio_upload_cover/upload_file`. Triage these (exempt the intentional,
 * close the genuine drift) before flipping strict.
 *
 * Exemptions: `.mcp-exempt.yaml` (`cli_only` / `mcp_only` lists, preferred for
 * whole-sub-domain or cross-surface-rename cases) OR an inline
 * `// mcp-exempt: <reason>` comment directly above a CLI command registration.
 */

// --- repo-root resolution (robust to the test's nested location) ---

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cli-mcp-parity: could not locate repo root (pnpm-workspace.yaml)");
}

const REPO_ROOT = findRepoRoot();
const MCP_PREFIX = "ttctl_";

/**
 * Canonical MCP tool-name shape: `ttctl_` then lowercase `[a-z0-9]` segments
 * joined by single underscores (no double underscore, no trailing underscore).
 */
const TOOL_NAME_RE = /^ttctl_[a-z0-9]+(?:_[a-z0-9]+)*$/;

// --- Commander tree walk (structural type; avoids a commander type import) ---

interface CommandLike {
  name(): string;
  commands: readonly CommandLike[];
}

/**
 * Canonical leaf command paths from a Commander tree. A leaf is a command with
 * zero sub-commands; the root program name is excluded. Uses `.name()` only —
 * aliases (`certs`, `experience`) are deliberately NOT walked, matching the
 * MCP side's canonical-names-only policy.
 */
function collectCliLeafPaths(root: CommandLike): string[][] {
  const out: string[][] = [];
  const walk = (cmd: CommandLike, prefix: string[]): void => {
    const subs = cmd.commands;
    if (subs.length === 0) {
      if (prefix.length > 0) out.push(prefix);
      return;
    }
    for (const sub of subs) walk(sub, [...prefix, sub.name()]);
  };
  walk(root, []);
  return out;
}

/**
 * CLI leaf path → expected MCP tool name. Hyphenated verbs
 * (`employer-autocomplete`) and nested groups (`basic photo show`) both
 * collapse to underscore-joined segments under the `ttctl_` prefix.
 */
function cliPathToMcpName(path: readonly string[]): string {
  return MCP_PREFIX + path.map((seg) => seg.replaceAll("-", "_")).join("_");
}

// --- exemptions ---

interface Exemptions {
  /** CLI command path (space-joined) → reason. */
  cliOnly: Map<string, string>;
  /** MCP tool name → reason. */
  mcpOnly: Map<string, string>;
}

function parseExemptYaml(content: string): Exemptions {
  const cliOnly = new Map<string, string>();
  const mcpOnly = new Map<string, string>();
  const doc: unknown = parseYaml(content);
  if (doc !== null && typeof doc === "object") {
    const rec = doc as Record<string, unknown>;
    for (const entry of Array.isArray(rec["cli_only"]) ? rec["cli_only"] : []) {
      if (entry !== null && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e["command"] === "string")
          cliOnly.set(e["command"], typeof e["reason"] === "string" ? e["reason"] : "");
      }
    }
    for (const entry of Array.isArray(rec["mcp_only"]) ? rec["mcp_only"] : []) {
      if (entry !== null && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e["tool"] === "string") mcpOnly.set(e["tool"], typeof e["reason"] === "string" ? e["reason"] : "");
      }
    }
  }
  return { cliOnly, mcpOnly };
}

const COMMENT_MARKER_RE = /^\s*\/\/\s*mcp-exempt:\s*(.+?)\s*$/;
const COMMAND_DECL_RE = /(?:\.command|new Command)\(\s*["'`]([a-z][a-z0-9-]*)/;
const COMMENT_DECL_WINDOW = 3;

/**
 * Scan CLI command source for inline `// mcp-exempt: <reason>` markers. A marker
 * exempts the command leaf whose terminal verb is the `.command("<verb>")` /
 * `new Command("<verb>")` declared within {@link COMMENT_DECL_WINDOW} lines
 * below it. Returns `terminal-verb → reason`. The terminal-verb scope can match
 * more than one leaf (e.g. several groups expose `show`); `analyzeParity`
 * surfaces that as an ambiguity so the author switches to `.mcp-exempt.yaml`
 * (full path). Returns an empty map when no markers exist.
 */
function parseCommentExemptions(files: { path: string; content: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { content } of files) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const marker = COMMENT_MARKER_RE.exec(lines[i] ?? "");
      if (marker === null) continue;
      const reason = marker[1] ?? "";
      for (let j = i + 1; j <= i + COMMENT_DECL_WINDOW && j < lines.length; j++) {
        const decl = COMMAND_DECL_RE.exec(lines[j] ?? "");
        if (decl !== null && decl[1] !== undefined) {
          out.set(decl[1], reason);
          break;
        }
      }
    }
  }
  return out;
}

// --- analysis ---

interface ParityReport {
  matched: { cli: string; mcp: string }[];
  /** CLI leaf with no matching MCP tool and no exemption. */
  missingMcp: { cli: string; mcp: string }[];
  /** `ttctl_`-prefixed MCP tool with no CLI counterpart and no exemption. */
  orphanMcp: string[];
  /** Registered MCP tool whose name violates the naming convention. */
  namingViolations: string[];
  exemptedCli: { cli: string; reason: string }[];
  exemptedMcp: { mcp: string; reason: string }[];
  /** Exemption entries that reference a command/tool that no longer exists. */
  staleExemptions: string[];
  /** Comment-marker verbs that match more than one CLI leaf (ambiguous). */
  ambiguousCommentExemptions: string[];
}

function analyzeParity(input: {
  cliLeafPaths: readonly string[][];
  mcpToolNames: readonly string[];
  exemptions: Exemptions;
  commentExemptVerbs: ReadonlyMap<string, string>;
}): ParityReport {
  const { cliLeafPaths, mcpToolNames, exemptions, commentExemptVerbs } = input;
  const mcpSet = new Set(mcpToolNames);
  const expectedFromCli = new Set(cliLeafPaths.map(cliPathToMcpName));

  const report: ParityReport = {
    matched: [],
    missingMcp: [],
    orphanMcp: [],
    namingViolations: [],
    exemptedCli: [],
    exemptedMcp: [],
    staleExemptions: [],
    ambiguousCommentExemptions: [],
  };

  // Count how many leaves each comment verb matches, to flag ambiguity.
  const commentVerbMatchCount = new Map<string, number>();
  for (const path of cliLeafPaths) {
    const verb = path[path.length - 1];
    if (verb !== undefined && commentExemptVerbs.has(verb)) {
      commentVerbMatchCount.set(verb, (commentVerbMatchCount.get(verb) ?? 0) + 1);
    }
  }
  for (const [verb, count] of commentVerbMatchCount) {
    if (count > 1) report.ambiguousCommentExemptions.push(verb);
  }

  // CLI → MCP direction.
  for (const path of cliLeafPaths) {
    const cli = path.join(" ");
    const mcp = cliPathToMcpName(path);
    if (mcpSet.has(mcp)) {
      report.matched.push({ cli, mcp });
      continue;
    }
    const yamlReason = exemptions.cliOnly.get(cli);
    if (yamlReason !== undefined) {
      report.exemptedCli.push({ cli, reason: yamlReason });
      continue;
    }
    const verb = path[path.length - 1];
    const commentReason = verb !== undefined ? commentExemptVerbs.get(verb) : undefined;
    if (commentReason !== undefined) {
      report.exemptedCli.push({ cli, reason: `(comment) ${commentReason}` });
      continue;
    }
    report.missingMcp.push({ cli, mcp });
  }

  // MCP → CLI direction (naming + orphans).
  for (const tool of mcpToolNames) {
    if (!TOOL_NAME_RE.test(tool)) report.namingViolations.push(tool);
    if (expectedFromCli.has(tool)) continue; // matched above
    const reason = exemptions.mcpOnly.get(tool);
    if (reason !== undefined) {
      report.exemptedMcp.push({ mcp: tool, reason });
      continue;
    }
    report.orphanMcp.push(tool);
  }

  // Stale exemptions: an entry that no longer corresponds to a real surface.
  const cliPathSet = new Set(cliLeafPaths.map((p) => p.join(" ")));
  for (const cmd of exemptions.cliOnly.keys()) {
    if (!cliPathSet.has(cmd)) report.staleExemptions.push(`cli_only: ${cmd}`);
  }
  for (const tool of exemptions.mcpOnly.keys()) {
    if (!mcpSet.has(tool)) report.staleExemptions.push(`mcp_only: ${tool}`);
  }

  report.matched.sort((a, b) => a.cli.localeCompare(b.cli));
  report.missingMcp.sort((a, b) => a.cli.localeCompare(b.cli));
  report.orphanMcp.sort();
  report.namingViolations.sort();

  return report;
}

// --- live-surface input gathering ---

function readCliCommandFiles(): { path: string; content: string }[] {
  const commandsDir = join(REPO_ROOT, "packages/cli/src/commands");
  const out: { path: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === "__tests__") continue;
        walk(p);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push({ path: p, content: readFileSync(p, "utf8") });
      }
    }
  };
  walk(commandsDir);
  return out;
}

function loadExemptions(): Exemptions {
  const path = join(REPO_ROOT, ".mcp-exempt.yaml");
  if (!existsSync(path)) return { cliOnly: new Map(), mcpOnly: new Map() };
  return parseExemptYaml(readFileSync(path, "utf8"));
}

// --- fixture unit tests for the pure analyzer ---

describe("cli-mcp-parity analyzer (fixtures)", () => {
  const noExempt: Exemptions = { cliOnly: new Map(), mcpOnly: new Map() };
  const noComments = new Map<string, string>();

  it("maps CLI paths to MCP names (nesting + hyphen)", () => {
    expect(cliPathToMcpName(["profile", "basic", "show"])).toBe("ttctl_profile_basic_show");
    expect(cliPathToMcpName(["profile", "employment", "employer-autocomplete"])).toBe(
      "ttctl_profile_employment_employer_autocomplete",
    );
  });

  it("collects only leaf paths, skips the root, ignores aliases", () => {
    const tree: CommandLike = {
      name: () => "ttctl",
      commands: [
        {
          name: () => "profile",
          commands: [
            { name: () => "show", commands: [] },
            {
              name: () => "basic",
              commands: [{ name: () => "show", commands: [] }],
            },
          ],
        },
      ],
    };
    expect(collectCliLeafPaths(tree)).toEqual([
      ["profile", "show"],
      ["profile", "basic", "show"],
    ]);
  });

  it("matches a clean pair and flags a genuine gap each direction", () => {
    const report = analyzeParity({
      cliLeafPaths: [
        ["profile", "basic", "show"],
        ["foo", "bar"],
      ],
      mcpToolNames: ["ttctl_profile_basic_show", "ttctl_orphan_tool"],
      exemptions: noExempt,
      commentExemptVerbs: noComments,
    });
    expect(report.matched).toEqual([{ cli: "profile basic show", mcp: "ttctl_profile_basic_show" }]);
    expect(report.missingMcp).toEqual([{ cli: "foo bar", mcp: "ttctl_foo_bar" }]);
    expect(report.orphanMcp).toEqual(["ttctl_orphan_tool"]);
  });

  it("honours a yaml cli_only exemption (no missing-MCP flag)", () => {
    const report = analyzeParity({
      cliLeafPaths: [["auth", "signin"]],
      mcpToolNames: [],
      exemptions: { cliOnly: new Map([["auth signin", "interactive"]]), mcpOnly: new Map() },
      commentExemptVerbs: noComments,
    });
    expect(report.missingMcp).toEqual([]);
    expect(report.exemptedCli).toEqual([{ cli: "auth signin", reason: "interactive" }]);
  });

  it("honours a yaml mcp_only exemption (no orphan flag)", () => {
    const report = analyzeParity({
      cliLeafPaths: [],
      mcpToolNames: ["ttctl_interest_requests_list"],
      exemptions: { cliOnly: new Map(), mcpOnly: new Map([["ttctl_interest_requests_list", "llm affordance"]]) },
      commentExemptVerbs: noComments,
    });
    expect(report.orphanMcp).toEqual([]);
    expect(report.exemptedMcp).toEqual([{ mcp: "ttctl_interest_requests_list", reason: "llm affordance" }]);
  });

  it("honours an inline comment exemption by terminal verb", () => {
    const report = analyzeParity({
      cliLeafPaths: [["widgets", "frobnicate"]],
      mcpToolNames: [],
      exemptions: noExempt,
      commentExemptVerbs: new Map([["frobnicate", "no MCP equivalent"]]),
    });
    expect(report.missingMcp).toEqual([]);
    expect(report.exemptedCli[0]?.cli).toBe("widgets frobnicate");
  });

  it("flags a naming-convention violation", () => {
    const report = analyzeParity({
      cliLeafPaths: [],
      mcpToolNames: ["ttctl_Bad__Name"],
      exemptions: noExempt,
      commentExemptVerbs: noComments,
    });
    expect(report.namingViolations).toEqual(["ttctl_Bad__Name"]);
  });

  it("flags a stale exemption", () => {
    const report = analyzeParity({
      cliLeafPaths: [],
      mcpToolNames: [],
      exemptions: { cliOnly: new Map([["gone command", "x"]]), mcpOnly: new Map([["ttctl_gone", "y"]]) },
      commentExemptVerbs: noComments,
    });
    expect(report.staleExemptions.sort()).toEqual(["cli_only: gone command", "mcp_only: ttctl_gone"]);
  });

  it("flags an ambiguous comment exemption (verb matches >1 leaf)", () => {
    const report = analyzeParity({
      cliLeafPaths: [
        ["a", "show"],
        ["b", "show"],
      ],
      mcpToolNames: [],
      exemptions: noExempt,
      commentExemptVerbs: new Map([["show", "oops"]]),
    });
    expect(report.ambiguousCommentExemptions).toEqual(["show"]);
  });

  it("parses cli_only and mcp_only from yaml", () => {
    const ex = parseExemptYaml(
      [
        "cli_only:",
        '  - command: "auth signin"',
        '    reason: "x"',
        "mcp_only:",
        '  - tool: "ttctl_y"',
        '    reason: "z"',
      ].join("\n"),
    );
    expect(ex.cliOnly.get("auth signin")).toBe("x");
    expect(ex.mcpOnly.get("ttctl_y")).toBe("z");
  });

  it("extracts an inline comment marker above a .command() declaration", () => {
    const verbs = parseCommentExemptions([
      { path: "x.ts", content: ["// mcp-exempt: no MCP equivalent", '.command("frobnicate")'].join("\n") },
    ]);
    expect(verbs.get("frobnicate")).toBe("no MCP equivalent");
  });
});

// --- live-surface contract ---

describe("CLI ↔ MCP registry parity (live surfaces)", () => {
  const cliLeafPaths = collectCliLeafPaths(buildProgram() as unknown as CommandLike);
  const mcpToolNames = listRegisteredMcpToolNames();
  const exemptions = loadExemptions();
  const commentExemptVerbs = parseCommentExemptions(readCliCommandFiles());
  const report = analyzeParity({ cliLeafPaths, mcpToolNames, exemptions, commentExemptVerbs });

  it("discovers both surfaces", () => {
    expect(cliLeafPaths.length).toBeGreaterThan(50);
    expect(mcpToolNames.length).toBeGreaterThan(50);
  });

  // --- always-on hard assertions (must be clean today) ---

  it("every registered MCP tool follows the ttctl_<group>_<sub-domain>_<verb> convention", () => {
    expect(report.namingViolations).toEqual([]);
  });

  it("has no stale exemption entries in .mcp-exempt.yaml", () => {
    expect(report.staleExemptions).toEqual([]);
  });

  it("has no ambiguous inline comment exemptions", () => {
    expect(report.ambiguousCommentExemptions).toEqual([]);
  });

  it("exempts the interactive auth surface (auth signin/signout/status/init)", () => {
    const exempted = new Set(report.exemptedCli.map((e) => e.cli));
    for (const cmd of ["auth init", "auth status", "auth signin", "auth signout"]) {
      expect(exempted, `${cmd} must be parity-exempt`).toContain(cmd);
      expect(report.missingMcp.map((m) => m.cli)).not.toContain(cmd);
    }
  });

  it("known-good CLI commands resolve to a registered MCP tool", () => {
    const knownGood: string[][] = [
      ["profile", "basic", "show"],
      ["profile", "skills", "add"],
      ["profile", "employment", "skills", "add"], // computed `ttctl_…_skills_${op}` — proves runtime introspection
      ["profile", "employment", "employer-autocomplete"], // hyphen → underscore
      ["timesheet", "list"],
      ["payments", "payouts", "list"],
      ["engagements", "list"],
    ];
    const registered = new Set(mcpToolNames);
    for (const path of knownGood) {
      expect(registered, `${path.join(" ")} → ${cliPathToMcpName(path)} must be registered`).toContain(
        cliPathToMcpName(path),
      );
    }
  });

  // --- drift detection: warn by default, fail under CLI_MCP_PARITY_STRICT=1 ---

  it("reports CLI↔MCP parity gaps (strict only under CLI_MCP_PARITY_STRICT=1)", () => {
    const strict = process.env["CLI_MCP_PARITY_STRICT"] === "1";
    if (report.missingMcp.length > 0 || report.orphanMcp.length > 0) {
      const lines = [
        `CLI↔MCP parity: ${String(report.missingMcp.length)} CLI command(s) without an MCP tool, ` +
          `${String(report.orphanMcp.length)} MCP tool(s) without a CLI command.`,
        ...report.missingMcp.map((m) => `  missing MCP   ${m.cli.padEnd(40)} → ${m.mcp}`),
        ...report.orphanMcp.map((t) => `  orphan MCP    ${t}`),
        strict
          ? `Set in CLI_MCP_PARITY_STRICT mode — failing.`
          : `WARN mode (build stays green). Exempt intentional divergences in .mcp-exempt.yaml ` +
            `or add a // mcp-exempt: comment; set CLI_MCP_PARITY_STRICT=1 to fail on the rest.`,
      ];
      console.warn(lines.join("\n"));
    }
    if (strict) {
      expect(report.missingMcp, "non-exempt CLI commands without an MCP tool").toEqual([]);
      expect(report.orphanMcp, "non-exempt MCP tools without a CLI command").toEqual([]);
    }
  });
});
