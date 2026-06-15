// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// e2e-covers: JobShow, JobsList, JobsByIDs, GetRecommendedJobs, GetJobMatchQualityMetrics, GetTalentJobRateInsight, GetJobsForDashboard, GetJobsCountForDashboard

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
 *
 * #546: extended to assert the new client-context projection
 * (`foundingYear` joins the existing city/countryName/industry/
 * isEnterprise/teamSize on `JOB_SHOW_QUERY`) AND to run the Track 1
 * `assertWireShapeStable` snapshot diff.
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, jobs } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors the pattern from `30-payments-payouts.e2e.test.ts:43-51`.
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

describe("jobs (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
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
    // Recruiter Fixed rate (#410): every row carries `fixedRate`,
    // shape is Money ({ decimal, verbose }) or null. Most eligibleJobs
    // browse rows the talent hasn't engaged report `null`; IRs and
    // recruiter-pinged jobs report the Money shape.
    expect("fixedRate" in first).toBe(true);
    for (const row of payload.items) {
      const r = row as { fixedRate?: unknown };
      if (r.fixedRate === null || r.fixedRate === undefined) continue;
      expect(typeof r.fixedRate).toBe("object");
      const rate = r.fixedRate as { decimal?: unknown; verbose?: unknown };
      expect(typeof rate.decimal).toBe("string");
      expect(typeof rate.verbose).toBe("string");
    }
  });

  it.skipIf(!e2eEnabled)(
    "jobs show projects fixedRate (Money | null) from activityItem.availabilityRequest.metadata",
    async () => {
      const listResult = await cli.run(["jobs", "list", "-o", "json"]);
      expect(listResult.exitCode).toBe(0);
      const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
      const probeId = listed.items[0]?.id;
      if (probeId === undefined) {
        process.stderr.write("warning: no eligible jobs in test account — jobs show fixedRate assertion skipped\n");
        return;
      }
      const showResult = await cli.run(["jobs", "show", probeId, "-o", "json"]);
      expect(showResult.exitCode).toBe(0);
      const detail = JSON.parse(showResult.stdout) as { fixedRate?: unknown };
      // `fixedRate` MUST be a key on the detail payload; null when the
      // job has no AR for the viewer, Money-shaped when present.
      expect("fixedRate" in detail).toBe(true);
      const fr = detail.fixedRate;
      if (fr === null || fr === undefined) return;
      expect(typeof fr).toBe("object");
      const rate = fr as { decimal?: unknown; verbose?: unknown };
      expect(typeof rate.decimal).toBe("string");
      expect(typeof rate.verbose).toBe("string");
    },
  );

  it.skipIf(!e2eEnabled)("jobs show projects counterparty identity: contacts + pointsOfContact", async () => {
    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const probeId = listed.items[0]?.id;
    if (probeId === undefined) {
      process.stderr.write("warning: no eligible jobs in test account — jobs show contacts assertion skipped\n");
      return;
    }
    const showResult = await cli.run(["jobs", "show", probeId, "-o", "json"]);
    expect(showResult.exitCode).toBe(0);
    const detail = JSON.parse(showResult.stdout) as Record<string, unknown>;

    // `contacts` (client-side hiring managers) and `pointsOfContact`
    // (Toptal-side recruiter) MUST be keys on the detail payload. Both
    // may be empty/null on a sparse account, so populated assertions are
    // conditional; presence + shape checks are unconditional.
    expect("contacts" in detail).toBe(true);
    expect(Array.isArray(detail["contacts"])).toBe(true);
    expect("pointsOfContact" in detail).toBe(true);

    const contacts = detail["contacts"] as Array<Record<string, unknown>>;
    if (contacts.length > 0) {
      // `CompanyRepresentative.fullName: String!` — well-typed, must be a string.
      expect(typeof contacts[0]?.["fullName"]).toBe("string");
    }

    const poc = detail["pointsOfContact"] as Record<string, unknown> | null;
    if (poc !== null) {
      expect("current" in poc).toBe(true);
      const current = poc["current"] as Record<string, unknown> | null;
      if (current !== null) {
        // "Who's the recruiter on this job" — `Recruiter.fullName: String!`.
        expect(typeof current["fullName"]).toBe("string");
      }
    }
  });

  it.skipIf(!e2eEnabled)(
    "jobs show projects client context: foundingYear (added) + countryName / industry / city / isEnterprise / teamSize populate",
    async () => {
      const listResult = await cli.run(["jobs", "list", "-o", "json"]);
      expect(listResult.exitCode).toBe(0);
      const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
      const probeId = listed.items[0]?.id;
      if (probeId === undefined) {
        process.stderr.write(
          "warning: no eligible jobs in test account — jobs show client-context assertions skipped\n",
        );
        return;
      }
      const showResult = await cli.run(["jobs", "show", probeId, "-o", "json"]);
      expect(showResult.exitCode).toBe(0);
      const detail = JSON.parse(showResult.stdout) as Record<string, unknown>;
      const client = detail["client"] as Record<string, unknown> | null | undefined;

      if (client === null || client === undefined) {
        process.stderr.write(
          "warning: client elided on this job — client-context (#546) assertions skipped (sparse-account fixture)\n",
        );
        return;
      }
      // `foundingYear` is the field #546 adds to JOB_SHOW_QUERY's client
      // selection (the other context fields were already shipped).
      expect("foundingYear" in client).toBe(true);
      // Sibling context keys MUST also be present (pre-#546 selections).
      expect("city" in client).toBe(true);
      expect("countryName" in client).toBe(true);
      expect("industry" in client).toBe(true);
      expect("isEnterprise" in client).toBe(true);
      expect("teamSize" in client).toBe(true);
      // `isEnterprise: Boolean!` and `teamSize: TeamSize!` are non-null in the SDL.
      expect(typeof client["isEnterprise"]).toBe("boolean");
      const teamSize = client["teamSize"] as Record<string, unknown> | null;
      expect(teamSize).not.toBeNull();
      if (teamSize !== null) {
        expect("value" in teamSize).toBe(true);
      }
      // `countryName` is the canonical "populates" check from the issue
      // body. Skip the populated-value assertion when the live wire
      // returns `null` (sparse client).
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
  // The `JobShow` op is classified Track 1 in
  // `docs/wire-validation-routing.md`. `assertWireShapeStable` reads
  // `JobShow.snapshot.json` from `packages/e2e/src/wire-snapshots/`; the
  // first run with `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` writes
  // the snapshot.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("JobShow wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const probeId = listed.items[0]?.id;
    if (probeId === undefined) {
      process.stderr.write("warning: no eligible jobs in test account — JobShow wire-shape snapshot skipped\n");
      return;
    }
    const response = await jobs.show(token, probeId);
    expect(() =>
      assertWireShapeStable({
        operationName: "JobShow",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------
  // Track 1 — JobsList wire-shape snapshot diff (#530)
  //
  // `JobsList` is classified Track 1 in `docs/wire-validation-routing.md`.
  // PR #562 fixed the polymorphic-supertype `metadata` selection (wrapping
  // `offeredHourlyRate` in `... on AvailabilityRequestFixedMetadata` after
  // Toptal split `AvailabilityRequestMetadata`) but deferred the snapshot
  // capture; this test closes that deferred T1 gap. The live `jobs.list`
  // call is itself the proof the wrapped selection is accepted — the
  // pre-fix naive selection 400'd (`GRAPHQL_VALIDATION_FAILED`), so a
  // successful return means the fix holds on the live wire.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("JobsList wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await jobs.list(token);
    if (response.items.length === 0) {
      process.stderr.write("warning: no eligible jobs in test account — JobsList wire-shape snapshot skipped\n");
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "JobsList",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------
  // GetRecommendedJobs — algorithmic feed (#472). READ-only, round-trip
  // safe. Schema/contract: hand-authored op against a schema gap
  // (`recommendedJobsV2` is `Unknown`-typed in the synthesized SDL),
  // Track 1. The live call IS the wire proof — a wrong selection or a
  // wrong `$pageSize` scalar 400s (cf. the #138 `PageSize` finding).
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("jobs recommended returns the list envelope with the projection shape", async () => {
    const result = await cli.run(["jobs", "recommended", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { version?: string; items?: unknown };
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      process.stderr.write("warning: no recommended jobs in test account — projection assertions skipped\n");
      return;
    }
    const first = payload.items[0] as Record<string, unknown>;
    for (const key of [
      "id",
      "title",
      "commitment",
      "workType",
      "client",
      "saved",
      "notInterested",
      "viewed",
      "fixedRate",
    ]) {
      expect(key in first).toBe(true);
    }
  });

  it.skipIf(!e2eEnabled)("GetRecommendedJobs wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await jobs.recommended(token);
    if (response.items.length === 0) {
      process.stderr.write(
        "warning: no recommended jobs in test account — GetRecommendedJobs wire-shape snapshot skipped\n",
      );
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "GetRecommendedJobs",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------
  // GetJobMatchQualityMetrics — per-job match-quality breakdown (#473).
  // READ-only, round-trip safe. Schema/contract: hand-authored op against
  // a schema gap (`matchQuality` is `Unknown`-typed in the synthesized
  // Viewer SDL), Track 1. The live call IS the wire proof — a wrong
  // selection 400s.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("jobs match-quality returns the per-criterion metrics breakdown", async () => {
    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const probeId = listed.items[0]?.id;
    if (probeId === undefined) {
      process.stderr.write("warning: no eligible jobs in test account — jobs match-quality assertions skipped\n");
      return;
    }
    const result = await cli.run(["jobs", "match-quality", probeId, "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { metrics?: unknown };
    expect("metrics" in payload).toBe(true);
    expect(Array.isArray(payload.metrics)).toBe(true);
    // metrics may be empty for some jobs (e.g. already-engaged); assert the
    // per-row projection only when the breakdown is populated.
    if (Array.isArray(payload.metrics) && payload.metrics.length > 0) {
      const first = payload.metrics[0] as Record<string, unknown>;
      for (const key of [
        "name",
        "slug",
        "statusV2",
        "description",
        "explanation",
        "isRequired",
        "forAvailabilityRequest",
      ]) {
        expect(key in first).toBe(true);
      }
    }
  });

  it.skipIf(!e2eEnabled)("GetJobMatchQualityMetrics wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const probeId = listed.items[0]?.id;
    if (probeId === undefined) {
      process.stderr.write("warning: no eligible jobs in test account — GetJobMatchQualityMetrics snapshot skipped\n");
      return;
    }
    const response = await jobs.matchQuality(token, probeId);
    if (response.metrics.length === 0) {
      process.stderr.write("warning: empty match-quality metrics — GetJobMatchQualityMetrics snapshot skipped\n");
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "GetJobMatchQualityMetrics",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------
  // GetTalentJobRateInsight — per-job rate-intelligence panel (#474).
  // READ-only, round-trip safe. Schema/contract: hand-authored op against
  // a schema gap (`rateInsight` is `Unknown`-typed in the synthesized
  // Viewer SDL), Track 1. The live call IS the wire proof — a wrong
  // union-member selection 400s. `null` is a valid response (the platform
  // surfaces no insight for already-engaged / ineligible jobs).
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("jobs rate-insight returns the per-job rate insight (or null)", async () => {
    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const probeId = listed.items[0]?.id;
    if (probeId === undefined) {
      process.stderr.write("warning: no eligible jobs in test account — jobs rate-insight assertions skipped\n");
      return;
    }
    const result = await cli.run(["jobs", "rate-insight", probeId, "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown> | null;
    if (payload === null) {
      process.stderr.write(
        "warning: no rate insight surfaced for the probe job — rate-insight shape assertion skipped\n",
      );
      return;
    }
    for (const key of [
      "kind",
      "estimatedRevenue",
      "estimatedRevenueExplanation",
      "longTermDisclaimer",
      "recentApplicationRate",
      "recommendedRate",
    ]) {
      expect(key in payload).toBe(true);
    }
    // The discriminant, when present, is one of the two known variants.
    if (payload["kind"] !== null) {
      expect(["competitive", "uncompetitive"]).toContain(payload["kind"]);
    }
  });

  it.skipIf(!e2eEnabled)("GetTalentJobRateInsight wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const probeId = listed.items[0]?.id;
    if (probeId === undefined) {
      process.stderr.write("warning: no eligible jobs in test account — GetTalentJobRateInsight snapshot skipped\n");
      return;
    }
    const response = await jobs.rateInsight(token, probeId);
    if (response === null) {
      process.stderr.write("warning: no rate insight surfaced — GetTalentJobRateInsight snapshot skipped\n");
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "GetTalentJobRateInsight",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------
  // GetJobsForDashboard + GetJobsCountForDashboard — the "my activity"
  // dashboard projection (#479). READ-only, round-trip safe. Schema/
  // contract: both ops are hand-authored against a schema gap
  // (`jobActivityList` resolves but `JobActivityStatusGroup` is a bare
  // scalar in the synthesized SDL), Track 1. The live call IS the wire
  // proof — a wrong selection or a bad `statusGroup` 400s. The list's
  // `statusGroup: { except: null, only: null }` (no filter) is the
  // specific claim the live call validates.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("jobs dashboard returns the activity-list envelope with the projection shape", async () => {
    const result = await cli.run(["jobs", "dashboard", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { version?: string; items?: unknown };
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      process.stderr.write("warning: no dashboard activity in test account — projection assertions skipped\n");
      return;
    }
    const first = payload.items[0] as Record<string, unknown>;
    for (const key of [
      "id",
      "status",
      "statusGroup",
      "statusColor",
      "lastUpdatedAt",
      "engagement",
      "application",
      "job",
    ]) {
      expect(key in first).toBe(true);
    }
    // The inner `job` rides the shared list projection.
    const job = first["job"] as Record<string, unknown>;
    expect("id" in job).toBe(true);
    expect("title" in job).toBe(true);
  });

  it.skipIf(!e2eEnabled)("GetJobsForDashboard wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await jobs.getJobsForDashboard(token);
    if (response.items.length === 0) {
      process.stderr.write("warning: no dashboard activity in test account — GetJobsForDashboard snapshot skipped\n");
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "GetJobsForDashboard",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  it.skipIf(!e2eEnabled)("jobs dashboard-count returns an integer count for a status group", async () => {
    const result = await cli.run(["jobs", "dashboard-count", "ACTIVE_ENGAGEMENT", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { statusGroup?: string; count?: unknown };
    expect(payload.statusGroup).toBe("ACTIVE_ENGAGEMENT");
    expect(typeof payload.count).toBe("number");
    expect(payload.count as number).toBeGreaterThanOrEqual(0);
  });

  it.skipIf(!e2eEnabled)("GetJobsCountForDashboard wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await jobs.getJobsCountForDashboard(token, "ACTIVE_ENGAGEMENT");
    expect(typeof response).toBe("number");
    expect(() =>
      assertWireShapeStable({
        operationName: "GetJobsCountForDashboard",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------
  // JobsByIDs — batch fetch. Schema/contract: hand-authored op
  // against a schema gap (`viewer.jobs(ids:)` is absent from the
  // synthesized Viewer SDL), Track 1. The live call IS the wire proof:
  // a wrong selection 400s. Also validates the two INFERRED behaviors —
  // input-order re-ordering and missing-id omission — against the wire.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("jobs.showMany batch-fetches real ids in input order (JobsByIDs, Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const ids = listed.items.map((i) => i.id).filter((id): id is string => typeof id === "string");
    if (ids.length === 0) {
      process.stderr.write("warning: no eligible jobs in test account — JobsByIDs snapshot skipped\n");
      return;
    }

    // Use up to two ids, REVERSED from list order, to prove the result
    // follows INPUT order rather than wire order.
    const probe = ids.slice(0, 2).reverse();
    const response = await jobs.showMany(token, probe);

    // Every requested id resolves (these came from `jobs list`), and the
    // result echoes the requested order.
    expect(response.map((j) => j.id)).toEqual(probe);

    // Track 1 wire-shape snapshot of the populated batch result.
    expect(() =>
      assertWireShapeStable({
        operationName: "JobsByIDs",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  it.skipIf(!e2eEnabled)("jobs.showMany unresolvable-id behavior — omit vs whole-batch error", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    const listResult = await cli.run(["jobs", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const realId = listed.items[0]?.id;
    if (typeof realId !== "string") {
      process.stderr.write("warning: no eligible jobs in test account — JobsByIDs missing-id check skipped\n");
      return;
    }

    // The unresolvable-id contract is NOT uniform — live-verified, two
    // classes behave differently and the service propagates whichever the
    // wire does:
    //  (a) an id the wire cannot decode to a job is silently DROPPED, so
    //      the batch returns a partial result (the real id only).
    const undecodableId = `${realId}-ttctl-nonexistent-zzz`;
    const partial = await jobs.showMany(token, [realId, undecodableId]);
    expect(partial.map((j) => j.id)).toEqual([realId]);

    //  (b) a cleanly-decodable-but-nonexistent id makes the wire reject
    //      the WHOLE batch with GRAPHQL_ERROR("Invalid ids") — the valid
    //      id in the same call yields nothing.
    const decodableMissingId = "VjEtSm9iLTAwMDAwMA"; // base64("V1-Job-000000")
    await expect(jobs.showMany(token, [realId, decodableMissingId])).rejects.toThrow(/Invalid ids/);
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

  // Toptal job IDs are base64-encoded (e.g. `VjEtSm9iLTQ5MzY4OA`).
  // The mobile-gateway has TWO error shapes for "no such job":
  //   1. valid-format-but-non-existent → `viewer.eligibleJob = null`
  //   2. malformed/unparseable ID       → GraphQL error `"Invalid ID"`
  // Both must collapse to `NOT_FOUND` on the user-visible envelope.
  // See #166 — case 2 originally fell through as `GRAPHQL_ERROR`.

  it.skipIf(!e2eEnabled)("jobs show returns NOT_FOUND for a valid-format non-existent id", async () => {
    // Valid base64 shape, but a job number guaranteed not to exist.
    // Exercises the `viewer.eligibleJob === null` branch.
    const fakeId = "VjEtSm9iLTk5OTk5OTk5OQ";
    const result = await cli.run(["jobs", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });

  it.skipIf(!e2eEnabled)("jobs show returns NOT_FOUND for a malformed id", async () => {
    // Wrong-format ID — the live API rejects with `Invalid ID` BEFORE
    // performing lookup. This case originally bypassed the regex
    // and surfaced as `GRAPHQL_ERROR`; #166 collapsed it to `NOT_FOUND`.
    const malformedId = "job_00000000000000000000000000000000";
    const result = await cli.run(["jobs", "show", malformedId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });

  // -------------------------------------------------------------------
  // Dry-run E2E coverage (issue #162)
  //
  // Mandatory per CLAUDE.md § Schema/contract validation rule — wiring
  // `--dry-run` through inferred mutation operations REQUIRES live
  // verification before merge. Because the dry-run path has zero
  // side effects by construction (transport never called), all 7
  // mutating leaves can be exercised in a single E2E run safely.
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

  it.skipIf(!e2eEnabled)("jobs save --dry-run emits the dry-run envelope without server side effects", async () => {
    const result = await cli.run(["--dry-run", "jobs", "save", "fake-job-id", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as DryRunEnvelope;
    assertDryRunEnvelope(payload, "jobs.save", "JobMarkSaved");
    expect(payload.preview?.variables).toEqual({ jobID: "fake-job-id" });
    // Stderr should be silent (no read-no-op note — leaf was markMutation'd).
    expect(result.stderr).not.toContain("no-op for read commands");
  });

  it.skipIf(!e2eEnabled)("jobs unsave --dry-run emits the dry-run envelope (wire op = JobClearInterest)", async () => {
    const result = await cli.run(["--dry-run", "jobs", "unsave", "fake-job-id", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as DryRunEnvelope;
    // CLI verb = "jobs.unsave"; wire operation = "JobClearInterest" (delegated).
    assertDryRunEnvelope(payload, "jobs.unsave", "JobClearInterest");
    expect(payload.preview?.variables).toEqual({ jobID: "fake-job-id" });
    expect(result.stderr).not.toContain("no-op for read commands");
  });

  it.skipIf(!e2eEnabled)("jobs mark-viewed --dry-run emits the dry-run envelope", async () => {
    const result = await cli.run(["--dry-run", "jobs", "mark-viewed", "fake-job-id", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as DryRunEnvelope;
    assertDryRunEnvelope(payload, "jobs.mark-viewed", "JobMarkViewed");
    expect(payload.preview?.variables).toEqual({ jobID: "fake-job-id" });
    expect(result.stderr).not.toContain("no-op for read commands");
  });

  it.skipIf(!e2eEnabled)("jobs not-interested --dry-run preserves the --reason in preview variables", async () => {
    const result = await cli.run([
      "--dry-run",
      "jobs",
      "not-interested",
      "fake-job-id",
      "--reason",
      "low_rate",
      "-o",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as DryRunEnvelope;
    assertDryRunEnvelope(payload, "jobs.not-interested", "JobMarkNotInterested");
    expect(payload.preview?.variables).toEqual({ jobID: "fake-job-id", reason: "low_rate" });
    expect(result.stderr).not.toContain("no-op for read commands");
  });

  it.skipIf(!e2eEnabled)("jobs clear-interest --dry-run emits the dry-run envelope", async () => {
    const result = await cli.run(["--dry-run", "jobs", "clear-interest", "fake-job-id", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as DryRunEnvelope;
    assertDryRunEnvelope(payload, "jobs.clear-interest", "JobClearInterest");
    expect(payload.preview?.variables).toEqual({ jobID: "fake-job-id" });
    expect(result.stderr).not.toContain("no-op for read commands");
  });

  it.skipIf(!e2eEnabled)(
    "jobs search save --dry-run emits the dry-run envelope (wire op = JobSearchSubscriptionStart)",
    async () => {
      const result = await cli.run(["--dry-run", "jobs", "search", "save", "--skill", "React", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as DryRunEnvelope;
      assertDryRunEnvelope(payload, "jobs.search.save", "JobSearchSubscriptionStart");
      expect(payload.preview?.variables["skills"]).toEqual(["React"]);
      expect(result.stderr).not.toContain("no-op for read commands");
    },
  );

  it.skipIf(!e2eEnabled)(
    "jobs search remove --dry-run emits the dry-run envelope (wire op = JobSearchSubscriptionTerminate)",
    async () => {
      const result = await cli.run(["--dry-run", "jobs", "search", "remove", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as DryRunEnvelope;
      assertDryRunEnvelope(payload, "jobs.search.remove", "JobSearchSubscriptionTerminate");
      expect(payload.preview?.variables).toEqual({});
      expect(result.stderr).not.toContain("no-op for read commands");
    },
  );

  // -------------------------------------------------------------------
  // Pagination E2E coverage (issue #138)
  //
  // Mandatory per CLAUDE.md § Schema/contract validation rule — the
  // pre-#138 `JOBS_LIST_QUERY` operation hardcoded `page: 0, pageSize:
  // 20`; this PR converts to `$page: Int!, $pageSize: Int!` variables.
  // The new wire-shape claim ("eligibleJobs accepts these as
  // variables") needs live verification. Unit tests with mocks confirm
  // the variable-substitution AT OUR SIDE only.
  //
  // Two assertions:
  //   1. Different pages return DIFFERENT entities — proves the server
  //      honored the `page` variable rather than ignoring it and
  //      returning a single fixed slice.
  //   2. `--per-page 5` limits the result set to ≤ 5 items AND the
  //      `pageInfo.perPage` envelope field reflects the request.
  //
  // Skip conditions: test account has < 6 eligible jobs (insufficient
  // to fill 2 pages of size 5) — the test prints a stderr warning and
  // returns.
  // -------------------------------------------------------------------

  interface ListEnvelope {
    version?: string;
    items?: Array<{ id?: string }>;
    pageInfo?: {
      currentPage?: number;
      perPage?: number;
      totalPages?: number;
      hasNextPage?: boolean;
    };
  }

  it.skipIf(!e2eEnabled)("jobs list --per-page 5 surfaces offset-style pageInfo and limits items", async () => {
    const result = await cli.run(["jobs", "list", "--page", "1", "--per-page", "5", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as ListEnvelope;
    expect(payload.version).toBe("1.0");
    expect(Array.isArray(payload.items)).toBe(true);

    // Server may return fewer than --per-page items if the test
    // account has < 5 eligible jobs total. In either case items must
    // not exceed perPage.
    if (Array.isArray(payload.items)) {
      expect(payload.items.length).toBeLessThanOrEqual(5);
    }

    // pageInfo MUST be present when --page/--per-page were passed —
    // even if the result set is empty, the envelope reflects the
    // request.
    expect(payload.pageInfo).toBeDefined();
    expect(payload.pageInfo?.currentPage).toBe(1);
    expect(payload.pageInfo?.perPage).toBe(5);
    // totalPages and hasNextPage derived from totalCount; both
    // present as the server always returns totalCount.
    expect(typeof payload.pageInfo?.totalPages).toBe("number");
    expect(typeof payload.pageInfo?.hasNextPage).toBe("boolean");
  });

  it.skipIf(!e2eEnabled)(
    "jobs list with --page 1 vs --page 2 returns DIFFERENT entities (server honors page variable)",
    async () => {
      // Use the default sort; eligibleJobs' default surface is stable
      // enough across consecutive paged fetches for the "at least one
      // different" assertion below. (--sort posted_at also works but
      // adds no value here.)
      const sharedArgs = ["jobs", "list", "--per-page", "5", "-o", "json"];
      const page1Result = await cli.run([...sharedArgs, "--page", "1"]);
      expect(page1Result.exitCode).toBe(0);
      const page1 = JSON.parse(page1Result.stdout) as ListEnvelope;

      // Need ≥ 6 jobs to fill 2 pages of size 5 with distinguishable
      // content. If there's only one page worth of data, the test
      // can't prove pagination — skip with a stderr warning.
      if (!page1.pageInfo?.hasNextPage) {
        process.stderr.write(
          `warning: test account has only one page of eligible jobs (totalCount fits in one --per-page=5 slice); pagination diff assertion skipped\n`,
        );
        return;
      }

      const page2Result = await cli.run([...sharedArgs, "--page", "2"]);
      expect(page2Result.exitCode).toBe(0);
      const page2 = JSON.parse(page2Result.stdout) as ListEnvelope;
      expect(page2.pageInfo?.currentPage).toBe(2);

      const page1Ids = new Set(
        (page1.items ?? []).map((j) => j.id).filter((id): id is string => typeof id === "string"),
      );
      const page2Ids = new Set(
        (page2.items ?? []).map((j) => j.id).filter((id): id is string => typeof id === "string"),
      );
      expect(page1Ids.size).toBeGreaterThan(0);
      expect(page2Ids.size).toBeGreaterThan(0);
      // At least one id on page 2 must NOT be on page 1 — proves the
      // server honored the page variable and returned a different
      // slice. We don't require strict partitioning (zero overlap)
      // because eligibleJobs' sort surfaces can still have ties even
      // under a stable sortTarget, and the same id can occasionally
      // appear on adjacent pages near the partition boundary. The
      // contract we're proving is "navigation", not "strict
      // partition".
      const distinct = [...page2Ids].filter((id) => !page1Ids.has(id));
      expect(distinct.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!e2eEnabled)("jobs list pretty footer renders 'Page X of Y' when paginated", async () => {
    const result = await cli.run(["jobs", "list", "--page", "1", "--per-page", "5"]);
    expect(result.exitCode).toBe(0);
    // Pretty output: the table is followed by the footer line.
    // When items is empty (no eligible jobs), the empty-state CTA
    // wrapper fires before the footer renderer — skip the assertion
    // in that case.
    if (result.stdout.includes("No jobs") || result.stdout.includes("(no")) {
      process.stderr.write("warning: test account has no eligible jobs; pretty-footer assertion skipped\n");
      return;
    }
    expect(result.stdout).toMatch(/Page 1 of \d+ \(per_page=5\)/);
  });

  it.skipIf(!e2eEnabled)("engagements list pretty footer renders 'Page X of Y' when paginated", async () => {
    const result = await cli.run(["engagements", "list", "--page", "1", "--per-page", "5"]);
    expect(result.exitCode).toBe(0);
    if (result.stdout.includes("No engagements") || result.stdout.includes("(no")) {
      process.stderr.write("warning: test account has no engagements; pretty-footer assertion skipped\n");
      return;
    }
    expect(result.stdout).toMatch(/Page 1 of \d+ \(per_page=5\)/);
  });
});
