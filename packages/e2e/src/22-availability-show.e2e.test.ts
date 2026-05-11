// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl availability show` and the sub-group `show`
 * leaves (#146 amended). Mandatory per the project's schema/contract
 * validation rule — validates the read shape of `GetAvailability`
 * (hand-authored query selecting `viewer.viewerRole.{allocatedHours,
 * timeZone, workingTimeFrom, workingTimeTo, availableShiftRangeFrom,
 * availableShiftRangeTo}`) against the live mobile-gateway.
 *
 * The query is hand-authored (not captured verbatim), so the live
 * wire-shape verification is the only authoritative check.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

interface SnapshotShape {
  viewerId?: string;
  timeZone?: { value?: string } | null;
  workingTimeFrom?: string | null;
  workingTimeTo?: string | null;
  availableShiftRangeFrom?: string | null;
  availableShiftRangeTo?: string | null;
  allocatedHours?: number | null;
}

describe("availability show (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the full availability snapshot with all wire fields present", async () => {
    const result = await cli.run(["availability", "show", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const snap = JSON.parse(result.stdout) as SnapshotShape;
    expect(typeof snap.viewerId).toBe("string");
    expect(snap.viewerId?.length ?? 0).toBeGreaterThan(0);
    // Every wire field MUST be present on the result (whether null or a
    // value) — the captured projection on viewerRole selects them all.
    expect("timeZone" in snap).toBe(true);
    expect("workingTimeFrom" in snap).toBe(true);
    expect("workingTimeTo" in snap).toBe(true);
    expect("availableShiftRangeFrom" in snap).toBe(true);
    expect("availableShiftRangeTo" in snap).toBe(true);
    expect("allocatedHours" in snap).toBe(true);
  });

  it.skipIf(!e2eEnabled)(
    "working-hours show subset preserves time-zone + window fields, drops allocatedHours",
    async () => {
      const result = await cli.run(["availability", "working-hours", "show", "-o", "json"]);
      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect("viewerId" in payload).toBe(true);
      expect("timeZone" in payload).toBe(true);
      expect("workingTimeFrom" in payload).toBe(true);
      expect("workingTimeTo" in payload).toBe(true);
      expect("availableShiftRangeFrom" in payload).toBe(true);
      expect("availableShiftRangeTo" in payload).toBe(true);
      expect("allocatedHours" in payload).toBe(false);
    },
  );

  it.skipIf(!e2eEnabled)("allocated-hours show returns a numeric value", async () => {
    const result = await cli.run(["availability", "allocated-hours", "show", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as { allocatedHours?: number };
    expect(typeof payload.allocatedHours).toBe("number");
    if (typeof payload.allocatedHours === "number") {
      expect(payload.allocatedHours).toBeGreaterThanOrEqual(0);
      // Portal UI caps at 80 — server enforces same range. The live
      // value should always satisfy this.
      expect(payload.allocatedHours).toBeLessThanOrEqual(80);
    }
  });

  it.skipIf(!e2eEnabled)("show.viewerId matches working-hours.show.viewerId (same underlying viewer)", async () => {
    const [snapResult, whResult] = await Promise.all([
      cli.run(["availability", "show", "-o", "json"]),
      cli.run(["availability", "working-hours", "show", "-o", "json"]),
    ]);
    expect(snapResult.exitCode).toBe(0);
    expect(whResult.exitCode).toBe(0);

    const snap = JSON.parse(snapResult.stdout) as SnapshotShape;
    const wh = JSON.parse(whResult.stdout) as { viewerId?: string };
    expect(snap.viewerId).toBe(wh.viewerId);
  });
});
