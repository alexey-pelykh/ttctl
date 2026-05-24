// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E regression coverage for #487 (wire-broke) — `employment_update`
 * silently nulled `endDate` on partial updates that did not supply `to`.
 *
 * The reporter's empirical evidence: a batch of MCP
 * `ttctl_profile_employment_update` calls that touched only `industryIds`
 * + `publicationPermit` (no `to`) wiped the stored `endDate` on every
 * row that had one — converting "Year – Year" to "Year – Present" on
 * the public profile. The bug was structurally confirmed in
 * `buildUpdateEmploymentInput`: `endDate` was missing from the merge
 * object entirely, so the spread `{ ...merged, ...fields }` carried
 * `endDate` to the wire only when the caller supplied it; absence on
 * the wire meant the server null-set the field. Asymmetric with
 * `startDate` which has always been force-echoed.
 *
 * Fix scope: endDate-only force-echo. A broader generalization (echo
 * every read-side-surfaced field — `companyWebsite`, `noWebsite`,
 * `highlight`, `toptalRelated` joining the merge alongside endDate)
 * was attempted mid-PR and rolled back: echoing
 * `(companyWebsite, noWebsite)` on catalog-employer rows trips the
 * Rails anchor gate `(employerId): You should specify either employer
 * or company website` (same class as the #484 CREATE-side anchor
 * contract). `(highlight, toptalRelated)` were rolled back at the
 * same time, pending per-field live verification. The endDate-only
 * scope is the empirically-safe class on this surface; see the
 * helper-doc `Per-field caution on the broader force-echo class`
 * block in `packages/core/src/services/profile/employment/index.ts`
 * for the full attempt-and-rollback narrative.
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * fix touches `packages/core/src/services/profile/employment/index.ts`,
 * which is a file-path trigger of the rule's code-review checklist.
 * The PR body declares `Schema/contract rule: triggered` and points
 * at this file as the live transcript.
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track
 * 2): `UpdateEmployment` is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`
 * and has no generated operation type → **T1** (wire-shape snapshot,
 * already at `packages/e2e/src/wire-snapshots/UpdateEmployment.snapshot.json`).
 * The UpdateEmployment snapshot stays stable through this PR — the
 * snapshot is asserted by `46-…` whose sentinel is an open role
 * (`endDate: null`); this test's sentinel carries a non-null endDate
 * but does NOT call `assertWireShapeStable`. No snapshot refresh is
 * required by #487.
 *
 * Coverage strategy (sentinel-based; mirrors the `46-…` try/finally
 * pattern):
 *
 *   1. **Source catalog refs** — real Skill id (sourced from an
 *      existing employment row), industry via autocomplete, employer
 *      via autocomplete (same protocol as 46-…).
 *   2. **Add a sentinel row WITH `endDate` set** (closed role: start
 *      2020, end 2022). The bug ONLY surfaces when the row has a non-
 *      null endDate at the time of the partial update.
 *   3. **Update an UNRELATED field** (`publicationPermit`) — the exact
 *      shape of the reporter's batch repro. No `to` / `current` flag
 *      in the input; if the merge regresses, the wire response shows
 *      `endDate: null` instead of `endDate: 2022`.
 *   4. **Assert `updated.endDate === 2022`** (the wire echo) AND
 *      `shown.endDate === 2022` via fresh `show()` (round-trip half of
 *      the schema/contract rule). Pre-fix BOTH assertions fail
 *      because the server null-set the field.
 *   5. **`try / finally` cleanup** removes the sentinel even on
 *      mid-assertion failure.
 *
 * **No silent-skip on USER_ERROR** — sibling-file pattern (see
 * `46-…` header). Any error from `update()` (including `USER_ERROR`)
 * propagates as a hard test failure; the regression class stays
 * loudly observable.
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

describe("profile employment update — endDate preservation regression (#487)", () => {
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
