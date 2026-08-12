#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * MCP tool-catalog gate (issue #886).
 *
 * Structural defense for the fourth MCP enumeration site. Adding or removing
 * a tool requires updating four places; three are test-enforced and this one
 * was not:
 *
 *   1. `registration.test.ts` — EXPECTED_TOOLS roster + count
 *   2. `tools.test.ts` — sorted list + count
 *   3. dry-run smoke — TOOL_INPUT_FIXTURES map + count
 *   4. `packages/mcp/README.md` — stated total + per-domain breakdown  ← this gate
 *
 * The catalog drifted 88 → 129 before #769 caught it by hand.
 *
 * Two invariants, both checked:
 *
 *   - **total**: the README's stated tool count equals the EXPECTED_TOOLS
 *     roster size.
 *   - **sum**: the per-domain bullet counts add up to that stated total. The
 *     README asserts this about itself in prose ("per-domain counts below sum
 *     to the total"), and a per-domain count can drift while the total stays
 *     right — so the total check alone would not catch it.
 *
 * Residual, named rather than implied: the gate does not verify each bullet's
 * count against the roster's actual per-domain grouping, so two bullets
 * drifting in opposite directions (+1 / −1) still satisfy both invariants.
 * Closing that needs a domain-label → tool-name-prefix map, which is itself a
 * staleness surface; the issue scoped this gate to the two invariants above.
 *
 * Detection scope:
 *
 *   - The `### Tool catalog` section of `packages/mcp/README.md`, up to the
 *     next heading. Exactly one non-bullet line in it must state a total
 *     (`<N> tools`); zero or several is a structural error rather than a
 *     guess.
 *   - Domain bullets of the form ``- **`<domain>`** (<N> tools) — ...``.
 *   - The roster is `EXPECTED_TOOLS` in the MCP registration test, parsed via
 *     `parseExpectedToolNames` from `check-readme-verbs.ts` — reused rather
 *     than re-implemented so the two gates cannot disagree about what the
 *     roster is. Importing is side-effect-free: that module's `main()` sits
 *     behind its own `invokedDirectly()` guard.
 *
 * Exemption mechanism:
 *
 *   - `<!-- mcp-catalog-exempt: <reason> -->` above the total line exempts the
 *     total invariant; above a domain bullet, it drops that bullet from the
 *     sum. It binds to the next total or bullet, so intervening blank lines
 *     are fine. The reason is mandatory and surfaces in the report. A marker
 *     with an empty reason, or one followed by neither, is a marker issue and
 *     fails strict mode.
 *
 *     Exempting the total is the one marker that removes the roster comparison
 *     entirely, leaving only a README self-consistency check — so the clean
 *     header says so rather than printing an equality it did not verify.
 *
 * Modes:
 *
 *   - **warn** (default): always exits 0. Findings reported to stderr.
 *   - **strict** (`--strict` or `MCP_TOOL_CATALOG_STRICT=1`): exits non-zero
 *     on invariant findings, structural errors, or marker issues. The
 *     package.json wiring passes `--strict` from day one — the catalog
 *     baseline is consistent (roster 140 = total 140 = sum 140), so unlike
 *     most siblings there is no warn-phase gap to pay down. Same posture as
 *     `check-readme-verbs.ts` post-#751.
 *
 * Exit codes:
 *
 *   0 — warn-mode (always) OR strict-mode with no findings.
 *   1 — strict-mode with at least one finding.
 */

import { execSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseExpectedToolNames, type McpToolResolution } from "./check-readme-verbs.js";

// ─── Configuration ──────────────────────────────────────────────────

const README_FILE = "packages/mcp/README.md";
const MCP_REGISTRATION_TEST = "packages/mcp/src/tools/__tests__/registration.test.ts";
const SECTION_HEADING = "### Tool catalog";
const EXEMPT_MARKER = /^<!--\s*mcp-catalog-exempt:\s*(.*?)\s*-->$/;
/** ``- **`profile.*`** (69 tools) — ...`` / ``- **`me`** (1 tool) — ...`` */
const DOMAIN_BULLET = /^- \*\*`([^`]+)`\*\*\s*\((\d+)\s+tools?\)/;
/**
 * The stated total on the catalog's lead paragraph. Global so that every
 * occurrence counts as a claim: two counts on ONE line must trip the ambiguity
 * guard rather than letting the first silently win.
 */
const STATED_TOTAL = /\b(\d+)\s+tools?\b/g;

// ─── Types ──────────────────────────────────────────────────────────

interface DomainBullet {
  readonly domain: string;
  readonly count: number;
  readonly line: number;
  readonly exemptReason: string | null;
}

interface TotalClaim {
  readonly count: number;
  readonly line: number;
  readonly exemptReason: string | null;
}

interface ParsedCatalog {
  readonly total: TotalClaim | null;
  readonly bullets: readonly DomainBullet[];
  readonly markerIssues: readonly string[];
  readonly structuralErrors: readonly string[];
}

interface Finding {
  readonly kind: "total" | "sum";
  readonly line: number;
  readonly detail: string;
}

interface Exempted {
  readonly kind: "total" | "bullet";
  readonly subject: string;
  readonly line: number;
  readonly reason: string;
}

export interface RunReport {
  readonly findings: readonly Finding[];
  readonly exempted: readonly Exempted[];
  readonly markerIssues: readonly string[];
  readonly structuralErrors: readonly string[];
  readonly rosterCount: number;
  readonly statedTotal: number | null;
  readonly domainSum: number;
  readonly bulletCount: number;
}

/** Injectable inputs for the pure core — wired to the real FS in `main`, to fixtures in tests. */
export interface CatalogInputs {
  /** Raw `packages/mcp/README.md` content. */
  readonly readme: string;
  /** Resolve the EXPECTED_TOOLS roster. */
  readonly resolveRoster: () => McpToolResolution;
}

// ─── Repo helpers ───────────────────────────────────────────────────

function gitTopLevel(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function collectRoster(repoRoot: string): McpToolResolution {
  let source: string;
  try {
    source = readFileSync(join(repoRoot, MCP_REGISTRATION_TEST), "utf8");
  } catch {
    return { names: new Set(), error: `${MCP_REGISTRATION_TEST} not readable — cannot resolve the tool roster` };
  }
  return parseExpectedToolNames(source);
}

// ─── Parsing ────────────────────────────────────────────────────────

export function parseCatalog(readme: string): ParsedCatalog {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => l.trim() === SECTION_HEADING);
  if (start === -1) {
    return {
      total: null,
      bullets: [],
      markerIssues: [],
      structuralErrors: [`"${SECTION_HEADING}" not found in ${README_FILE} — parser or README format is stale`],
    };
  }

  const bullets: DomainBullet[] = [];
  const markerIssues: string[] = [];
  const structuralErrors: string[] = [];
  const totals: TotalClaim[] = [];
  let pendingExempt: { reason: string; line: number } | null = null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^#{1,6}\s/.test(line)) break;

    const marker = EXEMPT_MARKER.exec(line.trim());
    if (marker !== null) {
      if (pendingExempt !== null) {
        markerIssues.push(
          `${README_FILE}:${String(pendingExempt.line)}: marker not followed by a total line or bullet`,
        );
      }
      const reason = (marker[1] ?? "").trim();
      if (reason.length === 0) {
        // An unusable marker must exempt NOTHING: silently honouring it would
        // suppress a real drift and report only the comment syntax.
        markerIssues.push(`${README_FILE}:${String(i + 1)}: exemption marker has an empty reason`);
        pendingExempt = null;
        continue;
      }
      pendingExempt = { reason, line: i + 1 };
      continue;
    }

    const bullet = DOMAIN_BULLET.exec(line);
    if (bullet !== null) {
      bullets.push({
        domain: bullet[1] as string,
        count: Number(bullet[2]),
        line: i + 1,
        exemptReason: pendingExempt?.reason ?? null,
      });
      pendingExempt = null;
      continue;
    }

    // A top-level list line that is not a domain bullet would be dropped from
    // the sum, turning a formatting slip into a bogus sum finding.
    if (/^- /.test(line)) {
      structuralErrors.push(
        `${README_FILE}:${String(i + 1)}: list line does not match the "- **\`domain\`** (N tools) — ..." bullet shape — it would be silently dropped from the sum`,
      );
      pendingExempt = null;
      continue;
    }

    const stated = [...line.matchAll(STATED_TOTAL)];
    if (stated.length > 0) {
      for (const m of stated) {
        totals.push({ count: Number(m[1]), line: i + 1, exemptReason: pendingExempt?.reason ?? null });
      }
      pendingExempt = null;
      continue;
    }

    if (pendingExempt !== null && line.trim().length > 0) {
      markerIssues.push(`${README_FILE}:${String(pendingExempt.line)}: marker not followed by a total line or bullet`);
      pendingExempt = null;
    }
  }

  if (pendingExempt !== null) {
    markerIssues.push(`${README_FILE}:${String(pendingExempt.line)}: marker not followed by a total line or bullet`);
  }

  if (totals.length === 0) {
    structuralErrors.push(
      `no stated tool total ("<N> tools") found under "${SECTION_HEADING}" — parser or README format is stale`,
    );
  } else if (totals.length > 1) {
    structuralErrors.push(
      `${String(totals.length)} tool totals stated under "${SECTION_HEADING}" (${totals.map((t) => `${README_FILE}:${String(t.line)} → ${String(t.count)}`).join(", ")}) — ambiguous which is authoritative`,
    );
  }

  if (bullets.length === 0) {
    structuralErrors.push(
      `no "- **\`domain\`** (N tools) — ..." bullets found under "${SECTION_HEADING}" — parser or README format is stale`,
    );
  }

  return { total: totals.length === 1 ? (totals[0] as TotalClaim) : null, bullets, markerIssues, structuralErrors };
}

// ─── Run ────────────────────────────────────────────────────────────

export function analyzeToolCatalog(inputs: CatalogInputs): RunReport {
  const { total, bullets, markerIssues, structuralErrors } = parseCatalog(inputs.readme);
  const errors = [...structuralErrors];
  const findings: Finding[] = [];
  const exempted: Exempted[] = [];

  // Resolved unconditionally: an unreadable roster must fail the gate, never
  // leave the total invariant quietly unchecked.
  const roster = inputs.resolveRoster();
  if (roster.error !== null) errors.push(roster.error);
  const rosterCount = roster.names.size;

  for (const b of bullets) {
    if (b.exemptReason !== null) {
      exempted.push({ kind: "bullet", subject: `\`${b.domain}\``, line: b.line, reason: b.exemptReason });
    }
  }
  const counted = bullets.filter((b) => b.exemptReason === null);
  const domainSum = counted.reduce((acc, b) => acc + b.count, 0);

  if (total !== null && total.exemptReason !== null) {
    exempted.push({ kind: "total", subject: "stated total", line: total.line, reason: total.exemptReason });
  }

  if (total !== null && roster.error === null && total.exemptReason === null && total.count !== rosterCount) {
    findings.push({
      kind: "total",
      line: total.line,
      detail: `README states ${String(total.count)} tools but EXPECTED_TOOLS holds ${String(rosterCount)}`,
    });
  }

  if (total !== null && domainSum !== total.count) {
    const skipped = bullets.length - counted.length;
    const exemptNote = skipped > 0 ? ` (excluding ${String(skipped)} exempted bullet(s))` : "";
    // Name the terms: the gate cannot say WHICH bullet drifted (that is the
    // documented residual), so the reader needs the addends to spot it.
    const terms = counted.map((b) => `${b.domain} ${String(b.count)}`).join(" + ");
    findings.push({
      kind: "sum",
      line: total.line,
      detail: `per-domain counts sum to ${String(domainSum)}${exemptNote} but the README states ${String(total.count)} — ${terms}`,
    });
  }

  return {
    findings,
    exempted,
    markerIssues,
    structuralErrors: errors,
    rosterCount,
    statedTotal: total?.count ?? null,
    domainSum,
    bulletCount: bullets.length,
  };
}

// ─── Report ─────────────────────────────────────────────────────────

export function formatReport(report: RunReport, strict: boolean): { exitCode: 0 | 1; text: string } {
  const lines: string[] = [];

  if (report.structuralErrors.length > 0) {
    lines.push("\n  structural errors:");
    for (const e of report.structuralErrors) lines.push(`    - ${e}`);
  }
  if (report.findings.length > 0) {
    lines.push("\n  CATALOG DRIFT:");
    for (const f of report.findings) lines.push(`    - ${README_FILE}:${String(f.line)}: ${f.detail}`);
  }
  if (report.markerIssues.length > 0) {
    lines.push("\n  marker issues:");
    for (const m of report.markerIssues) lines.push(`    - ${m}`);
  }
  if (report.exempted.length > 0) {
    lines.push(`\n  exempted (${String(report.exempted.length)}):`);
    for (const e of report.exempted) {
      lines.push(`    - ${e.subject} (${README_FILE}:${String(e.line)}): ${e.reason}`);
    }
  }
  if (report.findings.length > 0) {
    lines.push(
      "\n  remedy: re-derive the catalog from EXPECTED_TOOLS (total AND per-domain counts), or — for a deliberate divergence — place <!-- mcp-catalog-exempt: <reason> --> on the line above the total or the bullet",
    );
  }

  const fails = report.findings.length > 0 || report.structuralErrors.length > 0 || report.markerIssues.length > 0;
  // An exempted total means roster-vs-README was never compared — don't print
  // an equality the run did not verify.
  const totalExempted = report.exempted.some((e) => e.kind === "total");
  const proven = totalExempted
    ? `stated total ${String(report.statedTotal)} = per-domain sum ${String(report.domainSum)} (roster ${String(report.rosterCount)} comparison exempted)`
    : `roster ${String(report.rosterCount)} = stated total ${String(report.statedTotal)} = per-domain sum ${String(report.domainSum)}`;
  const header = fails
    ? `check-mcp-tool-catalog: ${String(report.findings.length)} drift finding(s), ${String(report.structuralErrors.length)} structural error(s), ${String(report.markerIssues.length)} marker issue(s)`
    : `check-mcp-tool-catalog: ${proven} across ${String(report.bulletCount)} domain(s)`;
  const exemptedNote = report.exempted.length > 0 ? `, ${String(report.exempted.length)} exempted` : "";
  const mode = strict ? "strict" : "warn";

  return {
    exitCode: strict && fails ? 1 : 0,
    text: `${header}${exemptedNote} [${mode}]${lines.join("\n")}\n`,
  };
}

function main(): void {
  const repoRoot = gitTopLevel();
  const strict = process.argv.includes("--strict") || process.env["MCP_TOOL_CATALOG_STRICT"] === "1";

  const report = analyzeToolCatalog({
    readme: readFileSync(join(repoRoot, README_FILE), "utf8"),
    resolveRoster: () => collectRoster(repoRoot),
  });
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
