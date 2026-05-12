// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl timesheet list` (#13).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * the timesheet service hand-authors four wire ops against the
 * mobile-gateway surface (`PendingTimesheets`, `Timesheets`,
 * `TimesheetDetails`, `SubmitTimesheet`). None of them appear in
 * `codegen.config.ts`. Live-API verification is the only authority
 * on whether the documents accurately model the wire shape.
 *
 * Coverage:
 *   - Default scope (no `--engagement`) returns the v0.4 list envelope
 *     populated with viewer-wide pending billing cycles.
 *   - Each row carries the `timesheetListFields` projection
 *     (id, week, hours, submission state, engagement+job refs).
 *   - `--engagement <id>` scope (when the test account has at least
 *     one active engagement) returns rows projected onto the same
 *     fragment.
 *
 * **Skip conditions** (silent — emit stderr warning, do not fail):
 *   - Test account has zero pending timesheets → empty list, shape
 *     assertions skipped.
 *   - Test account has zero active engagements → `--engagement`
 *     scoped subtest skipped.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("timesheet list (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the v0.4 list envelope (default = viewer-wide pending)", async () => {
    const result = await cli.run(["timesheet", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as unknown;
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();
    if (payload === null || typeof payload !== "object") return;

    expect("version" in payload).toBe(true);
    expect("items" in payload).toBe(true);
    const items = (payload as { items: unknown }).items;
    expect(Array.isArray(items)).toBe(true);
  });

  it.skipIf(!e2eEnabled)("rows carry the timesheetListFields projection", async () => {
    const result = await cli.run(["timesheet", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { items: unknown[] };
    const first = payload.items[0] as Record<string, unknown> | undefined;

    if (first === undefined) {
      process.stderr.write(
        "warning: timesheet list returned 0 rows (test account has no pending timesheets) — shape assertions skipped\n",
      );
      return;
    }

    expect("id" in first).toBe(true);
    expect("startDate" in first).toBe(true);
    expect("endDate" in first).toBe(true);
    expect("hours" in first).toBe(true);
    expect("timesheetOverdue" in first).toBe(true);
    expect("timesheetSubmissionOpenDatetime" in first).toBe(true);
    expect("timesheetSubmissionDeadlineDatetime" in first).toBe(true);
    expect("timesheetSubmitted" in first).toBe(true);
    expect("engagement" in first).toBe(true);

    // Pending-timesheets filter is server-side; every row MUST be
    // unsubmitted on the default scope.
    expect(first["timesheetSubmitted"]).toBe(false);

    // Engagement subobject must carry the job projection.
    const engagement = first["engagement"] as Record<string, unknown> | undefined;
    expect(engagement).toBeDefined();
    expect("id" in (engagement ?? {})).toBe(true);
    expect("job" in (engagement ?? {})).toBe(true);
  });

  it.skipIf(!e2eEnabled)("--engagement scope routes through the Timesheets query (per-engagement)", async () => {
    // Discover an active engagement id first.
    const engagementsResult = await cli.run(["engagements", "list", "--status", "active", "-o", "json"]);
    expect(engagementsResult.exitCode).toBe(0);
    const engagementsPayload = JSON.parse(engagementsResult.stdout) as {
      items: Array<{ id: string }>;
    };
    const engagementId = engagementsPayload.items[0]?.id;
    if (engagementId === undefined) {
      process.stderr.write(
        "warning: no active engagements (test account has never had a current engagement) — --engagement subtest skipped\n",
      );
      return;
    }

    const result = await cli.run(["timesheet", "list", "--engagement", engagementId, "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { items: Array<Record<string, unknown>> };
    expect(Array.isArray(payload.items)).toBe(true);

    // If the engagement has any cycles, the shape must match the
    // timesheetListFields fragment. (Default scope already ran the same
    // shape assertions; the per-engagement query SHOULD produce
    // structurally identical rows.)
    const first = payload.items[0];
    if (first !== undefined) {
      expect("id" in first).toBe(true);
      expect("timesheetSubmitted" in first).toBe(true);
      expect("engagement" in first).toBe(true);
    }
  });

  it.skipIf(!e2eEnabled)("yaml format also produces the list envelope shape", async () => {
    const result = await cli.run(["timesheet", "list", "--yaml"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("version:");
    expect(result.stdout).toContain("items:");
  });
});
