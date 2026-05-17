// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Remote version-killed manifest (#312) — defense-in-depth kill switch
 * for the TTCtl reverse-engineered surface.
 *
 * **Background**: TTCtl is reverse-engineered from Toptal's APK + GraphQL
 * extraction. The wire format on any of the three surfaces
 * (`mobile-gateway`, `talent-profile`, `scheduler`) can change at any
 * time without warning. Internal defenses (T1 wire-shape snapshots, T2
 * codegen-Zod, E2E coverage gate, schema/contract rule) detect drift
 * for the maintainer's account at the maintainer's pace — but they do
 * NOT cover how an existing user's install degrades gracefully when
 * their wire-version is known-broken.
 *
 * This module fetches a tiny JSON manifest from the project's own
 * stable infrastructure at startup and surfaces a warning (CLI may
 * additionally refuse) when the running version is listed. The
 * detection sources, severity tiers, and response procedure are
 * documented in `docs/operations/wire-breakage-runbook.md`.
 *
 * **Privacy** — the fetch sends ONLY the default Node fetch headers and
 * the URL. No version, no account identifier, no telemetry. Install-
 * count tracking is a separate (intentionally deferred) question.
 *
 * **Fail-silent contract** — every error path returns `fetch-failed`
 * silently. The kill switch MUST NEVER itself cause a denial-of-service
 * when the maintainer's GitHub raw URL is briefly unreachable, the
 * client is offline, the manifest is malformed, or a parse error
 * surfaces. Outer try/catch envelope on the fetch + structural
 * validation of the parsed JSON is the load-bearing defense.
 *
 * **Override** — set `TTCTL_DISABLE_KILL_SWITCH=1` to disable the
 * check entirely. The value is read ONCE at module load (matches the
 * established `TTCTL_DEBUG_CONFIG` / `TTCTL_DEBUG_MCP` /
 * `TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY` conventions). Any other value
 * (including empty string, `0`, `true`, or unset) keeps the check
 * enabled. Tests exercising both paths must `vi.resetModules()` and
 * dynamic-import after mutating `process.env`.
 */

/**
 * Stable manifest URL. Hosted at raw.githubusercontent.com from the
 * project repo's `main` branch (chosen for: zero CI setup, instant
 * updates on push, maintainer-only write via branch protection).
 *
 * Exported so callers can override for testing or local fixtures.
 */
export const KILL_SWITCH_MANIFEST_URL =
  "https://raw.githubusercontent.com/alexey-pelykh/ttctl/main/status/known-broken.json";

/** Default fetch timeout (ms). 3s upper bound on every invocation. */
export const KILL_SWITCH_DEFAULT_TIMEOUT_MS = 3000;

/** Default refetch interval for long-lived processes (MCP server). 24h. */
export const KILL_SWITCH_DEFAULT_REFETCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Env-var name (documented for callers + README + audit-checklist). */
export const KILL_SWITCH_OVERRIDE_ENV_VAR = "TTCTL_DISABLE_KILL_SWITCH";

/**
 * Module-load capture of `TTCTL_DISABLE_KILL_SWITCH=1`. Read ONCE so the
 * disabled path is constant-folded by V8 on subsequent JIT passes — the
 * zero-cost-when-disabled contract matches `TTCTL_DEBUG_CONFIG`'s
 * `DEBUG_ENABLED` in `configWriter.ts`.
 */
const KILL_SWITCH_DISABLED = process.env[KILL_SWITCH_OVERRIDE_ENV_VAR] === "1";

/** Single entry in the manifest's `known_broken` list. */
export interface KillSwitchEntry {
  /**
   * Version specifier matching the running TTCtl version. Supported
   * syntax (in order of precedence):
   *
   * - `*` — matches any version (global kill).
   * - `=X.Y.Z` or `X.Y.Z` — exact match.
   * - `<X.Y.Z`, `<=X.Y.Z`, `>X.Y.Z`, `>=X.Y.Z` — comparison.
   *
   * Pre-release suffixes (`-rc.1`, `-beta.0`) are compared lexico-
   * graphically per semver §11.4: a version with a pre-release tag is
   * less than the same version without. Build metadata (`+sha`) is
   * stripped before comparison.
   *
   * Compound ranges (`>=0.1.0 <0.2.0`) are NOT supported — emit two
   * entries in the manifest instead. This keeps the matcher trivial
   * and the manifest auditable.
   */
  version_spec: string;
  /** Human-readable explanation (rendered verbatim in the user-facing warning). */
  reason: string;
  /**
   * `warn` (continue execution) or `refuse` (CLI exits non-zero).
   * MCP server-side always treats both as `warn` — refusing a long-
   * lived server has no safe semantics (mid-flight tool calls would
   * be interrupted). Documented in the runbook.
   */
  action: "warn" | "refuse";
  /** ISO date when this entry was added (informational + audit trail). */
  as_of: string;
}

/** Top-level manifest shape. Versioned for forward-compat. */
export interface KillSwitchManifest {
  schema_version: 1;
  known_broken: KillSwitchEntry[];
}

/**
 * Discriminated result of `checkKillSwitch`. Callers map by status:
 *
 * - `disabled` — env override set; no fetch attempted. Silent.
 * - `fetch-failed` — silent failure (network, timeout, 404, parse-error,
 *   malformed manifest). Callers MUST NOT surface this to the user —
 *   fail-silent contract.
 * - `no-match` — running version is not in the manifest. Silent.
 * - `match` — running version matches an entry. Caller emits warning
 *   (CLI may also exit when `entry.action === 'refuse'`).
 */
export type KillSwitchResult =
  | { status: "disabled" }
  | { status: "fetch-failed"; reason: string }
  | { status: "no-match" }
  | { status: "match"; entry: KillSwitchEntry };

export interface CheckKillSwitchOptions {
  /** Running TTCtl version. Caller resolves via `readPackageVersion(import.meta.url)`. */
  version: string;
  /** Override the manifest URL (default: project raw.githubusercontent.com URL). */
  url?: string;
  /** Override the timeout in ms (default: `KILL_SWITCH_DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
  /**
   * Injected fetch implementation (default: `globalThis.fetch`). Tests
   * pass their own mock here — cleaner than `vi.stubGlobal('fetch', ...)`
   * because the global is left untouched.
   */
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Check whether the running version appears in the remote known-broken
 * manifest. Returns a discriminated `KillSwitchResult` — never throws,
 * regardless of network / parse / shape failures (fail-silent contract).
 *
 * @example
 * ```ts
 * const result = await checkKillSwitch({ version: "0.1.0" });
 * if (result.status === "match") {
 *   process.stderr.write(formatKillSwitchMessage({ toolName: "ttctl", version: "0.1.0", entry: result.entry }));
 *   if (result.entry.action === "refuse") process.exit(1);
 * }
 * ```
 */
export async function checkKillSwitch(opts: CheckKillSwitchOptions): Promise<KillSwitchResult> {
  if (KILL_SWITCH_DISABLED) return { status: "disabled" };

  const url = opts.url ?? KILL_SWITCH_MANIFEST_URL;
  const timeoutMs = opts.timeoutMs ?? KILL_SWITCH_DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchFn ?? globalThis.fetch;

  let parsed: unknown;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      // No custom headers — sends only the default fetch User-Agent.
      // Privacy posture: no version / account / telemetry in the
      // request envelope (per #312 spec).
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        return { status: "fetch-failed", reason: `http_${response.status.toString()}` };
      }
      const body = await response.text();
      parsed = JSON.parse(body);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // AbortError, network error, JSON parse error — all silent.
    const reason = err instanceof Error ? (err.name === "Error" ? err.message : err.name) : "unknown";
    return { status: "fetch-failed", reason };
  }

  if (!isValidManifest(parsed)) {
    return { status: "fetch-failed", reason: "manifest_shape_invalid" };
  }

  for (const entry of parsed.known_broken) {
    if (matchesVersion(opts.version, entry.version_spec)) {
      return { status: "match", entry };
    }
  }
  return { status: "no-match" };
}

function isValidManifest(value: unknown): value is KillSwitchManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<KillSwitchManifest>;
  if (m.schema_version !== 1) return false;
  if (!Array.isArray(m.known_broken)) return false;
  for (const entry of m.known_broken) {
    if (!isValidEntry(entry)) return false;
  }
  return true;
}

function isValidEntry(value: unknown): value is KillSwitchEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<KillSwitchEntry>;
  return (
    typeof e.version_spec === "string" &&
    typeof e.reason === "string" &&
    (e.action === "warn" || e.action === "refuse") &&
    typeof e.as_of === "string"
  );
}

/**
 * Match a running version against a manifest spec. Public for unit
 * testing the operator surface independently of the fetch path.
 */
export function matchesVersion(running: string, spec: string): boolean {
  const trimmed = spec.trim();
  if (trimmed === "*") return true;

  // Longest-prefix-first so `<=` matches before `<`, `>=` before `>`.
  const operators: ReadonlyArray<{ token: string; cmp: (ordering: number) => boolean }> = [
    { token: "<=", cmp: (o) => o <= 0 },
    { token: ">=", cmp: (o) => o >= 0 },
    { token: "<", cmp: (o) => o < 0 },
    { token: ">", cmp: (o) => o > 0 },
    { token: "=", cmp: (o) => o === 0 },
  ];
  for (const { token, cmp } of operators) {
    if (trimmed.startsWith(token)) {
      const rhs = trimmed.slice(token.length).trim();
      const ordering = compareSemverLike(running, rhs);
      return ordering === null ? false : cmp(ordering);
    }
  }
  // No prefix → exact match.
  return compareSemverLike(running, trimmed) === 0;
}

/**
 * Three-way compare two semver-ish strings. Returns:
 *   -1 if a < b
 *    0 if a == b
 *   +1 if a > b
 *   null if either string is unparseable (defensive — matcher returns
 *   false in that case rather than mis-matching).
 *
 * Implements just enough of semver §11 for the version_spec surface:
 *   - Strip `+build` metadata.
 *   - Compare `X.Y.Z` numerically.
 *   - On equal `X.Y.Z`, a pre-release tag (`-rc.1`) is LESS than no tag.
 *   - Both pre-release: lexicographic on the full suffix.
 */
function compareSemverLike(a: string, b: string): -1 | 0 | 1 | null {
  const aStripped = stripBuild(a);
  const bStripped = stripBuild(b);
  const aParts = splitSemver(aStripped);
  const bParts = splitSemver(bStripped);
  if (aParts === null || bParts === null) return null;

  for (let i = 0; i < 3; i += 1) {
    const av = aParts.numeric[i] ?? 0;
    const bv = bParts.numeric[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  if (aParts.pre === "" && bParts.pre === "") return 0;
  if (aParts.pre === "" && bParts.pre !== "") return 1;
  if (aParts.pre !== "" && bParts.pre === "") return -1;
  if (aParts.pre < bParts.pre) return -1;
  if (aParts.pre > bParts.pre) return 1;
  return 0;
}

function stripBuild(v: string): string {
  const idx = v.indexOf("+");
  return idx === -1 ? v : v.slice(0, idx);
}

function splitSemver(v: string): { numeric: number[]; pre: string } | null {
  const dashIdx = v.indexOf("-");
  const base = dashIdx === -1 ? v : v.slice(0, dashIdx);
  const pre = dashIdx === -1 ? "" : v.slice(dashIdx + 1);
  const numeric = base.split(".").map((p) => Number.parseInt(p, 10));
  if (numeric.length === 0 || numeric.some((n) => !Number.isFinite(n))) return null;
  return { numeric, pre };
}

export interface FormatKillSwitchMessageOptions {
  /** "ttctl" or "ttctl mcp" — appears in the rendered warning header. */
  toolName: string;
  /** Running version (string, displayed verbatim). */
  version: string;
  /** Matched entry (carries reason + action + as_of). */
  entry: KillSwitchEntry;
}

/**
 * Render a user-facing warning/refusal message for a kill-switch match.
 * Used by both CLI and MCP wire-ups so the surface stays consistent.
 * Message always includes the runbook link and the override hint —
 * critical for users who land on the warning without context.
 */
export function formatKillSwitchMessage(opts: FormatKillSwitchMessageOptions): string {
  const verb = opts.entry.action === "refuse" ? "REFUSED" : "WARNING";
  return (
    `[${verb}] ${opts.toolName} ${opts.version} is flagged as broken.\n` +
    `  Reason: ${opts.entry.reason}\n` +
    `  Reported: ${opts.entry.as_of}\n` +
    `  Runbook: https://github.com/alexey-pelykh/ttctl/blob/main/docs/operations/wire-breakage-runbook.md\n` +
    `  Override: set ${KILL_SWITCH_OVERRIDE_ENV_VAR}=1 to silence this check.\n`
  );
}
