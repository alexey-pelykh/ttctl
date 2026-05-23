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
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("engagements show (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
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

  it.skipIf(!e2eEnabled)("returns a structured NOT_FOUND error for an unknown id", async () => {
    const fakeId = "act_00000000000000000000000000000000";
    const result = await cli.run(["engagements", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });
});
