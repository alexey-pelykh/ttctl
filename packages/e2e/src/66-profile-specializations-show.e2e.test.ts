// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile specializations show` (#466).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `GetTalentSpecializations` is a hand-authored gateway-portal op in
 * `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`); no
 * generated type exists. The wire shape is best-effort INFERRED until
 * this file passes against a live session.
 *
 * Coverage:
 *   - `profile specializations show` returns an array (empty list is a
 *     legitimate state for fresh accounts) where every row carries the
 *     full projected shape: id, slug, title, description, logoUrl,
 *     applicationStatus, eligibleJobsCount, applicationCompletedAt,
 *     operations.apply.{callable, messages}.
 *   - pretty output renders the column header from
 *     `formatSpecializationsTable` (the list-shape dispatcher target).
 *     Empty accounts emit header-only; populated accounts emit header
 *     plus N data rows.
 *   - Wire-shape snapshot assertion (T1 disposition): the projected
 *     shape is pinned to
 *     `wire-snapshots/GetTalentSpecializations.snapshot.json`. Skipped
 *     when the account has zero specializations on the wire — the
 *     snapshot must be captured against real wire data, not an empty
 *     array.
 *
 * Read-only — no side effects.
 *
 * Disposition: **T1** (wire-shape snapshot). `GetTalentSpecializations`
 * is in the codegen-exclusion list, so no T2 Zod schema is generated;
 * `assertWireShapeStable` is the continuous wire-drift defense.
 */

// e2e-covers: GetTalentSpecializations

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Projection-contract field set returned by
 * `profile.specializations.show()`. Every row MUST carry these keys
 * (values may legitimately be null per the Wire-shape interface).
 */
const SPECIALIZATION_FIELDS = [
  "id",
  "slug",
  "title",
  "description",
  "logoUrl",
  "applicationStatus",
  "eligibleJobsCount",
  "applicationCompletedAt",
  "operations",
];

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `61-payments-summary.e2e.test.ts`.
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

describe("profile specializations show (live mobile-gateway, #466)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the projected Specialization[] shape (json)", async () => {
    const result = await cli.run(["profile", "specializations", "show", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as unknown;
    expect(Array.isArray(payload)).toBe(true);
    const rows = payload as Array<Record<string, unknown>>;

    // Empty list is a legitimate state for a fresh account — the wire
    // call succeeded, just no specializations granted yet. Document via
    // stdout so the run log explains the skipped row-shape assertions.
    if (rows.length === 0) {
      process.stdout.write(
        "[66-profile-specializations-show] No specializations on this account; row-shape assertions skipped.\n",
      );
      return;
    }

    for (const row of rows) {
      for (const field of SPECIALIZATION_FIELDS) {
        expect(field in row).toBe(true);
      }
      // String-typed fields when populated; id is always a non-empty
      // string (every catalog row carries a stable opaque id).
      expect(typeof row["id"]).toBe("string");
      expect((row["id"] as string).length).toBeGreaterThan(0);

      // operations.apply.{callable, messages} structure. `callable` is
      // an enum-string per the schema (`Operation.callable: String!`).
      const operations = row["operations"] as Record<string, unknown>;
      expect("apply" in operations).toBe(true);
      const apply = operations["apply"] as Record<string, unknown>;
      expect(typeof apply["callable"]).toBe("string");
      expect(Array.isArray(apply["messages"])).toBe(true);
    }
  });

  it.skipIf(!e2eEnabled)("pretty output renders the table header and zero-or-more data rows", async () => {
    const result = await cli.run(["profile", "specializations", "show"]);
    expect(result.exitCode).toBe(0);
    // Array-shaped data routes through `formatSpecializationsTable` per
    // `formatResult`'s list-shape dispatch (not `formatSpecializationsText`,
    // which is reachable only for show-shape objects). Both empty and
    // populated outputs share the column-header line; the populated
    // case adds N tab-separated data rows.
    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("slug\ttitle\tstatus\tapplicationCompletedAt\teligibleJobsCount\tapply.callable");
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------
  // Wire-shape snapshot assertion (T1 disposition; #466).
  //
  // Track 1 continuous-detection defense for `GetTalentSpecializations`
  // against post-merge wire drift (a field renamed / removed / retyped,
  // or the `operations.apply` sub-shape changing). Captured against the
  // projected `Specialization[]` — the surface CLI/MCP consumers depend
  // on. The shape assertion descends into the first row's nested fields;
  // an empty list cannot be snapshotted (zero-length arrays carry no
  // type information), so the test exits gracefully when the account
  // has no specializations on the wire.
  //
  // Snapshot lives at
  // `wire-snapshots/GetTalentSpecializations.snapshot.json`; the first
  // authenticated run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` captures it
  // against a populated account.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("GetTalentSpecializations wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await profile.specializations.show(token);
    if (response.length === 0) {
      process.stdout.write(
        "[66-profile-specializations-show] No specializations on this account; skipping wire-shape snapshot.\n",
      );
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "GetTalentSpecializations",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });
});
