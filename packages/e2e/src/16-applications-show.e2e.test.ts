// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications show <id>` (#15).
 *
 * Mandatory per the project's schema/contract validation rule. Validates
 * the live wire shape of the trimmed `JobActivityItem` operation
 * (`viewer.jobActivityItem(id:)`) and the typed `NOT_FOUND` branch.
 *
 * The id is discovered from a `list` call so the test doesn't need a
 * hard-coded fixture id (which would drift as the test account's
 * activity changes).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("applications show (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the detail projection for a known id (id discovered from `list`)", async () => {
    // Step 1: list to find a real id.
    const listResult = await cli.run(["applications", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const list = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const firstId = list.items[0]?.id;
    expect(firstId).toBeDefined();
    if (firstId === undefined) return;

    // Step 2: show by that id, assert the detail shape.
    const showResult = await cli.run(["applications", "show", firstId, "-o", "json"]);
    expect(showResult.exitCode).toBe(0);

    const detail = JSON.parse(showResult.stdout) as Record<string, unknown>;
    expect(detail["id"]).toBe(firstId);
    expect("statusV2" in detail).toBe(true);
    expect("statusGroupV2" in detail).toBe(true);
    expect("statusColor" in detail).toBe(true);
    expect("lastUpdatedAt" in detail).toBe(true);
    expect("job" in detail).toBe(true);

    // Detail-specific fields beyond the list projection
    const job = detail["job"] as Record<string, unknown>;
    // These fields are in the detail query's selection set but not in the
    // list projection — a regression in the trimmed selection set would
    // surface here.
    expect("descriptionMd" in job).toBe(true);
    expect("commitment" in job).toBe(true);
    expect("workType" in job).toBe(true);
    expect("specialization" in job).toBe(true);
    expect("estimatedLength" in job).toBe(true);
  });

  it.skipIf(!e2eEnabled)("returns a structured NOT_FOUND error for an unknown id", async () => {
    // Use a syntactically plausible but never-issued id. The gateway
    // returns `viewer.jobActivityItem === null`; the service maps that
    // to `ApplicationsError(NOT_FOUND)`; the CLI wraps it in the error
    // envelope with `code: "NOT_FOUND"` (per `handleApplicationsError`).
    const fakeId = "act_00000000000000000000000000000000";
    const result = await cli.run(["applications", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      errors?: Array<{ code?: string }>;
    };
    expect(payload.ok).toBe(false);
    // The live gateway responds with a top-level GraphQL error
    // `"Record not found"` (NOT a successful `viewer.jobActivityItem === null`).
    // `applications.show` translates that pattern to `NOT_FOUND` —
    // see service-side regex match.
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });
});
