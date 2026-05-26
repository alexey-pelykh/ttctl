// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.employment.skills.add` / `employment.skills.
 * remove` — additive merge wrappers (#614) over the existing full-replace
 * `employment.update.skills` (#541). Mandatory per CLAUDE.md § Schema/
 * contract validation rule: the change touches
 * `packages/core/src/services/profile/employment/`.
 *
 * Wire op: both wrappers issue `UpdateEmployment` under the hood — the
 * snapshot is owned by `46-profile-employment-update-merge.e2e.test.ts`.
 * This file asserts the read-merge-write semantics on top of it:
 *   - `add`: appends new ids, dedupes already-linked, returns `noop` when
 *     the supplied set is a subset of current state (no wire fire).
 *   - `remove`: drops supplied ids from the row, returns `noop` when none
 *     match, REFUSES (`VALIDATION_ERROR`) when the filtered set would be
 *     empty (the wire rejects empty `skills: []`).
 *
 * Sentinel-based pattern (mirrors `46-…-update-merge`):
 *   1. Source two distinct catalog `Skill.id`s from existing employment
 *      rows (the only reliable source — `profile.skills.list()` returns
 *      `ProfileSkillSet` ids the wire silently drops).
 *   2. Source an industry + employer for the sentinel seed.
 *   3. Seed a sentinel employment row carrying skill A.
 *   4. `skills.add(B)` → assert outcome.kind === "updated", show() echoes
 *      both A and B.
 *   5. `skills.add(B)` AGAIN → assert outcome.kind === "noop" (idempotent).
 *   6. `skills.remove(B)` → assert outcome.kind === "updated", show() back
 *      to A only.
 *   7. `skills.remove(B)` AGAIN → assert outcome.kind === "noop"
 *      (filter no-op).
 *   8. `skills.remove(A)` → assert ProfileError VALIDATION_ERROR (refusal
 *      to leave row with zero skills).
 *   9. `try/finally` cleanup removes the sentinel row.
 *
 * Same no-silent-skip-on-USER_ERROR discipline as `46-…-update-merge`: any
 * server error propagates as a hard failure.
 */

// e2e-covers: UpdateEmployment

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, ProfileError, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("profile.employment.skills — additive merge wrappers (#614)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "add → noop-on-resubmit → remove → noop-on-rerun → refusal-on-empty round-trips through show()",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const ts = Date.now().toString();
      const sentinelCompany = `e2e-614-sentinel-${ts}`;
      const sentinelStartYear = 2020;

      // Source two distinct catalog Skill ids from existing rows. We need
      // at least two because the test rotates one onto/off the sentinel.
      const existing = await profile.employment.list(token);
      const skills: { id: string; name: string }[] = [];
      for (const e of existing) {
        for (const s of e.skills) {
          if (!skills.some((k) => k.id === s.id)) skills.push(s);
          if (skills.length >= 2) break;
        }
        if (skills.length >= 2) break;
      }
      if (skills.length < 2) {
        throw new Error(
          "fewer than 2 distinct catalog Skill ids across existing employment rows — cannot exercise add/remove on a sentinel that mutates exactly one skill",
        );
      }
      const skillA = skills[0];
      const skillB = skills[1];
      if (skillA === undefined || skillB === undefined) {
        throw new Error("unreachable: length >= 2 implies indices 0 and 1 defined");
      }

      const industryMatches = await profile.industries.autocomplete(token, "Software", 5);
      const firstIndustry = industryMatches[0];
      if (firstIndustry === undefined) {
        throw new Error("industries autocomplete returned no matches for 'Software'");
      }
      const employerMatches = await profile.employment.employerAutocomplete(token, "Anthropic", 10);
      const exactEmployer = employerMatches.find((m) => m.name.trim().toLowerCase() === "anthropic");
      if (exactEmployer === undefined) {
        throw new Error(`autocomplete for "Anthropic" returned no exact-name match`);
      }

      let createdId: string | undefined;
      try {
        const addOutcome = await profile.employment.add(token, {
          company: sentinelCompany,
          position: "E2E Engineer",
          startDate: sentinelStartYear,
          employerId: exactEmployer.id,
          publicationPermit: true,
          experienceItems: [
            "Sentinel row for #614 employment.skills add/remove coverage; created and removed by this live e2e test.",
            "Carries exactly one initial skill so the test can rotate a second skill on and off.",
            "Cleanup runs in try/finally even on mid-assertion failure.",
          ],
          skills: [{ id: skillA.id, name: skillA.name }],
          industryIds: [firstIndustry.id],
        });
        if (addOutcome.kind !== "created") {
          throw new Error(`Expected add outcome.kind === 'created', got ${addOutcome.kind}`);
        }
        createdId = addOutcome.result.id;
        expect(addOutcome.result.skills.map((s) => s.id)).toEqual([skillA.id]);

        // 1) skills.add(B) on row carrying only A → updated, both echo.
        const added = await profile.employment.skills.add(token, createdId, {
          skillSetIds: [skillB.id],
        });
        if (added.kind !== "updated") {
          throw new Error(`Expected skills.add outcome.kind === 'updated', got ${added.kind}`);
        }
        const afterAddIds = new Set(added.result.skills.map((s) => s.id));
        expect(afterAddIds.has(skillA.id)).toBe(true);
        expect(afterAddIds.has(skillB.id)).toBe(true);

        // Fresh read confirms server state — round-trip half of the rule.
        const shownAfterAdd = await profile.employment.show(token, createdId);
        const shownAfterAddIds = new Set(shownAfterAdd.skills.map((s) => s.id));
        expect(shownAfterAddIds.has(skillA.id)).toBe(true);
        expect(shownAfterAddIds.has(skillB.id)).toBe(true);

        // 2) skills.add(B) AGAIN → noop (already linked, no wire fire).
        const reAdd = await profile.employment.skills.add(token, createdId, {
          skillSetIds: [skillB.id],
        });
        expect(reAdd.kind).toBe("noop");

        // 3) skills.remove(B) → updated, row back to A only.
        const removed = await profile.employment.skills.remove(token, createdId, {
          skillSetIds: [skillB.id],
        });
        if (removed.kind !== "updated") {
          throw new Error(`Expected skills.remove outcome.kind === 'updated', got ${removed.kind}`);
        }
        const afterRemoveIds = removed.result.skills.map((s) => s.id);
        expect(afterRemoveIds).toContain(skillA.id);
        expect(afterRemoveIds).not.toContain(skillB.id);

        const shownAfterRemove = await profile.employment.show(token, createdId);
        const shownAfterRemoveIds = shownAfterRemove.skills.map((s) => s.id);
        expect(shownAfterRemoveIds).toContain(skillA.id);
        expect(shownAfterRemoveIds).not.toContain(skillB.id);

        // 4) skills.remove(B) AGAIN → noop (not on row, filter no-op).
        const reRemove = await profile.employment.skills.remove(token, createdId, {
          skillSetIds: [skillB.id],
        });
        expect(reRemove.kind).toBe("noop");

        // 5) skills.remove(A) → refusal (filtered would be empty; the
        //    Toptal server rejects `skills: []`).
        await expect(profile.employment.skills.remove(token, createdId, { skillSetIds: [skillA.id] })).rejects.toThrow(
          ProfileError,
        );
      } finally {
        if (createdId !== undefined) {
          await profile.employment.remove(token, createdId);
        }
      }
    },
  );
});
