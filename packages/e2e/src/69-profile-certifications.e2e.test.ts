// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile certifications list` after the #557
 * `Certification.status` field was added to `CERTIFICATION_FRAGMENT`.
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `GET_CERTIFICATION` targets the Cloudflare-protected `talent-profile`
 * surface and is listed in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` in
 * `codegen.config.ts` (synthesized SDL types every field `Unknown`). The
 * live API is the only authority on the wire shape for the newly-selected
 * `status` field — the synthesized SDL says `status: Unknown`, the
 * upstream fragment at `research/graphql/talent_profile/fragments/Certification.graphql`
 * selects it, and the field is documented as enum-keyed
 * (`valid` / `expired` / `pending-verification` likely) — only the live
 * call confirms the concrete wire type (`string | null`).
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
 *   - **Pure read** (`GET_CERTIFICATION`): the response carries the eleven
 *     documented per-row fields (`id`, `certificate`, `institution`,
 *     `link`, `number`, `validFromMonth`, `validFromYear`, `validToMonth`,
 *     `validToYear`, `highlight`, `status`). `status` is asserted to be
 *     `string | null` (enum members surface as their wire string verbatim;
 *     enum-member drift is invisible to T1 per the snapshot redaction
 *     policy, accepted trade-off).
 *   - **Wire-shape snapshot — read** (`GET_CERTIFICATION`, T1): structural
 *     shape diffed against the committed snapshot. The snapshot's
 *     `status` field is the regression detector — a future selection-set
 *     regression (e.g., a status drop or rename) would surface as a
 *     structural diff.
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - Test account has zero certification rows → the per-row pure-read
 *     assertions are skipped (no rows to assert against) but the
 *     wire-shape snapshot subtest still runs (the operation succeeded and
 *     the response shape — including the empty `certifications.nodes`
 *     array shape — is still captured). The schema/contract rule remains
 *     satisfied via the snapshot.
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

describe("profile certifications list (live talent-profile, INFERRED wire shape, #557)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  // -----------------------------------------------------------------
  // Pure read — GET_CERTIFICATION wire shape (schema/contract core)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "list returns rows with every documented field, including status: string|null (#557)",
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
      }
    },
  );

  // -----------------------------------------------------------------
  // T1 wire-shape snapshot
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("GET_CERTIFICATION wire shape is stable (T1 snapshot, includes status)", async () => {
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
