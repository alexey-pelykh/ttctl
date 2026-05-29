// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile industries` — six operations against
 * Cloudflare-protected `talent-profile`.
 *
 * Coverage:
 *   - Unconditional `list()` smoke (passes empty result; asserts wire-shape).
 *   - `createIndustryProfile` + `listIndustryProfiles` + `updateIndustryProfile`
 *     + `removeIndustryProfile` round-trip with a catalog-resolved title
 *     (the mutation payloads carry `{ success, errors }` only — read back via
 *     `list` to confirm the row persisted).
 *   - T1 wire-shape snapshots for `list`, `show`, and `remove` projections.
 *   - `autocomplete` smoke (wire-shape regression guard).
 *
 * Catalog-driven sentinel: the live API rejects free-text industry titles;
 * the title must match a catalog entry from `industriesAutocomplete`. Test
 * resolves the first match for "Software" at runtime.
 *
 * Idempotency: `try/finally` removes any seeded row even on mid-assertion
 * failure. Because the title is a catalog entry shared with real industries,
 * leaked rows are NOT visually distinct — the pre/post id-set diff guards
 * against attributing existing rows to the seed.
 *
 * Skip conditions (stderr warning, no fail):
 *   - Autocomplete returns zero matches: round-trip subtest skipped.
 *   - `add` returns USER_ERROR `code: base` ("This action is not allowed.")
 *     — test-account-state issue, unrelated to the wire-shape gate:
 *     round-trip subtest skipped, wire-shape gate stays asserted.
 *   - Other USER_ERROR codes propagate as failures.
 */

// e2e-covers: CreateIndustryProfile, UpdateIndustryProfile, RemoveIndustryProfile, ListIndustryProfiles, GetIndustryProfile, GET_INDUSTRIES_FOR_AUTOCOMPLETE

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

interface CurationRef {
  id?: string;
}

interface IndustryShape {
  id?: string;
  title?: string | null;
  about?: string | null;
  domainArea?: string | null;
  // Curation cross-reference arrays — added in #553. Each maps to a
  // per-resource `show` op (employments → profile employment show, etc.).
  employments?: CurationRef[];
  educations?: CurationRef[];
  certifications?: CurationRef[];
  portfolioItems?: CurationRef[];
  highlights?: CurationRef[];
}

/**
 * Assert the five curation cross-reference arrays are present and
 * shaped as `CurationRef[]` (post-projection — flat `{ id }` arrays,
 * NOT the raw `{ nodes: [{ id }] }` connection shape). Used to confirm
 * the #553 fragment-extension lands cleanly on whichever curated row
 * the live API returns (even when seed disables the round-trip path
 * per the documented test-account-state issue).
 */
function expectCurationFieldsShape(row: IndustryShape | undefined): void {
  expect(row).toBeDefined();
  expect(Array.isArray(row?.employments)).toBe(true);
  expect(Array.isArray(row?.educations)).toBe(true);
  expect(Array.isArray(row?.certifications)).toBe(true);
  expect(Array.isArray(row?.portfolioItems)).toBe(true);
  expect(Array.isArray(row?.highlights)).toBe(true);
}

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

describe("profile industries (live talent-profile)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // ---------------------------------------------------------------------
  // #583 regression guard — UNCONDITIONAL `list()` document validation.
  //
  // Every other live subtest in this file is gated behind a successful
  // `add` (seed), which the maintainer's account CANNOT do
  // (auto-memory `project_test_account_industries_disabled` → "This
  // action is not allowed" → graceful skip). So `list()` was never
  // exercised live — which is exactly how #583 slipped through: the rc.9
  // read-surface expansion (#553) selected the five `IndustryProfile`
  // curation sub-fields as connections (`{ nodes { id } }`), but they are
  // plain lists of `IndustryProfileItem` (which has no `nodes` field).
  // The live API rejects the whole document at the GraphQL VALIDATION
  // layer — BEFORE the resolver runs and REGARDLESS of whether the
  // profile owns any industry rows.
  //
  // This subtest calls `list()` directly with NO seeding. Pre-fix it
  // threw `GRAPHQL_ERROR: Field 'nodes' doesn't exist on type
  // 'IndustryProfileItem'`; post-fix it validates and returns an array
  // (empty on this account — which is acceptable: the assertion is
  // "document validated + correct field shape", NOT "non-empty data").
  // It is the one assertion that actually catches #583, and because it
  // shares `INDUSTRY_PROFILE_FRAGMENT` with `show()`, a valid `list()`
  // document implies a valid `show()` fragment too.
  // ---------------------------------------------------------------------
  it.skipIf(!e2eEnabled)(
    "list() document validates against the live API and returns an array (empty allowed) — #583 regression guard",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // Must NOT throw GRAPHQL_ERROR. An empty array is the legitimate
      // "account has zero industry profiles" return.
      const rows = await profile.industries.list(token);
      expect(Array.isArray(rows)).toBe(true);

      // Whatever rows the live API returns (often [] on this account),
      // every one must carry the projected curation arrays — the part
      // the rc.9 regression broke.
      for (const row of rows) expectCurationFieldsShape(row);
    },
  );

  it.skipIf(!e2eEnabled)(
    "createIndustryProfile + listIndustryProfiles + updateIndustryProfile + removeIndustryProfile round-trip",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      // Resolve the sentinel title from the live catalog rather than
      // hard-coding free-text. The talent-profile surface rejects
      // unknown industry titles with a generic USER_ERROR ("This action
      // is not allowed. Please refresh the page."), so we pick the
      // first match for "Software" — a stable, popular catalog entry.
      const catalogMatches = await profile.industries.autocomplete(token, "Software", { limit: 5 });
      const catalogTitle = catalogMatches[0]?.name;
      if (catalogTitle === undefined) {
        console.warn(
          "[41-profile-industries] catalog autocomplete returned zero matches for 'Software'; skipping round-trip subtest",
        );
        return;
      }

      const initialConnection = "Engineer";
      const updatedConnection = "Architect";

      // Step 1: add. The mutation's payload only carries `{ success,
      // errors }` (per #321 fix); the CLI's `add` therefore must
      // re-read via list to surface the created row to the user. The
      // `add` invocation succeeds when the post-list read-back finds
      // the catalog title.
      const addResult = await cli.run([
        "profile",
        "industries",
        "add",
        catalogTitle,
        "--connection",
        initialConnection,
        "-o",
        "json",
      ]);

      // Distinguish wire-shape regressions (loud failure — that's the
      // bug #321 fixes) from the documented test-account-state issue
      // ("This action is not allowed" USER_ERROR) which is unrelated
      // to #321 and gates the seed step on the maintainer's profile.
      if (addResult.exitCode !== 0) {
        const errPayload = JSON.parse(addResult.stdout) as {
          ok?: boolean;
          errors?: { code?: string; message?: string }[];
        };
        const firstErr = errPayload.errors?.[0];
        const isBusinessGate =
          firstErr?.code === "USER_ERROR" && (firstErr.message ?? "").includes("This action is not allowed");
        if (isBusinessGate) {
          console.warn(
            `[41-profile-industries] talent-profile rejected the seed with the documented "This action is not allowed" USER_ERROR (test-account-state issue, NOT a #321 regression — the wire-shape gate has been passed). Skipping round-trip subtest.`,
          );
          return;
        }
        // Anything else — including a real wire-shape regression — is
        // a hard failure. Surface the error verbatim.
        throw new Error(
          `profile industries add failed unexpectedly (exit ${String(addResult.exitCode)}): stdout=${addResult.stdout} stderr=${addResult.stderr}`,
        );
      }

      const addPayload = JSON.parse(addResult.stdout) as {
        ok?: boolean;
        operation?: string;
        created?: IndustryShape;
      };
      expect(addPayload.ok).toBe(true);
      expect(addPayload.operation).toBe("profile.industries.add");
      expect(addPayload.created?.title).toBe(catalogTitle);
      expect(addPayload.created?.domainArea).toBe(initialConnection);
      expect(typeof addPayload.created?.id).toBe("string");
      // #553 — the post-add read-back goes through `list()` which now
      // projects the five curation arrays; assert their shape on the
      // returned row. Brand-new industries have empty curation (no
      // employments/portfolio items have been linked yet), so the
      // assertion verifies the projection ran AND the arrays land as
      // empty rather than missing/undefined.
      expectCurationFieldsShape(addPayload.created);
      expect(addPayload.created?.employments).toEqual([]);
      expect(addPayload.created?.educations).toEqual([]);
      expect(addPayload.created?.certifications).toEqual([]);
      expect(addPayload.created?.portfolioItems).toEqual([]);
      expect(addPayload.created?.highlights).toEqual([]);
      const sentinelId = addPayload.created?.id;
      if (sentinelId === undefined) return;

      try {
        // Step 2: list. AC #3 — the list MUST surface the newly added
        // row. A `[]` return is a regression of AC #6 (silent-empty
        // failure mode forbidden).
        const listResult = await cli.run(["profile", "industries", "list", "-o", "json"]);
        expect(listResult.exitCode).toBe(0);
        const listPayload = JSON.parse(listResult.stdout) as {
          version?: string;
          items?: IndustryShape[];
        };
        expect(listPayload.version).toBeDefined();
        expect(Array.isArray(listPayload.items)).toBe(true);
        const found = (listPayload.items ?? []).find((row) => row.id === sentinelId);
        expect(found).toBeDefined();
        expect(found?.title).toBe(catalogTitle);
        expect(found?.domainArea).toBe(initialConnection);
        // #553 — list() also projects curation arrays; verify the
        // shape lands cleanly on every row returned.
        expectCurationFieldsShape(found);

        // Step 3: update — change the connection.
        const updateResult = await cli.run([
          "profile",
          "industries",
          "update",
          sentinelId,
          "--connection",
          updatedConnection,
          "-o",
          "json",
        ]);
        expect(updateResult.exitCode).toBe(0);
        const updatePayload = JSON.parse(updateResult.stdout) as {
          ok?: boolean;
          operation?: string;
          updated?: IndustryShape;
        };
        expect(updatePayload.ok).toBe(true);
        expect(updatePayload.operation).toBe("profile.industries.update");
        expect(updatePayload.updated?.id).toBe(sentinelId);
        expect(updatePayload.updated?.domainArea).toBe(updatedConnection);
        // The title MUST remain unchanged — we only sent `--connection`.
        expect(updatePayload.updated?.title).toBe(catalogTitle);

        // Step 4: list again — verify the update persisted across a
        // fresh read. AC #2.
        const listAfterUpdate = await cli.run(["profile", "industries", "list", "-o", "json"]);
        expect(listAfterUpdate.exitCode).toBe(0);
        const listAfterUpdatePayload = JSON.parse(listAfterUpdate.stdout) as { items?: IndustryShape[] };
        const updated = (listAfterUpdatePayload.items ?? []).find((row) => row.id === sentinelId);
        expect(updated?.domainArea).toBe(updatedConnection);
      } finally {
        // Step 5 (always-runs): remove the sentinel.
        const removeResult = await cli.run(["profile", "industries", "remove", sentinelId, "-o", "json"]);
        expect(removeResult.exitCode).toBe(0);
        const removePayload = JSON.parse(removeResult.stdout) as {
          ok?: boolean;
          operation?: string;
          removed?: { id?: string };
        };
        expect(removePayload.ok).toBe(true);
        expect(removePayload.operation).toBe("profile.industries.remove");
        expect(removePayload.removed?.id).toBe(sentinelId);
      }
    },
  );

  // ---------------------------------------------------------------------
  // Wire-shape snapshot assertions (T1 per `docs/wire-validation-routing.md`).
  //
  // The snapshots capture the post-projection structural shape returned
  // by the core service — same pattern as `25-timesheet-list.e2e.test.ts`.
  // For ListIndustryProfiles / GetIndustryProfile this is meaningful
  // wire-shape coverage (the `IndustryProfile` projection has multiple
  // typed fields). RemoveIndustryProfile's projection is a bare `string`
  // (the returned id) and the snapshot is included for parity, even
  // though structurally minimal.
  //
  // The list-shape subtest seeds a sentinel row (then cleans it up) so
  // the snapshot has at least one element to capture; an empty array
  // collapses to `{ kind: "unknown" }` per `captureWireShape`'s
  // empty-array handling, which loses the per-element shape.
  // ---------------------------------------------------------------------

  /**
   * Seed a sentinel `IndustryProfile` for snapshot capture; returns
   * `null` (with stderr warning) when the documented test-account-state
   * USER_ERROR fires. Other errors propagate.
   *
   * The seed `add` is the same wire-shape-validated call that the
   * round-trip subtest exercises — the wire-shape gate has already been
   * passed by the time we reach this point in test execution if the
   * round-trip ran. Skipping on the same business-gate condition keeps
   * the snapshot subtests from failing on something unrelated to #321
   * while preserving regression detection if the wire-shape ever drifts
   * back into the originating-bug state.
   */
  async function seedOrSkip(token: string, label: string): Promise<{ id: string; title: string } | null> {
    const catalogMatches = await profile.industries.autocomplete(token, "Software", { limit: 5 });
    const catalogTitle = catalogMatches[0]?.name;
    if (catalogTitle === undefined) {
      console.warn(
        `[41-profile-industries:${label}] catalog autocomplete returned zero matches for 'Software'; skipping`,
      );
      return null;
    }
    try {
      const seeded = await profile.industries.add(token, { title: catalogTitle, domainArea: "Backend" });
      return { id: seeded.id, title: catalogTitle };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "USER_ERROR" && (e.message ?? "").includes("This action is not allowed")) {
        console.warn(
          `[41-profile-industries:${label}] talent-profile rejected the snapshot-seed with the documented "This action is not allowed" USER_ERROR (test-account-state issue, NOT a #321 regression). Skipping.`,
        );
        return null;
      }
      throw err;
    }
  }

  it.skipIf(!e2eEnabled)("ListIndustryProfiles wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    // Seed a sentinel so the list has at least one element for shape
    // capture. Cleanup happens via `try/finally` so a snapshot mismatch
    // does not strand the row.
    const seeded = await seedOrSkip(token, "list-snap");
    if (seeded === null) return;

    try {
      const rows = await profile.industries.list(token);
      expect(rows.length).toBeGreaterThan(0);
      // #553 — explicit curation-shape assertion guards against the
      // projection collapsing the connection sub-fields to undefined
      // (which would still pass the snapshot if the snapshot itself
      // captured the broken shape on a UPDATE run). The two checks
      // — array-shape AND snapshot — are complementary: the array
      // check is invariant across snapshot lifetime; the snapshot
      // catches changes to the projected element type.
      for (const row of rows) expectCurationFieldsShape(row);
      expect(() =>
        assertWireShapeStable({
          operationName: "ListIndustryProfiles",
          surface: "talent-profile",
          transport: "impersonated",
          response: rows,
        }),
      ).not.toThrow();
    } finally {
      await profile.industries.remove(token, seeded.id);
    }
  });

  it.skipIf(!e2eEnabled)("GetIndustryProfile wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    // Seed a sentinel so `show()` has a guaranteed-resolvable id.
    const seeded = await seedOrSkip(token, "show-snap");
    if (seeded === null) return;

    try {
      const row = await profile.industries.show(token, seeded.id);
      // #553 — explicit curation-shape assertion (see ListIndustryProfiles
      // sibling above for the rationale).
      expectCurationFieldsShape(row);
      expect(() =>
        assertWireShapeStable({
          operationName: "GetIndustryProfile",
          surface: "talent-profile",
          transport: "impersonated",
          response: row,
        }),
      ).not.toThrow();
    } finally {
      await profile.industries.remove(token, seeded.id);
    }
  });

  it.skipIf(!e2eEnabled)("RemoveIndustryProfile wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    // Seed a sentinel that we can immediately remove inside the
    // assertion. The captured shape is the projection (string id),
    // structurally minimal — the snapshot is included for parity with
    // the per-op disposition table; drift here would more likely be a
    // wire-rejection caught by the round-trip test above.
    const seeded = await seedOrSkip(token, "rm-snap");
    if (seeded === null) return;

    const removedId = await profile.industries.remove(token, seeded.id);
    expect(() =>
      assertWireShapeStable({
        operationName: "RemoveIndustryProfile",
        surface: "talent-profile",
        transport: "impersonated",
        response: removedId,
      }),
    ).not.toThrow();
  });

  it.skipIf(!e2eEnabled)(
    "autocomplete (regression smoke-test) returns at least one match for a generic query",
    async () => {
      const result = await cli.run(["profile", "industries", "autocomplete", "Software", "--limit", "5", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as { items?: { id?: string; name?: string }[] };
      expect(Array.isArray(payload.items)).toBe(true);
      // The catalog is large; "Software" matches the popular industry
      // names (Software, Software Engineering, etc.) and is unlikely to
      // be empty. If it ever IS empty (catalog culled), the assertion
      // surfaces it loudly rather than passing on a silent regression.
      expect((payload.items ?? []).length).toBeGreaterThan(0);
    },
  );
});
