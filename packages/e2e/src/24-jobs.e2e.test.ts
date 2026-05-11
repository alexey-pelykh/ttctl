// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl jobs` (#148).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * the jobs service hand-authors every operation against a schema gap
 * region (rich filter args on `eligibleJobs`, `searchSubscription`
 * cardinality). Mutation paths (`MarkJobAsSaved`,
 * `ClearJobInterestStatus`) trigger the rule specifically.
 *
 * Coverage:
 *   - `jobs list` returns the v0.4 list envelope with the projected
 *     fields (id, title, client, commitment, etc.).
 *   - Round-trip: `jobs save` → `jobs saved` (verify presence) →
 *     `jobs unsave` (clears via `ClearJobInterestStatus`) → `jobs
 *     saved` (verify absent). This exercises both the save mutation
 *     AND the saved-filter list path.
 *   - `jobs show` for an unknown id returns the NOT_FOUND envelope.
 *
 * **Skip conditions** (silent — emit a stderr warning):
 *   - Test account has zero eligible jobs (the round-trip skips).
 *
 * **Safety**: the round-trip targets a job already returned by
 * `jobs list`. The save/unsave pair is net-neutral — provided unsave
 * runs, the test leaves the account in the same state it started.
 * The cleanup is in a `finally` block so a mid-test failure still
 * runs the unsave.
 *
 * **What's NOT covered here** (deliberate, scope-bounded):
 *   - `not-interested` mutation — same wire-shape pattern as `save`;
 *     covering both would double the side-effect surface for no extra
 *     contract verification.
 *   - `search` subscription mutations — touch viewer-level state that
 *     can affect job-alert email notifications; left to manual
 *     verification per the live-API session.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("jobs (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("jobs list returns the v0.4 list envelope with at least the projection shape", async () => {
    const result = await cli.run(["jobs", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as { version?: string; items?: unknown };
    expect(typeof payload).toBe("object");
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      process.stderr.write("warning: no eligible jobs in test account — jobs list projection assertions skipped\n");
      return;
    }

    const first = payload.items[0] as Record<string, unknown>;
    expect("id" in first).toBe(true);
    expect("title" in first).toBe(true);
    expect("commitment" in first).toBe(true);
    expect("workType" in first).toBe(true);
    expect("client" in first).toBe(true);
    // Interest-state flags are part of every row's projection.
    expect("saved" in first).toBe(true);
    expect("notInterested" in first).toBe(true);
    expect("viewed" in first).toBe(true);
  });

  it.skipIf(!e2eEnabled)("round-trips save → saved → unsave → saved against a real job", async () => {
    // Step 1: find a job to use as the round-trip subject.
    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as {
      items: Array<{ id?: string; saved?: boolean | null }>;
    };
    // Prefer a job that is NOT already saved so the round-trip's net
    // effect is "back to original state" (not "still saved after").
    const target = listed.items.find((j) => j.saved !== true);
    if (target?.id === undefined) {
      process.stderr.write("warning: no unsaved eligible jobs in test account — jobs save round-trip skipped\n");
      return;
    }
    const jobId = target.id;

    // Step 2: save the job.
    const saveResult = await cli.run(["jobs", "save", jobId, "-o", "json"]);
    expect(saveResult.exitCode).toBe(0);
    const savePayload = JSON.parse(saveResult.stdout) as {
      ok?: boolean;
      operation?: string;
      updated?: { id?: string; saved?: boolean | null };
    };
    expect(savePayload.ok).toBe(true);
    expect(savePayload.operation).toBe("jobs.save");
    expect(savePayload.updated?.id).toBe(jobId);
    expect(savePayload.updated?.saved).toBe(true);

    try {
      // Step 3: verify the job appears in `jobs saved`.
      const savedListResult = await cli.run(["jobs", "saved", "-o", "json"]);
      expect(savedListResult.exitCode).toBe(0);
      const savedListed = JSON.parse(savedListResult.stdout) as { items: Array<{ id?: string }> };
      const savedIds = new Set(savedListed.items.map((j) => j.id).filter((id): id is string => typeof id === "string"));
      expect(savedIds.has(jobId)).toBe(true);
    } finally {
      // Step 4 (always-runs): unsave the job. Cleanup MUST run.
      const unsaveResult = await cli.run(["jobs", "unsave", jobId, "-o", "json"]);
      expect(unsaveResult.exitCode).toBe(0);
      const unsavePayload = JSON.parse(unsaveResult.stdout) as {
        ok?: boolean;
        operation?: string;
        removed?: { id?: string };
      };
      expect(unsavePayload.ok).toBe(true);
      expect(unsavePayload.operation).toBe("jobs.unsave");
      expect(unsavePayload.removed?.id).toBe(jobId);

      // Step 5: verify the job is gone from `jobs saved`.
      const finalSavedResult = await cli.run(["jobs", "saved", "-o", "json"]);
      expect(finalSavedResult.exitCode).toBe(0);
      const finalSaved = JSON.parse(finalSavedResult.stdout) as { items: Array<{ id?: string }> };
      const finalIds = new Set(finalSaved.items.map((j) => j.id).filter((id): id is string => typeof id === "string"));
      expect(finalIds.has(jobId)).toBe(false);
    }
  });

  it.skipIf(!e2eEnabled)("jobs show returns NOT_FOUND for an unknown id", async () => {
    const fakeId = "job_00000000000000000000000000000000";
    const result = await cli.run(["jobs", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });
});
