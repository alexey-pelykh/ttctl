// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.skills.add` after the #396 wire-shape rewrite.
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `ADD_PROFILE_SKILL_SET` is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`), the schema is gappy
 * (`AddProfileSkillSetInput { _placeholder: String }` at
 * `research/graphql/talent_profile/schema.graphql:893`), and the input
 * shape was — until #396 — pure invention with NO live capture. The live
 * API is the only authority on the `AddProfileSkillSetInput!` contract.
 *
 * **Originating bug (#396)**: pre-#396, `add(token, name)` sent the
 * invented shape `{ input: { name } }`. The server rejected with
 * `name (Field is not defined on AddProfileSkillSetInput),
 * profileId (Expected value to not be null),
 * skillSet (Expected value to not be null)`. #396 captured the real
 * wire shape (`research/captures/web/inputs/ADD_PROFILE_SKILL_SET.json`,
 * both catalog + custom variants), fixed the service to send
 * `{ input: { profileId, skillSet: { name, rating, experience, public,
 * [id] } } }`, and bumped the signature to the `{ fields, options }`
 * form (mirrors #395 employment.add / #393 basic.set).
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * `ADD_PROFILE_SKILL_SET` has no generated operation type → **T1**
 * (wire-shape snapshot). `assertWireShapeStable(...)` diffs the live
 * response shape against the committed snapshot at
 * `packages/e2e/src/wire-snapshots/ADD_PROFILE_SKILL_SET.snapshot.json`.
 *
 * Coverage:
 *   - **Round-trip custom skill** (#396 core AC): apply
 *     `add(token, { name })` with all defaults against the live API.
 *     Asserts the call no longer rejects on `name` / `profileId` /
 *     `skillSet` (a rejection mentioning any of those is precisely the
 *     #396 regression class — surfaced as a hard failure). Reads back
 *     via `list()` to assert persistence.
 *   - **Wire-shape snapshot** (T1): the `ProfileSkillSet` returned by
 *     `add` is diffed against the committed snapshot.
 *   - **Dry-run** is exercised in the core unit tests (zero-network);
 *     not repeated here.
 *
 * **Non-destructive design**: every created row is removed in `finally`
 * so the user's profile content is unchanged at end of test, even on
 * assertion failure.
 *
 * **NO USER_ERROR silent-skip anti-pattern**: a USER_ERROR from
 * `ADD_PROFILE_SKILL_SET` whose message mentions `name`, `profileId`,
 * or `skillSet` is the #396 regression class — propagated as a hard
 * failure. Other USER_ERROR variants (e.g., the test account is
 * feature-disabled for skill add) are surfaced verbatim so the failure
 * is actionable, not hidden.
 */

// e2e-covers: ADD_PROFILE_SKILL_SET

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/** Unique-ish marker so the test skill is identifiable and removable. */
const TEST_SKILL_NAME = `ttctl-e2e-skill-${Date.now().toString()}`;

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("profile skills wire-shape-fixed add() (live talent-profile, formerly INVENTED shape)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "round-trips add({ name }) against live ADD_PROFILE_SKILL_SET without rejecting on name/profileId/skillSet",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      let createdId: string | undefined;
      try {
        const outcome = await profile.skills.add(token, { name: TEST_SKILL_NAME });
        expect(outcome.kind).toBe("created");
        if (outcome.kind !== "created") throw new Error("unreachable");
        const created = outcome.result;
        createdId = created.id;

        expect(typeof created.id).toBe("string");
        expect(created.id.length).toBeGreaterThan(0);
        expect(created.skill.name).toBe(TEST_SKILL_NAME);
        // Defaults asserted on the round-tripped server state.
        expect(created.rating).toBe("COMPETENT");
        expect(created.public).toBe(false);

        // Persistence assertion — the new skill appears in list().
        const basic = await profile.basic.show(token);
        const basicShape = basic as unknown as { viewer?: { viewerRole?: { profile?: { id?: string } } } };
        const profileId = basicShape.viewer?.viewerRole?.profile?.id;
        if (profileId === undefined) {
          throw new Error("Cannot extract profileId from basic.show response — test fixture needs adjustment.");
        }
        const all = await profile.skills.list(token, profileId);
        expect(all.some((s) => s.id === created.id)).toBe(true);

        // T1 snapshot — drift in the server's response signals a
        // wire-format regression to re-engineer.
        expect(() =>
          assertWireShapeStable({
            operationName: "ADD_PROFILE_SKILL_SET",
            surface: "talent-profile",
            transport: "impersonated",
            response: created,
          }),
        ).not.toThrow();
      } catch (err) {
        if (err !== null && typeof err === "object" && "code" in err) {
          const code = (err as { code?: unknown; message?: unknown }).code;
          const msg = (err as { message?: unknown }).message;
          // A USER_ERROR / GRAPHQL_ERROR mentioning name/profileId/skillSet
          // is precisely the #396 regression class. Surface as a hard
          // failure rather than a silent skip.
          if (
            (code === "USER_ERROR" || code === "GRAPHQL_ERROR") &&
            typeof msg === "string" &&
            /\b(name|profileId|skillSet)\b/.test(msg)
          ) {
            throw new Error(`#396 REGRESSION: live add() rejected on the invented-shape error class: ${msg}`, {
              cause: err,
            });
          }
        }
        throw err;
      } finally {
        if (createdId !== undefined) {
          await profile.skills.rm(token, createdId);
        }
      }
    },
  );

  it.skipIf(!e2eEnabled)("applies explicit rating/experience/public and round-trips them", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const name = `${TEST_SKILL_NAME}-explicit`;

    let createdId: string | undefined;
    try {
      const outcome = await profile.skills.add(token, {
        name,
        rating: "EXPERT",
        experience: 5,
        public: true,
      });
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") throw new Error("unreachable");
      const created = outcome.result;
      createdId = created.id;

      expect(created.skill.name).toBe(name);
      expect(created.rating).toBe("EXPERT");
      expect(created.public).toBe(true);
    } finally {
      if (createdId !== undefined) {
        await profile.skills.rm(token, createdId);
      }
    }
  });
});
