// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * First file in the E2E sequence (numeric prefix `01-`). Asserts that
 * `globalSetup` successfully established a live session, then exercises
 * the read-side shape of the gateway via `auth status` and `profile show`.
 *
 * The signout assertion lives in `99-auth-signout.e2e.test.ts` — it must
 * run LAST so the shared session remains live for `profile show` and other
 * downstream cases. Numeric prefixes pin the logical order via the
 * explicit `BaseSequencer` in `vitest.e2e.config.ts`.
 *
 * Suite shape: this file uses `getSharedSession()` to read the session
 * metadata that `globalSetup` wrote. No per-file signin happens here —
 * the live signin is amortized across all `getSharedSession()`-using files
 * (AC #1 of #105: exactly one shared signin per run).
 *
 * Skip-gate: every test is `.skipIf(!e2eEnabled)`. Without `TTCTL_E2E=1`,
 * vitest discovers the file (only when `vitest.e2e.config.ts` includes it,
 * which itself env-gates), and every test reports SKIPPED.
 *
 * Output redaction (#21 C3): tests extract specific fields BEFORE
 * asserting, so a failing test diff never includes the full profile JSON.
 * Existence checks use `key in obj` so failure diffs collapse to
 * `Expected: true / Received: false` instead of dumping the host object.
 */

import { existsSync, statSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("auth signin + profile (live Toptal, shared session)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "signin: globalSetup established a session — token exists, auth status reports the email",
    async () => {
      const { tokenPath, email } = getSharedSession();

      // Isolated auth token exists and is non-empty (#21 spec: "isolated
      // session-of-record present after signin"). The token is plain
      // text + trailing newline; non-zero size is the observable proxy
      // that core.signIn captured + saveAuthToken persisted something.
      expect(existsSync(tokenPath)).toBe(true);
      expect(statSync(tokenPath).size).toBeGreaterThan(0);

      // Session round-trips through the CLI: auth status exits 0 and the
      // table row mentions the email we signed in with.
      const result = await cli.run(["auth", "status"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(email);
    },
  );

  it.skipIf(!e2eEnabled)("auth status: returns exit 0 with the configured email", async () => {
    const { email } = getSharedSession();
    const result = await cli.run(["auth", "status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(email);
  });

  it.skipIf(!e2eEnabled)(
    "profile show: returns parseable JSON with the rich mobile-gateway-native shape (#66)",
    async () => {
      const result = await cli.run(["profile", "show", "-o", "json"]);
      expect(result.exitCode).toBe(0);

      // Field extraction with explicit narrowing (#21 C3) — no `toEqual`
      // against the full payload, no `toMatchObject` either: both leak the
      // host object on failure. Existence is asserted as a boolean so a
      // failed assertion shows `Expected: true / Received: false`.
      const payload = JSON.parse(result.stdout) as unknown;
      expect(typeof payload).toBe("object");
      expect(payload).not.toBeNull();

      const root = payload as { viewer?: unknown };
      const viewer = root.viewer as { viewerRole?: unknown } | undefined;
      expect(typeof viewer).toBe("object");
      expect(viewer).not.toBeNull();
      if (viewer === undefined || viewer === null) return;

      const viewerRole = viewer.viewerRole as Record<string, unknown> | undefined;
      expect(typeof viewerRole).toBe("object");
      expect(viewerRole).not.toBeNull();
      if (viewerRole === undefined || viewerRole === null) return;

      // Identity field — assert non-empty string (don't assert the value
      // itself; the operator's name is not a stable test fixture).
      const fullName = viewerRole["fullName"];
      expect(fullName).toBeTypeOf("string");
      if (typeof fullName !== "string") return;
      expect(fullName.length).toBeGreaterThan(0);

      // Rich-shape sentinel fields — fields the mobile-gateway-native query
      // (#66) selects that the prior talent-profile-shaped query did NOT.
      // Their presence is the observable that the new transport + selection
      // set actually landed on the live response.
      expect("email" in viewerRole).toBe(true);
      expect("profileId" in viewerRole).toBe(true);
      expect("availability" in viewerRole).toBe(true);
      expect("hourlyRate" in viewerRole).toBe(true);
      expect("timeZone" in viewerRole).toBe(true);
      expect("specializations" in viewerRole).toBe(true);
      expect("vertical" in viewerRole).toBe(true);

      // Profile substructure — assert keys exist via boolean membership so
      // failure diffs don't dump the object.
      const profile = viewerRole["profile"] as Record<string, unknown> | undefined;
      expect(typeof profile).toBe("object");
      expect(profile).not.toBeNull();
      if (profile === undefined || profile === null) return;

      expect("id" in profile).toBe(true);
      expect("city" in profile).toBe(true);
      expect("skillSets" in profile).toBe(true);
    },
  );
});
