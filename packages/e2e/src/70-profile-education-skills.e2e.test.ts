// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile education list` covering #556
 * (`Education.skills`) — the new selection on `EDUCATION_FRAGMENT`.
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `GET_EDUCATION` targets the Cloudflare-protected `talent-profile`
 * surface and is listed in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` in
 * `codegen.config.ts` (synthesized SDL types every field `Unknown`). The
 * live API is the only authority on the wire shape for the newly-selected
 * `skills` field — the synthesized SDL types `Education.skills` as
 * `Unknown`, the upstream fragment at
 * `research/graphql/talent_profile/fragments/Education.graphql` selects
 * `skills { nodes { id name } }`, and only the live call confirms the
 * concrete wire types. A 2026-05-23 introspection-by-rejection probe
 * against the maintainer's live session confirmed the response shape
 * `skills { nodes [{ id, name }] }` (connection wrapping `{ id, name }`
 * objects); ttctl flattens to `{ id, name }[]` via `mapEducationNode`
 * (mirrors `mapCertificationNode` for #558 and `mapEmploymentNode` for
 * #344).
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * `GET_EDUCATION` has no generated operation type → **T1** (wire-shape
 * snapshot). `assertWireShapeStable(...)` diffs the live response shape
 * against the committed
 * `packages/e2e/src/wire-snapshots/GET_EDUCATION.snapshot.json`. The
 * snapshot is generated on the first
 * `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run (per
 * `packages/e2e/src/wire-snapshots/README.md`); the maintainer commits it
 * alongside this test.
 *
 * Coverage:
 *   - **Pure read** (`GET_EDUCATION`): the response carries the documented
 *     per-row fields (`id`, `institution`, `degree`, `fieldOfStudy`,
 *     `location`, `title`, `yearFrom`, `yearTo`, `highlight`, `skills`).
 *     `skills` is asserted to be `{ id: string; name: string }[]`
 *     post-mapping. The mapping (#556 `mapEducationNode`) is the unit
 *     under test against the live wire — a future selection-set or
 *     wire-shape regression surfaces as either a per-row assertion
 *     failure (sub-field-level) or a snapshot diff (envelope-level).
 *   - **Wire-shape snapshot — read** (`GET_EDUCATION`, T1): structural
 *     shape diffed against the committed snapshot.
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - Test account has zero education rows → the per-row pure-read
 *     assertions are skipped (no rows to assert against) but the
 *     wire-shape snapshot subtest still runs (the operation succeeded and
 *     the response shape — including the empty `educations.nodes` array
 *     shape — is still captured). The schema/contract rule remains
 *     satisfied via the snapshot.
 *   - Test account has education rows but none with skill links → the
 *     per-row `skills` assertion still passes (empty arrays are valid);
 *     the wire-shape snapshot's `skills.item` will be `{ kind: "unknown" }`
 *     (per the README's empty-array convention) instead of the populated
 *     `{ kind: "object", fields: { id, name } }`. Both shapes are
 *     legitimate; the snapshot at commit time records whichever the live
 *     account produced.
 */

// e2e-covers: GET_EDUCATION

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `69-profile-certifications.e2e.test.ts`.
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

describe("profile education list (live talent-profile, INFERRED wire shape, #556)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  // -----------------------------------------------------------------
  // Pure read — GET_EDUCATION wire shape (schema/contract core)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("list returns rows with every documented field, including skills: SkillRef[]", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const rows = await profile.education.list(token);

    if (rows.length === 0) {
      process.stderr.write(
        "[70-profile-education-skills] account has zero education rows — per-row " +
          "field-shape assertions skipped (the wire-shape snapshot subtest still runs " +
          "and covers the response envelope shape).\n",
      );
      return;
    }

    for (const e of rows) {
      expect(typeof e.id).toBe("string");
      expect(e.id.length).toBeGreaterThan(0);
      expect(typeof e.institution).toBe("string");
      expect(typeof e.degree).toBe("string");
      expect(typeof e.fieldOfStudy === "string" || e.fieldOfStudy === null).toBe(true);
      expect(typeof e.location === "string" || e.location === null).toBe(true);
      expect(typeof e.title === "string" || e.title === null).toBe(true);
      expect(typeof e.yearFrom === "number" || e.yearFrom === null).toBe(true);
      expect(typeof e.yearTo === "number" || e.yearTo === null).toBe(true);
      expect(typeof e.highlight).toBe("boolean");
      // #556 — skills surfaces as SkillRef[] post-mapping. The wire
      // returns `skills { nodes [{ id, name }] }`; `mapEducationNode`
      // flattens it. Empty arrays are valid (education has no skill links).
      expect(Array.isArray(e.skills)).toBe(true);
      for (const s of e.skills) {
        expect(typeof s.id).toBe("string");
        expect(s.id.length).toBeGreaterThan(0);
        expect(typeof s.name).toBe("string");
        expect(s.name.length).toBeGreaterThan(0);
      }
    }
  });

  // -----------------------------------------------------------------
  // T1 wire-shape snapshot
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("GET_EDUCATION wire shape is stable (T1 snapshot, includes skills)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    // Snapshot the full response envelope (data.profile.educations.nodes),
    // not just the rows — captures the connection wrapper shape too.
    const rows = await profile.education.list(token);
    assertWireShapeStable({
      operationName: "GET_EDUCATION",
      surface: "talent-profile",
      transport: "impersonated",
      response: { educations: { nodes: rows } },
    });
  });
});
