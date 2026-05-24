// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E live-wire coverage for #586 — exposing `primaryGeographyId` as a
 * write field on `employment_add` / `employment_update` (MCP + CLI).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule.** The change
 * surfaces a field that was INFERRED on `EmploymentInput`
 * (`research/captures/web/inputs/UpdateEmploymentInput.json` lists
 * `primaryGeographyId: ID` under `inferred_inputs` but the captured payload
 * never set it) and had NEVER been live-exercised: the maintainer's test
 * account carries `primaryGeography: null` on every row, so the
 * read-current+merge echo branch in `buildUpdateEmploymentInput`
 * (`if (current.primaryGeography !== null) …`) was dead code in practice.
 * Consuming an INFERRED input field => live round-trip required before the
 * change merges. The PR body declares `Schema/contract rule: triggered` and
 * points at this file as the transcript.
 *
 * **Open prerequisite resolved (the issue was filed "NOT
 * implementation-ready"):** a live probe (2026-05-24) confirmed the wire
 * ACCEPTS and PERSISTS `primaryGeographyId` on BOTH the create and update
 * paths — it is a clean wrapper-only change (same class as #541), not a
 * Toptal server-side limitation.
 *
 * **Geography id source.** There is no `geographiesAutocomplete` on any
 * surface; the only ttctl-reachable geography catalog is the top-level
 * `getCountries` query (`countries { id code name }`, talent_profile
 * surface). Ids are base64 `V1-Country-<n>` (e.g. United States =
 * `VjEtQ291bnRyeS0yMzQ`). This test sources a real id inline via
 * `impersonatedTransport` (the same primitive `callTalentProfile` wraps);
 * shipping a user-facing discovery command is deferred to #596.
 *
 * **No `assertWireShapeStable` here (deliberate).** `CreateEmployment` /
 * `UpdateEmployment` are T1 ops whose committed snapshots
 * (`wire-snapshots/{Create,Update}Employment.snapshot.json`, owned by tests
 * 45/46) record `primaryGeography: { kind: "null" }` — the test account's
 * common case. Setting a geography makes the projection an OBJECT; asserting
 * it against the null-case snapshot would register as `~` drift. This file's
 * schema/contract obligation is the round-trip persistence assertion below;
 * ongoing T1 drift detection for these ops stays owned by 45/46.
 *
 * Coverage strategy (sentinel add/remove, mirrors 46-…e2e):
 *   1. Source a real geography id (and a second distinct one) via getCountries.
 *   2. Source the cascade catalog refs add() requires (skill / industry / employer).
 *   3. CREATE a row WITH primaryGeographyId → assert response + show() round-trip.
 *   4. CREATE a plain sentinel (geo null) → UPDATE it with primaryGeographyId →
 *      assert response + show() round-trip.
 *   5. RE-ASSIGN to a second geography → assert it changed (settable, not one-shot).
 *   6. Partial update OMITTING geography → assert the merge PRESERVES it (this is
 *      the first live exercise of the previously-dead non-null echo branch).
 *   7. try/finally removes both sentinels even on mid-assertion failure.
 *
 * No silent-skip on USER_ERROR — any error from add()/update() propagates as
 * a hard failure (the anti-pattern called out in #392's memo).
 */

// e2e-covers: CreateEmployment, UpdateEmployment

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, impersonatedTransport, profile } from "@ttctl/core";
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

interface CountryRow {
  id: string;
  code: string | null;
  name: string | null;
}

/**
 * Fetch the geography catalog via the inline `getCountries` query (no
 * shipped ttctl command — discovery is deferred to #596). Uses the same
 * `impersonatedTransport` primitive `callTalentProfile` wraps internally.
 */
async function fetchCountries(token: string): Promise<CountryRow[]> {
  const res = await impersonatedTransport({
    surface: "talent-profile",
    authToken: token,
    body: {
      operationName: "getCountries",
      query: "query getCountries { countries { id code name } }",
      variables: {},
    },
  });
  const body = res.body as { data?: { countries?: CountryRow[] } } | null;
  return body?.data?.countries ?? [];
}

describe("profile employment primaryGeography write (#586)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "CreateEmployment and UpdateEmployment accept + persist primaryGeographyId (round-trip via show())",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // 1) Source two distinct real geography ids from the countries catalog.
      const countries = await fetchCountries(token);
      expect(countries.length).toBeGreaterThan(1);
      const geo = countries.find((c) => c.code === "US") ?? countries[0];
      if (geo === undefined) throw new Error("getCountries returned no usable country");
      expect(typeof geo.id).toBe("string");
      const geo2 = countries.find((c) => c.id !== geo.id && c.code === "CA") ?? countries.find((c) => c.id !== geo.id);
      if (geo2 === undefined) throw new Error("getCountries returned fewer than 2 distinct countries");

      // 2) Source the cascade catalog refs add() requires (mirror 46-…e2e):
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
          "Sentinel row for issue 586 primaryGeography write coverage; created and removed by this live e2e test run.",
          "Verifies CreateEmployment and UpdateEmployment accept and persist a primaryGeographyId sourced from getCountries.",
          "Also proves read-current merge preserves a non-null geography when a later partial update omits the field entirely.",
        ],
        skills: [{ id: firstSkill.id, name: firstSkill.name }],
        industryIds: [firstIndustry.id],
      };

      let createId: string | undefined;
      let updateId: string | undefined;
      try {
        // 3) CREATE path — a row created WITH primaryGeographyId persists it.
        const addGeo = await profile.employment.add(token, {
          company: `e2e-586-create-${ts}`,
          position: "Geo Create Engineer",
          ...seed,
          primaryGeographyId: geo.id,
        });
        if (addGeo.kind !== "created") throw new Error(`Expected outcome.kind === 'created', got ${addGeo.kind}`);
        createId = addGeo.result.id;
        // Positive shape check on the mutation response.
        expect(addGeo.result.primaryGeography).not.toBeNull();
        expect(addGeo.result.primaryGeography?.id).toBe(geo.id);
        // Round-trip: fresh read confirms persistence (schema/contract rule).
        const shownCreate = await profile.employment.show(token, createId);
        expect(shownCreate.primaryGeography?.id).toBe(geo.id);

        // 4) UPDATE path — a plain sentinel (geo null) gains a geography.
        const addPlain = await profile.employment.add(token, {
          company: `e2e-586-update-${ts}`,
          position: "Geo Update Engineer",
          ...seed,
        });
        if (addPlain.kind !== "created") throw new Error(`Expected outcome.kind === 'created', got ${addPlain.kind}`);
        updateId = addPlain.result.id;
        expect(addPlain.result.primaryGeography).toBeNull(); // starts unset

        const updated = await profile.employment.update(token, updateId, { primaryGeographyId: geo.id });
        expect(updated.primaryGeography?.id).toBe(geo.id);
        const shownUpdate = await profile.employment.show(token, updateId);
        expect(shownUpdate.primaryGeography?.id).toBe(geo.id);

        // 5) RE-ASSIGN to a second geography — proves it is a settable field,
        //    not a write-once latch.
        const reassigned = await profile.employment.update(token, updateId, { primaryGeographyId: geo2.id });
        expect(reassigned.primaryGeography?.id).toBe(geo2.id);
        const shownReassign = await profile.employment.show(token, updateId);
        expect(shownReassign.primaryGeography?.id).toBe(geo2.id);

        // 6) PARTIAL update OMITTING geography — the read-current+merge must
        //    PRESERVE it. This is the first live exercise of the previously
        //    dead non-null `current.primaryGeography` echo branch.
        const preserved = await profile.employment.update(token, updateId, { position: "Geo Update Engineer II" });
        expect(preserved.position).toBe("Geo Update Engineer II");
        expect(preserved.primaryGeography?.id).toBe(geo2.id);
        const shownPreserved = await profile.employment.show(token, updateId);
        expect(shownPreserved.primaryGeography?.id).toBe(geo2.id);
      } finally {
        if (createId !== undefined) {
          await profile.employment.remove(token, createId);
        }
        if (updateId !== undefined) {
          await profile.employment.remove(token, updateId);
        }
      }
    },
  );
});
