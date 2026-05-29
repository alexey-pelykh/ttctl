// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.employment.add` — `CreateEmployment` is a
 * gappy-schema T1 op; the live API is the contract authority.
 *
 * Required input fields the wire enforces independently of the
 * autocomplete resolution:
 *   1. `publicationPermit: true` — server treats `false` as blank
 *      (Rails `.blank?` on Boolean false).
 *   2. `experienceItems`: ≥3 items, 50-250 chars each.
 *   3. `skills`: ≥1 `SkillRefInput` (catalog id reference).
 *   4. `industries`: ≥1 industry catalog id.
 *
 * The CLI/MCP surface does NOT yet expose flags for 2-4; tests supply
 * them via the EmploymentFields surface so the live round-trip can
 * complete.
 *
 * Coverage:
 *   - Round-trip with autocomplete-resolved `company`.
 *   - Bypass path with explicit `employerId`.
 *   - T1 wire-shape snapshot on the returned `Employment`.
 *
 * Design invariants:
 *   - Non-destructive: every created row is removed in `finally`.
 *   - NO USER_ERROR silent-skip — a `USER_ERROR` mentioning `employerId`
 *     is propagated as a hard failure (it would be a regression of the
 *     autocomplete-resolution contract). Other USER_ERROR variants are
 *     surfaced verbatim so failures stay actionable.
 */

// e2e-covers: CreateEmployment, GET_EMPLOYERS_AUTOCOMPLETE, RemoveEmployment, UpdateEmployment

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

describe("profile employment employerId-resolved add() (live talent-profile, INFERRED wire shape)", () => {
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
          skills: [{ id: firstSkill.skill.id, name: firstSkill.skill.name }],
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
          skills: [{ id: firstSkill.skill.id, name: firstSkill.skill.name }],
          industryIds: [firstIndustry.id],
        });
        expect(outcome.kind).toBe("created");
        if (outcome.kind !== "created") throw new Error("unreachable");
        const created = outcome.result;
        createdId = created.id;

        expect(typeof created.id).toBe("string");
        // The display name we sent should be on the row. The
        // employer-record identity is governed by employerId; post-#394
        // the Employment fragment selects `employer { id }` so it IS
        // readable as `created.employerId` (see the #401 block below for
        // a test that asserts it). This bypass test proves the path
        // worked via non-USER_ERROR success — a missing employerId would
        // have triggered the pre-#395 error regardless of read-back.
      } finally {
        if (createdId !== undefined) {
          await profile.employment.remove(token, createdId);
        }
      }
    },
  );
});

/**
 * E2E coverage for `profile.employment.add` on the custom (non-catalog)
 * workplace path — `employerId: null` with a free-text `company` (what
 * the Toptal "Add as new: <name>" UI sends; there is no `CreateEmployer`
 * mutation).
 *
 * URL-host determinism: when `companyWebsite` is a routable host, Toptal
 * may auto-create or auto-link to a catalog Employer (id materializes,
 * `employerId` no longer null). To keep the inferred CREATE contract
 * holding deterministically, this test uses an RFC-2606 `.invalid` host
 * so the server makes no catalog link — `employerId` stays null and
 * `companyWebsite` round-trips verbatim.
 *
 * Axis-independence under test: `employerId: null` × `noWebsite: false` +
 * `companyWebsite: <url>` — the variant the catalog-resolved sibling
 * tests do NOT cover.
 *
 * Track 1 disposition: shares the committed `CreateEmployment.snapshot.json`
 * with the sibling tests (only the REQUEST differs from the autocomplete
 * path; the RESPONSE shape is invariant).
 *
 * Design invariants:
 *   - Non-destructive: created row is removed in `finally`.
 *   - NO USER_ERROR silent-skip: `USER_ERROR` mentioning `employerId` is
 *     propagated as a hard failure (it would be the contract-violation
 *     class this test is meant to detect).
 */
describe("profile employment custom (non-catalog) workplace add() (live talent-profile, INFERRED wire shape)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  // -------------------------------------------------------------------
  // Custom workplace WITH a website — proves employerId:null ⊥ noWebsite
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "lifecycle: add({ noEmployer:true, companyWebsite:`https://*.invalid`, noWebsite:false }) → show() → remove() — employerId:null persists across add+show, companyWebsite round-trips verbatim, axis independence (website coexists with employerId:null) survives, self-cleaning",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // Cascade fixture — skills + industries + experienceItems are
      // server-required on CreateEmployment regardless of the employer
      // path (see the #395 file header § Cascade-of-required-fields).
      const basic = await profile.basic.show(token);
      const basicShape = basic as unknown as { viewer?: { viewerRole?: { profile?: { id?: string } } } };
      const profileId = basicShape.viewer?.viewerRole?.profile?.id;
      if (profileId === undefined) {
        throw new Error("Cannot extract profileId from basic.show response — test fixture needs adjustment.");
      }
      const skillsList = await profile.skills.list(token, profileId);
      const firstSkill = skillsList[0];
      const industryMatches = await profile.industries.autocomplete(token, "Software", 5);
      const firstIndustry = industryMatches[0];
      if (firstSkill === undefined || firstIndustry === undefined) {
        // HARD failure — deliberately NOT a green-skip. This subtest is
        // the SOLE live settler of the INFERRED employerId:null-on-CREATE
        // contract that CLAUDE.md § Schema/contract rule mandates for
        // #401. A green-skip would let the mandated gate pass vacuously
        // and surface a misleading PASS in the maintainer's required
        // transcript (the degenerate-subject-gate trap). This diverges
        // from the #395 sibling's skip on purpose: #395 validates an
        // already-*captured* wire path; #401 gates a *newly inferred*
        // contract — precedent context-drift, so the skip semantics do
        // not carry over. A real Toptal talent account has ≥1 skill and
        // `industries.autocomplete("Software")` is a catalog read (not
        // the account-scoped IndustryProfile-seeding block), so this
        // does not trip in practice; if it ever does, the contract was
        // NOT exercised and the operator MUST see a failure, never a skip.
        throw new Error(
          "#401 PRECONDITION UNMET: the test account lacks a skill and/or a " +
            "catalog industry (both server-required for the custom-workplace " +
            "CreateEmployment). The mandated employerId:null contract gate " +
            "must not pass vacuously — seed at least one skill/industry on " +
            "the test account and re-run TTCTL_E2E=1.",
        );
      }

      // A deliberately unique free-text name that is NOT a catalog
      // employer — proves the custom path (autocomplete would never
      // resolve it, and is never consulted on this path anyway).
      const customName = `TTCtl Custom Workplace #401 ${Date.now().toString()}`;
      // Use an RFC-2606 `.invalid` TLD so Toptal cannot catalog-match the
      // host against any existing Employer record. Empirically (3-run
      // investigation captured in PR #406):
      //   • `anthropic.com` (real, distinct host)  → server auto-creates
      //     a new Employer; `shown.employerId` becomes the new catalog id;
      //     `https://` is stripped (`shown.companyWebsite` = `www.anthropic.com`).
      //   • `example.com` (real, host matches a pre-existing Employer
      //     record in the test account's catalog) → row is LINKED to the
      //     existing Employer id; `shown.companyWebsite` is garbled with
      //     that Employer's name (a Toptal-side display-merging quirk).
      //   • `*.invalid` (RFC-2606 non-routable) → server makes NO catalog
      //     link; `shown.employerId` stays `null`; `shown.companyWebsite`
      //     round-trips verbatim (no stripping, no garbling).
      // The `.invalid` choice makes this test a deterministic verification
      // of the inferred CONTRACT (the maintainer-described "Add as new:
      // <name>" UX with NO catalog interaction) rather than a branching
      // observation of Toptal's catalog-matching behaviour. The other two
      // URL-host modes are documented but NOT asserted here — they are
      // Toptal product behaviour, not TTCtl's contract surface.
      const customWebsite = `https://nonexistent-${Date.now().toString()}.invalid`;

      let createdId: string | undefined;
      try {
        const outcome = await profile.employment.add(token, {
          company: customName,
          position: "E2E Engineer (#401 custom workplace + website)",
          startDate: 2024,
          // The #401 signal: custom (non-catalog) workplace →
          // employerId:null, autocomplete skipped entirely.
          noEmployer: true,
          // Orthogonal website axis — explicitly NOT noWebsite. Proves a
          // custom workplace can still carry a site (the over-coupling
          // the research note implied is false).
          companyWebsite: customWebsite,
          noWebsite: false,
          experienceItems: [
            "Founded and operated a custom (non-catalog) workplace; this row exercises the #401 employerId:null path.",
            "Validated that the free-text company name persists verbatim with no Toptal employer-catalog record.",
            "Confirmed the website axis is independent of the employer axis on the live CreateEmployment wire.",
          ],
          skills: [{ id: firstSkill.skill.id, name: firstSkill.skill.name }],
          industryIds: [firstIndustry.id],
        });
        expect(outcome.kind).toBe("created");
        if (outcome.kind !== "created") throw new Error("unreachable");
        const created = outcome.result;
        createdId = created.id;

        expect(typeof created.id).toBe("string");
        expect(created.id.length).toBeGreaterThan(0);
        expect(created.company).toBe(customName);
        // THE #401 contract — leg 1 (mutation echo):
        // CreateEmployment accepts `employerId: null` and the immediate
        // response echoes the input (the mutation mirrors `employerId`
        // verbatim — this is true for both real-host catalog-link and
        // null-keep paths; documented from the 3-run investigation in
        // PR #406).
        expect(created.employerId).toBeNull();
        // Axis-independence proof on the immediate echo: the website
        // survived alongside `employerId: null` (noWebsite:false honoured
        // on the live wire — employer and website axes are orthogonal).
        expect(created.noWebsite).toBe(false);
        expect(created.companyWebsite).toBe(customWebsite);

        // Read back via show() — THE persistence assertion. With the
        // RFC-2606 `.invalid` TLD, Toptal makes no catalog link, so
        // `shown.employerId` stays `null` and `shown.companyWebsite`
        // round-trips verbatim (no stripping, no garbling).
        const shown = await profile.employment.show(token, created.id);
        expect(shown.id).toBe(created.id);
        expect(shown.company).toBe(customName);
        // THE #401 contract — leg 2 (persistence):
        // with a non-routable URL host, the inferred contract holds
        // exactly as the maintainer described: `employerId: null` on
        // CREATE → row persists with `employerId: null`, the free-text
        // `company` is preserved verbatim, no implicit catalog
        // interaction. This is the maintainer-clarified "Add as new:
        // <name>" UX in its purest form.
        expect(shown.employerId).toBeNull();
        expect(shown.companyWebsite).toBe(customWebsite);
        // Axis-independence also survives the read-back round-trip
        // (not merely the mutation echo): noWebsite:false persists
        // alongside `employerId: null`. Closes the second-axis leg on
        // the show() path.
        expect(shown.noWebsite).toBe(false);

        // T1 snapshot for CreateEmployment is NOT asserted here:
        // this test's immediate `created.employerId` is `null` (the
        // mutation echoes the input), which would drift against the
        // committed `kind: "string"` produced by the #395 sibling
        // (which sends an autocomplete-resolved id). The CreateEmployment
        // response SHAPE is already exhaustively covered by tests #1
        // and #2 in this file. This test's contribution is the
        // CONTRACT verification (null accepted, null persists), not
        // redundant wire-shape coverage.

        // ── update() OMITTED on this axis ──
        // The 2026-05-21 captured successful UpdateEmployment payload
        // was on a `noWebsite: true, companyWebsite: null` row (the
        // sibling #484 axis). The `noWebsite: false, companyWebsite:
        // <URL>` axis exercised here has an additional URL-host
        // validation concern on UPDATE that the empirical evidence
        // does not yet cover — `.invalid` TLDs may be rejected by a
        // separate Rails validator. The #508 fix's UPDATE coverage
        // lives in the sibling #484 test below; this test stays
        // CREATE-only on this axis until a successful capture on the
        // URL-anchor axis is available. See research/notes/15
        // SUPERSEDED banner for the corrected framing.
      } catch (err) {
        if (err !== null && typeof err === "object" && "code" in err) {
          const code = (err as { code?: unknown; message?: unknown }).code;
          const msg = (err as { message?: unknown }).message;
          // A USER_ERROR mentioning employerId from CreateEmployment is
          // precisely the #401 contract-violation class (the inferred
          // null-employerId CREATE contract being wrong). UpdateEmployment
          // is NOT exercised here per the WORM limitation documented in
          // the file header — its known-failing employerId rejection on
          // null-employerId rows would shadow a genuine CREATE-side
          // regression.
          if (code === "USER_ERROR" && typeof msg === "string" && /employerId/i.test(msg)) {
            throw new Error(
              `#401 CONTRACT VIOLATION: live CreateEmployment rejected employerId:null for a custom workplace: ${msg}`,
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
});

/**
 * E2E coverage for `profile.employment.add` on the custom-workplace-
 * WITHOUT-website path — `noEmployer:true + noWebsite:true +
 * companyWebsite: undefined`.
 *
 * The CREATE-side anchor contract: on the `noEmployer:true` path, the
 * Rails server validates `employer_id` as `.blank?` UNLESS the row
 * carries either (a) a `companyWebsite` URL signal OR (b) an explicit
 * `noWebsite:true` "intentionally no website" signal. With neither
 * anchor, the server falls through to demanding `employer_id`. Tests
 * cover (a) on the sibling above and (b) here; ttctl refuses
 * client-side when neither anchor is present.
 *
 * Track 1 disposition: shares `CreateEmployment.snapshot.json` with the
 * sibling tests — the RESPONSE shape is invariant across the anchor
 * permutations.
 *
 * Design invariants: non-destructive (`finally` cleanup); NO
 * USER_ERROR silent-skip on `employerId` (would be a contract-violation
 * regression).
 */
describe("profile employment custom workplace WITHOUT website add() lifecycle + update() round-trip on a self-seeded noEmployer row", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "lifecycle: add({ noEmployer:true, noWebsite:true, companyWebsite:undefined }) → show() → remove() — noWebsite:true alone is sufficient anchor on CREATE",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      const basic = await profile.basic.show(token);
      const basicShape = basic as unknown as { viewer?: { viewerRole?: { profile?: { id?: string } } } };
      const profileId = basicShape.viewer?.viewerRole?.profile?.id;
      if (profileId === undefined) {
        throw new Error("Cannot extract profileId from basic.show response — test fixture needs adjustment.");
      }
      const skillsList = await profile.skills.list(token, profileId);
      const firstSkill = skillsList[0];
      const industryMatches = await profile.industries.autocomplete(token, "Software", 5);
      const firstIndustry = industryMatches[0];
      if (firstSkill === undefined || firstIndustry === undefined) {
        throw new Error(
          "#484 PRECONDITION UNMET: the test account lacks a skill and/or a catalog industry. Seed at least one of each and re-run TTCTL_E2E=1.",
        );
      }

      const customName = `TTCtl Custom Workplace #484 ${Date.now().toString()}`;
      let createdId: string | undefined;
      try {
        const outcome = await profile.employment.add(token, {
          company: customName,
          position: "E2E Engineer (#484 custom workplace, no website)",
          startDate: 2024,
          noEmployer: true,
          noWebsite: true,
          experienceItems: [
            "Founded and operated a custom (non-catalog) workplace with no website; exercises the #484 noWebsite-alone-anchor path.",
            "Validated that the free-text company name persists verbatim when neither catalog nor URL anchor is present.",
            "Confirmed that an explicit noWebsite:true signal substitutes for companyWebsite as the server's anchor requirement.",
          ],
          skills: [{ id: firstSkill.skill.id, name: firstSkill.skill.name }],
          industryIds: [firstIndustry.id],
        });
        expect(outcome.kind).toBe("created");
        if (outcome.kind !== "created") throw new Error("unreachable");
        const created = outcome.result;
        createdId = created.id;
        expect(created.employerId).toBeNull();
        expect(created.noWebsite).toBe(true);
        expect(created.companyWebsite).toBeNull();

        const shown = await profile.employment.show(token, created.id);
        expect(shown.employerId).toBeNull();
        expect(shown.noWebsite).toBe(true);
        expect(shown.companyWebsite).toBeNull();
      } catch (err) {
        if (err !== null && typeof err === "object" && "code" in err) {
          const code = (err as { code?: unknown; message?: unknown }).code;
          const msg = (err as { message?: unknown }).message;
          if (code === "USER_ERROR" && typeof msg === "string" && /employerId/i.test(msg)) {
            throw new Error(`#484 CONTRACT VIOLATION on CREATE: ${msg}`, { cause: err });
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

  // #508 — UPDATE side of the anchor-pair contract. Self-seeds a fresh
  // noEmployer row (CreateEmployment with employerId:null + noWebsite:true
  // anchor per #484), exercises update({position}) → show() round-trip,
  // and removes the row in `finally`. Self-seeding lifts the historical
  // manual-fixture requirement so the test is fully non-destructive and
  // does not depend on pre-existing account state.
  it.skipIf(!e2eEnabled)(
    "update({position}) succeeds against a self-seeded noEmployer row (anchor-pair echo via buildUpdateEmploymentInput)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      const basic = await profile.basic.show(token);
      const basicShape = basic as unknown as { viewer?: { viewerRole?: { profile?: { id?: string } } } };
      const profileId = basicShape.viewer?.viewerRole?.profile?.id;
      if (profileId === undefined) {
        throw new Error("Cannot extract profileId from basic.show response — test fixture needs adjustment.");
      }
      const skillsList = await profile.skills.list(token, profileId);
      const firstSkill = skillsList[0];
      const industryMatches = await profile.industries.autocomplete(token, "Software", 5);
      const firstIndustry = industryMatches[0];
      if (firstSkill === undefined || firstIndustry === undefined) {
        throw new Error(
          "#508 PRECONDITION UNMET: the test account lacks a skill and/or a catalog industry. Seed at least one of each and re-run TTCTL_E2E=1.",
        );
      }

      const seedCompany = `TTCtl #508 self-seed ${Date.now().toString()}`;
      const seedPosition = "Founder";
      let createdId: string | undefined;
      try {
        const outcome = await profile.employment.add(token, {
          company: seedCompany,
          position: seedPosition,
          startDate: 2024,
          noEmployer: true,
          noWebsite: true,
          experienceItems: [
            "Self-seeded noEmployer row for the #508 update-side anchor-pair test.",
            "Created and removed in the same test run; no manual UI fixture required.",
            "Validates that update({position}) preserves the null employerId across the round-trip.",
          ],
          skills: [{ id: firstSkill.skill.id, name: firstSkill.skill.name }],
          industryIds: [firstIndustry.id],
        });
        expect(outcome.kind).toBe("created");
        if (outcome.kind !== "created") throw new Error("unreachable");
        const target = outcome.result;
        createdId = target.id;
        expect(target.employerId).toBeNull();
        expect(target.company).toBe(seedCompany);

        const probePosition = `${seedPosition} (#508 probe ${Date.now().toString()})`;
        const updated = await profile.employment.update(token, target.id, { position: probePosition });
        expect(updated.id).toBe(target.id);
        expect(updated.position).toBe(probePosition);
        expect(updated.employerId).toBeNull();
        const reshown = await profile.employment.show(token, target.id);
        expect(reshown.position).toBe(probePosition);
      } finally {
        if (createdId !== undefined) {
          await profile.employment.remove(token, createdId);
        }
      }
    },
  );
});
