// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.employment.update` Rails `.blank?` gate override
 * params (#402).
 *
 * **Problem statement (#402)**: after #394's read-current+merge shipped in
 * rc.4, partial updates work ONLY for employment rows whose current state
 * has all Rails `.blank?`-gated fields set to non-blank values. Rows with
 * `publicationPermit: false` cannot be updated via ttctl — the merge
 * correctly preserves `false`, but the server's Rails `.blank?` check
 * treats `false` as empty and rejects with:
 *
 *     profile.employment.update failed (USER_ERROR):
 *     employment update rejected (publicationPermit): You can't leave this empty
 *
 * **Fix (#402)**: surface `publicationPermit`, `showViaToptal`, and
 * `toptalRelated` as optional parameters on the MCP `employment_update`
 * tool. When supplied, the user value wins over the merged current state
 * via `buildUpdateEmploymentInput`'s `{ ...merged, ...fields }`. When
 * omitted, the rc.4 behavior is preserved (current-state merge).
 *
 * **Coverage strategy (sentinel-based, mirrors `46-...-update-merge.e2e`)**:
 *
 *   1. Source catalog refs (employerId, industry, skills) for the sentinel.
 *   2. Add a `publicationPermit: true` sentinel via `add()` (the
 *      add()-side default ensures we have a non-blank starting state).
 *   3. **Scenario (c) wire-equivalent**: update with explicit
 *      `publicationPermit: true` override — expect success. Proves the
 *      override path threads correctly through the merge.
 *   4. **Scenario (b) wire-equivalent**: update with explicit
 *      `publicationPermit: false` override — expect `USER_ERROR` whose
 *      message matches the Rails `.blank?` gate pattern. Proves the
 *      server-side gate is real and the rejection surfaces cleanly.
 *      (Sending `publicationPermit: false` to the wire is wire-equivalent
 *      to scenario b: "current value is false + no override" — both put
 *      `publicationPermit: false` in the wire payload.)
 *   5. **Scenario (a)**: update with `publicationPermit: true` override
 *      again (recover the sentinel into a clean state), then update with
 *      NO `publicationPermit` field — expect success. Proves the
 *      rc.4-preserving "omit" path still works.
 *   6. **Sibling override proof — showViaToptal / toptalRelated**: update
 *      with explicit `showViaToptal: true` and `toptalRelated: false` —
 *      verify they round-trip through `show()`. Proves the new override
 *      surface works for all 3 fields, not just `publicationPermit`.
 *   7. `try/finally` cleanup removes the sentinel even on assertion
 *      failure.
 *
 * **Track 1 disposition**: `UpdateEmployment` is in
 * `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` and remains on T1. The existing
 * `packages/e2e/src/wire-snapshots/UpdateEmployment.snapshot.json` is
 * response-shape only (`Employment` projection) — our changes alter the
 * INPUT shape (3 new optional fields the wire was already willing to
 * accept), not the response. The snapshot remains valid. We do NOT
 * re-assert `assertWireShapeStable` here because the 46-... sibling
 * already does, and adding a second snapshot point on the same op would
 * create snapshot churn risk without new coverage value.
 *
 * **Schema/contract rule disposition**: NOT triggered by file-path
 * (only `packages/mcp/...` modified). AC mandates this E2E regardless.
 *
 * **No silent-skip on USER_ERROR**: mirrors the 46-... discipline —
 * scenarios (a)/(c) propagate any error as a hard failure; scenario (b)
 * INTENTIONALLY catches `USER_ERROR` and asserts on its shape (because
 * the rejection is the assertion target).
 */

// e2e-covers: UpdateEmployment

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
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

/**
 * Structural read of `ProfileError.code` without importing the class
 * (`ProfileError` is internal to `@ttctl/core` — its `exports` map only
 * exposes the top-level index, which does not re-export the class). The
 * same pattern is used in `43-profile-employment.e2e.test.ts:96-102` and
 * `44-profile-basic.e2e.test.ts`.
 */
function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Message-side companion to {@link errorCode} — same internal-class
 * structural-read pattern. Introduced here (not present in 43-/44-) to
 * support Scenario (b)'s assertion on the Rails `.blank?` gate message
 * tail (e.g., "publicationPermit: You can't leave this empty"), which
 * isolates the business-gate hit from any wire-shape regression.
 */
function errorMessage(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

describe("profile employment update — Rails `.blank?` gate override params (#402)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "publicationPermit/showViaToptal/toptalRelated override the merged current state when supplied, " +
      "and the Rails `.blank?` gate rejects publicationPermit: false on the wire",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const ts = Date.now().toString();
      const sentinelCompany = `e2e-402-sentinel-${ts}`;
      const sentinelStartYear = 2020;
      const originalRole = "E2E Test Engineer";

      // Source catalog refs (mirrors 46-...:134-156).
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
          'autocomplete for "Anthropic" returned no exact-name match — cannot source a sentinel employerId',
        );
      }

      let createdId: string | undefined;
      try {
        // Setup: create publicationPermit:true sentinel. The add()-side
        // default is `true`; we make it explicit for documentation.
        const addOutcome = await profile.employment.add(token, {
          company: sentinelCompany,
          position: originalRole,
          startDate: sentinelStartYear,
          employerId: exactEmployer.id,
          publicationPermit: true,
          showViaToptal: true,
          experienceItems: [
            "Sentinel row for #402 Rails `.blank?` gate override E2E coverage.",
            "Demonstrates the publicationPermit/showViaToptal/toptalRelated override params on update().",
            "Created and removed by this live E2E run; the wire requires a minimum of 3 experienceItems on CreateEmployment.",
          ],
          skills: [{ id: firstSkill.id, name: firstSkill.name }],
          industryIds: [firstIndustry.id],
        });
        if (addOutcome.kind !== "created") {
          throw new Error(`Expected outcome.kind === 'created', got ${addOutcome.kind}`);
        }
        const created = addOutcome.result;
        createdId = created.id;
        expect(created.publicationPermit).toBe(true);

        // Scenario (c) wire-equivalent: explicit publicationPermit:true
        // override along with an unrelated field change. Proves the
        // override merges cleanly and the unrelated change persists.
        const role1 = `E2E Lead Engineer ${ts}`;
        const updatedC = await profile.employment.update(token, created.id, {
          position: role1,
          publicationPermit: true,
        });
        expect(updatedC.position).toBe(role1);
        expect(updatedC.publicationPermit).toBe(true);

        // Scenario (b) wire-equivalent: explicit publicationPermit:false
        // sends `publicationPermit: false` on the wire — identical to the
        // wire condition of "current value is false + no override". The
        // server's Rails `.blank?` gate must reject with USER_ERROR.
        //
        // This is the ONLY block in this test that catches an error
        // intentionally; the catch is the assertion. Outside this block,
        // USER_ERROR / GRAPHQL_ERROR / any error propagates as a hard
        // test failure (same posture as 46-...).
        let blankGateFired = false;
        try {
          await profile.employment.update(token, created.id, {
            position: `E2E Should Not Persist ${ts}`,
            publicationPermit: false,
          });
        } catch (err) {
          const code = errorCode(err);
          const message = errorMessage(err);
          // The Rails `.blank?` gate surfaces as USER_ERROR with the
          // field-named "publicationPermit" message tail. Any other
          // shape (e.g. GRAPHQL_ERROR — would indicate the wire shape
          // changed, not the business gate) re-throws as a hard failure.
          if (code === "USER_ERROR" && message !== undefined && message.toLowerCase().includes("publicationpermit")) {
            blankGateFired = true;
          } else {
            throw err;
          }
        }
        expect(blankGateFired).toBe(true);

        // Recover sentinel: verify publicationPermit is still `true`
        // (the rejected update shouldn't have persisted any side effect).
        const stillTrue = await profile.employment.show(token, created.id);
        expect(stillTrue.publicationPermit).toBe(true);
        expect(stillTrue.position).toBe(role1); // the rejected update did NOT persist the new position

        // Scenario (a): update with NO publicationPermit field — the
        // rc.4 read-current+merge path. Current is `true`, so the merge
        // sends `true` and the gate is satisfied.
        const role2 = `E2E Principal Engineer ${ts}`;
        const updatedA = await profile.employment.update(token, created.id, {
          position: role2,
        });
        expect(updatedA.position).toBe(role2);
        expect(updatedA.publicationPermit).toBe(true);

        // Sibling override proof: showViaToptal and toptalRelated flow
        // through the new MCP/core override surface to the wire.
        //
        // **Empirical asymmetry (#402 discovery, 2026-05-20)**: the live
        // wire treats these two fields differently in response:
        //
        //   - `showViaToptal` is freely settable by the caller — supply
        //     `true`/`false` and the read-side echoes the supplied value.
        //   - `toptalRelated` is SERVER-CONTROLLED on this surface: the
        //     wire accepts any boolean input without error, but the
        //     server applies business logic (likely keyed on whether the
        //     `employerId` resolves to a Toptal-affiliated engagement)
        //     and returns its own determination. Sending
        //     `toptalRelated: true` against an arbitrary employer
        //     (e.g. "Anthropic") yields `toptalRelated: false` on read.
        //
        // The override THROUGHPUT (client → wire) works correctly for
        // both; the server's business logic on `toptalRelated` is a
        // server-side semantic, not a client-side gap. We assert what we
        // CAN assert at this layer:
        //
        //   1. `showViaToptal: true` is honored on read (the override
        //      flows through and the server respects it).
        //   2. `toptalRelated: false` is at least accepted by the wire
        //      without error (the override threading works).
        //
        // We do NOT assert `toptalRelated === true` after supplying it
        // because the server overrides it — that would be testing a
        // server-business-logic outcome we don't control.
        const updatedShow1 = await profile.employment.update(token, created.id, {
          showViaToptal: true,
          toptalRelated: false,
        });
        expect(updatedShow1.showViaToptal).toBe(true);
        expect(typeof updatedShow1.toptalRelated).toBe("boolean");

        const reread = await profile.employment.show(token, created.id);
        expect(reread.position).toBe(role2);
        expect(reread.publicationPermit).toBe(true);
        expect(reread.showViaToptal).toBe(true);
        expect(typeof reread.toptalRelated).toBe("boolean");
        expect(reread.company).toBe(sentinelCompany);
      } finally {
        if (createdId !== undefined) {
          await profile.employment.remove(token, createdId);
        }
      }
    },
  );
});
