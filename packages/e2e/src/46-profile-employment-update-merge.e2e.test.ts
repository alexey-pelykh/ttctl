// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E regression coverage for `profile.employment.update`'s read-current+
 * merge fix (#394 — wire-broke meta-class #392).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the fix
 * touches `packages/core/src/services/profile/employment/index.ts`, which
 * is one of the file-path triggers of the rule's code-review checklist.
 * The PR body declares `Schema/contract rule: triggered` and points at
 * this file as the live transcript.
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * `UpdateEmployment` is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` and has no
 * generated operation type → **T1** (wire-shape snapshot).
 * `assertWireShapeStable(...)` diffs the live response shape against the
 * committed `packages/e2e/src/wire-snapshots/UpdateEmployment.snapshot.json`.
 * The snapshot is generated on the first
 * `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run.
 *
 * Bug repro before the fix (recorded in #394's body verbatim):
 *
 * ```jsonc
 * {
 *   "tool": "ttctl_profile_employment_update",
 *   "args": {
 *     "id": "VjEtRW1wbG95bWVudC0xMjM0NTY7",
 *     "role": "Odoo Expert"
 *   }
 * }
 * ```
 *
 * Pre-fix the live API rejected the variables with
 * `Variable $input of type UpdateEmploymentInput! was provided invalid
 * value for employment.showViaToptal (Expected value to not be null), ...`
 * — four required-non-null GraphQL fields treated as null because the apply
 * path sent only the user-supplied subset (`{position: "Odoo Expert"}`).
 * The #394 live capture (2026-05-19) surfaced a second tier of server-side
 * Rails `.blank?` USER_ERROR gates that fire AFTER the GraphQL layer
 * accepts the input (`company`, `employerId`, `publicationPermit`,
 * `industryIds`, `skills`). The fix injects ALL of these from the
 * current row state.
 *
 * Coverage strategy (sentinel-based, mirrors `42-profile-external-show`'s
 * non-destructive round-trip pattern but uses an add/remove sentinel
 * because employment is row-oriented):
 *
 *   1. **Source cascade catalog refs** — a real `Skill.id` (sourced from
 *      an existing employment row, since `profile.skills.list()` returns
 *      `ProfileSkillSet` ids which the wire silently drops); an industry
 *      via `industries.autocomplete`; an `employerId` via
 *      `employer-autocomplete`.
 *   2. **Add a sentinel row** via `add()` with the full required input.
 *   3. **Update with the MINIMAL `{position}` payload** that previously
 *      failed at the wire layer (`{id, role}` per the bug repro). The
 *      fix's read-current+merge logic injects experienceItems, skills,
 *      showViaToptal, startDate, company, publicationPermit, employerId,
 *      and industryIds from the sentinel's current state. The live call
 *      must succeed without GRAPHQL_ERROR / USER_ERROR.
 *   4. **Assert the position changed** on the update response.
 *   5. **`show()` to re-read** and assert the change persisted (the
 *      "round-trip" half of the schema/contract rule).
 *   6. **Snapshot the UpdateEmployment response shape (T1)**.
 *   7. **`try/finally` cleanup** removes the sentinel even on mid-
 *      assertion failure.
 *
 * **No silent-skip on USER_ERROR.** The sibling `43-profile-employment.
 * e2e.test.ts:159-165` swallows `USER_ERROR` and emits a stderr warning;
 * that anti-pattern was the call-out in #392's investigation memo (a
 * post-fix `USER_ERROR` would silently mask the very regression #394
 * fixes). This file intentionally does NOT propagate that pattern — any
 * error from `update()` (including `USER_ERROR`) propagates as a hard
 * test failure so the regression class stays loudly observable.
 *
 * **Fragment extensions in #394**: `EMPLOYMENT_FRAGMENT` now selects
 * `employer { id }` and `skills { nodes { id name } }`, so `update()`
 * can echo both through the merge. The `Employment` interface gained
 * `employerId: string | null` and `skills: { id; name }[]` fields to
 * surface them on the read side.
 */

// e2e-covers: UpdateEmployment

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `42-profile-external-show.e2e.test.ts` and `43-profile-
 * employment.e2e.test.ts`.
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

describe("profile employment update — read-current+merge regression (#394)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "update({id, role}) succeeds against the live API and the change round-trips through show()",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const ts = Date.now().toString();
      const sentinelCompany = `e2e-394-sentinel-${ts}`;
      const sentinelStartYear = 2020;
      const originalRole = "E2E Engineer";
      const updatedRole = `E2E Lead Engineer ${ts}`;

      // The post-#395 add() requires a non-empty `skills: SkillRefInput[]`,
      // an `industryIds`, and `experienceItems`. The Skill IDs live on
      // existing employment rows — sourcing from an existing row is more
      // reliable than `profile.skills.list()` (which returns
      // ProfileSkillSet IDs, not the catalog Skill IDs the wire wants).
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
      // Source an employerId via autocomplete — "Anthropic" is empirically
      // 1-exact-match on the maintainer's catalog at the time of writing.
      const employerMatches = await profile.employment.employerAutocomplete(token, "Anthropic", 10);
      const exactEmployer = employerMatches.find((m) => m.name.trim().toLowerCase() === "anthropic");
      if (exactEmployer === undefined) {
        throw new Error(
          `autocomplete for "Anthropic" returned no exact-name match — cannot source a sentinel employerId`,
        );
      }

      let createdId: string | undefined;
      try {
        const addOutcome = await profile.employment.add(token, {
          company: sentinelCompany,
          position: originalRole,
          startDate: sentinelStartYear,
          employerId: exactEmployer.id,
          publicationPermit: true,
          experienceItems: [
            "Sentinel row for #394 wire-shape regression coverage; created and removed by this live e2e test.",
            "The minimal update() payload ({id, position}) must not regress to GRAPHQL_ERROR / USER_ERROR on required fields.",
            "The fix wires read-current+merge so the wire-required non-null fields are populated from current row state.",
          ],
          skills: [{ id: firstSkill.id, name: firstSkill.name }],
          industryIds: [firstIndustry.id],
        });
        if (addOutcome.kind !== "created") {
          throw new Error(`Expected outcome.kind === 'created', got ${addOutcome.kind}`);
        }
        const created = addOutcome.result;
        createdId = created.id;
        expect(typeof created.id).toBe("string");
        expect(created.position).toBe(originalRole);

        // The CORE repro from the #394 bug body: minimal `{position}`
        // update with no other fields. Pre-fix this rejected at the wire
        // layer with `Expected value to not be null` for the four
        // required-non-null fields. The fix's read-current+merge logic
        // makes this succeed.
        //
        // Any error — `GRAPHQL_ERROR` (wire-shape regression), `USER_ERROR`
        // (server-side business gate), or anything else — propagates as
        // a hard test failure. There is intentionally NO try/catch+skip
        // here; that anti-pattern (sibling 43-…:159-165) is what #394's
        // investigation memo called out as masking exactly the regression
        // class this file defends.
        const updated = await profile.employment.update(token, created.id, { position: updatedRole });
        expect(updated.position).toBe(updatedRole);
        expect(updated.id).toBe(created.id);
        // Other fields preserved through the merge — the wire kept what
        // it had for fields the caller did not supply.
        expect(updated.company).toBe(sentinelCompany);
        expect(updated.startDate).toBe(sentinelStartYear);
        expect(updated.showViaToptal).toBe(created.showViaToptal);

        // Fresh read confirms the position persisted (not just echoed in
        // the mutation response). This is the schema/contract rule's
        // "round-trip the change and verify it persisted" half.
        const shown = await profile.employment.show(token, created.id);
        expect(shown.position).toBe(updatedRole);
        expect(shown.company).toBe(sentinelCompany);
        expect(shown.startDate).toBe(sentinelStartYear);

        // T1 wire-shape snapshot for UpdateEmployment. The snapshot
        // subject is the typed `Employment` projection that `update()`
        // returns — same convention as the GET_WORK_EXPERIENCE snapshot
        // in 43-…:178-200 (post-projection mapped shape, not raw wire).
        assertWireShapeStable({
          operationName: "UpdateEmployment",
          surface: "talent-profile",
          transport: "impersonated",
          response: updated,
        });

        // #403 AC#4(c): the minimal {position} update did NOT supply
        // industryIds — read-current+merge must PRESERVE the seeded set.
        expect(shown.industries.map((i) => i.id)).toContain(firstIndustry.id);

        // #403 AC#4(b): supplying industryIds REPLACES the entire set
        // (replace-on-supply, mirrors portfolio_update). Source a second
        // distinct catalog industry, replace, assert the set is now
        // exactly the replacement (the seeded firstIndustry is gone).
        //
        // Fixture-availability guard: HARD throw on missing 2nd distinct
        // industry, mirroring the seed-industry/employer/skills guards
        // earlier in this test (`unreachable` precedent at line ~140,
        // exact-employer precedent at line ~152). A soft warn-and-skip
        // here would let the test PASS while leaving AC#4(b) — the ONLY
        // on-wire proof of replace-on-supply — silently unproven. The
        // file header (§ Coverage strategy + "No silent-skip on
        // USER_ERROR") explicitly opposes that pattern; the live e2e
        // run's value as a Submit-phase AC#4 transcript depends on
        // every sub-assertion being unconditional once reached.
        const otherMatches = await profile.industries.autocomplete(token, "Finance", 5);
        const otherIndustry = otherMatches.find((m) => m.id !== firstIndustry.id);
        if (otherIndustry === undefined) {
          throw new Error(
            `industries autocomplete for "Finance" returned no catalog match distinct from ` +
              `firstIndustry (${firstIndustry.id}) — cannot prove #403 AC#4(b) replace-on-supply. ` +
              `Re-broaden the autocomplete query (or adjust the test fixture) if the catalog changed.`,
          );
        }
        const replaced = await profile.employment.update(token, created.id, {
          industryIds: [otherIndustry.id],
        });
        const replacedIds = replaced.industries.map((i) => i.id);
        expect(replacedIds).toContain(otherIndustry.id);
        expect(replacedIds).not.toContain(firstIndustry.id);
      } finally {
        if (createdId !== undefined) {
          await profile.employment.remove(token, createdId);
        }
      }
    },
  );
});
