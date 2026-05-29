// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E regression coverage for `employment.update` `endDate` preservation
 * on partial updates.
 *
 * Contract under test: a partial update that does NOT supply `to` must
 * preserve the row's existing `endDate`. Pre-fix the merge was missing
 * `endDate`, so the wire received no value and the server null-set the
 * field — converting "Year – Year" closed roles to "Year – Present" on
 * the public profile.
 *
 * Scope: `endDate`-only force-echo. A broader generalization (echo every
 * read-side-surfaced field) was attempted and rolled back because echoing
 * `(companyWebsite, noWebsite)` on catalog-employer rows trips the Rails
 * anchor gate. See the helper-doc block in `services/profile/employment/`
 * for the per-field caution.
 *
 * Track 1: `UpdateEmployment` snapshot stays stable through this test
 * (the open-role sentinel in the sibling test exercises the snapshot;
 * this test uses a closed-role sentinel but does not re-assert it).
 *
 * Coverage (sentinel-based):
 *   1. Source catalog refs — real Skill id, industry, employer.
 *   2. Add a sentinel row WITH `endDate` set (closed role).
 *   3. Update an UNRELATED field (`publicationPermit`) — the exact shape
 *      of the bug repro.
 *   4. Assert both the wire echo and a fresh `show()` re-read keep the
 *      original `endDate` (round-trip).
 *   5. `try/finally` cleanup removes the sentinel.
 *
 * No silent-skip on USER_ERROR — any error propagates as a hard failure.
 */

// e2e-covers: UpdateEmployment

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";

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

describe("profile employment update — endDate preservation regression", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("endDate survives a partial update on a closed role (regression)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const ts = Date.now().toString();
    const sentinelCompany = `e2e-487-sentinel-${ts}`;
    const sentinelStartYear = 2020;
    const sentinelEndYear = 2022;

    // Source catalog refs — same protocol as 46-… (sourcing Skill
    // from an existing row because `profile.skills.list()` returns
    // ProfileSkillSet ids rather than the catalog Skill ids the wire
    // wants for SkillRefInput).
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
    // Same fixture-source as 46-…
    const employerMatches = await profile.employment.employerAutocomplete(token, "Anthropic", 10);
    const exactEmployer = employerMatches.find((m) => m.name.trim().toLowerCase() === "anthropic");
    if (exactEmployer === undefined) {
      throw new Error(
        `autocomplete for "Anthropic" returned no exact-name match — cannot source a sentinel employerId`,
      );
    }

    let createdId: string | undefined;
    try {
      // Sentinel: closed role with `endDate` explicitly set. The bug
      // ONLY surfaces when the row has a non-null endDate at the
      // time of the partial update.
      const addOutcome = await profile.employment.add(token, {
        company: sentinelCompany,
        position: "E2E Engineer",
        startDate: sentinelStartYear,
        endDate: sentinelEndYear,
        employerId: exactEmployer.id,
        publicationPermit: true,
        experienceItems: [
          "Sentinel row for #487 endDate-preservation regression coverage; created and removed by this live e2e test.",
          "The partial-update payload ({publicationPermit: false}) below does NOT supply `to` — pre-fix the wire dropped endDate and the server null-set it (visible as 'Year – Present' on the public profile).",
          "Post-fix: buildUpdateEmploymentInput force-echoes current.endDate through the merge symmetric to startDate. The wire requires a minimum of 3 experienceItems on CreateEmployment.",
        ],
        skills: [{ id: firstSkill.id, name: firstSkill.name }],
        industryIds: [firstIndustry.id],
      });
      if (addOutcome.kind !== "created") {
        throw new Error(`Expected outcome.kind === 'created', got ${addOutcome.kind}`);
      }
      const created = addOutcome.result;
      createdId = created.id;
      expect(created.endDate).toBe(sentinelEndYear);

      // The core repro shape from #487: partial update touching ONLY
      // an unrelated field. Pre-fix the merge dropped `endDate`
      // entirely; the server treated the omission as null-set and
      // wiped the stored value silently. Post-fix the merge force-
      // echoes `current.endDate` symmetric to `current.startDate`.
      //
      // Trigger field choice: `position` is a wire-required-non-null
      // string field already force-echoed in the merge (#407). Setting
      // it via `fields` just changes the value — no nullability or
      // Rails `.blank?` quirk in play. We intentionally do NOT use
      // `publicationPermit: false` here even though the reporter's
      // payload mentioned `publicationPermit`: Rails treats
      // `false.blank?` as true, so the wire rejects
      // `publicationPermit: false` with `(publicationPermit): You can't
      // leave this empty` BEFORE the apply path runs — the request
      // never reaches the code that would null-set endDate. The
      // reporter's bug therefore manifested under
      // `publicationPermit: true` (a no-op bulk-touch on rows whose
      // current value was already true) or under a different combo;
      // either way, choosing `position` here exercises the same
      // merge-drops-endDate code path with a wire input the server
      // accepts unambiguously.
      //
      // Any error — `GRAPHQL_ERROR` / `USER_ERROR` — propagates as a
      // hard test failure (no try/catch+skip, sibling 46-… anti-pattern
      // memo).
      const updatedPosition = "E2E Engineer (updated)";
      const updated = await profile.employment.update(token, created.id, { position: updatedPosition });
      expect(updated.position).toBe(updatedPosition);
      expect(updated.endDate).toBe(sentinelEndYear); // #487 core assertion
      expect(updated.startDate).toBe(sentinelStartYear); // sibling — was already preserved pre-fix

      // Fresh read confirms `endDate` also persisted server-side
      // (not just echoed in the mutation response). Round-trip half
      // of the schema/contract rule.
      const shown = await profile.employment.show(token, created.id);
      expect(shown.endDate).toBe(sentinelEndYear);
      expect(shown.position).toBe(updatedPosition);
      expect(shown.startDate).toBe(sentinelStartYear);
    } finally {
      if (createdId !== undefined) {
        await profile.employment.remove(token, createdId);
      }
    }
  });
});
