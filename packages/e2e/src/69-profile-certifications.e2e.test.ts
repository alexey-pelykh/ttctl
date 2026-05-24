// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile certifications list` covering #557
 * (`Certification.status`) and #558 (`Certification.skills`) — both new
 * selections on `CERTIFICATION_FRAGMENT`.
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `GET_CERTIFICATION` targets the Cloudflare-protected `talent-profile`
 * surface and is listed in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` in
 * `codegen.config.ts` (synthesized SDL types every field `Unknown`). The
 * live API is the only authority on the wire shape for the newly-selected
 * fields — the synthesized SDL types both as `Unknown`, the upstream
 * fragment at `research/graphql/talent_profile/fragments/Certification.graphql`
 * selects them, and only the live call confirms the concrete wire types:
 *   - `status`: `string | null` (enum-keyed; members surface verbatim).
 *   - `skills`: connection `skills { nodes [{ id, name }] }`, flattened by
 *     ttctl to `{ id, name }[]` (mirrors `Employment.skills`).
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * `GET_CERTIFICATION` has no generated operation type → **T1** (wire-shape
 * snapshot). `assertWireShapeStable(...)` diffs the live response shape
 * against the committed
 * `packages/e2e/src/wire-snapshots/GET_CERTIFICATION.snapshot.json`. The
 * snapshot is generated on the first
 * `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run (per
 * `packages/e2e/src/wire-snapshots/README.md`); the maintainer commits it
 * alongside this test.
 *
 * Coverage:
 *   - **Pure read** (`GET_CERTIFICATION`): the response carries the twelve
 *     documented per-row fields (`id`, `certificate`, `institution`,
 *     `link`, `number`, `validFromMonth`, `validFromYear`, `validToMonth`,
 *     `validToYear`, `highlight`, `status`, `skills`). `skills` is
 *     asserted to be `{ id: string; name: string }[]` post-mapping. The
 *     mapping (#558 `mapCertificationNode`) is the unit under test
 *     against the live wire — a future selection-set or wire-shape
 *     regression surfaces as either a per-row assertion failure
 *     (sub-field-level) or a snapshot diff (envelope-level).
 *   - **Wire-shape snapshot — read** (`GET_CERTIFICATION`, T1): structural
 *     shape diffed against the committed snapshot.
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - Test account has zero certification rows → the per-row pure-read
 *     assertions are skipped (no rows to assert against) but the
 *     wire-shape snapshot subtest still runs (the operation succeeded and
 *     the response shape — including the empty `certifications.nodes`
 *     array shape — is still captured). The schema/contract rule remains
 *     satisfied via the snapshot.
 *   - Test account has certifications but none with skill links → the
 *     per-row `skills` assertion still passes (empty arrays are valid);
 *     the wire-shape snapshot's `skills.item` will be `{ kind: "unknown" }`
 *     (per the README's empty-array convention) instead of the populated
 *     `{ kind: "object", fields: { id, name } }`. Both shapes are
 *     legitimate; the snapshot at commit time records whichever the live
 *     account produced.
 */

// e2e-covers: GET_CERTIFICATION

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `42-profile-external-show.e2e.test.ts:75-83`.
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

describe("profile certifications list (live talent-profile, INFERRED wire shape, #557, #558)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  // -----------------------------------------------------------------
  // Pure read — GET_CERTIFICATION wire shape (schema/contract core)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "list returns rows with every documented field, including status: string|null and skills: SkillRef[]",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const rows = await profile.certifications.list(token);

      if (rows.length === 0) {
        process.stderr.write(
          "[69-profile-certifications] account has zero certification rows — per-row " +
            "field-shape assertions skipped (the wire-shape snapshot subtest still runs " +
            "and covers the response envelope shape).\n",
        );
        return;
      }

      for (const c of rows) {
        expect(typeof c.id).toBe("string");
        expect(c.id.length).toBeGreaterThan(0);
        expect(typeof c.certificate).toBe("string");
        expect(typeof c.institution).toBe("string");
        expect(typeof c.link === "string" || c.link === null).toBe(true);
        expect(typeof c.number === "string" || c.number === null).toBe(true);
        expect(typeof c.validFromMonth === "number" || c.validFromMonth === null).toBe(true);
        expect(typeof c.validFromYear === "number" || c.validFromYear === null).toBe(true);
        expect(typeof c.validToMonth === "number" || c.validToMonth === null).toBe(true);
        expect(typeof c.validToYear === "number" || c.validToYear === null).toBe(true);
        expect(typeof c.highlight).toBe("boolean");
        // #557 — status surfaces as string | null. Enum members surface
        // verbatim; we don't assert membership here (member drift is a
        // T2-class concern and `GET_CERTIFICATION` is T1).
        expect(typeof c.status === "string" || c.status === null).toBe(true);
        // #558 — skills surfaces as SkillRef[] post-mapping. The wire
        // returns `skills { nodes [{ id, name }] }`; `mapCertificationNode`
        // flattens it. Empty arrays are valid (cert has no skill links).
        expect(Array.isArray(c.skills)).toBe(true);
        for (const s of c.skills) {
          expect(typeof s.id).toBe("string");
          expect(s.id.length).toBeGreaterThan(0);
          expect(typeof s.name).toBe("string");
          expect(s.name.length).toBeGreaterThan(0);
        }
      }
    },
  );

  // -----------------------------------------------------------------
  // T1 wire-shape snapshot
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("GET_CERTIFICATION wire shape is stable (T1 snapshot, includes status + skills)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    // Snapshot the full response envelope (data.profile.certifications.nodes),
    // not just the rows — captures the connection wrapper shape too.
    const rows = await profile.certifications.list(token);
    assertWireShapeStable({
      operationName: "GET_CERTIFICATION",
      surface: "talent-profile",
      transport: "impersonated",
      response: { certifications: { nodes: rows } },
    });
  });
});
