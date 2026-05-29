// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E live-wire coverage for #587 — exposing `engagementId` as a write
 * field on `employment_add` / `employment_update` (MCP + CLI).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule.** The change
 * surfaces a field that was INFERRED on `EmploymentInput`
 * (`research/captures/web/inputs/UpdateEmploymentInput.json` lists
 * `engagementId: ID  (V1-TalentEngagement-<n> if Toptal-related)` in both the
 * redacted captured UPDATE variables AND `inferred_inputs.EmploymentInput`,
 * but no live mutation had ever exercised it through ttctl). Consuming an
 * INFERRED input field => live round-trip required before the change merges.
 * The PR body declares `Schema/contract rule: triggered` and points at this
 * file as the transcript.
 *
 * **Open prerequisite (the issue was filed "NOT implementation-ready"):**
 * confirm the Toptal `UpdateEmployment` / `CreateEmployment` input accepts an
 * engagement-id field. This test IS that probe — a live round-trip that
 * either proves the wrapper-only change (same class as #586) or surfaces a
 * Toptal server-side limitation (the #526-class outcome the issue anticipates).
 *
 * **Engagement id source.** Unlike #586's `getCountries` catalog, the
 * engagement linkage value is the talent's own `TalentEngagement.id` —
 * surfaced as each `engagements list` row's `engagementId` field (the
 * underlying TalentEngagement id, distinct from the row's `jobActivityItem.id`
 * — see the engagements service "Engagement-id semantics" note). This test
 * sources a real id via `engagements.list({ status: "all" })`. The maintainer
 * test account MAY have zero engagements (the 18-engagements-list e2e notes
 * this); when none is linkable, the test fails loud (verification cannot be
 * faked) rather than skip.
 *
 * **No `assertWireShapeStable` here (deliberate).** `CreateEmployment` /
 * `UpdateEmployment` are T1 ops whose committed snapshots
 * (`wire-snapshots/{Create,Update}Employment.snapshot.json`, owned by tests
 * 45/46) record `engagement: { kind: "null" }` — the test account's common
 * case. Setting an engagement makes the projection an OBJECT; asserting it
 * against the null-case snapshot would register as `~` drift. This file's
 * schema/contract obligation is the round-trip persistence assertion below;
 * ongoing T1 drift detection for these ops stays owned by 45/46.
 *
 * Coverage strategy (sentinel add/remove, mirrors 71-…e2e):
 *   1. Source a real engagementId (and a second distinct one, if available)
 *      via engagements.list({ status: "all" }).
 *   2. Source the cascade catalog refs add() requires (skill / industry / employer).
 *   3. UPDATE path (the issue's primary use case): create a plain sentinel
 *      (engagement null) → UPDATE it with engagementId → assert response +
 *      show() round-trip.
 *   4. PARTIAL update OMITTING engagementId → assert the merge PRESERVES the
 *      linkage (first live exercise of the new non-null `current.engagement`
 *      echo branch in buildUpdateEmploymentInput).
 *   5. RE-ASSIGN to a second engagement (only when the account has ≥2) →
 *      assert it changed (settable, not write-once).
 *   6. CREATE path: a row created WITH engagementId persists it.
 *   7. try/finally removes both sentinels even on mid-assertion failure.
 *
 * No silent-skip on USER_ERROR — any error from add()/update() propagates as
 * a hard failure (the anti-pattern called out in #392's memo).
 */

// e2e-covers: CreateEmployment, UpdateEmployment

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, engagements, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";

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
 * Source the talent's linkable TalentEngagement ids from `engagements list`.
 * Returns the distinct, non-null `engagementId` values across all statuses.
 */
async function fetchLinkableEngagementIds(token: string): Promise<string[]> {
  const page = await engagements.list(token, { status: "all", perPage: 50 });
  const ids = page.items
    .map((i) => i.engagementId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}

describe("profile employment engagementId write", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "UpdateEmployment (and CreateEmployment) accept + persist engagementId (round-trip via show())",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // 1) Source the talent's real TalentEngagement ids.
      const engagementIds = await fetchLinkableEngagementIds(token);
      if (engagementIds.length === 0) {
        throw new Error(
          "engagements list returned no linkable engagementId across any status — the maintainer test account has " +
            "no Toptal engagement to link, so the engagementId round-trip cannot be verified live. (Schema/contract " +
            "rule cannot be satisfied without a linkable engagement; re-run on an account with at least one engagement.)",
        );
      }
      const engId = engagementIds[0];
      if (engId === undefined) throw new Error("unreachable: engagementIds.length > 0 implies index 0 defined");
      const engId2 = engagementIds[1]; // may be undefined (account has only one engagement)

      // 2) Source the cascade catalog refs add() requires (mirror 71-…e2e):
      //    a Skill id from an existing row, an industry, an exact employer.
      const existing = await profile.employment.list(token);
      const skillSource = existing.find((e) => e.skills.length > 0);
      if (!skillSource) {
        throw new Error("no existing employment with skills — cannot source a catalog Skill id for the sentinel seed");
      }
      const firstSkill = skillSource.skills[0];
      if (firstSkill === undefined) throw new Error("unreachable: skills.length > 0 implies index 0 defined");
      const industryMatches = await profile.industries.autocomplete(token, "Software", 5);
      const firstIndustry = industryMatches[0];
      if (firstIndustry === undefined) {
        throw new Error(
          "industries autocomplete returned no matches for 'Software' — cannot source a catalog industry id",
        );
      }
      const employerMatches = await profile.employment.employerAutocomplete(token, "Anthropic", 10);
      const exactEmployer = employerMatches.find((m) => m.name.trim().toLowerCase() === "anthropic");
      if (exactEmployer === undefined) {
        throw new Error(
          `autocomplete for "Anthropic" returned no exact-name match — cannot source a sentinel employerId`,
        );
      }

      const ts = Date.now().toString();
      const seed = {
        startDate: 2020,
        employerId: exactEmployer.id,
        publicationPermit: true,
        experienceItems: [
          "Sentinel row for issue 587 engagementId write coverage; created and removed by this live e2e test run.",
          "Verifies UpdateEmployment and CreateEmployment accept and persist an engagementId sourced from engagements list.",
          "Also proves the read-current merge preserves a non-null engagement when a later partial update omits the field.",
        ],
        skills: [{ id: firstSkill.id, name: firstSkill.name }],
        industryIds: [firstIndustry.id],
      };

      let updateId: string | undefined;
      let createId: string | undefined;
      try {
        // 3) UPDATE path (the issue's primary use case) — a plain sentinel
        //    (engagement null) gains an engagement linkage.
        const addPlain = await profile.employment.add(token, {
          company: `e2e-587-update-${ts}`,
          position: "Engagement Update Engineer",
          ...seed,
        });
        if (addPlain.kind !== "created") throw new Error(`Expected outcome.kind === 'created', got ${addPlain.kind}`);
        updateId = addPlain.result.id;
        expect(addPlain.result.engagement).toBeNull(); // starts unlinked

        const updated = await profile.employment.update(token, updateId, { engagementId: engId });
        // Positive shape check on the mutation response.
        expect(updated.engagement).not.toBeNull();
        expect(updated.engagement?.id).toBe(engId);
        // Round-trip: fresh read confirms persistence (schema/contract rule).
        const shownUpdate = await profile.employment.show(token, updateId);
        expect(shownUpdate.engagement?.id).toBe(engId);

        // 4) PARTIAL update OMITTING engagementId — the read-current+merge
        //    must PRESERVE it. First live exercise of the new non-null
        //    `current.engagement` echo branch in buildUpdateEmploymentInput.
        const preserved = await profile.employment.update(token, updateId, {
          position: "Engagement Update Engineer II",
        });
        expect(preserved.position).toBe("Engagement Update Engineer II");
        expect(preserved.engagement?.id).toBe(engId);
        const shownPreserved = await profile.employment.show(token, updateId);
        expect(shownPreserved.engagement?.id).toBe(engId);

        // 5) RE-ASSIGN to a second engagement — proves it is a settable
        //    field, not a write-once latch. Only when the account has ≥2.
        if (engId2 !== undefined) {
          const reassigned = await profile.employment.update(token, updateId, { engagementId: engId2 });
          expect(reassigned.engagement?.id).toBe(engId2);
          const shownReassign = await profile.employment.show(token, updateId);
          expect(shownReassign.engagement?.id).toBe(engId2);
        }

        // 6) CREATE path — a row created WITH engagementId persists it.
        const addEng = await profile.employment.add(token, {
          company: `e2e-587-create-${ts}`,
          position: "Engagement Create Engineer",
          ...seed,
          engagementId: engId,
        });
        if (addEng.kind !== "created") throw new Error(`Expected outcome.kind === 'created', got ${addEng.kind}`);
        createId = addEng.result.id;
        expect(addEng.result.engagement).not.toBeNull();
        expect(addEng.result.engagement?.id).toBe(engId);
        const shownCreate = await profile.employment.show(token, createId);
        expect(shownCreate.engagement?.id).toBe(engId);
      } finally {
        if (updateId !== undefined) {
          await profile.employment.remove(token, updateId);
        }
        if (createId !== undefined) {
          await profile.employment.remove(token, createId);
        }
      }
    },
  );
});
