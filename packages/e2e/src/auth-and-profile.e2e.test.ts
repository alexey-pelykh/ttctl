// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * First E2E test cases against the live Toptal Talent platform — issue #21.
 *
 * Suite shape (per #21 AC E2: exactly one EmailPasswordSignIn + one SignOut
 * per run): a single `withFreshSession()` registered at the top of this
 * file establishes the session in `beforeAll` and tears it down in
 * `afterAll`. All 5 tests share that session.
 *
 * Test order (sequential — vitest default within one file):
 *
 *   1. signin    — assert beforeAll established the session
 *   2. auth status   — assert exit 0 + email visible
 *   3. profile show  — assert JSON parses + has expected schema fields
 *   4. profile update round-trip (destructive) — capture → mutate → echo
 *      check → restore → byte-for-byte verify (#21 B1-B4)
 *   5. signout   — `ttctl auth signout` + post-state checks
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
 */

import { existsSync, statSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { getCliClient, withFreshSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import {
  applyMinimalWhitespaceEdit,
  captureBioToDisk,
  deleteBreadcrumb,
  generateRunId,
  readBreadcrumb,
} from "./restore-bio.js";

const session = withFreshSession();
const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Pull the bio out of `profile show -o json`'s payload. Centralised so the
 * round-trip test and the post-restore verifier agree on the path.
 *
 * Throws (rather than returning undefined) on schema mismatches so the
 * round-trip test doesn't swallow a Toptal-side schema break as an empty
 * bio and silently "succeed". Returns `""` only when the bio field is
 * present but null — that's a legitimate state for a profile with no bio.
 */
function extractBioFromShowJson(stdout: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`profile show -o json: parse failed: ${message}`);
  }
  const root = payload as { viewer?: { viewerRole?: { profile?: { about?: string | null } } } } | null;
  const about = root?.viewer?.viewerRole?.profile?.about;
  if (about === undefined) {
    throw new Error("profile show -o json: viewer.viewerRole.profile.about is missing from the payload");
  }
  return about ?? "";
}

describe("auth + profile E2E (live Toptal)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { jarPath } = session.getContext();
    cli = getCliClient({ jarPath });
  });

  it.skipIf(!e2eEnabled)(
    "signin: beforeAll established a session (auth status reports the email; isolated jar non-empty)",
    async () => {
      const { jarPath, email } = session.getContext();

      // Isolated jar exists and is non-empty (#21 spec: "isolated jar
      // contains expected session cookies"). The jar format is Mozilla
      // tab-separated; we don't parse it here — non-zero size is the
      // observable proxy that tough-cookie wrote something.
      expect(existsSync(jarPath)).toBe(true);
      expect(statSync(jarPath).size).toBeGreaterThan(0);

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

  it.skipIf(!e2eEnabled)("profile show: returns parseable JSON with expected schema fields", async () => {
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

    // Name field — assert it's a non-empty string (don't assert the value
    // itself; the operator's name is not a stable test fixture).
    const fullName = viewerRole["fullName"];
    expect(fullName).toBeTypeOf("string");
    if (typeof fullName !== "string") return; // narrowing for the .length below
    expect(fullName.length).toBeGreaterThan(0);

    // Profile substructure — assert keys exist via boolean membership so
    // failure diffs don't dump the object.
    const profile = viewerRole["profile"] as Record<string, unknown> | undefined;
    expect(typeof profile).toBe("object");
    expect(profile).not.toBeNull();
    if (profile === undefined || profile === null) return;

    expect("about" in profile).toBe(true);
    expect("quote" in profile).toBe(true);
  });

  describe("profile update round-trip (destructive)", () => {
    let breadcrumbFile: string | null = null;
    let originalBio: string | null = null;

    afterEach(async () => {
      // #21 B1: restore runs in afterEach — vitest's afterEach is the
      // try/finally analogue and fires regardless of whether the test body
      // threw. If `originalBio` was never captured (early failure before
      // capture), there is nothing to restore.
      if (originalBio === null) {
        breadcrumbFile = null;
        return;
      }

      // Capture the in-memory snapshot before clearing the closure vars,
      // so the restore path doesn't depend on instance state we're about
      // to null out.
      const bioToRestore = originalBio;
      const breadcrumbPath = breadcrumbFile;
      breadcrumbFile = null;
      originalBio = null;

      // Best-effort restore + byte-for-byte verify. Any failure here is a
      // CRITICAL B3 violation: the bio is in an unknown state and the
      // operator MUST see it. We collect the failure context, surface it
      // on stderr (loud), and re-throw so vitest fails the test even if
      // the body itself passed. The breadcrumb is kept on every failure
      // path so manual recovery is possible.
      let failure: string | null = null;
      try {
        const restoreResult = await cli.run(["profile", "update", "--bio", bioToRestore]);
        if (restoreResult.exitCode !== 0) {
          failure = `restore command exited ${restoreResult.exitCode.toString()}`;
        } else {
          const verify = await cli.run(["profile", "show", "-o", "json"]);
          if (verify.exitCode !== 0) {
            failure = `post-restore profile show exited ${verify.exitCode.toString()}`;
          } else {
            const roundTripped = extractBioFromShowJson(verify.stdout);
            if (roundTripped !== bioToRestore) {
              failure = `post-restore bio differs from original (length delta ${(roundTripped.length - bioToRestore.length).toString()})`;
            }
          }
        }
      } catch (err) {
        failure = `restore threw: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (failure === null) {
        // #21 B3 success path: restore + verify both succeeded. Delete
        // the breadcrumb. AC E5 invariant: post-suite breadcrumb is gone
        // on success — enforced HERE; subsequent tests in the suite have
        // no business inspecting it.
        if (breadcrumbPath !== null) {
          await deleteBreadcrumb(breadcrumbPath);
        }
        return;
      }

      // FAILURE PATH (#21 B3 "fails loudly — does not silently pass"):
      // breadcrumb retained, stderr written, throw to fail the test.
      const recoveryHint =
        breadcrumbPath !== null
          ? `pnpm exec ttctl profile update --bio "$(jq -r .bio ${breadcrumbPath})"`
          : "(breadcrumb path unknown — inspect .tmp/e2e-restore/ manually)";
      const message =
        `[#21 round-trip] CRITICAL: ${failure}; breadcrumb at ${breadcrumbPath ?? "<unknown>"} retained. ` +
        `Recover with: ${recoveryHint}`;
      process.stderr.write(message + "\n");
      throw new Error(message);
    });

    it.skipIf(!e2eEnabled)(
      "captures original bio, mutates with single trailing space, asserts echo, restores, verifies byte-for-byte",
      async () => {
        const { repoRoot } = session.getContext();
        const runId = generateRunId();

        // Read original bio.
        const showResult = await cli.run(["profile", "show", "-o", "json"]);
        expect(showResult.exitCode).toBe(0);
        const original = extractBioFromShowJson(showResult.stdout);

        // #21 B2: persist BEFORE mutation. The breadcrumb is the ONLY
        // recovery path if a process crash happens between mutate and
        // restore — there is no second copy.
        breadcrumbFile = await captureBioToDisk(repoRoot, runId, original);
        originalBio = original;

        // Sanity-check that the breadcrumb is readable. If the disk write
        // is somehow corrupt, fail BEFORE mutating (so afterEach has a
        // valid `originalBio` for restore via the in-memory copy).
        const breadcrumb = await readBreadcrumb(breadcrumbFile);
        expect(breadcrumb.bio).toBe(original);

        // #21 B4: minimum whitespace mutation — a single trailing space.
        // The pure helper carries the assumption documented (round-trips
        // verbatim through Toptal's profile API). If the assumption holds,
        // the post-mutate bio === mutated. If it fails (whitespace
        // normalization), this test fails LOUDLY — the operator picks an
        // alternative on first live run and the suite is unchanged
        // mechanically.
        const mutated = applyMinimalWhitespaceEdit(original);
        expect(mutated.length - original.length).toBeLessThanOrEqual(2);
        expect(mutated).not.toBe(original);

        const updateResult = await cli.run(["profile", "update", "--bio", mutated]);
        expect(updateResult.exitCode).toBe(0);

        // Round-trip check: re-fetch and assert echoed === mutated.
        const verifyAfterMutate = await cli.run(["profile", "show", "-o", "json"]);
        expect(verifyAfterMutate.exitCode).toBe(0);
        const echoed = extractBioFromShowJson(verifyAfterMutate.stdout);
        // If this assertion fails: Toptal normalized whitespace. The
        // afterEach hook still runs and restores the bio — we are
        // crash-safe even when this assertion is the failure mode.
        expect(echoed).toBe(mutated);

        // afterEach (above) restores + verifies + deletes the breadcrumb.
      },
      90_000, // 4-5 sequential CLI calls × ~10s each: bump above the 30s default.
    );
  });

  it.skipIf(!e2eEnabled)(
    "signout: ttctl auth signout exits 0; subsequent auth status reports no session; jar deleted",
    async () => {
      const { jarPath } = session.getContext();

      // #21 spec: this is the suite's only `auth signout` invocation. The
      // harness's afterAll also unlinks the jar, but ENOENT is silently
      // swallowed there — the count of *logical* signouts remains exactly
      // one (this CLI call) per AC E2.
      const signoutResult = await cli.run(["auth", "signout"]);
      expect(signoutResult.exitCode).toBe(0);

      // Jar gone (signout's contract: idempotent unlink).
      expect(existsSync(jarPath)).toBe(false);

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
