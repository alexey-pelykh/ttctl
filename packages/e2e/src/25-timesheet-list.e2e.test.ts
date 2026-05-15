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

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, timesheet, engagements } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors the pattern from `97-auth-signout-server-side.e2e.test.ts:125-134`
 * — `ConfigLoadSchema` validates the Form-D shape (`auth.token` present).
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

describe("timesheet list (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
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

  // ---------------------------------------------------------------------
  // Wire-shape snapshot assertions (WS-3 / #285).
  //
  // Track 1 structural defense against the PR #275 regression class
  // (`duration` declared `number` while wire returned `string`). Each
  // sub-test calls the core service directly to obtain the post-projection
  // response, then asserts the structural shape against the committed
  // snapshot at `packages/e2e/src/wire-snapshots/<OpName>.snapshot.json`.
  //
  // The projection (`projectListItem`) is a pure field-name pass-through,
  // so the captured shape is structurally equivalent to the wire-level
  // `BillingCycle` at the row level. Outer-envelope drift
  // (`viewer.billingCycles.nodes` rename) is caught upstream as a service
  // crash (`null` access on the unwrap path), not by these snapshots.
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("PendingTimesheets wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await timesheet.list(token);
    if (response.length === 0) {
      process.stderr.write(
        "warning: PendingTimesheets returned 0 rows (test account has no pending cycles) — wire-shape assertion skipped\n",
      );
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "PendingTimesheets",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  it.skipIf(!e2eEnabled)("Timesheets wire shape matches snapshot (--engagement scope)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const engs = await engagements.list(token, { status: "active" });
    if (engs.length === 0) {
      process.stderr.write(
        "warning: no active engagements (test account has none currently) — Timesheets wire-shape assertion skipped\n",
      );
      return;
    }
    const engagementId = engs[0]?.id;
    if (engagementId === undefined) return;
    const response = await timesheet.list(token, { engagement: engagementId });
    if (response.length === 0) {
      process.stderr.write(
        `warning: Timesheets returned 0 rows for engagement ${engagementId} — wire-shape assertion skipped\n`,
      );
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "Timesheets",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });
});
