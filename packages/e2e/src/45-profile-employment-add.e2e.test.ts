// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.employment.add` after the #395 employerId-
 * resolution rewrite.
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `CreateEmployment` is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`), the schema is gappy
 * (`CreateEmploymentInput { _placeholder: String }`), and the input
 * shape was inferred from the captured browser curl in
 * `research/notes/10-mutation-input-patterns.md` / `research/captures/
 * web/inputs/UpdateEmploymentInput.json`. The live API is the only
 * authority on whether the autocomplete-resolved `employerId` matches
 * the server's `CreateEmploymentInput!` contract.
 *
 * **Originating bug (#395)**: pre-#395, `add({company, role, ...})`
 * passed `company` (free-text name) to the server's `CreateEmployment`
 * mutation. The server requires `employment.employerId` (catalog id,
 * not the company string) and rejected the call with
 * `USER_ERROR: employment add rejected (employerId): You can't leave
 * this empty`. The fix wires the existing `employerAutocomplete()`
 * (at `services/profile/employment/index.ts:399-415`) into `add()`
 * with disambiguation policy: 1 match = transparent use, 0 = nudge,
 * 2+ = candidate listing. An explicit `--employer-id` (CLI) /
 * `employerId` (MCP) bypasses autocomplete entirely.
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * `CreateEmployment` has no generated operation type → **T1** (wire-
 * shape snapshot). `assertWireShapeStable(...)` diffs the live response
 * shape against the committed snapshot at
 * `packages/e2e/src/wire-snapshots/CreateEmployment.snapshot.json`.
 *
 * **Cascade-of-required-fields discovery (#395 scope note)**: the live
 * capture for #395 surfaced FOUR additional required fields the
 * autocomplete fix did NOT resolve and which pre-existed independently:
 *   1. `publicationPermit: true` — server treats `false` as blank
 *      (Rails `.blank?` semantics on Boolean false).
 *   2. `experienceItems: [≥3 items, 50-250 chars each]`.
 *   3. `skills: [≥1 SkillRefInput]` — needs a catalog id reference.
 *   4. `industries: [≥1 industry catalog id]` — needs a catalog id ref.
 *
 * Per the operator-locked scope ("Out of scope: revisiting the `add()`
 * static-defaults … unless the autocomplete wiring naturally exposes
 * them as wrong. Document the choice in the PR."), this PR ships ONLY
 * the employerId-resolution fix + a `publicationPermit: true` default
 * (the static-default the autocomplete wiring most naturally exposed).
 * The remaining 3 fields (experienceItems / skills / industries) need
 * new CLI/MCP surface flags + catalog integration — tracked as a
 * follow-up issue. The e2e tests in this file therefore supply those 3
 * fields explicitly via the EmploymentFields surface so the live
 * round-trip can complete.
 *
 * Coverage:
 *   - **Round-trip with autocomplete-resolved company** (#395 core AC):
 *     apply `add({company: "Anthropic", role: ..., employerId omitted,
 *     skills + industries + experienceItems supplied})` against the
 *     live API. Asserts the autocomplete-resolution path closes the
 *     employerId gate (a `USER_ERROR` mentioning `employerId` would be
 *     a regression — surfaced as a hard failure).
 *   - **Bypass path with explicit employerId**: apply `add({company,
 *     role, employerId, ...full input})` where `employerId` is sourced
 *     from autocomplete (so the test doesn't hardcode IDs that could
 *     drift). Asserts the bypass path produces the same successful
 *     create.
 *   - **Wire-shape snapshot** (T1): the `Employment` returned by `add`
 *     is diffed against the committed snapshot.
 *
 * **Non-destructive design**: every created row is removed in `finally`
 * so the user's profile content is unchanged at end of test, even on
 * assertion failure.
 *
 * **NO USER_ERROR silent-skip anti-pattern**: unlike the original
 * `43-profile-employment.e2e.test.ts:159-165` (which #394 will fix),
 * this file does NOT skip on USER_ERROR. A USER_ERROR from
 * `CreateEmployment` with the message containing `employerId` is
 * precisely the #395 regression class — propagated as a hard failure.
 * Other USER_ERROR variants (e.g., the test account is feature-disabled
 * for employment add) are surfaced verbatim so the failure is
 * actionable, not hidden.
 */

// e2e-covers: CreateEmployment, GET_EMPLOYERS_AUTOCOMPLETE

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `44-profile-basic.e2e.test.ts` / `43-profile-employment.e2e.test.ts`.
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

describe("profile employment #395 employerId-resolved add() (live talent-profile, INFERRED wire shape)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  // -------------------------------------------------------------------
  // Round-trip — add({company: <autocomplete-resolvable>}) persists
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "round-trips add({company: 'Anthropic', ...full required input}) against live CreateEmployment without rejecting on employerId",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // Step 1: confirm the autocomplete catalog has the expected
      // employer with EXACTLY ONE exact-name match (the resolveEmployerId
      // heuristic requires this for transparent resolution). "Anthropic"
      // is empirically a 1-exact-match name on the alexey-pelykh
      // account's catalog (Toptal is 3-exact-match → would trigger
      // disambiguation).
      const matches = await profile.employment.employerAutocomplete(token, "Anthropic", 10);
      const exact = matches.filter((m) => m.name.trim().toLowerCase() === "anthropic");
      if (exact.length !== 1) {
        throw new Error(
          `Autocomplete for "Anthropic" returned ${exact.length.toString()} exact-name matches ` +
            `(expected 1 for transparent resolution). Adjust the test fixture if Anthropic was renamed or split. ` +
            `All matches: ${matches.map((m) => `${m.id} / ${m.name}`).join("; ")}`,
        );
      }

      // Phase 2b cascade fixture — source skill + industry catalog ids
      // (the wire requires both as non-empty arrays, see file header).
      const basic = await profile.basic.show(token);
      // basic.show projects { viewer.viewerRole.profile.id } at the
      // mobile-gateway shape; the `as` cast is justified by the live
      // shape captured in services/profile/basic/index.ts:305.
      const basicShape = basic as unknown as { viewer?: { viewerRole?: { profile?: { id?: string } } } };
      const profileId = basicShape.viewer?.viewerRole?.profile?.id;
      if (profileId === undefined) {
        throw new Error("Cannot extract profileId from basic.show response — test fixture needs adjustment.");
      }
      const skillsList = await profile.skills.list(token, profileId);
      const firstSkill = skillsList[0];
      if (firstSkill === undefined) {
        process.stderr.write(
          `warning: [45-profile-employment-add] account has no skills — cannot complete the live add() ` +
            `(skills is a required server-side field). Subtest skipped — not a #395 regression.\n`,
        );
        return;
      }
      const industryMatches = await profile.industries.autocomplete(token, "Software", 5);
      const firstIndustry = industryMatches[0];
      if (firstIndustry === undefined) {
        process.stderr.write(
          `warning: [45-profile-employment-add] industries autocomplete returned no matches for 'Software' — ` +
            `cannot source a catalog industry id. Subtest skipped — not a #395 regression.\n`,
        );
        return;
      }

      let createdId: string | undefined;
      try {
        const outcome = await profile.employment.add(token, {
          // employerId OMITTED — autocomplete resolution is what we're
          // proving works. The `company` string must resolve to exactly
          // one exact-name catalog entry; "Anthropic" satisfies this on
          // the maintainer's account at the time of writing.
          company: "Anthropic",
          position: "E2E Engineer (#395 autocomplete-resolved)",
          startDate: 2024,
          // The 3 fields below are required by the live wire (server
          // returns USER_ERROR otherwise) but pre-exist #395 — see file
          // header § Cascade-of-required-fields discovery.
          experienceItems: [
            "Worked on AI alignment research; built training pipelines for safe LLM development at scale.",
            "Designed infrastructure for large-scale model fine-tuning workflows and reproducibility tooling.",
            "Collaborated cross-functionally on safety evaluation, red-team analysis, and shipped artifacts.",
          ],
          skills: [{ id: firstSkill.id, name: firstSkill.name ?? "skill" }],
          industryIds: [firstIndustry.id],
        });
        expect(outcome.kind).toBe("created");
        if (outcome.kind !== "created") throw new Error("unreachable");
        const created = outcome.result;
        createdId = created.id;

        expect(typeof created.id).toBe("string");
        expect(created.id.length).toBeGreaterThan(0);
        expect(created.company).toBe("Anthropic");
        expect(created.position).toBe("E2E Engineer (#395 autocomplete-resolved)");

        // Read back via show() — persistence assertion.
        const shown = await profile.employment.show(token, created.id);
        expect(shown.id).toBe(created.id);
        expect(shown.company).toBe("Anthropic");
        // #403 AC#4(a): the explicitly-supplied industryIds persisted
        // and round-trip through the read-side `industries` projection.
        expect(shown.industries.map((i) => i.id)).toContain(firstIndustry.id);

        // T1 snapshot — capture the mapped Employment shape returned by
        // add(). Drift in the server's response signals a wire-format
        // regression to re-engineer.
        expect(() =>
          assertWireShapeStable({
            operationName: "CreateEmployment",
            surface: "talent-profile",
            transport: "impersonated",
            response: created,
          }),
        ).not.toThrow();
      } catch (err) {
        if (err !== null && typeof err === "object" && "code" in err) {
          const code = (err as { code?: unknown; message?: unknown }).code;
          const msg = (err as { message?: unknown }).message;
          // A USER_ERROR mentioning `employerId` is precisely the #395
          // regression class. Surface as a hard failure.
          if (code === "USER_ERROR" && typeof msg === "string" && /employerId/i.test(msg)) {
            throw new Error(
              `#395 REGRESSION: live add() rejected with employerId error after autocomplete resolution: ${msg}`,
              { cause: err },
            );
          }
        }
        throw err;
      } finally {
        if (createdId !== undefined) {
          await profile.employment.remove(token, createdId);
        }
      }
    },
  );

  // -------------------------------------------------------------------
  // Bypass path — explicit employerId skips autocomplete
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "bypass: add({company, role, employerId, ...full input}) skips autocomplete and uses the explicit id verbatim",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // Source a known-good employerId via autocomplete (so the test
      // doesn't hardcode IDs that could drift). "Toptal" — even
      // ambiguous on resolution — gives us a known catalog id that we
      // can pass as a verbatim bypass. The bypass path explicitly
      // skips autocomplete-disambiguation logic.
      const matches = await profile.employment.employerAutocomplete(token, "Toptal", 10);
      const toptal = matches.find((m) => m.name === "Toptal");
      if (toptal === undefined) {
        throw new Error(
          `Autocomplete for "Toptal" returned no exact match — cannot source a bypass employerId. ` +
            `See sibling round-trip test for context.`,
        );
      }

      // Same cascade fixture as the sibling autocomplete-path test.
      const basic = await profile.basic.show(token);
      const basicShape = basic as unknown as { viewer?: { viewerRole?: { profile?: { id?: string } } } };
      const profileId = basicShape.viewer?.viewerRole?.profile?.id;
      if (profileId === undefined) {
        process.stderr.write(`warning: [45-profile-employment-add] no profileId — bypass subtest skipped\n`);
        return;
      }
      const skillsList = await profile.skills.list(token, profileId);
      const firstSkill = skillsList[0];
      const industryMatches = await profile.industries.autocomplete(token, "Software", 5);
      const firstIndustry = industryMatches[0];
      if (firstSkill === undefined || firstIndustry === undefined) {
        process.stderr.write(`warning: [45-profile-employment-add] no skills/industries — bypass subtest skipped\n`);
        return;
      }

      let createdId: string | undefined;
      try {
        const outcome = await profile.employment.add(token, {
          // Pass a deliberately non-matching company string to prove
          // that the autocomplete path is NOT consulted when employerId
          // is supplied. Server stores `company` verbatim but uses
          // `employerId` as the canonical employer reference.
          company: "Toptal (bypass-test display name)",
          position: "E2E Engineer (employerId bypass)",
          startDate: 2024,
          employerId: toptal.id,
          experienceItems: [
            "Bypass-path test: proves --employer-id parameter routes around autocomplete entirely.",
            "Server stores employment row keyed by the supplied employerId (not autocomplete-resolved).",
            "Bypass round-trip demonstrates the bypass path produces identical wire-success vs the autocomplete path.",
          ],
          skills: [{ id: firstSkill.id, name: firstSkill.name ?? "skill" }],
          industryIds: [firstIndustry.id],
        });
        expect(outcome.kind).toBe("created");
        if (outcome.kind !== "created") throw new Error("unreachable");
        const created = outcome.result;
        createdId = created.id;

        expect(typeof created.id).toBe("string");
        // The display name we sent should be on the row. The actual
        // employer-record identity is governed by employerId — which we
        // can't read back through the Employment fragment (the read
        // doesn't echo employerId per #340 read-write asymmetry
        // documented in research/notes/10-mutation-input-patterns.md).
        // The proof that the bypass worked is non-USER_ERROR success:
        // a missing employerId would have triggered the pre-#395 error.
      } finally {
        if (createdId !== undefined) {
          await profile.employment.remove(token, createdId);
        }
      }
    },
  );
});
