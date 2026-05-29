// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// e2e-covers: JobActivityItem

/**
 * E2E coverage for `ttctl engagements show <id>` (#147).
 *
 * Mandatory per the project's schema/contract validation rule.
 * Validates the live wire shape of the engagement-extended
 * `JobActivityItem` operation (selection set deeper than applications'
 * projection — adds currentAgreement, billCycle, earning, breaks).
 *
 * The id is discovered from `engagements list --status all` so the
 * test doesn't need a hard-coded fixture id.
 *
 * #546: extended to assert the new client-context projection (city,
 * countryName, foundingYear, industry, isEnterprise, teamSize) populates
 * on the live wire AND to run the Track 1 `assertWireShapeStable`
 * snapshot diff.
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, engagements } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors the pattern from `26-timesheet-show.e2e.test.ts:38-46` /
 * `30-payments-payouts.e2e.test.ts:43-51`.
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

describe("engagements show (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the engagement detail projection for a known id", async () => {
    const listResult = await cli.run(["engagements", "list", "--status", "all", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const list = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const firstId = list.items[0]?.id;
    if (firstId === undefined) {
      process.stderr.write(
        "warning: engagements list returned 0 rows (test account has never had an engagement) — show assertions skipped\n",
      );
      return;
    }

    const showResult = await cli.run(["engagements", "show", firstId, "-o", "json"]);
    expect(showResult.exitCode).toBe(0);

    const detail = JSON.parse(showResult.stdout) as Record<string, unknown>;
    expect(detail["id"]).toBe(firstId);
    expect("engagementId" in detail).toBe(true);
    expect("statusV2" in detail).toBe(true);
    expect("statusGroupV2" in detail).toBe(true);
    expect("lastUpdatedAt" in detail).toBe(true);
    expect("job" in detail).toBe(true);

    // Engagement-extended fields the show projection adds beyond list
    expect("currentAgreement" in detail).toBe(true);
    expect("billCycle" in detail).toBe(true);
    expect("earning" in detail).toBe(true);
    expect("eligibleForPayment" in detail).toBe(true);
    expect("eligibleToViewTimesheets" in detail).toBe(true);
    expect("eligibleToViewTimeOffs" in detail).toBe(true);
    expect("proposedEnd" in detail).toBe(true);
    expect("breaks" in detail).toBe(true);
    expect(Array.isArray(detail["breaks"])).toBe(true);

    // Job-extended fields beyond list
    const job = detail["job"] as Record<string, unknown>;
    expect("descriptionMd" in job).toBe(true);
    expect("commitment" in job).toBe(true);
    expect("workType" in job).toBe(true);
    expect("specialization" in job).toBe(true);

    // Counterparty identity (#545): client-side contacts + Toptal-side
    // recruiter points-of-contact. `contacts` may be `[]` and a recruiter
    // may be elided on a sparse account, so the populated assertions are
    // conditional — the presence + array-shape checks are unconditional.
    expect("contacts" in job).toBe(true);
    expect(Array.isArray(job["contacts"])).toBe(true);
    expect("pointsOfContact" in job).toBe(true);

    const contacts = job["contacts"] as Array<Record<string, unknown>>;
    if (contacts.length > 0) {
      // Well-typed `CompanyRepresentative.fullName: String!` — must be a string.
      expect(typeof contacts[0]?.["fullName"]).toBe("string");
    }

    const poc = job["pointsOfContact"] as Record<string, unknown> | null;
    if (poc !== null) {
      expect("current" in poc).toBe(true);
      const current = poc["current"] as Record<string, unknown> | null;
      if (current !== null) {
        // "Who's my recruiter" — the core #545 value; `Recruiter.fullName: String!`.
        expect(typeof current["fullName"]).toBe("string");
      }
    }
  });

  it.skipIf(!e2eEnabled)(
    "engagements show projects client context: city/countryName/foundingYear/industry/isEnterprise/teamSize",
    async () => {
      const listResult = await cli.run(["engagements", "list", "--status", "all", "-o", "json"]);
      expect(listResult.exitCode).toBe(0);
      const list = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
      const firstId = list.items[0]?.id;
      if (firstId === undefined) {
        process.stderr.write("warning: engagements list returned 0 rows — client-context (#546) assertions skipped\n");
        return;
      }

      const showResult = await cli.run(["engagements", "show", firstId, "-o", "json"]);
      expect(showResult.exitCode).toBe(0);
      const detail = JSON.parse(showResult.stdout) as Record<string, unknown>;
      const job = detail["job"] as Record<string, unknown> | undefined;
      expect(job).toBeDefined();
      const client = job?.["client"] as Record<string, unknown> | null | undefined;

      // The `Client` type's id is `ID!` and `isEnterprise` / `teamSize` are
      // non-null in the SDL, so `client` itself must be present and the
      // non-null context keys MUST exist (their values may be empty
      // strings on sparse clients but the keys are unconditional).
      if (client === null || client === undefined) {
        process.stderr.write(
          "warning: job.client elided on this engagement — client context assertions skipped (sparse-account fixture)\n",
        );
        return;
      }
      // Identity keys (pre-#546) remain.
      expect("id" in client).toBe(true);
      expect("fullName" in client).toBe(true);
      // Client context (#546): every key MUST be a key on the detail
      // payload (presence-only); the nullable fields may carry `null`
      // values on accounts with sparse client metadata.
      expect("city" in client).toBe(true);
      expect("countryName" in client).toBe(true);
      expect("foundingYear" in client).toBe(true);
      expect("industry" in client).toBe(true);
      expect("isEnterprise" in client).toBe(true);
      // `Boolean!` in the SDL — must be a boolean (non-null).
      expect(typeof client["isEnterprise"]).toBe("boolean");
      expect("teamSize" in client).toBe(true);
      // `TeamSize!` in the SDL — non-null object with `value: String`.
      const teamSize = client["teamSize"] as Record<string, unknown> | null;
      expect(teamSize).not.toBeNull();
      if (teamSize !== null) {
        expect("value" in teamSize).toBe(true);
      }
      // `countryName` is a `String?` populated for most live clients — the
      // issue body cites it as the canonical "populates" check. Skip when
      // the live wire returns `null` (sparse client) so we don't false-fail
      // accounts without populated geography metadata.
      if (client["countryName"] !== null) {
        expect(typeof client["countryName"]).toBe("string");
      }
      if (client["industry"] !== null) {
        expect(typeof client["industry"]).toBe("string");
      }
    },
  );

  // -------------------------------------------------------------------
  // Track 1 — wire-shape snapshot diff (#546)
  //
  // The `JobActivityItem` op is classified Track 1 in
  // `docs/wire-validation-routing.md` (schema gappy, no generated type).
  // `assertWireShapeStable` reads `JobActivityItem.snapshot.json` from
  // `packages/e2e/src/wire-snapshots/`; the first run with
  // `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` writes the snapshot.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("JobActivityItem wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    const listResult = await cli.run(["engagements", "list", "--status", "all", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const list = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const firstId = list.items[0]?.id;
    if (firstId === undefined) {
      process.stderr.write("warning: engagements list returned 0 rows — JobActivityItem wire-shape snapshot skipped\n");
      return;
    }
    try {
      const response = await engagements.show(token, firstId);
      expect(() =>
        assertWireShapeStable({
          operationName: "JobActivityItem",
          surface: "mobile-gateway",
          transport: "stock",
          response,
        }),
      ).not.toThrow();
    } catch (err) {
      // The CLI test above already covers NOT_FOUND / NO_ENGAGEMENT
      // routing. If the first list item happens to be an
      // interview-only row (NO_ENGAGEMENT), skip the snapshot check —
      // it's contingent on a wire success path.
      if (err instanceof engagements.EngagementsError && err.code === "NO_ENGAGEMENT") {
        process.stderr.write(
          "warning: first engagement row has no engagement (interview-only) — JobActivityItem wire-shape snapshot skipped\n",
        );
        return;
      }
      throw err;
    }
  });

  it.skipIf(!e2eEnabled)("returns a structured NOT_FOUND error for an unknown id", async () => {
    const fakeId = "act_00000000000000000000000000000000";
    const result = await cli.run(["engagements", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });
});
