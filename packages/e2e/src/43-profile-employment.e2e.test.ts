// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for the #344 employment read/write-parity extension.
 *
 * **Mandatory per the project's Schema/contract validation rule** —
 * #344 extends the hand-authored `EMPLOYMENT_FRAGMENT` selection set in
 * `packages/core/src/services/profile/employment/index.ts` with four
 * fields whose READ wire shape was INFERRED from
 * `research/graphql/talent_profile/fragments/Employment.graphql`
 * (`publicationPermit`, `reportingTo`, the nested
 * `industries { nodes { id name } }` connection, and the
 * `primaryGeography { id code name }` object). `GET_WORK_EXPERIENCE`
 * is on the **T1** wire-validation track per
 * `docs/wire-validation-routing.md:123` (talent-profile SDL is gappy —
 * the op is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`, codegen-excluded,
 * so no generated Zod schema exists). The live API is the only
 * authority on whether the extended selection set is wire-accurate:
 * if any of the four added selections names a field the live
 * `Employment` type does not expose, the server rejects the entire
 * `CreateEmployment` / `GET_WORK_EXPERIENCE` document with a top-level
 * GraphQL error, which the core service surfaces as
 * `ProfileError("GRAPHQL_ERROR")` and this test propagates as a hard
 * failure (introspection-by-rejection).
 *
 * Coverage strategy (mirrors `41-profile-industries.e2e.test.ts` /
 * `36-profile-portfolio.e2e.test.ts` sentinel round-trip + the
 * `25-timesheet-list.e2e.test.ts` T1 snapshot pattern):
 *
 *   - **Round-trip the parity fields**: add a sentinel employment row,
 *     `update` it with the two scalar parity fields the write input
 *     accepts without a catalog lookup (`publicationPermit: false`,
 *     `reportingTo: <sentinel>`), `show` it back, and assert the
 *     mapped read shape echoes them — this is the rule's "round-trip
 *     the change and verify it persisted" requirement. The
 *     `industries` / `primaryGeography` selections are exercised on
 *     every `add` / `list` / `update` (they are unconditionally in the
 *     fragment); the positive shape check asserts they resolve to the
 *     mapped projection (`[]` / `null` when unset is valid — the point
 *     is the selection succeeded, not that the test account has data).
 *     `try/finally` removes the sentinel even on mid-assertion failure.
 *   - **GET_WORK_EXPERIENCE wire-shape snapshot (T1)**: the post-
 *     projection `Employment[]` from `profile.employment.list` is
 *     asserted against the committed snapshot. The snapshot is created
 *     on the first `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run (the maintainer's
 *     live run) and asserted thereafter.
 *
 * **Skip conditions** (silent — emit stderr warning, do not fail):
 *   - `add` / `update` rejected by a server-side business gate
 *     (`USER_ERROR` — e.g. the documented "This action is not allowed"
 *     test-account-state issue observed on the maintainer's profile):
 *     the wire-shape gate has already been passed (a wire-shape bug
 *     fails earlier with `GRAPHQL_ERROR`, BEFORE the business gate), so
 *     the round-trip subtest skips. A `GRAPHQL_ERROR` is NEVER skipped
 *     — that is precisely the regression class this file defends.
 *   - `list` returns zero rows (clean test account, sentinel cleanup
 *     already ran) → snapshot assertion skipped.
 */

// e2e-covers: GET_WORK_EXPERIENCE, CreateEmployment, UpdateEmployment, RemoveEmployment

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `25-timesheet-list.e2e.test.ts` — `ConfigLoadSchema` validates
 * the Form-D shape (`auth.token` present).
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

/**
 * Structural read of `ProfileError.code` without importing the class
 * (`ProfileError` is internal to `@ttctl/core`). A `USER_ERROR` is a
 * server-side business gate (graceful skip — the wire-shape gate is
 * already passed by then); any other code (notably `GRAPHQL_ERROR`)
 * propagates as a hard failure.
 */
function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

describe("profile employment #344 read/write parity (live talent-profile, INFERRED wire shape)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "round-trips publicationPermit + reportingTo and surfaces industries/primaryGeography on show",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const ts = Date.now().toString();
      const sentinelCompany = `e2e-sentinel-emp-${ts}`;
      const sentinelReportingTo = `e2e reporting line ${ts}`;

      let createdId: string | undefined;
      // Custom (non-catalog) row keeps the #344 parity test independent
      // of catalog state; noEmployer + noWebsite is the #484 anchor pair.
      try {
        const outcome = await profile.employment.add(token, {
          company: sentinelCompany,
          position: "E2E Engineer",
          startDate: 2020,
          noEmployer: true,
          noWebsite: true,
        });
        if (outcome.kind !== "created") throw new Error("unreachable: dryRun not set");
        const created = outcome.result;
        createdId = created.id;
        expect(typeof created.id).toBe("string");
        // The mapped add response already proves the extended fragment
        // resolved on the live wire (a wrong selection rejects the whole
        // CreateEmployment document upstream of here).
        expect(created).toHaveProperty("publicationPermit");
        expect(created).toHaveProperty("reportingTo");
        expect(Array.isArray(created.industries)).toBe(true);
        expect(created.primaryGeography === null || typeof created.primaryGeography === "object").toBe(true);

        // Write the two scalar parity fields the input accepts without a
        // catalog lookup, then read them back.
        const updated = await profile.employment.update(token, created.id, {
          publicationPermit: false,
          reportingTo: sentinelReportingTo,
        });
        expect(updated.publicationPermit).toBe(false);
        expect(updated.reportingTo).toBe(sentinelReportingTo);

        // Fresh read via show() — the persistence + positive-shape check.
        const shown = await profile.employment.show(token, created.id);
        expect(shown.publicationPermit).toBe(false);
        expect(shown.reportingTo).toBe(sentinelReportingTo);
        expect(Array.isArray(shown.industries)).toBe(true);
        for (const ind of shown.industries) {
          expect(typeof ind.id).toBe("string");
          expect(typeof ind.name).toBe("string");
        }
        if (shown.primaryGeography !== null) {
          expect(typeof shown.primaryGeography.id).toBe("string");
        }
      } catch (err) {
        if (errorCode(err) === "USER_ERROR") {
          process.stderr.write(
            `warning: [42-profile-employment] talent-profile rejected the sentinel add/update with a USER_ERROR business gate ` +
              `(test-account-state issue, NOT a #344 wire-shape regression — a wrong selection set fails earlier with ` +
              `GRAPHQL_ERROR). Round-trip subtest skipped.\n`,
          );
          return;
        }
        // GRAPHQL_ERROR / NETWORK_ERROR / UNKNOWN — propagate. A
        // GRAPHQL_ERROR here is exactly the regression this file defends.
        throw err;
      } finally {
        if (createdId !== undefined) {
          await profile.employment.remove(token, createdId);
        }
      }
    },
  );

  it.skipIf(!e2eEnabled)("GET_WORK_EXPERIENCE post-projection wire shape matches snapshot (T1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await profile.employment.list(token);
    if (response.length === 0) {
      process.stderr.write(
        "warning: [42-profile-employment] GET_WORK_EXPERIENCE returned 0 rows (clean test account) — wire-shape assertion skipped\n",
      );
      return;
    }
    // T1 disposition per docs/wire-validation-routing.md:123. The
    // snapshot captures the mapped `Employment[]` shape surfaced to
    // consumers (consistent with the portfolio/industries T1 pattern —
    // the raw GraphQL response is opaque to callers). Drift in the
    // server's response signals a wire-format regression to re-engineer.
    expect(() =>
      assertWireShapeStable({
        operationName: "GET_WORK_EXPERIENCE",
        surface: "talent-profile",
        transport: "impersonated",
        response,
      }),
    ).not.toThrow();
  });
});
