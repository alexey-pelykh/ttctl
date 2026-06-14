#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * README verb gate (issue #762; MCP tool-name parity #765).
 *
 * Structural defense against the **#751 drift class**: a README
 * "What It Does" bullet claiming a verb or command that no CLI command
 * registers. The bullets are hand-maintained prose; #751 shipped a
 * `timesheet update` claim while `packages/cli/src/commands/timesheet/`
 * registers only list / pending / show / submit — docs issue #431 closed
 * ahead of its prerequisite feature #458, and nothing structural caught
 * the divergence. This gate diffs the claims against the command tree at
 * lint time. Backtick `ttctl_*` spans additionally resolve against the
 * registered MCP tool names (#765): the same drift class has an MCP-parity
 * sibling — a bullet naming a renamed or removed tool — that the CLI-only
 * universe could not catch.
 *
 * Detection scope:
 *
 *   - README bold bullets (`- **Domain** — ...`) between `## What It Does`
 *     and the next heading (`### Out of scope`). The out-of-scope block is
 *     deliberately NOT parsed — it documents what does not exist, and its
 *     backticks name GraphQL ops, not CLI commands.
 *   - The command universe per domain is every `.command("<name>")`
 *     registration under `packages/cli/src/commands/<domain>/**\/*.ts`
 *     (tests excluded), reduced to the first whitespace-delimited token
 *     (`.command("add <name>")` registers `add`). Matching is token-set
 *     based: every segment of a claimed path must be a registered token in
 *     that domain. Token-set matching catches the #751 class (a token
 *     registered nowhere); it does not verify segment nesting order.
 *   - The MCP tool-name universe is the `EXPECTED_TOOLS` roster parsed
 *     from `packages/mcp/src/tools/__tests__/registration.test.ts` — the
 *     canonical inventory the registration test pins to the live server
 *     registry (so it cannot silently drift from the real tools). Resolved
 *     lazily (only when a `ttctl_*` span is seen); a missing or unparseable
 *     roster is a structural error, never a silent pass.
 *
 * Claim taxonomy (what is — and is not — mechanically checkable):
 *
 *   1. **Command claims**: backtick spans whose first token (after an
 *      optional leading `ttctl`) is a CLI domain directory, e.g.
 *      `applications interview show <id>`. `<arg>`/`[arg]` placeholders
 *      (multi-word ones span to their closing bracket) and `--flag`
 *      tokens are stripped; remaining segments must all be registered
 *      tokens of that domain.
 *   2. **MCP tool-name claims**: backtick spans whose first token is an
 *      `ttctl_*` MCP tool name (e.g. `ttctl_jobs_apply_similar_answers`),
 *      resolved against the `EXPECTED_TOOLS` roster. An unregistered name
 *      is a finding (fails strict); a registered one is a checked claim.
 *   3. **Verb claims**: the bullet's leading verb clause (text up to the
 *      first `;`, `(`, or `.`), split on commas — and on " and " only
 *      when the next word is itself a known verb — then mapped through
 *      the alias vocabulary below (`view` → `show`, `sign in` → `signin`,
 *      ...). The alias map's keys DEFINE the checkable vocabulary.
 *   4. **Unchecked**: everything else — verb segments outside the alias
 *      vocabulary ("aggregate payment totals"), non-command backticks
 *      (`--flags`), prose after the leading clause ("manage engagement
 *      breaks" — one un-scanned-remainder row per bullet), nested list
 *      lines, and command spans left unchecked past an unbalanced
 *      placeholder bracket. Every unchecked item is reported visibly; none
 *      ever fails the gate. The parser is honest about this boundary
 *      rather than pretending prose is verifiable.
 *
 * Exemption mechanism:
 *
 *   - Place `<!-- readme-verbs-exempt: <reason> -->` on the line directly
 *     above a bullet to skip that bullet entirely (deliberate prose that
 *     names no command). The reason is mandatory and surfaces in the
 *     report. A marker not followed by a bullet, or with an empty reason,
 *     is reported as a marker issue and fails strict mode.
 *
 * Modes:
 *
 *   - **warn** (default): always exits 0. Findings reported to stderr.
 *   - **strict** (`--strict` flag or `README_VERBS_STRICT=1` env): exits
 *     non-zero on missing-command claims, unknown bullet domains,
 *     structural parse errors (section/bullets not found, top-level list
 *     lines that fail the bullet shape — a parser that matches nothing
 *     asserts nothing), or marker issues. Sibling pattern
 *     to the `E2E_COVERAGE_STRICT` / `SURFACE_COVERAGE_STRICT` /
 *     `WRITE_READ_SYMMETRY_STRICT` / `MERGE_COMPLETENESS_STRICT` /
 *     `SNAPSHOT_DEGENERACY_STRICT` switches. The package.json wiring
 *     passes `--strict` from day one: the README baseline is clean
 *     (post-#751), so there is no warn-phase gap to pay down.
 *
 * Exit codes:
 *
 *   0 — warn-mode (always) OR strict-mode with no findings.
 *   1 — strict-mode with at least one finding.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Configuration ──────────────────────────────────────────────────

const README_FILE = "README.md";
const COMMANDS_ROOT = "packages/cli/src/commands";
// Canonical MCP tool-name roster — the live registration test pins
// `EXPECTED_TOOLS` to the server's real registry, so reusing it here means
// the gate's tool-name universe cannot drift from the actual tools (#765).
const MCP_REGISTRATION_TEST = "packages/mcp/src/tools/__tests__/registration.test.ts";
const SECTION_HEADING = "## What It Does";
const EXEMPT_MARKER = /^<!--\s*readme-verbs-exempt:\s*(.*?)\s*-->$/;
const BULLET = /^- \*\*(.+?)\*\*\s+—\s+(.*)$/;
/** The `EXPECTED_TOOLS = [ ... ]` array body in the MCP registration test (tolerates a `: Type` annotation). */
const EXPECTED_TOOLS_ARRAY = /const\s+EXPECTED_TOOLS\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/;
/** A double-quoted `ttctl_*` MCP tool-name literal. */
const MCP_TOOL_NAME = /"(ttctl_[a-z0-9_]+)"/g;

/** README bullet display name → CLI command domain directory. */
const DOMAIN_MAP: ReadonlyMap<string, string> = new Map([
  ["Profile", "profile"],
  ["Applications", "applications"],
  ["Engagements", "engagements"],
  ["Jobs", "jobs"],
  ["Timesheets", "timesheet"],
  ["Availability", "availability"],
  ["Contracts", "contracts"],
  ["Payments", "payments"],
  ["Surveys", "surveys"],
  ["Auth", "auth"],
]);

/** Multi-word prose phrase → candidate command tokens (matched before single verbs). */
const PHRASE_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["bootstrap config", ["init"]],
  ["sign in", ["signin"]],
  ["sign out", ["signout"]],
  ["check status", ["status"]],
]);

/** Single leading verb → candidate command tokens. Keys define the checkable vocabulary. */
const VERB_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["view", ["show"]],
  ["show", ["show"]],
  ["list", ["list"]],
  ["submit", ["submit"]],
  ["update", ["set", "update"]],
  ["browse", ["list"]],
  ["review", ["list", "show"]],
]);

// ─── Types ──────────────────────────────────────────────────────────

interface UncheckedItem {
  readonly bullet: string;
  readonly line: number;
  readonly detail: string;
}

interface Finding {
  readonly bullet: string;
  readonly line: number;
  readonly detail: string;
}

interface ExemptedBullet {
  readonly bullet: string;
  readonly line: number;
  readonly reason: string;
}

export interface RunReport {
  readonly findings: Finding[];
  readonly unchecked: UncheckedItem[];
  readonly exempted: ExemptedBullet[];
  readonly markerIssues: string[];
  readonly structuralErrors: string[];
  readonly bulletCount: number;
  readonly claimCount: number;
}

/** Resolved MCP tool-name roster, or a structural error explaining why it could not be loaded. */
export interface McpToolResolution {
  readonly names: ReadonlySet<string>;
  readonly error: string | null;
}

/** Injectable inputs for the pure core — wired to the real FS in `main`, to fixtures in tests. */
export interface ReadmeVerbsInputs {
  /** Raw `README.md` content. */
  readonly readme: string;
  /** CLI command domain directory names under `packages/cli/src/commands`. */
  readonly domains: ReadonlySet<string>;
  /** Registered `.command("...")` tokens for a domain (called only for known domains). */
  readonly tokensOf: (domain: string) => ReadonlySet<string>;
  /** Resolve the MCP tool-name roster — called lazily, only when a `ttctl_*` span is seen. */
  readonly resolveMcpTools: () => McpToolResolution;
}

// ─── Repo helpers ───────────────────────────────────────────────────

function gitTopLevel(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

/**
 * Replace comment bodies with spaces so a `.command("...")` mentioned in
 * a JSDoc or line comment does not register as a registration. String
 * literals are respected (a `//` inside a string is not a comment).
 */
function maskComments(source: string): string {
  const out = source.split("");
  let i = 0;
  let stringDelimiter: string | null = null;
  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (stringDelimiter !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === stringDelimiter) stringDelimiter = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringDelimiter = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < source.length) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

// ─── Command universe ───────────────────────────────────────────────

function listDomains(repoRoot: string): Set<string> {
  return new Set(
    readdirSync(join(repoRoot, COMMANDS_ROOT), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") walkTsFiles(abs, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
}

/** First whitespace-delimited token of every `.command("...")` registration in the domain tree. */
function collectDomainTokens(repoRoot: string, domain: string): Set<string> {
  const files: string[] = [];
  walkTsFiles(join(repoRoot, COMMANDS_ROOT, domain), files);
  const tokens = new Set<string>();
  for (const file of files) {
    const masked = maskComments(readFileSync(file, "utf8"));
    for (const m of masked.matchAll(/\.command\(\s*"([^"]+)"/g)) {
      const name = (m[1] ?? "").trim().split(/\s+/)[0] ?? "";
      if (name.length > 0) tokens.add(name);
    }
  }
  return tokens;
}

// ─── MCP tool-name universe ─────────────────────────────────────────

/**
 * Extract the `ttctl_*` names from the `EXPECTED_TOOLS` array in the MCP
 * registration test. Comments are masked first so a tool name mentioned in
 * a comment cannot register as a roster entry. A missing array or an empty
 * roster is an error (the caller fails the gate) rather than a silently
 * empty universe that would pass every claim.
 */
export function parseExpectedToolNames(source: string): McpToolResolution {
  const block = EXPECTED_TOOLS_ARRAY.exec(maskComments(source));
  if (block === null) {
    return {
      names: new Set(),
      error: `EXPECTED_TOOLS array not found in ${MCP_REGISTRATION_TEST} — MCP tool-name source is stale`,
    };
  }
  const names = new Set<string>();
  for (const m of (block[1] ?? "").matchAll(MCP_TOOL_NAME)) names.add(m[1] ?? "");
  if (names.size === 0) {
    return {
      names,
      error: `EXPECTED_TOOLS array in ${MCP_REGISTRATION_TEST} has no ttctl_* names — MCP tool-name source is stale`,
    };
  }
  return { names, error: null };
}

/** Load + parse the MCP tool-name roster from disk. Unreadable file → error, never a silent empty universe. */
function collectMcpToolNames(repoRoot: string): McpToolResolution {
  let source: string;
  try {
    source = readFileSync(join(repoRoot, MCP_REGISTRATION_TEST), "utf8");
  } catch {
    return {
      names: new Set(),
      error: `${MCP_REGISTRATION_TEST} not readable — cannot resolve ttctl_* MCP tool-name claims`,
    };
  }
  return parseExpectedToolNames(source);
}

// ─── README parsing ─────────────────────────────────────────────────

interface ParsedBullet {
  readonly name: string;
  readonly text: string;
  readonly line: number;
  readonly exemptReason: string | null;
}

interface ParsedSection {
  readonly bullets: ParsedBullet[];
  readonly markerIssues: string[];
  readonly structuralErrors: string[];
  readonly nestedUnchecked: UncheckedItem[];
}

/** Extract bullets from the positive-claims block of `## What It Does`. */
function parseReadme(readme: string): ParsedSection {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => l.trim() === SECTION_HEADING);
  if (start === -1) {
    return {
      bullets: [],
      markerIssues: [],
      structuralErrors: [`section "${SECTION_HEADING}" not found in ${README_FILE}`],
      nestedUnchecked: [],
    };
  }

  const bullets: ParsedBullet[] = [];
  const markerIssues: string[] = [];
  const structuralErrors: string[] = [];
  const nestedUnchecked: UncheckedItem[] = [];
  let pendingExempt: { reason: string; line: number } | null = null;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^#{2,3} /.test(line)) break;

    const marker = EXEMPT_MARKER.exec(line.trim());
    if (marker !== null) {
      if (pendingExempt !== null) {
        markerIssues.push(`${README_FILE}:${String(pendingExempt.line)}: marker not followed by a bullet`);
      }
      const reason = marker[1] ?? "";
      if (reason.length === 0) {
        markerIssues.push(`${README_FILE}:${String(i + 1)}: exemption reason is mandatory`);
        pendingExempt = null;
      } else {
        pendingExempt = { reason, line: i + 1 };
      }
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      bullets.push({
        name: bullet[1] ?? "",
        text: bullet[2] ?? "",
        line: i + 1,
        exemptReason: pendingExempt?.reason ?? null,
      });
      pendingExempt = null;
      continue;
    }

    // A top-level list line that fails the bullet shape would otherwise
    // vanish with every claim on it — fail loud instead of dropping it.
    if (/^- /.test(line)) {
      structuralErrors.push(
        `${README_FILE}:${String(i + 1)}: list line does not match the "- **Domain** — ..." bullet shape — its claims would be silently skipped`,
      );
    }

    // Nested list lines are outside the scanned universe — surface them
    // as unchecked (not structural: legitimate prose sub-bullets must not
    // fail strict).
    if (/^\s+- /.test(line)) {
      const text = line.trim();
      const preview = text.length > 60 ? `${text.slice(0, 57)}...` : text;
      nestedUnchecked.push({
        bullet: bullets[bullets.length - 1]?.name ?? "(section)",
        line: i + 1,
        detail: `nested list line not scanned: "${preview}"`,
      });
    }

    if (pendingExempt !== null && line.trim().length > 0) {
      markerIssues.push(`${README_FILE}:${String(pendingExempt.line)}: marker not followed by a bullet`);
      pendingExempt = null;
    }
  }

  if (pendingExempt !== null) {
    markerIssues.push(`${README_FILE}:${String(pendingExempt.line)}: marker not followed by a bullet`);
  }

  if (bullets.length === 0) {
    structuralErrors.push(
      `no "- **Domain** — ..." bullets found under "${SECTION_HEADING}" — parser or README format is stale`,
    );
  }
  return { bullets, markerIssues, structuralErrors, nestedUnchecked };
}

// ─── Claim extraction ───────────────────────────────────────────────

/** Bullet text up to the first `;`, `(`, or `.` — the leading verb clause — plus the un-scanned remainder. */
function splitLeadingClause(text: string): { clause: string; remainder: string } {
  const raw = /^[^;(.]*/.exec(text)?.[0] ?? "";
  return { clause: raw.trim(), remainder: text.slice(raw.length).trim() };
}

function aliasFor(segment: string): { phrase: string; candidates: readonly string[] } | null {
  const words = segment.toLowerCase().split(/\s+/);
  const twoWord = words.slice(0, 2).join(" ");
  const phraseHit = PHRASE_ALIASES.get(twoWord);
  if (phraseHit !== undefined) return { phrase: twoWord, candidates: phraseHit };
  const first = words[0] ?? "";
  const verbHit = VERB_ALIASES.get(first);
  if (verbHit !== undefined) return { phrase: first, candidates: verbHit };
  return null;
}

function startsWithKnownVerb(segment: string): boolean {
  return aliasFor(segment) !== null;
}

/**
 * Split the leading clause into verb segments: on commas always, and on
 * " and " only when the next word is itself a known verb ("view and
 * update" splits; "current and past engagements" does not).
 */
function splitVerbSegments(clause: string): string[] {
  const segments: string[] = [];
  for (const rawPart of clause.split(",")) {
    const part = rawPart.trim().replace(/^and\s+/, "");
    if (part.length === 0) continue;
    const andParts = part.split(/\s+and\s+/);
    let current = andParts[0] ?? "";
    for (const next of andParts.slice(1)) {
      if (startsWithKnownVerb(next)) {
        if (current.trim().length > 0) segments.push(current.trim());
        current = next;
      } else {
        current = `${current} and ${next}`;
      }
    }
    if (current.trim().length > 0) segments.push(current.trim());
  }
  return segments;
}

// ─── Run ────────────────────────────────────────────────────────────

export function analyzeReadmeVerbs(inputs: ReadmeVerbsInputs): RunReport {
  const { readme, domains, tokensOf, resolveMcpTools } = inputs;

  // MCP roster is resolved lazily + memoized: a README with no `ttctl_*`
  // span never touches the registration test, so a stale roster fails the
  // gate only when a tool-name claim actually depends on it.
  let mcpResolution: McpToolResolution | null = null;
  const mcpTools = (): McpToolResolution => {
    if (mcpResolution === null) mcpResolution = resolveMcpTools();
    return mcpResolution;
  };

  const { bullets, markerIssues, structuralErrors, nestedUnchecked } = parseReadme(readme);
  const findings: Finding[] = [];
  const unchecked: UncheckedItem[] = [];
  const exempted: ExemptedBullet[] = [];
  let claimCount = 0;
  unchecked.push(...nestedUnchecked);

  for (const dir of DOMAIN_MAP.values()) {
    if (!domains.has(dir)) {
      structuralErrors.push(`DOMAIN_MAP targets "${dir}" but ${COMMANDS_ROOT}/${dir} does not exist — map is stale`);
    }
  }

  for (const bullet of bullets) {
    if (bullet.exemptReason !== null) {
      exempted.push({ bullet: bullet.name, line: bullet.line, reason: bullet.exemptReason });
      continue;
    }

    const domain = DOMAIN_MAP.get(bullet.name);
    if (domain === undefined || !domains.has(domain)) {
      findings.push({
        bullet: bullet.name,
        line: bullet.line,
        detail: `bullet domain "${bullet.name}" has no CLI command domain (known: ${[...DOMAIN_MAP.keys()].join(", ")})`,
      });
      continue;
    }

    // Command claims — backtick spans naming a domain-rooted path.
    for (const m of bullet.text.matchAll(/`([^`]+)`/g)) {
      const span = (m[1] ?? "").trim();
      const tokens = span.split(/\s+/);
      if ((tokens[0] ?? "") === "ttctl") tokens.shift();
      const first = tokens[0] ?? "";
      if (first.startsWith("--")) {
        unchecked.push({
          bullet: bullet.name,
          line: bullet.line,
          detail: `backtick \`${span}\` (flag — not a command path)`,
        });
        continue;
      }
      if (first.startsWith("ttctl_")) {
        const mcp = mcpTools();
        if (mcp.error !== null) {
          if (!structuralErrors.includes(mcp.error)) structuralErrors.push(mcp.error);
          continue;
        }
        claimCount += 1;
        if (!mcp.names.has(first)) {
          findings.push({
            bullet: bullet.name,
            line: bullet.line,
            detail: `\`${span}\` → MCP tool "${first}" not registered (see ${MCP_REGISTRATION_TEST} EXPECTED_TOOLS)`,
          });
        }
        continue;
      }
      if (!domains.has(first)) {
        unchecked.push({
          bullet: bullet.name,
          line: bullet.line,
          detail: `backtick \`${span}\` (no CLI domain prefix — not parsed as a command)`,
        });
        continue;
      }
      claimCount += 1;
      const spanTokens = tokensOf(first);
      let placeholderCloser: string | null = null;
      for (const segment of tokens.slice(1)) {
        if (placeholderCloser !== null) {
          if (segment.endsWith(placeholderCloser)) placeholderCloser = null;
          continue;
        }
        if (segment.startsWith("--")) continue;
        if (segment.startsWith("<") || segment.startsWith("[")) {
          const closer = segment.startsWith("<") ? ">" : "]";
          if (!segment.endsWith(closer)) placeholderCloser = closer;
          continue;
        }
        if (!spanTokens.has(segment)) {
          findings.push({
            bullet: bullet.name,
            line: bullet.line,
            detail: `\`${span}\` → token "${segment}" not registered under ${COMMANDS_ROOT}/${first}`,
          });
        }
      }
      if (placeholderCloser !== null) {
        unchecked.push({
          bullet: bullet.name,
          line: bullet.line,
          detail: `backtick \`${span}\` — unbalanced placeholder bracket; segments after the opener were not checked`,
        });
      }
    }

    // Verb claims — leading clause mapped through the alias vocabulary.
    // The remainder is surfaced as unchecked so capability claims hiding
    // past the first `;`/`(`/`.` never vanish from the report (the #751
    // text itself would be invisible one punctuation mark later).
    const domainTokens = tokensOf(domain);
    const { clause, remainder } = splitLeadingClause(bullet.text);
    if (remainder.length > 0) {
      const preview = remainder.length > 60 ? `${remainder.slice(0, 57)}...` : remainder;
      unchecked.push({
        bullet: bullet.name,
        line: bullet.line,
        detail: `remainder past leading clause not verb-scanned: "${preview}"`,
      });
    }
    for (const segment of splitVerbSegments(clause)) {
      const alias = aliasFor(segment);
      if (alias === null) {
        unchecked.push({
          bullet: bullet.name,
          line: bullet.line,
          detail: `verb segment "${segment}" (outside alias vocabulary)`,
        });
        continue;
      }
      claimCount += 1;
      if (!alias.candidates.some((c) => domainTokens.has(c))) {
        findings.push({
          bullet: bullet.name,
          line: bullet.line,
          detail: `verb "${alias.phrase}" → none of [${alias.candidates.join(", ")}] registered under ${COMMANDS_ROOT}/${domain}`,
        });
      }
    }
  }

  return { findings, unchecked, exempted, markerIssues, structuralErrors, bulletCount: bullets.length, claimCount };
}

// ─── Report ─────────────────────────────────────────────────────────

export function formatReport(report: RunReport, strict: boolean): { exitCode: 0 | 1; text: string } {
  const lines: string[] = [];

  if (report.structuralErrors.length > 0) {
    lines.push("\n  structural errors:");
    for (const e of report.structuralErrors) lines.push(`    - ${e}`);
  }
  if (report.findings.length > 0) {
    lines.push("\n  MISSING COMMANDS / TOOLS:");
    for (const f of report.findings) {
      lines.push(`    - ${f.bullet} (${README_FILE}:${String(f.line)}): ${f.detail}`);
    }
  }
  if (report.markerIssues.length > 0) {
    lines.push("\n  marker issues:");
    for (const m of report.markerIssues) lines.push(`    - ${m}`);
  }
  if (report.exempted.length > 0) {
    lines.push(`\n  exempted (${String(report.exempted.length)}):`);
    for (const e of report.exempted) {
      lines.push(`    - ${e.bullet} (${README_FILE}:${String(e.line)}): ${e.reason}`);
    }
  }
  if (report.unchecked.length > 0) {
    lines.push(`\n  unchecked — not mechanically parseable (${String(report.unchecked.length)}):`);
    for (const u of report.unchecked) {
      lines.push(`    - ${u.bullet} (${README_FILE}:${String(u.line)}): ${u.detail}`);
    }
  }
  if (report.findings.length > 0) {
    lines.push(
      "\n  remedy: fix the README claim, register the command or MCP tool, or — for deliberate prose naming no command — place <!-- readme-verbs-exempt: <reason> --> on the line above the bullet",
    );
  }

  const fails = report.findings.length > 0 || report.structuralErrors.length > 0 || report.markerIssues.length > 0;
  const header = fails
    ? `check-readme-verbs: ${String(report.findings.length)} missing command/tool claim(s), ${String(report.structuralErrors.length)} structural error(s), ${String(report.markerIssues.length)} marker issue(s)`
    : `check-readme-verbs: ${String(report.claimCount)} claim(s) checked across ${String(report.bulletCount)} bullet(s), no missing commands or tools`;
  const uncheckedNote = report.unchecked.length > 0 ? `, ${String(report.unchecked.length)} unchecked` : "";
  const exemptedNote = report.exempted.length > 0 ? `, ${String(report.exempted.length)} exempted` : "";
  const mode = strict ? "strict" : "warn";

  return {
    exitCode: strict && fails ? 1 : 0,
    text: `${header}${uncheckedNote}${exemptedNote} [${mode}]${lines.join("\n")}\n`,
  };
}

function main(): void {
  const repoRoot = gitTopLevel();
  const strict = process.argv.includes("--strict") || process.env["README_VERBS_STRICT"] === "1";

  const tokenCache = new Map<string, ReadonlySet<string>>();
  const inputs: ReadmeVerbsInputs = {
    readme: readFileSync(join(repoRoot, README_FILE), "utf8"),
    domains: listDomains(repoRoot),
    tokensOf: (domain) => {
      let tokens = tokenCache.get(domain);
      if (tokens === undefined) {
        tokens = collectDomainTokens(repoRoot, domain);
        tokenCache.set(domain, tokens);
      }
      return tokens;
    },
    resolveMcpTools: () => collectMcpToolNames(repoRoot),
  };

  const report = analyzeReadmeVerbs(inputs);
  const { exitCode, text } = formatReport(report, strict);
  process.stderr.write(text);
  process.exit(exitCode);
}

/**
 * True when this module is the process entrypoint (`tsx scripts/...`), false
 * when imported (e.g. by the unit test). Compares realpath-normalized native
 * paths rather than URL strings so a Windows drive-letter / slash mismatch
 * cannot make the gate silently no-op (which, in warn mode, would still exit
 * 0 and look green).
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
