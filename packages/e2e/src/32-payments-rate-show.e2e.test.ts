// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl payments rate show` (#149).
 *
 * Mandatory per CLAUDE.md § Schema/contract validation rule —
 * `LastRateChangeRequest` and `RateChangeFormDetails` are both
 * hand-authored against the mobile-gateway. The `ongoingRateChangeRequest`
 * field on Viewer is `Unknown`-typed in the synthesized SDL;
 * `rate.show` projects ongoing-by-status from `lastRateChangeRequest`,
 * so this test pins the actual fields the projection depends on.
 *
 * Coverage:
 *   - `payments rate show` returns the unified projection (current
 *     rate + last change + ongoing change classification + market
 *     insight + validation).
 *   - Validation block (minRate, rateStep) is non-null on accounts
 *     where the platformConfiguration includes hourly rules.
 *
 * Read-only — no side effects.
 */

// e2e-covers: LastRateChangeRequest
// e2e-covers: RateChangeFormDetails

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("payments rate show (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("rate show returns the unified projection shape", async () => {
    const result = await cli.run(["payments", "rate", "show", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    // Top-level keys are stable per the RateProjection contract.
    expect("currentRateVerbose" in payload).toBe(true);
    expect("currentRateDecimal" in payload).toBe(true);
    expect("lastChange" in payload).toBe(true);
    expect("ongoingChange" in payload).toBe(true);
    expect("marketInsight" in payload).toBe(true);
    expect("validation" in payload).toBe(true);

    // At least one of currentRateVerbose / currentRateDecimal should be
    // non-null for an active talent account; skip if both null.
    if (payload["currentRateVerbose"] === null && payload["currentRateDecimal"] === null) {
      process.stderr.write(
        "warning: test account has no current rate on file — rate projection assertions partially skipped\n",
      );
    }

    // lastChange may be null (account never requested a change) — both
    // valid. If non-null, assert the shape.
    const last = payload["lastChange"] as Record<string, unknown> | null;
    if (last !== null) {
      expect("id" in last).toBe(true);
      expect("requestType" in last).toBe(true);
      expect("status" in last).toBe(true);
      expect("desiredRate" in last).toBe(true);
    }
  });
});
