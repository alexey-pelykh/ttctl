// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkKillSwitch,
  formatKillSwitchMessage,
  KILL_SWITCH_OVERRIDE_ENV_VAR,
  matchesVersion,
} from "../kill-switch.js";
import type { KillSwitchEntry, KillSwitchManifest } from "../kill-switch.js";

/**
 * Unit tests for the remote version-killed manifest primitive (#312).
 *
 * AC #6 enumerates 6 paths that MUST be covered:
 *   - fetch-success-with-match
 *   - fetch-success-no-match
 *   - fetch-timeout
 *   - fetch-404
 *   - parse-error
 *   - override-env-var
 *
 * The first five exercise the fetch path via the `fetchFn` injection
 * point (default is `globalThis.fetch`). The sixth tests the
 * module-load env-var capture — exercised by `vi.resetModules()` and
 * dynamic import after `process.env` mutation, matching the pattern in
 * `persistAuthToken-debug.test.ts`.
 *
 * Additional coverage:
 *   - matchesVersion operator surface (`*`, `=`, exact, `<`, `<=`, `>`, `>=`)
 *   - manifest shape validation (rejects garbage with `manifest_shape_invalid`)
 *   - formatKillSwitchMessage shape
 */

function manifest(...entries: KillSwitchEntry[]): KillSwitchManifest {
  return { schema_version: 1, known_broken: entries };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("checkKillSwitch — AC #6 mandated paths", () => {
  it("fetch-success-with-match → returns match with the matched entry", async () => {
    const entry: KillSwitchEntry = {
      version_spec: "0.1.0",
      reason: "Toptal mobile-gateway rotated persisted-query hashes 2026-05-15",
      action: "warn",
      as_of: "2026-05-15",
    };
    const fetchFn = vi.fn(async () => jsonResponse(manifest(entry)));

    const result = await checkKillSwitch({ version: "0.1.0", fetchFn });

    expect(result).toEqual({ status: "match", entry });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fetch-success-no-match → returns no-match when running version is absent", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        manifest({
          version_spec: "<0.1.0",
          reason: "old",
          action: "warn",
          as_of: "2026-05-15",
        }),
      ),
    );

    const result = await checkKillSwitch({ version: "0.2.0", fetchFn });

    expect(result).toEqual({ status: "no-match" });
  });

  it("fetch-timeout → returns fetch-failed silently when the abort fires", async () => {
    // Simulate a hang that exceeds the 50ms timeout. The AbortController
    // wired inside checkKillSwitch should fire and we get an AbortError-
    // shaped reason. The promise resolves to `fetch-failed`, NEVER throws.
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const result = await checkKillSwitch({ version: "0.1.0", fetchFn, timeoutMs: 50 });

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") {
      // AbortError is the named surface — the reason field carries it.
      expect(result.reason).toBe("AbortError");
    }
  });

  it("fetch-404 → returns fetch-failed with http_404 reason", async () => {
    const fetchFn = vi.fn(async () => new Response("not found", { status: 404 }));

    const result = await checkKillSwitch({ version: "0.1.0", fetchFn });

    expect(result).toEqual({ status: "fetch-failed", reason: "http_404" });
  });

  it("parse-error → returns fetch-failed silently on malformed JSON", async () => {
    const fetchFn = vi.fn(async () => new Response("definitely not json {{{", { status: 200 }));

    const result = await checkKillSwitch({ version: "0.1.0", fetchFn });

    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") {
      // Reason carries either SyntaxError (V8 wraps JSON.parse) or the
      // raw message — either way, it MUST NOT throw and MUST surface
      // some diagnostic string for the maintainer's debug logs.
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("checkKillSwitch — override env var (module-load capture)", () => {
  const originalEnv = process.env["TTCTL_DISABLE_KILL_SWITCH"];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env["TTCTL_DISABLE_KILL_SWITCH"];
    else process.env["TTCTL_DISABLE_KILL_SWITCH"] = originalEnv;
  });

  it("override-env-var → returns disabled when TTCTL_DISABLE_KILL_SWITCH=1, never calls fetch", async () => {
    process.env["TTCTL_DISABLE_KILL_SWITCH"] = "1";
    // Dynamic import after env mutation — the module-load const-fold
    // captures the new value on this fresh import.
    const mod = await import("../kill-switch.js");

    const fetchFn = vi.fn();
    const result = await mod.checkKillSwitch({ version: "0.1.0", fetchFn });

    expect(result).toEqual({ status: "disabled" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("non-'1' values (empty, '0', 'true', unset) keep the check enabled", async () => {
    // Spot-check the strict ===1 contract documented in the module
    // header. Truthy strings other than '1' must NOT disable.
    for (const val of ["", "0", "true", "yes"]) {
      process.env["TTCTL_DISABLE_KILL_SWITCH"] = val;
      vi.resetModules();
      const mod = await import("../kill-switch.js");
      const fetchFn = vi.fn(async () => jsonResponse(manifest()));
      const result = await mod.checkKillSwitch({ version: "0.1.0", fetchFn });
      expect(result.status).not.toBe("disabled");
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });
});

describe("checkKillSwitch — manifest shape validation", () => {
  it("rejects manifests with wrong schema_version", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 2, known_broken: [] }));
    const result = await checkKillSwitch({ version: "0.1.0", fetchFn });
    expect(result).toEqual({ status: "fetch-failed", reason: "manifest_shape_invalid" });
  });

  it("rejects manifests with non-array known_broken", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: "oops" }));
    const result = await checkKillSwitch({ version: "0.1.0", fetchFn });
    expect(result).toEqual({ status: "fetch-failed", reason: "manifest_shape_invalid" });
  });

  it("rejects entries with action outside {warn, refuse}", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        schema_version: 1,
        known_broken: [{ version_spec: "*", reason: "x", action: "block", as_of: "2026-05-15" }],
      }),
    );
    const result = await checkKillSwitch({ version: "0.1.0", fetchFn });
    expect(result).toEqual({ status: "fetch-failed", reason: "manifest_shape_invalid" });
  });

  it("accepts an empty known_broken array", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(manifest()));
    const result = await checkKillSwitch({ version: "0.1.0", fetchFn });
    expect(result).toEqual({ status: "no-match" });
  });

  it("returns the FIRST matching entry when multiple match", async () => {
    const wild: KillSwitchEntry = {
      version_spec: "*",
      reason: "global kill",
      action: "refuse",
      as_of: "2026-05-15",
    };
    const lt: KillSwitchEntry = {
      version_spec: "<1.0.0",
      reason: "pre-1.0",
      action: "warn",
      as_of: "2026-05-15",
    };
    const fetchFn = vi.fn(async () => jsonResponse(manifest(wild, lt)));
    const result = await checkKillSwitch({ version: "0.1.0", fetchFn });
    expect(result).toEqual({ status: "match", entry: wild });
  });
});

describe("matchesVersion — operator surface", () => {
  it("`*` matches anything", () => {
    expect(matchesVersion("0.0.0", "*")).toBe(true);
    expect(matchesVersion("99.99.99-rc.42", "*")).toBe(true);
  });

  it("exact match (no operator) is precise", () => {
    expect(matchesVersion("0.1.0", "0.1.0")).toBe(true);
    expect(matchesVersion("0.1.0", "0.1.1")).toBe(false);
    expect(matchesVersion("0.1.0-rc.1", "0.1.0")).toBe(false);
  });

  it("`=X.Y.Z` is equivalent to exact match", () => {
    expect(matchesVersion("0.1.0", "=0.1.0")).toBe(true);
    expect(matchesVersion("0.1.0", "= 0.1.0")).toBe(true); // whitespace tolerated
    expect(matchesVersion("0.1.1", "=0.1.0")).toBe(false);
  });

  it("`<X.Y.Z` matches strictly less", () => {
    expect(matchesVersion("0.0.9", "<0.1.0")).toBe(true);
    expect(matchesVersion("0.1.0", "<0.1.0")).toBe(false);
    expect(matchesVersion("0.1.1", "<0.1.0")).toBe(false);
  });

  it("`<=X.Y.Z` matches less-or-equal", () => {
    expect(matchesVersion("0.0.9", "<=0.1.0")).toBe(true);
    expect(matchesVersion("0.1.0", "<=0.1.0")).toBe(true);
    expect(matchesVersion("0.1.1", "<=0.1.0")).toBe(false);
  });

  it("`>X.Y.Z` matches strictly greater", () => {
    expect(matchesVersion("0.1.1", ">0.1.0")).toBe(true);
    expect(matchesVersion("0.1.0", ">0.1.0")).toBe(false);
    expect(matchesVersion("0.0.9", ">0.1.0")).toBe(false);
  });

  it("`>=X.Y.Z` matches greater-or-equal", () => {
    expect(matchesVersion("0.1.0", ">=0.1.0")).toBe(true);
    expect(matchesVersion("0.1.1", ">=0.1.0")).toBe(true);
    expect(matchesVersion("0.0.9", ">=0.1.0")).toBe(false);
  });

  it("pre-release tag is LESS than the same X.Y.Z without (semver §11.4)", () => {
    expect(matchesVersion("0.1.0-rc.1", "<0.1.0")).toBe(true);
    expect(matchesVersion("0.1.0", "<0.1.0-rc.1")).toBe(false);
    expect(matchesVersion("0.1.0-rc.1", "=0.1.0")).toBe(false);
  });

  it("pre-release ordering: lexicographic on the suffix", () => {
    expect(matchesVersion("0.1.0-rc.1", "<0.1.0-rc.2")).toBe(true);
    expect(matchesVersion("0.1.0-beta", "<0.1.0-rc.1")).toBe(true);
  });

  it("build metadata (+sha) is stripped before comparison", () => {
    expect(matchesVersion("0.1.0+abc123", "=0.1.0")).toBe(true);
    expect(matchesVersion("0.1.0+abc123", "0.1.0")).toBe(true);
  });

  it("malformed running version returns false (defensive — no mis-match)", () => {
    expect(matchesVersion("not-a-version", "*")).toBe(true); // wildcard still matches
    expect(matchesVersion("not-a-version", "=0.1.0")).toBe(false);
    expect(matchesVersion("not-a-version", "<0.1.0")).toBe(false);
  });
});

describe("formatKillSwitchMessage", () => {
  const entry: KillSwitchEntry = {
    version_spec: "<0.1.0",
    reason: "Toptal rotated mobile-gateway hashes",
    action: "warn",
    as_of: "2026-05-15",
  };

  it("renders a WARNING banner for action=warn", () => {
    const msg = formatKillSwitchMessage({ toolName: "ttctl", version: "0.0.9", entry });
    expect(msg).toContain("[WARNING]");
    expect(msg).toContain("ttctl 0.0.9");
    expect(msg).toContain("Toptal rotated mobile-gateway hashes");
    expect(msg).toContain("2026-05-15");
    expect(msg).toContain("docs/operations/wire-breakage-runbook.md");
    expect(msg).toContain(KILL_SWITCH_OVERRIDE_ENV_VAR);
  });

  it("renders a REFUSED banner for action=refuse", () => {
    const refuseEntry: KillSwitchEntry = { ...entry, action: "refuse" };
    const msg = formatKillSwitchMessage({ toolName: "ttctl", version: "0.0.9", entry: refuseEntry });
    expect(msg).toContain("[REFUSED]");
  });

  it("uses the supplied toolName verbatim (CLI vs MCP variant)", () => {
    const msg = formatKillSwitchMessage({ toolName: "ttctl mcp", version: "0.0.9", entry });
    expect(msg).toContain("ttctl mcp 0.0.9");
  });
});
