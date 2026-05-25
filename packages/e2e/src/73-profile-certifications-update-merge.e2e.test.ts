// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E regression coverage for `profile.certifications.update`'s read-current+
 * merge fix (#605 — wire-shape contract class C with #604, #394, #407).
 * Mandatory per CLAUDE.md § Schema/contract validation rule (the fix
 * touches `packages/core/src/services/profile/certifications/**`).
 * Track 1 disposition (`UPDATE_CERTIFICATION` is in
 * `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`): wire-shape snapshot via
 * `assertWireShapeStable`.
 *
 * Coverage (sentinel-based, mirrors `46-profile-employment-update-
 * merge.e2e.test.ts`): add cert with every writable field populated →
 * update with minimal `{highlight: true}` → assert every other field
 * preserved on both the mutation response and a fresh `show()` →
 * snapshot the response shape → cleanup. No silent-skip on USER_ERROR.
 * `skills` is exercised only by default (the `[]` injection in `add()`
 * and current-row echo in `update()`) — no CLI / MCP writable surface
 * for skills is in scope per the #605 issue body.
 */

// e2e-covers: UPDATE_CERTIFICATION

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `46-profile-employment-update-merge.e2e.test.ts`.
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

describe("profile certifications update — read-current+merge regression (#605)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "update({id, highlight}) preserves the other seven writable fields under the full-replacement contract (#605)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const ts = Date.now().toString();
      const sentinelCertificate = `e2e-605-sentinel-cert-${ts}`;
      const sentinelInstitution = `e2e-605-sentinel-issuer-${ts}`;
      const sentinelLink = `https://example.test/e2e-605/${ts}`;
      const sentinelNumber = `E2E-605-${ts}`;
      const sentinelValidFromMonth = 3;
      const sentinelValidFromYear = 2022;
      const sentinelValidToMonth = 9;
      const sentinelValidToYear = 2026;

      // Source a catalog Skill id from existing employment rows — the wire
      // rejects `skills: []` on create (`is too short, minimum is 1
      // character`, same Rails `.blank?` posture as #394). Catalog Skill
      // IDs surface most reliably via existing employment row `.skills`
      // (mirrors the precedent in 46-…:134-140).
      const existingEmployment = await profile.employment.list(token);
      const employmentWithSkill = existingEmployment.find((e) => e.skills.length > 0);
      if (!employmentWithSkill) {
        throw new Error("no existing employment with skills — cannot source a catalog Skill id for the sentinel seed");
      }
      const seedSkill = employmentWithSkill.skills[0];
      if (seedSkill === undefined) throw new Error("unreachable: skills.length > 0 implies index 0 defined");

      let createdId: string | undefined;
      try {
        const created = await profile.certifications.add(token, {
          certificate: sentinelCertificate,
          institution: sentinelInstitution,
          link: sentinelLink,
          number: sentinelNumber,
          validFromMonth: sentinelValidFromMonth,
          validFromYear: sentinelValidFromYear,
          validToMonth: sentinelValidToMonth,
          validToYear: sentinelValidToYear,
          highlight: false,
          skills: [{ id: seedSkill.id, name: seedSkill.name }],
        });
        createdId = created.id;
        expect(typeof created.id).toBe("string");
        expect(created.certificate).toBe(sentinelCertificate);
        expect(created.link).toBe(sentinelLink);
        expect(created.number).toBe(sentinelNumber);

        // Core repro for the #605 bug class: minimal `{highlight: true}`
        // update — pre-fix would have nulled the other seven writable
        // fields server-side. Any error (GRAPHQL_ERROR / USER_ERROR /
        // anything) propagates as a hard test failure; no silent-skip.
        const updated = await profile.certifications.update(token, created.id, { highlight: true });
        expect(updated.id).toBe(created.id);
        expect(updated.highlight).toBe(true);

        // Load-bearing preservation assertions — pre-fix these would have nulled.
        expect(updated.certificate).toBe(sentinelCertificate);
        expect(updated.institution).toBe(sentinelInstitution);
        expect(updated.link).toBe(sentinelLink);
        expect(updated.number).toBe(sentinelNumber);
        expect(updated.validFromMonth).toBe(sentinelValidFromMonth);
        expect(updated.validFromYear).toBe(sentinelValidFromYear);
        expect(updated.validToMonth).toBe(sentinelValidToMonth);
        expect(updated.validToYear).toBe(sentinelValidToYear);
        // skills preserved through the merge (echoed from current.skills).
        expect(updated.skills.map((s) => s.id)).toContain(seedSkill.id);

        // Schema/contract rule's "round-trip the change and verify it
        // persisted" half — fresh read, not just the mutation response.
        const shown = await profile.certifications.show(token, created.id);
        expect(shown.highlight).toBe(true);
        expect(shown.certificate).toBe(sentinelCertificate);
        expect(shown.institution).toBe(sentinelInstitution);
        expect(shown.link).toBe(sentinelLink);
        expect(shown.number).toBe(sentinelNumber);
        expect(shown.validFromMonth).toBe(sentinelValidFromMonth);
        expect(shown.validFromYear).toBe(sentinelValidFromYear);
        expect(shown.validToMonth).toBe(sentinelValidToMonth);
        expect(shown.validToYear).toBe(sentinelValidToYear);

        // T1 wire-shape snapshot — typed `Certification` projection
        // (post-projection mapped shape, not raw wire). Mirrors
        // `UpdateEmployment.snapshot.json` in 46-…:215-221.
        assertWireShapeStable({
          operationName: "UPDATE_CERTIFICATION",
          surface: "talent-profile",
          transport: "impersonated",
          response: updated,
        });
      } finally {
        if (createdId !== undefined) {
          await profile.certifications.remove(token, createdId);
        }
      }
    },
  );
});
