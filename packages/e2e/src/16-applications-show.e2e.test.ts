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

  // -------------------------------------------------------------------
  // Recruiter Fixed rate projection (#410) — live wire-shape assertion
  // for the detail-view selection set.
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("show projects fixedRate (Money | null) from availabilityRequest.metadata", async () => {
    // Prefer an ON_RECRUITER_REVIEW row so the AR-side path is
    // exercised; fall back to any first row if the IR pool is empty.
    const irList = await cli.run(["applications", "list", "--status-group", "ON_RECRUITER_REVIEW", "-o", "json"]);
    expect(irList.exitCode).toBe(0);
    const irItems = JSON.parse(irList.stdout) as { items: Array<{ id?: string }> };
    let probeId: string | undefined = irItems.items[0]?.id;
    if (probeId === undefined) {
      const fallback = await cli.run(["applications", "list", "-o", "json"]);
      const fbItems = JSON.parse(fallback.stdout) as { items: Array<{ id?: string }> };
      probeId = fbItems.items[0]?.id;
    }
    expect(probeId).toBeDefined();
    if (probeId === undefined) return;

    const detail = await cli.run(["applications", "show", probeId, "-o", "json"]);
    expect(detail.exitCode).toBe(0);
    const payload = JSON.parse(detail.stdout) as {
      fixedRate?: unknown;
      availabilityRequest?: Record<string, unknown> | null;
    };
    // `fixedRate` MUST be a key on the detail payload — `null` when
    // no AR or no metadata; Money-shaped when present.
    expect("fixedRate" in payload).toBe(true);
    const fr = payload.fixedRate;
    if (fr === null) return;
    expect(typeof fr).toBe("object");
    const rate = fr as { decimal?: unknown; verbose?: unknown };
    expect(typeof rate.decimal).toBe("string");
    expect(typeof rate.verbose).toBe("string");
  });

  // -------------------------------------------------------------------
  // Embedded AR projection on show (#539)
  //
  // The `availabilityRequest { ... }` sub-selection on the
  // `JobActivityItem` detail operation carries the talent-response
  // triple + recruiter identity. INFERRED fields (`rejectReason` /
  // `recruiter`) need live verification per the schema/contract rule.
  // The assertion is tolerant of pre-response rows: keys present +
  // shape correct when populated.
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("show surfaces the embedded AR projection keys when an AR is present", async () => {
    // Prefer an ON_RECRUITER_REVIEW row (carries an AR); fall back to
    // the first row otherwise.
    const irList = await cli.run(["applications", "list", "--status-group", "ON_RECRUITER_REVIEW", "-o", "json"]);
    expect(irList.exitCode).toBe(0);
    const irItems = JSON.parse(irList.stdout) as { items: Array<{ id?: string }> };
    const probeId = irItems.items[0]?.id;
    if (probeId === undefined) {
      process.stderr.write(
        "[16-applications-show] No ON_RECRUITER_REVIEW row available; embedded-AR projection assertion skipped.\n",
      );
      return;
    }

    const detail = await cli.run(["applications", "show", probeId, "-o", "json"]);
    expect(detail.exitCode).toBe(0);
    const payload = JSON.parse(detail.stdout) as { availabilityRequest?: Record<string, unknown> | null };
    const ar = payload.availabilityRequest;
    if (ar === null || ar === undefined) {
      process.stderr.write(
        "[16-applications-show] Probe row carries no AR; embedded-AR projection assertion skipped.\n",
      );
      return;
    }
    for (const key of ["id", "talentComment", "requestedHourlyRate", "rejectReason", "recruiter"]) {
      expect(key in ar).toBe(true);
    }
    const recruiter = ar["recruiter"];
    if (recruiter !== null && recruiter !== undefined) {
      const rec = recruiter as Record<string, unknown>;
      for (const k of ["firstName", "lastName", "fullName"]) {
        expect(k in rec).toBe(true);
      }
    }
  });

  // -------------------------------------------------------------------
  // mostRelevantApplication projection on show (#547)
  //
  // `TalentJobActivityItem.mostRelevantApplication: AvailabilityRequest`
  // is well-typed (no INFERRED risk), but the field rides the same
  // hand-authored `JobActivityItem` op (T1 / GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS),
  // so a live call is the authority on the wire shape. Tolerant: the key
  // MUST be present on the detail payload; `{ id: string }` when an AR is
  // the platform's "most relevant" pick, `null` for rows with no AR.
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("show surfaces mostRelevantApplication (id-only | null)", async () => {
    // Prefer an ON_RECRUITER_REVIEW row (carries an AR → likely a
    // non-null mostRelevantApplication); fall back to the first row.
    const irList = await cli.run(["applications", "list", "--status-group", "ON_RECRUITER_REVIEW", "-o", "json"]);
    expect(irList.exitCode).toBe(0);
    const irItems = JSON.parse(irList.stdout) as { items: Array<{ id?: string }> };
    let probeId: string | undefined = irItems.items[0]?.id;
    if (probeId === undefined) {
      const fallback = await cli.run(["applications", "list", "-o", "json"]);
      const fbItems = JSON.parse(fallback.stdout) as { items: Array<{ id?: string }> };
      probeId = fbItems.items[0]?.id;
    }
    expect(probeId).toBeDefined();
    if (probeId === undefined) return;

    const detail = await cli.run(["applications", "show", probeId, "-o", "json"]);
    expect(detail.exitCode).toBe(0);
    const payload = JSON.parse(detail.stdout) as { mostRelevantApplication?: unknown };
    // Key MUST be present — the projection always sets it (null or { id }).
    expect("mostRelevantApplication" in payload).toBe(true);
    const mra = payload.mostRelevantApplication;
    if (mra === null) return;
    expect(typeof mra).toBe("object");
    const ref = mra as { id?: unknown };
    expect(typeof ref.id).toBe("string");
  });
});
