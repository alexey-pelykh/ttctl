// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl engagements breaks {list, add, remove}` (#147).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * specifically the rule's "live integration test" trigger for
 * mutations whose input shape was inferred from the captured operation
 * pattern. `CreateEngagementBreak` and `CancelEngagementBreak` are the
 * mutation paths; this file is the live verification of their wire
 * contract.
 *
 * Coverage:
 *   - `breaks list` returns the v0.4 list envelope and per-row
 *     projection (id, startDate, endDate, comment, operations).
 *   - `breaks add` round-trip: schedule a break with far-future dates,
 *     verify it appears in `breaks list`, then `breaks remove` it and
 *     verify it disappears.
 *   - Far-future dates (≈ 2 years out) ensure the test does NOT collide
 *     with real planned time-off in the test account. The break id is
 *     captured for cleanup so a partial run leaves no stale break.
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - Test account has zero active engagements.
 *   - The `breaks list` call surfaces an existing break that overlaps
 *     the chosen far-future window (collision: skip; the user should
 *     pick a non-overlapping window or clean up the existing break).
 *
 * **Safety**: the round-trip is gated on TTCTL_E2E=1 alongside the
 * read-side tests. There is no separate write-only env gate; the
 * operations are designed to be idempotent (add+remove is a no-op
 * net effect) and use far-future dates to avoid collision.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Far-future window for the round-trip test. Computed at module-import
 * time; "today + 2 years" → "today + 2 years + 7 days" gives a 7-day
 * break that's unlikely to collide with real plans.
 */
function farFutureWindow(): { startDate: string; endDate: string } {
  const today = new Date();
  const start = new Date(today.getTime());
  start.setFullYear(start.getFullYear() + 2);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 7);
  return {
    startDate: formatYmd(start),
    endDate: formatYmd(end),
  };
}

function formatYmd(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("engagements breaks (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("round-trips breaks add → list → remove against a real active engagement", async () => {
    // Step 1: find an active engagement.
    const listResult = await cli.run(["engagements", "list", "--status", "active", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const engagements = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const engagementId = engagements.items[0]?.id;
    if (engagementId === undefined) {
      process.stderr.write("warning: no active engagements in test account — breaks round-trip skipped\n");
      return;
    }

    // Step 2: choose a far-future window to avoid colliding with real plans.
    const { startDate, endDate } = farFutureWindow();

    // Step 3: snapshot existing breaks (so the post-add diff is unambiguous).
    const preBreaksResult = await cli.run(["engagements", "breaks", "list", engagementId, "-o", "json"]);
    expect(preBreaksResult.exitCode).toBe(0);
    const preBreaks = JSON.parse(preBreaksResult.stdout) as { items: Array<{ id?: string }> };
    const preIds = new Set(preBreaks.items.map((b) => b.id).filter((id): id is string => typeof id === "string"));

    // Collision guard: if any existing break overlaps the chosen window,
    // skip rather than create a doomed mutation.
    const overlappingExisting = preBreaks.items.some((b) => {
      const bStart = (b as Record<string, unknown>)["startDate"];
      const bEnd = (b as Record<string, unknown>)["endDate"];
      if (typeof bStart !== "string" || typeof bEnd !== "string") return false;
      return bStart <= endDate && bEnd >= startDate;
    });
    if (overlappingExisting) {
      process.stderr.write(
        `warning: existing break overlaps far-future window ${startDate}..${endDate} — round-trip skipped\n`,
      );
      return;
    }

    // Step 4: add the break.
    // `--reason-id other` is the catch-all identifier from the
    // `platformConfiguration.engagementBreakReasons` catalog (known
    // canonical values: `talent_on_vacation`, `client_needs_preparation`,
    // `client_on_vacation`, `other`). The server rejects empty
    // reasonIdentifier with `code=blank, key=reasonId`, so the CLI
    // surface marks `--reason-id` as required.
    const addResult = await cli.run([
      "engagements",
      "breaks",
      "add",
      engagementId,
      "--from",
      startDate,
      "--to",
      endDate,
      "--reason-id",
      "other",
      "--comment",
      "ttctl e2e test (auto-cleanup attempted)",
      "-o",
      "json",
    ]);
    expect(addResult.exitCode).toBe(0);
    const addPayload = JSON.parse(addResult.stdout) as {
      ok?: boolean;
      operation?: string;
      created?: { id?: string; startDate?: string; endDate?: string };
    };
    expect(addPayload.ok).toBe(true);
    expect(addPayload.operation).toBe("engagements.breaks.add");
    const newBreakId = addPayload.created?.id;
    expect(typeof newBreakId).toBe("string");
    if (typeof newBreakId !== "string") return;
    expect(addPayload.created?.startDate).toBe(startDate);
    expect(addPayload.created?.endDate).toBe(endDate);

    try {
      // Step 5: verify the new break appears in `breaks list`.
      const postBreaksResult = await cli.run(["engagements", "breaks", "list", engagementId, "-o", "json"]);
      expect(postBreaksResult.exitCode).toBe(0);
      const postBreaks = JSON.parse(postBreaksResult.stdout) as { items: Array<{ id?: string }> };
      const postIds = new Set(postBreaks.items.map((b) => b.id).filter((id): id is string => typeof id === "string"));
      expect(postIds.has(newBreakId)).toBe(true);
      expect(postIds.size).toBe(preIds.size + 1);
    } finally {
      // Step 6 (always-runs): remove the break, regardless of whether the
      // post-add list assertion passed. The cleanup MUST run to avoid
      // polluting the test account with stale breaks.
      const removeResult = await cli.run(["engagements", "breaks", "remove", newBreakId, "-o", "json"]);
      expect(removeResult.exitCode).toBe(0);
      const removePayload = JSON.parse(removeResult.stdout) as {
        ok?: boolean;
        operation?: string;
        removed?: { id?: string };
      };
      expect(removePayload.ok).toBe(true);
      expect(removePayload.operation).toBe("engagements.breaks.remove");
      expect(removePayload.removed?.id).toBe(newBreakId);

      // Step 7: verify the break is gone from `breaks list`.
      const finalBreaksResult = await cli.run(["engagements", "breaks", "list", engagementId, "-o", "json"]);
      expect(finalBreaksResult.exitCode).toBe(0);
      const finalBreaks = JSON.parse(finalBreaksResult.stdout) as { items: Array<{ id?: string }> };
      const finalIds = new Set(finalBreaks.items.map((b) => b.id).filter((id): id is string => typeof id === "string"));
      expect(finalIds.has(newBreakId)).toBe(false);
      expect(finalIds.size).toBe(preIds.size);
    }
  });

  it.skipIf(!e2eEnabled)("breaks list returns NOT_FOUND for an unknown engagement id", async () => {
    const fakeId = "act_00000000000000000000000000000000";
    const result = await cli.run(["engagements", "breaks", "list", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });

  // -------------------------------------------------------------------
  // Dry-run E2E coverage (issue #163)
  //
  // Mandatory per CLAUDE.md § Schema/contract validation rule — wiring
  // `--dry-run` through inferred mutation operations
  // (`CreateEngagementBreak`, `CancelEngagementBreak`) REQUIRES live
  // verification before merge. Because the dry-run path has zero side
  // effects by construction (transport never called — including the
  // `EngagementBreaks` prefetch in `breaks add`), both mutating leaves
  // can be exercised in a single E2E run safely without any account
  // state mutation.
  //
  // Each assertion verifies:
  //   - exitCode === 0
  //   - JSON envelope has `dryRun: true`
  //   - envelope's `operation` matches the leaf
  //   - `preview.operationName` matches the wire operation per the
  //     issue's mapping table (this is the CRITICAL wire-shape AC)
  //   - `preview.surface === "mobile-gateway"`
  //   - `preview.transport === "stock"`
  //   - bearer redacted in `preview.headers.authorization`
  // -------------------------------------------------------------------

  interface DryRunEnvelope {
    ok?: boolean;
    version?: string;
    operation?: string;
    dryRun?: boolean;
    notice?: string;
    preview?: {
      operationName?: string;
      surface?: string;
      transport?: string;
      variables?: Record<string, unknown>;
      headers?: Record<string, string>;
    };
  }

  function assertDryRunEnvelope(
    payload: DryRunEnvelope,
    expectedOperation: string,
    expectedWireOperation: string,
  ): void {
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe("1.0");
    expect(payload.dryRun).toBe(true);
    expect(payload.operation).toBe(expectedOperation);
    expect(payload.preview?.operationName).toBe(expectedWireOperation);
    expect(payload.preview?.surface).toBe("mobile-gateway");
    expect(payload.preview?.transport).toBe("stock");
    // Bearer redaction — the captured session token MUST NOT leak.
    expect(payload.preview?.headers?.["authorization"]).toBe("Token token=<redacted>");
  }

  it.skipIf(!e2eEnabled)(
    "engagements breaks add --dry-run emits the dry-run envelope without server side effects (prefetch skipped)",
    async () => {
      // Use a synthetic activity-item id — the dry-run path skips the
      // prefetch, so no live engagement is needed. The preview will
      // carry the synthetic id as the `engagementId` placeholder per
      // the deferred-resolution semantics.
      const result = await cli.run([
        "--dry-run",
        "engagements",
        "breaks",
        "add",
        "act-fake-engagement-id",
        "--from",
        "2030-01-01",
        "--to",
        "2030-01-08",
        "--reason-id",
        "talent_on_vacation",
        "--comment",
        "dry-run preview",
        "-o",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as DryRunEnvelope;
      assertDryRunEnvelope(payload, "engagements.breaks.add", "CreateEngagementBreak");
      expect(payload.preview?.variables).toEqual({
        engagementId: "act-fake-engagement-id",
        startDate: "2030-01-01",
        endDate: "2030-01-08",
        reasonIdentifier: "talent_on_vacation",
        comment: "dry-run preview",
      });
      // Notice surfaces the deferred-resolution caveat.
      expect(typeof payload.notice).toBe("string");
      expect(payload.notice).toContain("placeholder");
      // Stderr should be silent (no read-no-op note — leaf was markMutation'd).
      expect(result.stderr).not.toContain("no-op for read commands");
    },
  );

  it.skipIf(!e2eEnabled)(
    "engagements breaks remove --dry-run emits the dry-run envelope without server side effects",
    async () => {
      // Use a synthetic break id — no live break is needed since the
      // mutation is never sent on dry-run.
      const result = await cli.run(["--dry-run", "engagements", "breaks", "remove", "br-fake-break-id", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as DryRunEnvelope;
      assertDryRunEnvelope(payload, "engagements.breaks.remove", "CancelEngagementBreak");
      expect(payload.preview?.variables).toEqual({ engagementBreakId: "br-fake-break-id" });
      // Stderr should be silent (no read-no-op note — leaf was markMutation'd).
      expect(result.stderr).not.toContain("no-op for read commands");
    },
  );
});
