// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.basic.set` after the #393 read-merge rewrite.
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `UPDATE_BASIC_INFO` is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`), the schema is gappy
 * (`UpdateBasicInfoInput { _placeholder: String }`), and the input shape
 * was inferred from the captured browser curl in
 * `research/notes/10-mutation-input-patterns.md`. The live API is the
 * only authority on whether the merged input matches the server's
 * `UpdateBasicInfoInput!` contract.
 *
 * **Originating bug (#393)**: pre-#393, `set({bio, headline})` constructed
 * `{profileId, profile: {about?, quote?}}` only. The server rejected
 * the call with "Variable $input of type UpdateBasicInfoInput! was
 * provided invalid value for profile.fullName (Expected value to not be
 * null), profile.legalName (Expected value to not be null), …" on 9
 * required-non-null fields. The `talent_profile` API treats
 * `UPDATE_BASIC_INFO` as a **full-replacement contract** despite the JS
 * bundle's partial-input shape. The fix: read current state via
 * `getBasicInfo()` first, merge user-supplied fields over it, send the
 * full input. This E2E test is the post-merge regression defence.
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * `UPDATE_BASIC_INFO` has no generated operation type → **T1** (wire-shape
 * snapshot). `assertWireShapeStable(...)` diffs the live response shape
 * against the committed snapshot at
 * `packages/e2e/src/wire-snapshots/UPDATE_BASIC_INFO.snapshot.json`.
 *
 * Coverage:
 *   - **Round-trip** (#393 core AC): apply `set({bio, headline})` against
 *     the live API, then read back via `getBasicInfo()` and assert
 *     persisted values. The set MUST succeed — a `GRAPHQL_ERROR`
 *     "Expected value to not be null" on any of the 9 required fields
 *     means the read-merge regressed.
 *   - **Wire-shape snapshot** (T1): the `UpdateProfileResult` returned
 *     by `set()` is diffed against the committed snapshot.
 *
 * **Non-destructive design**: the test captures the current bio+headline
 * BEFORE the test runs, applies sentinel values, asserts persistence,
 * and restores the originals in `finally` — the user's profile content
 * is unchanged at end of test, even on assertion failure.
 *
 * **Skip conditions** (silent — emit stderr warning, do not fail):
 *   - The current profile is missing one of the server-required fields
 *     (e.g. `fullName === null`): the read-merge would pass `null`
 *     verbatim and the server would reject. This is a test-account-state
 *     issue, not a wire-shape regression. Skip the subtest with a
 *     stderr warning.
 *   - `USER_ERROR` from the mutation (a server-side business gate):
 *     wire-shape gate already passed; skip the subtest.
 *   - A `GRAPHQL_ERROR` is NEVER skipped — that is precisely the
 *     regression class this file defends.
 */

// e2e-covers: UPDATE_BASIC_INFO, GET_BASIC_INFO

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors the established pattern in
 * `42-profile-external-show.e2e.test.ts:71-79` and
 * `43-profile-employment.e2e.test.ts:79-87` — `ConfigLoadSchema`
 * validates the Form-D shape (`auth.token` present).
 */
function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

/**
 * Structural read of `ProfileError.code` without importing the class
 * (`ProfileError` is internal to `@ttctl/core`). A `USER_ERROR` is a
 * server-side business gate (graceful skip — the wire-shape gate is
 * already passed by then); any other code (notably `GRAPHQL_ERROR`)
 * propagates as a hard failure.
 */
function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

describe("profile basic #393 read-merge set() (live talent-profile, INFERRED wire shape)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  // -------------------------------------------------------------------
  // Round-trip — set({bio, headline}) → getBasicInfo() echoes
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "round-trips set({bio, headline}) against live UPDATE_BASIC_INFO without rejecting on null required fields",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // Step 1: capture the current bio + headline so we can restore
      // them in `finally`. The read-merge path inside `set()` will also
      // call getBasicInfo internally; this is the test-side capture for
      // restoration.
      const before = await profile.basic.getBasicInfo(token);

      // Pre-flight: the read-merge only works when every server-
      // required field is set on the current profile. If `fullName`
      // (or any other required scalar) is null on this account, the
      // merge would pass null through and the server would still
      // reject. That's a test-account-state issue, not a wire-shape
      // regression — skip with a warning.
      const requiredScalars: [string, string | null][] = [
        ["fullName", before.fullName],
        ["legalName", before.legalName],
        ["city", before.city],
        ["placeIdentity", before.placeIdentity],
        ["countryId", before.countryId],
        ["citizenshipId", before.citizenshipId],
        ["phoneNumber", before.phoneNumber],
      ];
      const missing = requiredScalars.filter(([, v]) => v === null).map(([k]) => k);
      if (missing.length > 0 || before.languages.length === 0) {
        process.stderr.write(
          `warning: [44-profile-basic] account is missing required server-side fields ` +
            `(${[...missing, ...(before.languages.length === 0 ? ["languages"] : [])].join(", ")}) — ` +
            `the read-merge round-trip would fail on the server's null-required-field gate, not on ` +
            `a wire-shape regression. Subtest skipped.\n`,
        );
        return;
      }

      // Step 2: apply sentinel values via the read-merge path.
      const ts = Date.now().toString();
      const sentinelBio = `e2e bio sentinel ${ts}\n\nrestored after test`;
      const sentinelHeadline = `e2e headline ${ts}`;

      try {
        const outcome = await profile.basic.set(token, {
          bio: sentinelBio,
          headline: sentinelHeadline,
        });

        // Apply-path must return the "applied" discriminator. A
        // wire-shape regression that the server rejected would have
        // thrown above with GRAPHQL_ERROR — propagation is automatic.
        expect(outcome.kind).toBe("applied");
        if (outcome.kind !== "applied") return;

        // The mutation response echoes the merged values.
        expect(outcome.result.profile.about).toBe(sentinelBio);
        expect(outcome.result.profile.quote).toBe(sentinelHeadline);

        // Step 3: round-trip via a fresh getBasicInfo() — the persistence
        // gate. A divergence here would mean the server accepted the
        // mutation but didn't actually persist the values; the read-back
        // is the canonical proof of write-read parity.
        const after = await profile.basic.getBasicInfo(token);
        expect(after.bio).toBe(sentinelBio);
        expect(after.headline).toBe(sentinelHeadline);

        // Step 4: the OTHER required fields must be UNCHANGED — the
        // read-merge contract guarantees user-unsupplied fields are
        // preserved from current state.
        expect(after.fullName).toBe(before.fullName);
        expect(after.legalName).toBe(before.legalName);
        expect(after.city).toBe(before.city);
        expect(after.placeIdentity).toBe(before.placeIdentity);
        expect(after.countryId).toBe(before.countryId);
        expect(after.citizenshipId).toBe(before.citizenshipId);
        expect(after.phoneNumber).toBe(before.phoneNumber);
        expect(after.languages.map((l) => l.id).sort()).toEqual(before.languages.map((l) => l.id).sort());
        expect(after.softwareSkills.map((s) => s.id).sort()).toEqual(before.softwareSkills.map((s) => s.id).sort());
      } catch (err) {
        if (errorCode(err) === "USER_ERROR") {
          process.stderr.write(
            `warning: [44-profile-basic] talent-profile rejected the sentinel write with a USER_ERROR ` +
              `business gate (test-account-state issue, NOT a #393 wire-shape regression — a wrong ` +
              `input shape fails earlier with GRAPHQL_ERROR). Round-trip subtest skipped.\n`,
          );
          return;
        }
        // GRAPHQL_ERROR / NETWORK_ERROR / UNKNOWN — propagate. A
        // GRAPHQL_ERROR here is exactly the regression this file defends
        // (the #393 wire-error class).
        throw err;
      } finally {
        // Restore original bio + headline so the user's profile content
        // is unchanged at end of test. Skip if the original was null —
        // `set()` rejects an undefined bio + undefined headline, and we
        // shouldn't fabricate a value for the restore.
        if (before.bio !== null || before.headline !== null) {
          try {
            await profile.basic.set(token, {
              ...(before.bio !== null && { bio: before.bio }),
              ...(before.headline !== null && { headline: before.headline }),
            });
          } catch (restoreErr) {
            process.stderr.write(
              `warning: [44-profile-basic] failed to restore original bio/headline after sentinel apply: ` +
                `${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}\n`,
            );
          }
        }
      }
    },
    // Live mutation + multiple reads; give it room over the default 5s.
    30_000,
  );

  // -------------------------------------------------------------------
  // T1 wire-shape snapshot for UPDATE_BASIC_INFO
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "UPDATE_BASIC_INFO wire shape is stable (T1 snapshot, full-replacement)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const before = await profile.basic.getBasicInfo(token);

      // Same pre-flight as the round-trip subtest — if the account is
      // missing required fields, the snapshot subject can't be produced
      // without trashing user data. Skip silently with a warning.
      const requiredScalars: [string, string | null][] = [
        ["fullName", before.fullName],
        ["legalName", before.legalName],
        ["city", before.city],
        ["placeIdentity", before.placeIdentity],
        ["countryId", before.countryId],
        ["citizenshipId", before.citizenshipId],
        ["phoneNumber", before.phoneNumber],
      ];
      const missing = requiredScalars.filter(([, v]) => v === null).map(([k]) => k);
      if (missing.length > 0 || before.languages.length === 0) {
        process.stderr.write(
          `warning: [44-profile-basic] account is missing required server-side fields ` +
            `(${[...missing, ...(before.languages.length === 0 ? ["languages"] : [])].join(", ")}) — ` +
            `UPDATE_BASIC_INFO snapshot subtest skipped (cannot exercise the merge without a no-op write).\n`,
        );
        return;
      }

      // Re-apply current bio + headline — idempotent no-op write (NOT a
      // sentinel; the snapshot subject is the response shape, independent
      // of what we wrote). If the user has never set a bio, fall back to a
      // sentinel that we restore in finally; this is the only case where
      // we touch user data, and only if the user has no bio to preserve.
      const originalBio = before.bio;
      const originalHeadline = before.headline;
      const needsSentinelBio = originalBio === null;
      const needsSentinelHeadline = originalHeadline === null;
      const writeBio = originalBio ?? "e2e snapshot sentinel bio";
      const writeHeadline = originalHeadline ?? "e2e snapshot sentinel headline";

      try {
        const outcome = await profile.basic.set(token, { bio: writeBio, headline: writeHeadline });
        expect(outcome.kind).toBe("applied");
        if (outcome.kind !== "applied") return;
        // Snapshot the `UpdateProfileResult` shape — same convention as
        // `42-profile-external-show.e2e.test.ts` (snapshots the mapped
        // service result, not the raw GraphQL body, since the raw is
        // opaque to consumers).
        assertWireShapeStable({
          operationName: "UPDATE_BASIC_INFO",
          surface: "talent-profile",
          transport: "impersonated",
          response: outcome.result,
        });
      } catch (err) {
        if (errorCode(err) === "USER_ERROR") {
          process.stderr.write(
            `warning: [44-profile-basic] UPDATE_BASIC_INFO snapshot — talent-profile rejected with USER_ERROR ` +
              `business gate (test-account-state issue, NOT a wire-shape regression). Snapshot subtest skipped.\n`,
          );
          return;
        }
        throw err;
      } finally {
        // Restore — only if we used a sentinel for either field.
        if (needsSentinelBio || needsSentinelHeadline) {
          // The original was null; we can't "restore to null" via set()
          // because set() requires at least one of bio/headline. There's
          // no way to revert a null→string transition on this surface
          // without a separate clear-field mutation. Surface a warning
          // and leave the sentinel in place — the user can clear it
          // manually via `ttctl profile basic update --bio ""`.
          const sentineled = [needsSentinelBio ? "bio" : null, needsSentinelHeadline ? "headline" : null]
            .filter((v): v is string => v !== null)
            .join(" and ");
          process.stderr.write(
            `warning: [44-profile-basic] UPDATE_BASIC_INFO snapshot wrote a sentinel because the account had no ` +
              `${sentineled} set; clear it manually if undesired.\n`,
          );
        }
        // Round-trip subtest already handles the restore for the
        // bio-was-set / headline-was-set case (same originals captured),
        // so no duplicate restore here. If THIS subtest ran first (test
        // ordering nondeterminism), the next subtest's restore will fix
        // it; if THIS subtest ran solo (e.g. .only filter), the values
        // we wrote ARE the originals — no restore needed.
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------
  // #535 / #526 — Twitter round-trip via basic.set (basic-owned write)
  // -------------------------------------------------------------------
  //
  // Per CLAUDE.md § Schema/contract validation rule: `basic.set({twitter})`
  // writes the inferred `UpdateBasicInfoInput.profile.twitter` field, the
  // implementing change touches `packages/core/src/services/profile/basic/
  // index.ts`, and this is a MUTATION — the rule triggers. This subtest is
  // the live wire authority for the #526 normalisation contract.
  //
  // #526 WIRE TRUTH (authoritative, from a live UPDATE_BASIC_INFO capture):
  // `twitter` is a BARE HANDLE on the wire (e.g. `alexey_pelykh`), NOT a
  // URL — unlike the sibling linkedin/github/website fields on the same
  // input. Callers naturally pass a URL; pre-#526 it was stored verbatim
  // and the field rendered broken. `normalizeTwitterHandle` (in core) fixes
  // this. This subtest proves it END-TO-END against the live API for BOTH
  // input shapes: a URL input AND a bare-handle input must each persist as
  // the SAME normalised bare handle, visible on basic.show AND external.show.
  //
  // Non-destructive: captures the user's current twitter handle up-front,
  // runs both round-trips, and restores the original in `finally` (even on
  // assertion failure).

  it.skipIf(!e2eEnabled)(
    "round-trips basic.set({twitter}) with BOTH a URL and a bare-handle input — each normalises to the bare handle and persists on basic.show + external.show (#526)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // Same pre-flight as the sibling round-trip — the read-merge needs
      // every server-required scalar set on the current profile.
      const before = await profile.basic.getBasicInfo(token);
      const requiredScalars: [string, string | null][] = [
        ["fullName", before.fullName],
        ["legalName", before.legalName],
        ["city", before.city],
        ["placeIdentity", before.placeIdentity],
        ["countryId", before.countryId],
        ["citizenshipId", before.citizenshipId],
        ["phoneNumber", before.phoneNumber],
      ];
      const missing = requiredScalars.filter(([, v]) => v === null).map(([k]) => k);
      if (missing.length > 0 || before.languages.length === 0) {
        process.stderr.write(
          `warning: [44-profile-basic] account is missing required server-side fields ` +
            `(${[...missing, ...(before.languages.length === 0 ? ["languages"] : [])].join(", ")}) — ` +
            `the read-merge twitter round-trip would fail on the server's null-required-field gate, not on ` +
            `a wire-shape regression. Subtest skipped.\n`,
        );
        return;
      }

      const originalTwitter = before.twitter;
      const ts = Date.now().toString();
      // Two distinct sentinel handles: short, alphanumeric+underscore
      // (matches Twitter's handle constraint), suffixed with a timestamp so
      // concurrent E2E runs don't collide, ≤15 chars. The URL case feeds a
      // full https://x.com/<handle> URL; the bare case feeds the handle
      // directly. Both must end up stored as the SAME bare-handle shape.
      const urlHandle = `ttu_${ts.slice(-8)}`;
      const bareHandle = `ttb_${ts.slice(-8)}`;
      const urlInput = `https://x.com/${urlHandle}`;

      /**
       * Apply `twitter: input` and assert the live API normalises +
       * persists it to `expectedHandle` on the mutation echo, basic.show,
       * AND external.show. Returns `false` if a USER_ERROR business gate
       * fired (caller skips the rest with a warning).
       */
      const roundTrip = async (input: string, expectedHandle: string, label: string): Promise<boolean> => {
        const outcome = await profile.basic.set(token, { twitter: input });
        expect(outcome.kind).toBe("applied");
        if (outcome.kind !== "applied") return false;

        // The mutation response echoes the NORMALISED bare handle — proof
        // that what the server stored is the handle, not the URL we sent.
        expect(outcome.result.profile.twitter, `${label}: mutation echo`).toBe(expectedHandle);

        // basic.show persistence gate.
        const afterBasic = await profile.basic.getBasicInfo(token);
        expect(afterBasic.twitter, `${label}: basic.show`).toBe(expectedHandle);
        // Sanity: the merge preserved user-unsupplied scalars.
        expect(afterBasic.bio).toBe(before.bio);
        expect(afterBasic.headline).toBe(before.headline);

        // external.show echo gate — twitter is read-visible on both
        // surfaces; the basic write must not break the external echo.
        const afterExternal = await profile.external.show(token);
        expect(afterExternal.twitter, `${label}: external.show`).toBe(expectedHandle);

        // Positive confirmation that the live normalisation assertions
        // ACTUALLY ran (vs an early skip on a USER_ERROR / missing-field
        // gate, both of which print a `warning:` line and `return` before
        // here). Records the exact input → stored-handle mapping observed
        // against the live API, so the PR transcript is unambiguous.
        process.stderr.write(
          `ok: [44-profile-basic #526] ${label} — sent ${JSON.stringify(input)}; live API stored + ` +
            `echoed bare handle ${JSON.stringify(expectedHandle)} (mutation echo + basic.show + external.show all matched).\n`,
        );
        return true;
      };

      try {
        // 1) URL input → stored as the bare handle (#526 core fix).
        if (!(await roundTrip(urlInput, urlHandle, "URL input"))) return;
        // 2) Bare-handle input → stored unchanged (normalisation no-op).
        if (!(await roundTrip(bareHandle, bareHandle, "bare-handle input"))) return;
      } catch (err) {
        if (errorCode(err) === "USER_ERROR") {
          process.stderr.write(
            `warning: [44-profile-basic] twitter round-trip — talent-profile rejected the sentinel write with ` +
              `a USER_ERROR business gate (test-account-state issue, NOT a #526 wire-shape regression — a wrong ` +
              `input shape fails earlier with GRAPHQL_ERROR). Subtest skipped.\n`,
          );
          return;
        }
        // GRAPHQL_ERROR / NETWORK_ERROR / UNKNOWN — propagate. A
        // GRAPHQL_ERROR here would mean the wire shape was mis-inferred
        // (e.g. `twitter` is not actually settable on UpdateBasicInfoInput).
        throw err;
      } finally {
        // Restore the original twitter handle so the user's profile is
        // unchanged at end of test. `twitter: null` is the documented
        // "clear it" intent when the original was null; otherwise restore
        // the original string verbatim (already a bare handle).
        try {
          await profile.basic.set(token, { twitter: originalTwitter });
        } catch (restoreErr) {
          process.stderr.write(
            `warning: [44-profile-basic] failed to restore original twitter handle after sentinel apply: ` +
              `${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}\n`,
          );
        }
      }
    },
    // Two round-trips (2 mutations + 4 reads) + restore; well over 5s.
    60_000,
  );
});
