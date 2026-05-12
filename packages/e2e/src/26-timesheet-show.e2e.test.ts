// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl timesheet show <id>` (#13).
 *
 * Mandatory per the project's schema/contract validation rule. The
 * `TimesheetDetails($id)` query is hand-authored and not in
 * `codegen.config.ts`; live-API verification is the only authority
 * on the wire shape.
 *
 * Coverage:
 *   - Detail payload carries the `timesheetDetailsFields` projection
 *     (timesheetUrl, actualAgreement, timesheetRecords[], comment).
 *   - Invalid id → NOT_FOUND error envelope, exit code 1.
 *
 * **Skip conditions** (silent — emit stderr warning, do not fail):
 *   - Test account has zero pending timesheets → no id to drive
 *     show against; happy-path subtest skipped.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("timesheet show (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("happy-path: returns the timesheetDetailsFields projection", async () => {
    // Discover a BillingCycle id from the pending list.
    const listResult = await cli.run(["timesheet", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listPayload = JSON.parse(listResult.stdout) as { items: Array<{ id: string }> };
    const cycleId = listPayload.items[0]?.id;
    if (cycleId === undefined) {
      process.stderr.write("warning: timesheet list returned 0 rows (no pending cycles) — show happy-path skipped\n");
      return;
    }

    const result = await cli.run(["timesheet", "show", cycleId, "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    // List-fragment fields
    expect(payload["id"]).toBe(cycleId);
    expect("startDate" in payload).toBe(true);
    expect("endDate" in payload).toBe(true);
    expect("hours" in payload).toBe(true);
    expect("timesheetSubmitted" in payload).toBe(true);
    // Detail-fragment extension
    expect("timesheetUrl" in payload).toBe(true);
    expect("timesheetComment" in payload).toBe(true);
    expect("timesheetRecords" in payload).toBe(true);
    expect("actualAgreement" in payload).toBe(true);
    // timesheetRecords MUST be an array (empty allowed)
    expect(Array.isArray(payload["timesheetRecords"])).toBe(true);
    // engagement.expectedHours is part of the detail projection
    const engagement = payload["engagement"] as Record<string, unknown> | undefined;
    expect(engagement).toBeDefined();
    expect("expectedHours" in (engagement ?? {})).toBe(true);
  });

  it.skipIf(!e2eEnabled)("invalid id → NOT_FOUND error envelope on json", async () => {
    // Use an id-shaped string that won't resolve. The Toptal mobile-gateway
    // decodes the Relay global id and returns:
    //   "Node id '<id>' resolves to an unknown type Nonexistent."
    // — captured 2026-05-12 by the schema/contract validation rule. Our
    // `NOT_FOUND_MESSAGE_PATTERN` remaps this `GRAPHQL_ERROR` to `NOT_FOUND`
    // for a domain-typed UX surface.
    const result = await cli.run(["timesheet", "show", "VjEtTm9uZXhpc3RlbnQtMA", "-o", "json"]);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; errors: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors[0]?.code).toBe("NOT_FOUND");
  });
});
