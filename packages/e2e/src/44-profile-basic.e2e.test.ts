// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.basic.set`'s read-merge contract.
 *
 * Contract under test: `UPDATE_BASIC_INFO` is a full-replacement
 * contract — the server requires every non-null field in the input. The
 * apply path reads current state via `getBasicInfo()` and merges
 * user-supplied fields on top before sending. A partial input (anything
 * less than the 9 required-non-null fields populated) returns
 * GRAPHQL_ERROR.
 *
 * Track 1: `UPDATE_BASIC_INFO` is T1 — `assertWireShapeStable(...)` diffs
 * the response against `UPDATE_BASIC_INFO.snapshot.json`.
 *
 * Coverage:
 *   - Round-trip `set({bio, headline})` → `getBasicInfo()` re-read; the
 *     set MUST succeed (a `GRAPHQL_ERROR` on required-non-null fields
 *     is the regression class this test defends).
 *   - T1 snapshot on the `UpdateProfileResult` returned by `set()`.
 *
 * Non-destructive: captures current bio + headline, applies sentinels,
 * restores originals in `finally`.
 *
 * Skip conditions (stderr warning, no fail):
 *   - Current profile is missing one of the server-required fields
 *     (e.g. `fullName === null`): test-account-state issue, the
 *     read-merge would pass null verbatim. Subtest skipped.
 *   - `USER_ERROR` (business gate, not wire-shape): subtest skipped.
 *   - `GRAPHQL_ERROR` is NEVER skipped — propagates as a hard failure.
 */

// e2e-covers: UPDATE_BASIC_INFO, GET_BASIC_INFO

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/** Load the bearer captured by `globalSetup` into the shared sandbox YAML. */
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

describe("profile basic read-merge set() (live talent-profile, INFERRED wire shape)", () => {
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
  // #604 — social URLs + skype preservation across a basic_update
  // -------------------------------------------------------------------
  //
  // Mandatory per CLAUDE.md § Schema/contract validation rule. The fix
  // for #604 extended the `UpdateBasicInfoProfileInput` and the merge
  // path to carry `linkedin / github / website / behance / dribbble /
  // skype`. The hypothesis (drawn from the 2026-05-06 live curl in
  // `research/notes/10` § Captured exception): the input ACCEPTS these
  // six and the full-replacement contract preserves them when present.
  // Only the live API can prove either half.
  //
  // The test is intentionally robust to accounts where the user hasn't
  // set any of the six — the assertion is `after.X === before.X`, so
  // null === null passes. The bug is observable only on accounts WITH
  // any of the six set, but the wire-shape acceptance is exercised on
  // every run (sending the keys with null values must not be rejected).
  //
  // Skip conditions reuse the round-trip's pre-flight (missing required
  // server-side fields would mask the social preservation behind a
  // generic "Expected value to not be null" wire error).

  it.skipIf(!e2eEnabled)(
    "preserves social URLs + skype across a headline-only basic.set (#604 regression, full-replacement contract)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // Step 1: capture EVERY field we care about preservation for.
      const before = await profile.basic.getBasicInfo(token);

      // Same pre-flight as the round-trip subtest — without the required
      // scalars the merge would null-out a different field and the test
      // would fail on the wrong gate.
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
            `#604 social-preservation subtest skipped (cannot exercise without trashing user data).\n`,
        );
        return;
      }

      // Step 2: change ONLY headline. If the input now carries the six
      // social fields read-merged from current, all six must survive.
      const ts = Date.now().toString();
      const sentinelHeadline = `e2e #604 social-preservation sentinel ${ts}`;
      const originalHeadline = before.headline;

      try {
        const outcome = await profile.basic.set(token, { headline: sentinelHeadline });
        expect(outcome.kind).toBe("applied");
        if (outcome.kind !== "applied") return;

        // Step 3: read back and assert each social field is UNCHANGED.
        // null === null is acceptable: it proves the wire input accepted
        // the field with a null value and the server didn't reject. A
        // value-vs-null transition would be the pre-#604 bug (server
        // nulled an omitted field) — caught even on accounts with one
        // or two of the six set.
        const after = await profile.basic.getBasicInfo(token);
        expect(after.linkedin).toBe(before.linkedin);
        expect(after.github).toBe(before.github);
        expect(after.website).toBe(before.website);
        expect(after.behance).toBe(before.behance);
        expect(after.dribbble).toBe(before.dribbble);
        expect(after.skype).toBe(before.skype);
        // And the headline change itself must have applied (proves the
        // set executed, not skipped by some upstream guard).
        expect(after.headline).toBe(sentinelHeadline);

        // Explicit success transcript line — matches the #526 convention in
        // this file so a future skip vs full-run can be distinguished from
        // verbose output alone (the #604 skip path emits a `warning:` line;
        // a successful round-trip emits this `ok:` line).
        const setCount = [
          before.linkedin,
          before.github,
          before.website,
          before.behance,
          before.dribbble,
          before.skype,
        ].filter((v) => v !== null).length;
        process.stderr.write(
          `ok: [44-profile-basic #604] headline-only set() preserved all six social fields ` +
            `(linkedin/github/website/behance/dribbble/skype) across the full-replacement contract; ` +
            `${setCount.toString()}/6 of these were non-null on this account → values matched, nulls stayed null.\n`,
        );
      } catch (err) {
        if (errorCode(err) === "USER_ERROR") {
          process.stderr.write(
            `warning: [44-profile-basic] talent-profile rejected the #604 sentinel with USER_ERROR ` +
              `(business gate, NOT a wire-shape regression). Subtest skipped.\n`,
          );
          return;
        }
        // GRAPHQL_ERROR here would mean the live API rejected one of the
        // six new input fields ("Field 'X' is not defined on
        // UpdateBasicInfoProfileInput") — the hypothesis underlying the
        // #604 fix is wrong, and the merge must take a different shape
        // (capture+restore via external.update). Propagate.
        throw err;
      } finally {
        // Restore the original headline.
        if (originalHeadline !== null) {
          try {
            await profile.basic.set(token, { headline: originalHeadline });
          } catch (restoreErr) {
            process.stderr.write(
              `warning: [44-profile-basic] failed to restore original headline after #604 sentinel apply: ` +
                `${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}\n`,
            );
          }
        }
      }
    },
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
