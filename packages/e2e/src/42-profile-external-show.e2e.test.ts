// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile external show` (#343).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — this
 * issue introduces a NEW hand-authored GraphQL query (`getExternalProfiles`)
 * against the Cloudflare-protected `talent-profile` surface. The document
 * is NOT in `codegen.config.ts`'s trusted catalog (it is listed in
 * `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` — every selected field is typed
 * `Unknown` in the synthesized SDL). The live API is the only authority
 * on whether the document accurately models the wire shape.
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * `getExternalProfiles` is excluded from codegen → no generated operation
 * type → **T1** (wire-shape snapshot). `assertWireShapeStable(...)` diffs
 * the live response shape against the committed
 * `packages/e2e/src/wire-snapshots/getExternalProfiles.snapshot.json`.
 *
 * Coverage:
 *   - **Pure read** (`getExternalProfiles`): the response carries the
 *     eight documented keys (`id`, `updatedByTalentAt`, and the six URL
 *     fields linkedin / github / website / twitter / behance / dribbble),
 *     each `string | null`. This is the schema/contract rule's core
 *     requirement — the new hand-authored query exercised live.
 *   - **Wire-shape snapshot** (T1): structural shape diffed against the
 *     committed snapshot via `assertWireShapeStable`.
 *   - **Round-trip** (AC: `update --<url> <X>` → `show` → assert echoed):
 *     read the current state, pick a URL that IS set, re-apply its EXACT
 *     current value via `update` (an idempotent no-op write — NOT a
 *     sentinel, so non-destructive), then `show` again and assert the
 *     value round-tripped. This is the same safe-round-trip shape the
 *     `updateCustomRequirements` E2E uses (re-apply current state). The
 *     existence of `show` is precisely what makes `UpdateExternalProfiles`
 *     safely round-trippable for the first time (previously e2e-exempt at
 *     source for lack of a read-side pre-state).
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - Test account has NO external URL set → the round-trip subtest is
 *     skipped (re-applying `null` is impossible: `update` requires at
 *     least one field and a valid URL). The pure-read + wire-snapshot
 *     assertions still run unconditionally and satisfy the
 *     schema/contract rule on their own.
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

const URL_FIELDS = ["linkedin", "github", "website", "twitter", "behance", "dribbble"] as const;

describe("profile external show (live talent-profile, INFERRED wire shape, #343)", () => {
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

    // Step 2: pick a URL that IS set. Re-applying its EXACT current value
    // is an idempotent no-op write (non-destructive) — NOT a sentinel.
    const field = URL_FIELDS.find((f) => typeof before[f] === "string" && before[f] !== "");
    if (field === undefined) {
      process.stderr.write(
        "[42-profile-external-show] account has no external URL set — round-trip subtest skipped " +
          "(re-applying null is impossible; pure-read + wire-snapshot assertions cover the schema/contract rule).\n",
      );
      return;
    }
    const value = before[field];
    expect(typeof value).toBe("string");

    // Step 3: re-apply the same value via update (no-op write).
    const updated = await profile.external.update(token, { [field]: value as string });
    expect(updated.profile.id).toBe(before.id);

    // Step 4: show again — the value must have round-tripped unchanged.
    const after = await profile.external.show(token);
    expect(after[field]).toBe(value);
    // The other URLs must be untouched by the single-field update.
    for (const f of URL_FIELDS) {
      if (f === field) continue;
      expect(after[f]).toBe(before[f]);
    }
  });
});
