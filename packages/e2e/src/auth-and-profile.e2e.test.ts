// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * First E2E test cases against the live Toptal Talent platform — issue #21.
 *
 * Suite shape (per #21 AC E2: exactly one EmailPasswordSignIn + one SignOut
 * per run): a single `withFreshSession()` registered at the top of this
 * file establishes the session in `beforeAll` and tears it down in
 * `afterAll`. All tests share that session.
 *
 * Test order (sequential — vitest default within one file):
 *
 *   1. signin    — assert beforeAll established the session
 *   2. auth status   — assert exit 0 + email visible
 *   3. profile show  — assert JSON parses + has expected rich-shape fields
 *   4. signout   — `ttctl auth signout` + post-state checks
 *
 * Skip-gate: every test is `.skipIf(!e2eEnabled)`. Without `TTCTL_E2E=1`,
 * vitest discovers the file, the harness's beforeAll is a no-op (per
 * `withFreshSession` setUp's env gate), and every test reports SKIPPED.
 * `pnpm test:e2e` exits 0 silently — verified by CI (which never sets
 * TTCTL_E2E=1).
 *
 * Output redaction (#21 C3): tests extract specific fields BEFORE
 * asserting, so a failing test diff never includes the full profile JSON.
 * Existence checks use `key in obj` so failure diffs collapse to
 * `Expected: true / Received: false` instead of dumping the host object.
 *
 * Note: the profile-update round-trip test from earlier #21 iterations was
 * removed in #66 when the read path migrated to mobile-gateway. The bio
 * (`Profile.about`) and headline (`Profile.quote`) fields are NOT on
 * mobile-gateway's `Profile` type, so a `profile show`-based round-trip
 * verification is no longer feasible. `profile update` itself remains
 * exercised at the unit-test layer; live-API write-side coverage will
 * return when a follow-up issue restores read-side bio/headline visibility.
 */

import { existsSync, statSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, withFreshSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const session = withFreshSession();
const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("auth + profile E2E (live Toptal)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = session.getContext();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "signin: beforeAll established a session (auth status reports the email; isolated token non-empty)",
    async () => {
      const { tokenPath, email } = session.getContext();

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
    const { email } = session.getContext();
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

  it.skipIf(!e2eEnabled)(
    "signout: ttctl auth signout exits 0; subsequent auth status reports no session; token deleted",
    async () => {
      const { tokenPath } = session.getContext();

      // #21 spec: this is the suite's only `auth signout` invocation. The
      // harness's afterAll also unlinks the token, but ENOENT is silently
      // swallowed there — the count of *logical* signouts remains exactly
      // one (this CLI call) per AC E2.
      const signoutResult = await cli.run(["auth", "signout"]);
      expect(signoutResult.exitCode).toBe(0);

      // Token gone (signout's contract: idempotent unlink).
      expect(existsSync(tokenPath)).toBe(false);

      // Status now reports invalid (exit 1 — no-session branch).
      const statusAfter = await cli.run(["auth", "status"]);
      expect(statusAfter.exitCode).toBe(1);
      // Tolerate either "No session found" (no-session) or "Session
      // expired" (session-expired) — both are user-equivalent and the AC
      // says "shows 'not signed in' (or equivalent)".
      expect(statusAfter.stdout).toMatch(/no session|session expired/i);
    },
  );
});
