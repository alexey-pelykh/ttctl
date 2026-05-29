// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile external show` (#343) and
 * `ttctl profile external update`'s response-echo gap (#345 / #526).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — both
 * operations target the Cloudflare-protected `talent-profile` surface.
 * Neither is in `codegen.config.ts`'s trusted catalog (both listed in
 * `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` — every selected field is typed
 * `Unknown` in the synthesized SDL). The live API is the only authority
 * on whether the documents accurately model the wire shape.
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * neither op has a generated operation type → **T1** (wire-shape
 * snapshot). `assertWireShapeStable(...)` diffs each live response shape
 * against the committed
 * `packages/e2e/src/wire-snapshots/<OpName>.snapshot.json`. Snapshots
 * are generated on the first `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1`
 * run (per `packages/e2e/src/wire-snapshots/README.md`); the maintainer
 * commits them alongside the test.
 *
 * Coverage:
 *   - **Pure read** (`getExternalProfiles`): the response carries the
 *     eight documented keys (`id`, `updatedByTalentAt`, and the six URL
 *     fields linkedin / github / website / twitter / behance / dribbble),
 *     each `string | null`. `twitter` is read-only (#526) — listed here
 *     for read-shape coverage but NOT used as a round-trip subject.
 *   - **Wire-shape snapshot — read** (`getExternalProfiles`, T1):
 *     structural shape diffed against the committed snapshot.
 *   - **Round-trip** (AC: `update --<url> <X>` → response echoes; #343 +
 *     #345 AC): read the current state, pick a WRITABLE URL that IS set
 *     (excludes `twitter` post-#526), re-apply its EXACT current value
 *     via `update` (an idempotent no-op write — NOT a sentinel, so
 *     non-destructive), then assert (a) the update response echoes every
 *     URL field including `twitter` (the #345 selection-set gap echo is
 *     retained even though twitter is no longer writable), and (b)
 *     `show` again round-trips the value.
 *   - **Wire-shape snapshot — write** (`UpdateExternalProfiles`, T1;
 *     added #345): structural shape diffed against the committed snapshot.
 *     The snapshot's `profile.twitter` field is the regression-detector —
 *     a future selection-set regression (twitter dropped from the
 *     response) would surface as a structural diff.
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - Test account has NO writable URL set (linkedin/github/website/
 *     behance/dribbble all null) → both the round-trip subtest AND the
 *     UpdateExternalProfiles snapshot subtest are skipped (re-applying
 *     `null` is impossible: `update` requires at least one field and a
 *     valid URL; twitter cannot be the round-trip subject after #526).
 *     The pure-read + `getExternalProfiles` snapshot assertions still
 *     run unconditionally and satisfy the schema/contract rule for the
 *     read side.
 */

// e2e-covers: getExternalProfiles, UpdateExternalProfiles

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `25-timesheet-list.e2e.test.ts:47-54` — `ConfigLoadSchema`
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

// All six URL fields surfaced on the read side. `twitter` is included here
// for read-shape coverage (the `Profile` entity still exposes it) but is
// NOT a valid round-trip subject — see WRITABLE_URL_FIELDS below.
const URL_FIELDS = ["linkedin", "github", "website", "twitter", "behance", "dribbble"] as const;

// The five fields the live `ExternalProfilesInput` accepts. `twitter` was
// dropped server-side (the live wire rejects it transactionally on the
// whole batch — see #526), so it must be excluded from round-trip subject
// selection even though `show` still surfaces it.
const WRITABLE_URL_FIELDS = ["linkedin", "github", "website", "behance", "dribbble"] as const;
type WritableUrlField = (typeof WRITABLE_URL_FIELDS)[number];

describe("profile external show (live talent-profile, INFERRED wire shape)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  // -----------------------------------------------------------------
  // Pure read — getExternalProfiles wire shape (schema/contract core)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("show returns id + updatedByTalentAt + the six URL fields, each string|null", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const result = await profile.external.show(token);

    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);

    const tsOk = typeof result.updatedByTalentAt === "string" || result.updatedByTalentAt === null;
    expect(tsOk).toBe(true);

    for (const f of URL_FIELDS) {
      const v = result[f];
      expect(typeof v === "string" || v === null).toBe(true);
    }
  });

  // -----------------------------------------------------------------
  // T1 wire-shape snapshot
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("getExternalProfiles wire shape is stable (T1 snapshot)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await profile.external.show(token);
    assertWireShapeStable({
      operationName: "getExternalProfiles",
      surface: "talent-profile",
      transport: "impersonated",
      response,
    });
  });

  // -----------------------------------------------------------------
  // Round-trip — update → show → assert echoed (AC)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("round-trip: re-apply a current URL via update, then show echoes it", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    // Step 1: capture current state.
    const before = await profile.external.show(token);

    // Step 2: pick a WRITABLE URL that IS set. Re-applying its EXACT
    // current value is an idempotent no-op write (non-destructive) —
    // NOT a sentinel. `twitter` is excluded (#526 — server rejects it
    // on the input transactionally).
    const field: WritableUrlField | undefined = WRITABLE_URL_FIELDS.find(
      (f) => typeof before[f] === "string" && before[f] !== "",
    );
    if (field === undefined) {
      process.stderr.write(
        "[42-profile-external-show] account has no writable external URL set (twitter excluded post-#526) — " +
          "round-trip subtest skipped (re-applying null is impossible; pure-read + wire-snapshot " +
          "assertions cover the schema/contract rule).\n",
      );
      return;
    }
    const value = before[field];
    expect(typeof value).toBe("string");

    // Step 3: re-apply the same value via update (no-op write).
    const updated = await profile.external.update(token, { [field]: value as string });
    expect(updated.profile.id).toBe(before.id);

    // #345 — assert the mutation response echoes all six URL fields
    // (including `twitter`), not just the one we wrote. Even after #526
    // dropped `twitter` from the writable input, the response selection
    // set retains it because the server's `Profile` entity still
    // exposes the field; callers writing other fields can still observe
    // the pre-existing twitter value on the result.
    for (const f of URL_FIELDS) {
      const v = updated.profile[f];
      expect(typeof v === "string" || v === null).toBe(true);
    }

    // Step 4: show again — the value must have round-tripped unchanged.
    const after = await profile.external.show(token);
    expect(after[field]).toBe(value);
    // The other URLs must be untouched by the single-field update.
    for (const f of URL_FIELDS) {
      if (f === field) continue;
      expect(after[f]).toBe(before[f]);
    }
  });

  // -----------------------------------------------------------------
  // T1 wire-shape snapshot for UpdateExternalProfiles (#345)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("UpdateExternalProfiles wire shape is stable (T1 snapshot, includes twitter)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    // Pick a WRITABLE URL that IS set so the round-trip stays
    // non-destructive (re-apply current value — identical to the
    // round-trip subtest above). The snapshot subject is the full
    // mutation result shape (id + 6 URL fields + updatedByTalentAt +
    // notice), independent of which URL we used to trigger the call.
    // `twitter` is read-only post-#526 — excluded as a triggering field
    // but still expected in the response shape.
    const before = await profile.external.show(token);
    const field: WritableUrlField | undefined = WRITABLE_URL_FIELDS.find(
      (f) => typeof before[f] === "string" && before[f] !== "",
    );
    if (field === undefined) {
      process.stderr.write(
        "[42-profile-external-show] account has no writable external URL set (twitter excluded post-#526) — " +
          "UpdateExternalProfiles snapshot subtest skipped (no safe value to re-apply; pure-read + " +
          "getExternalProfiles snapshot still cover the wire shape on the read side).\n",
      );
      return;
    }
    const value = before[field];

    const updated = await profile.external.update(token, { [field]: value as string });
    assertWireShapeStable({
      operationName: "UpdateExternalProfiles",
      surface: "talent-profile",
      transport: "impersonated",
      response: updated,
    });
  });
});
