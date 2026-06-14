// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E regression coverage for `profile.education.update`'s read-current+merge
 * fix (#612 — full-replacement contract class, sibling of #605 cert and #604
 * basic). Mandatory per CLAUDE.md § Schema/contract validation rule (the fix
 * touches `packages/core/src/services/profile/education/**`). Track 1
 * disposition (`UPDATE_EDUCATION` is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`):
 * wire-shape snapshot via `assertWireShapeStable`.
 *
 * Coverage (sentinel-based, mirrors `73-profile-certifications-update-
 * merge.e2e.test.ts`): add education with every writable field populated →
 * update with minimal `{highlight: true}` → assert every other field
 * preserved on both the mutation response and a fresh `show()` → snapshot
 * the response shape → cleanup. No silent-skip on USER_ERROR.
 *
 * Secondary load-bearing assertion (the #612 § "Required investigation"
 * empirical probe): the wire input `EducationInput` has only `title` —
 * no `institution` field (capture
 * `research/captures/web/inputs/UpdateEducationInput.json`). ttctl's
 * `EducationFields.institution` is mapped to wire `title` internally; the
 * server echoes back to read-side `Education.institution`. The seed sends
 * `institution: sentinel` and asserts `read.institution === sentinel` —
 * failure = hypothesis is wrong and the fix design must be revisited.
 * The read-side `Education.title` is NOT input-driven here (no wire slot
 * matches it); preservation is asserted as `updated.title === created.title`
 * (whatever the server populated on create round-trips through the merge).
 *
 * `skills` is exercised by default (the seed passes a non-empty `skills`
 * sourced from existing employment per the #605 cert E2E pattern; the
 * empty-skills wire rejection on CREATE is the live-API confirmation that
 * makes the seed non-trivial).
 *
 * Second scenario (#633 — writable `skills` surface): the explicit-skills-
 * override round-trip. The new CLI `--skill-id` / MCP `skills` surface sends
 * `SkillRefInput { id, name: "" }` (the server keys on `id`); this proves the
 * exact wire shape the surface produces is accepted on `UpdateEducation` and
 * that an explicit set REPLACES the row's current skills (not preserve-merge).
 * Safe round-trip: a fresh temp row is created with skill A, overridden to
 * skill B, asserted (B present, A absent — both non-empty per the #633 scope
 * note that `skills: []` on update stays unverified), then removed.
 */

// e2e-covers: UPDATE_EDUCATION, CREATE_EDUCATION, REMOVE_EDUCATION

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `73-profile-certifications-update-merge.e2e.test.ts`.
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

describe("profile education update — read-current+merge regression", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "update({id, highlight}) preserves the other six writable fields under the full-replacement contract (#612)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const ts = Date.now().toString();
      const sentinelInstitution = `e2e-612-sentinel-school-${ts}`;
      const sentinelDegree = `e2e-612-sentinel-deg-${ts}`;
      const sentinelFieldOfStudy = `e2e-612-sentinel-fos-${ts}`;
      const sentinelLocation = `e2e-612-sentinel-loc-${ts}`;
      const sentinelYearFrom = 2018;
      const sentinelYearTo = 2022;

      // Source a catalog Skill id from existing employment rows — the wire
      // likely rejects `skills: []` on create (`is too short, minimum is 1
      // character`, same Rails `.blank?` posture as #394 / #605). Catalog
      // Skill IDs surface most reliably via existing employment row
      // `.skills` (mirrors `73-…:74-83`).
      const existingEmployment = await profile.employment.list(token);
      const employmentWithSkill = existingEmployment.find((e) => e.skills.length > 0);
      if (!employmentWithSkill) {
        throw new Error("no existing employment with skills — cannot source a catalog Skill id for the sentinel seed");
      }
      const seedSkill = employmentWithSkill.skills[0];
      if (seedSkill === undefined) throw new Error("unreachable: skills.length > 0 implies index 0 defined");

      let createdId: string | undefined;
      try {
        const created = await profile.education.add(token, {
          institution: sentinelInstitution,
          degree: sentinelDegree,
          fieldOfStudy: sentinelFieldOfStudy,
          location: sentinelLocation,
          yearFrom: sentinelYearFrom,
          yearTo: sentinelYearTo,
          highlight: false,
          skills: [{ id: seedSkill.id, name: seedSkill.name }],
        });
        createdId = created.id;
        expect(typeof created.id).toBe("string");
        // #612 § Required investigation: write→read mapping probe.
        // EducationInput has only `title` on the wire; ttctl maps the
        // surface field `institution` to wire `title`. Hypothesis: server
        // echoes back to read `institution`. Failure here = re-design.
        expect(created.institution).toBe(sentinelInstitution);
        expect(created.degree).toBe(sentinelDegree);
        // Capture whatever the server populated for read-side `title` —
        // there's no wire input slot matching it, so preservation is the
        // assertion shape (created.title === updated.title === shown.title).
        const observedCreateTitle = created.title;

        // Core repro for the #612 bug class: minimal `{highlight: true}`
        // update — pre-fix would have nulled the other six writable fields
        // server-side. Any error (GRAPHQL_ERROR / USER_ERROR / anything)
        // propagates as a hard test failure; no silent-skip.
        const updated = await profile.education.update(token, created.id, { highlight: true });
        expect(updated.id).toBe(created.id);
        expect(updated.highlight).toBe(true);

        // Load-bearing preservation assertions — pre-fix these would have nulled.
        expect(updated.institution).toBe(sentinelInstitution);
        expect(updated.degree).toBe(sentinelDegree);
        expect(updated.fieldOfStudy).toBe(sentinelFieldOfStudy);
        expect(updated.location).toBe(sentinelLocation);
        expect(updated.yearFrom).toBe(sentinelYearFrom);
        expect(updated.yearTo).toBe(sentinelYearTo);
        // Read `title` round-trips through the merge (no caller override).
        expect(updated.title).toBe(observedCreateTitle);
        // skills preserved through the merge (echoed from current.skills).
        expect(updated.skills.map((s) => s.id)).toContain(seedSkill.id);

        // Schema/contract rule's "round-trip the change and verify it
        // persisted" half — fresh read, not just the mutation response.
        const shown = await profile.education.show(token, created.id);
        expect(shown.highlight).toBe(true);
        expect(shown.institution).toBe(sentinelInstitution);
        expect(shown.degree).toBe(sentinelDegree);
        expect(shown.fieldOfStudy).toBe(sentinelFieldOfStudy);
        expect(shown.location).toBe(sentinelLocation);
        expect(shown.title).toBe(observedCreateTitle);
        expect(shown.yearFrom).toBe(sentinelYearFrom);
        expect(shown.yearTo).toBe(sentinelYearTo);
        expect(shown.skills.map((s) => s.id)).toContain(seedSkill.id);

        // T1 wire-shape snapshot — typed `Education` projection (post-
        // projection mapped shape, not raw wire). Mirrors
        // `UPDATE_CERTIFICATION.snapshot.json` in 73-…:142-146.
        assertWireShapeStable({
          operationName: "UPDATE_EDUCATION",
          surface: "talent-profile",
          transport: "impersonated",
          response: updated,
        });
      } finally {
        if (createdId !== undefined) {
          await profile.education.remove(token, createdId);
        }
      }
    },
  );

  it.skipIf(!e2eEnabled)(
    "update({id, skills:[B]}) REPLACES the row's current skills with the explicit set, sending name='' (#633)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const ts = Date.now().toString();

      // Source TWO distinct catalog Skill ids — override requires a before
      // (A) and an after (B). Catalog Skill ids surface most reliably via
      // existing employment rows' `.skills` (mirrors the first scenario).
      const existingEmployment = await profile.employment.list(token);
      const distinctSkills = [...new Map(existingEmployment.flatMap((e) => e.skills).map((s) => [s.id, s])).values()];
      if (distinctSkills.length < 2) {
        throw new Error(
          `need ≥2 distinct catalog Skill ids to exercise the override (found ${distinctSkills.length.toString()})`,
        );
      }
      const skillA = distinctSkills[0];
      const skillB = distinctSkills[1];
      if (skillA === undefined || skillB === undefined)
        throw new Error("unreachable: length ≥ 2 implies [0]/[1] defined");

      let createdId: string | undefined;
      try {
        // Seed a fresh row carrying skill A. CreateEducationInput requires
        // location / fieldOfStudy / yearFrom / yearTo non-null on the live
        // wire (empirically confirmed #633) — seed all of them so the test
        // exercises the skills OVERRIDE, not the CREATE-completeness contract.
        const created = await profile.education.add(token, {
          institution: `e2e-633-override-school-${ts}`,
          degree: `e2e-633-deg-${ts}`,
          fieldOfStudy: `e2e-633-fos-${ts}`,
          location: `e2e-633-loc-${ts}`,
          yearFrom: 2019,
          yearTo: 2023,
          skills: [{ id: skillA.id, name: skillA.name }],
        });
        createdId = created.id;
        expect(created.skills.map((s) => s.id)).toContain(skillA.id);

        // The override: send skill B with name="" — the EXACT shape the new
        // `--skill-id` / MCP `skills` surface produces (server keys on id).
        const updated = await profile.education.update(token, created.id, {
          skills: [{ id: skillB.id, name: "" }],
        });
        expect(updated.id).toBe(created.id);
        // REPLACE semantics: B is now linked, A is gone (not a merge/append).
        expect(updated.skills.map((s) => s.id)).toContain(skillB.id);
        expect(updated.skills.map((s) => s.id)).not.toContain(skillA.id);
        // The server resolved B's display name from the catalog despite name="".
        const echoedB = updated.skills.find((s) => s.id === skillB.id);
        expect(echoedB?.name).toBe(skillB.name);

        // Round-trip the change — fresh read, not just the mutation response.
        const shown = await profile.education.show(token, created.id);
        expect(shown.skills.map((s) => s.id)).toContain(skillB.id);
        expect(shown.skills.map((s) => s.id)).not.toContain(skillA.id);

        // Same T1 wire-shape snapshot as the first scenario (response shape is
        // identical regardless of which writable field drove the update).
        assertWireShapeStable({
          operationName: "UPDATE_EDUCATION",
          surface: "talent-profile",
          transport: "impersonated",
          response: updated,
        });
      } finally {
        if (createdId !== undefined) {
          await profile.education.remove(token, createdId);
        }
      }
    },
  );
});
