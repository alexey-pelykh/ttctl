// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl availability working-hours set` and
 * `ttctl availability allocated-hours set` (#146 amended). Mandatory
 * per the project's schema/contract validation rule — these mutations
 * are the inferred-input contracts that must be verified against the
 * live API:
 *
 *   - `UpdateWorkingHours` — `UpdateWorkingHoursInput` is a documented
 *     schema gap (`_placeholder: String`); the input shape used here
 *     (`{ timeZone?, workingTimeFrom?, workingTimeTo?, ... }`) is
 *     recovered from the portal bundle call-site, not from live capture.
 *   - `UpdateAllocatedHours` — captured verbatim, but per the project
 *     rule any mutation needs live verification.
 *
 * **Safety**: this test ROUND-TRIPS to preserve the user's actual
 * settings. The strategy:
 *
 *   1. Read current values via `availability show`.
 *   2. Send a `working-hours set` that re-applies the SAME values
 *      (no semantic change — the mutation's wire shape and success
 *      path are still exercised). Verifies the inferred input is
 *      accepted by the server.
 *   3. Send an `allocated-hours set --hours <same>` that re-applies the
 *      SAME value (no semantic change).
 *   4. Verify both responses match expected envelopes.
 *
 * If any field is null on the snapshot (unset), it's omitted from the
 * round-trip update — `UpdateWorkingHours` rejects an empty input but
 * happily accepts partial input.
 *
 * Skip conditions (emit a stderr warning, do not fail):
 *   - User has no working-hours fields set (working window or flex
 *     range both null) — the round-trip would send an empty input and
 *     the pre-flight gate would reject. The user should set at least
 *     one working-hours value manually before running this E2E.
 *
 * # Wire-shape snapshot coverage (#461)
 *
 * Per the Track 1 disposition for mobile-gateway availability ops, this
 * file also asserts structural stability of the post-projection
 * responses for `GetAvailability` and `UpdateAllocatedHours` via
 * `assertWireShapeStable`. The snapshots live at
 * `packages/e2e/src/wire-snapshots/{GetAvailability,UpdateAllocatedHours}.snapshot.json`
 * and lock the public API surface of `availability.show()` and
 * `availability.allocatedHours.set()`. Drift surfaces as a structured
 * diff (`+` / `-` / `~`); updates require `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`.
 * See `packages/e2e/src/wire-snapshots/README.md`.
 *
 * The Gherkin spec-by-example for these scenarios lives at
 * `features/availability-allocated-hours.feature.md` (issue #461).
 */

// e2e-covers: GetAvailability, UpdateAllocatedHours, UpdateWorkingHours
//
// `// e2e-covers:` directive is informational for the `check-e2e-coverage`
// gate. Currently the gate enforces only the `talent-profile` and
// `scheduler` surfaces (`mobile-gateway` ops are out of scope by
// design — see `scripts/check-e2e-coverage.ts` IN_SCOPE_SURFACES). The
// directive is added for forward-compatibility and audit visibility.

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, availability } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors the pattern from sibling E2Es (`25-timesheet-list`, `30-payments-payouts`,
 * etc.) — `ConfigLoadSchema` validates the Form-D shape (`auth.token` present).
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

describe("availability write paths (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "working-hours set round-trip: re-applies current values via UpdateWorkingHours and verifies the wire contract",
    async () => {
      // Step 1: read current values.
      const snapResult = await cli.run(["availability", "show", "-o", "json"]);
      expect(snapResult.exitCode).toBe(0);
      const before = JSON.parse(snapResult.stdout) as SnapshotShape;

      // Step 2: build a re-apply set of only the currently-set fields.
      const flags: string[] = [];
      if (before.workingTimeFrom !== null && before.workingTimeFrom !== undefined) {
        flags.push("--start", before.workingTimeFrom);
      }
      if (before.workingTimeTo !== null && before.workingTimeTo !== undefined) {
        flags.push("--end", before.workingTimeTo);
      }
      if (before.availableShiftRangeFrom !== null && before.availableShiftRangeFrom !== undefined) {
        flags.push("--flex-start", before.availableShiftRangeFrom);
      }
      if (before.availableShiftRangeTo !== null && before.availableShiftRangeTo !== undefined) {
        flags.push("--flex-end", before.availableShiftRangeTo);
      }
      if (before.timeZone?.value !== undefined) {
        flags.push("--time-zone", before.timeZone.value);
      }
      if (flags.length === 0) {
        process.stderr.write(
          "warning: no working-hours fields are set on the test account — write round-trip skipped\n",
        );
        return;
      }

      // Step 3: send the re-apply mutation.
      const setResult = await cli.run(["availability", "working-hours", "set", ...flags, "-o", "json"]);
      expect(setResult.exitCode).toBe(0);
      const setPayload = JSON.parse(setResult.stdout) as {
        ok?: boolean;
        operation?: string;
        updated?: {
          timeZone?: { value?: string } | null;
          workingTimeFrom?: string | null;
          workingTimeTo?: string | null;
        };
      };
      expect(setPayload.ok).toBe(true);
      expect(setPayload.operation).toBe("availability.working-hours.set");
      // Post-mutation values match what we sent.
      if (before.workingTimeFrom !== null && before.workingTimeFrom !== undefined) {
        expect(setPayload.updated?.workingTimeFrom).toBe(before.workingTimeFrom);
      }
      if (before.workingTimeTo !== null && before.workingTimeTo !== undefined) {
        expect(setPayload.updated?.workingTimeTo).toBe(before.workingTimeTo);
      }
      if (before.timeZone?.value !== undefined) {
        expect(setPayload.updated?.timeZone?.value).toBe(before.timeZone.value);
      }

      // Step 4: verify via a fresh `availability show` that nothing changed.
      const afterResult = await cli.run(["availability", "show", "-o", "json"]);
      expect(afterResult.exitCode).toBe(0);
      const after = JSON.parse(afterResult.stdout) as SnapshotShape;
      expect(after.workingTimeFrom).toBe(before.workingTimeFrom);
      expect(after.workingTimeTo).toBe(before.workingTimeTo);
      expect(after.availableShiftRangeFrom).toBe(before.availableShiftRangeFrom);
      expect(after.availableShiftRangeTo).toBe(before.availableShiftRangeTo);
      expect(after.timeZone?.value).toBe(before.timeZone?.value);
    },
  );

  it.skipIf(!e2eEnabled)(
    "allocated-hours set round-trip: re-applies current value via UpdateAllocatedHours",
    async () => {
      // Step 1: read current allocated-hours value.
      const snapResult = await cli.run(["availability", "allocated-hours", "show", "-o", "json"]);
      expect(snapResult.exitCode).toBe(0);
      const before = JSON.parse(snapResult.stdout) as { allocatedHours?: number };
      expect(typeof before.allocatedHours).toBe("number");
      if (typeof before.allocatedHours !== "number") return;

      // Step 2: send the re-apply mutation with the SAME value.
      const setResult = await cli.run([
        "availability",
        "allocated-hours",
        "set",
        "--hours",
        String(before.allocatedHours),
        "-o",
        "json",
      ]);
      expect(setResult.exitCode).toBe(0);
      const setPayload = JSON.parse(setResult.stdout) as {
        ok?: boolean;
        operation?: string;
        updated?: { allocatedHours?: number; hiredHours?: number | null };
      };
      expect(setPayload.ok).toBe(true);
      expect(setPayload.operation).toBe("availability.allocated-hours.set");
      expect(setPayload.updated?.allocatedHours).toBe(before.allocatedHours);

      // Step 3: verify via a fresh show.
      const afterResult = await cli.run(["availability", "allocated-hours", "show", "-o", "json"]);
      expect(afterResult.exitCode).toBe(0);
      const after = JSON.parse(afterResult.stdout) as { allocatedHours?: number };
      expect(after.allocatedHours).toBe(before.allocatedHours);
    },
  );

  it.skipIf(!e2eEnabled)("working-hours set rejects an empty change set with a clean error envelope", async () => {
    const result = await cli.run(["availability", "working-hours", "set", "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("MUTATION_ERROR");
  });

  // ---------------------------------------------------------------------
  // Issue #164: --dry-run coverage. The CLAUDE.md schema/contract rule
  // mandates at least one live E2E run for any wire-behavior change on
  // inferred mutation operations. Since dry-run by definition issues NO
  // wire requests, "live" here means: the CLI is exercised against the
  // real session config (token loader, config resolution, envelope
  // emission), with the wire transport intentionally never reached.
  // The assertion is a stdout-envelope-shape check; if any wire call
  // were to leak through, the apply path would touch the user's actual
  // settings.
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "allocated-hours set --dry-run: emits dry-run envelope, exit 0, no wire mutation (UpdateAllocatedHours)",
    async () => {
      // Capture the pre-state so we can assert no persistence happened.
      const beforeResult = await cli.run(["availability", "allocated-hours", "show", "-o", "json"]);
      expect(beforeResult.exitCode).toBe(0);
      const before = JSON.parse(beforeResult.stdout) as { allocatedHours?: number };
      const baseline = before.allocatedHours;

      // Pick a value DIFFERENT from the baseline so any leaked apply
      // path would be detectable. Use 1 (or 2 if baseline is 1).
      const dryRunValue = baseline === 1 ? 2 : 1;

      const dryRunResult = await cli.run([
        "--dry-run",
        "availability",
        "allocated-hours",
        "set",
        "--hours",
        String(dryRunValue),
        "-o",
        "json",
      ]);
      expect(dryRunResult.exitCode).toBe(0);
      const payload = JSON.parse(dryRunResult.stdout) as {
        dryRun?: boolean;
        ok?: boolean;
        operation?: string;
        preview?: { operationName?: string; surface?: string; variables?: { hours?: number } };
        updated?: unknown;
      };
      expect(payload.ok).toBe(true);
      expect(payload.dryRun).toBe(true);
      expect(payload.operation).toBe("availability.allocated-hours.set");
      expect(payload.preview?.operationName).toBe("UpdateAllocatedHours");
      expect(payload.preview?.surface).toBe("mobile-gateway");
      expect(payload.preview?.variables?.hours).toBe(dryRunValue);
      // Apply-path field MUST NOT appear in the dry-run payload.
      expect(payload.updated).toBeUndefined();

      // Verify the wire was untouched: post-state matches pre-state.
      const afterResult = await cli.run(["availability", "allocated-hours", "show", "-o", "json"]);
      expect(afterResult.exitCode).toBe(0);
      const after = JSON.parse(afterResult.stdout) as { allocatedHours?: number };
      expect(after.allocatedHours).toBe(baseline);
    },
  );

  it.skipIf(!e2eEnabled)(
    "working-hours set --dry-run: emits dry-run envelope, exit 0, no wire mutation (UpdateWorkingHours)",
    async () => {
      // Capture pre-state.
      const beforeResult = await cli.run(["availability", "show", "-o", "json"]);
      expect(beforeResult.exitCode).toBe(0);
      const before = JSON.parse(beforeResult.stdout) as SnapshotShape;
      const baselineFrom = before.workingTimeFrom;

      // Pick an intentionally different working window so a leaked
      // apply path would be detectable. The test uses a deliberately
      // distinct time string ("04:00:00") that is unlikely to be the
      // user's actual setting.
      const dryRunResult = await cli.run([
        "--dry-run",
        "availability",
        "working-hours",
        "set",
        "--start",
        "04:00:00",
        "-o",
        "json",
      ]);
      expect(dryRunResult.exitCode).toBe(0);
      const payload = JSON.parse(dryRunResult.stdout) as {
        dryRun?: boolean;
        ok?: boolean;
        operation?: string;
        preview?: {
          operationName?: string;
          surface?: string;
          variables?: {
            input?: { profileId?: string; profile?: Record<string, unknown> };
          };
        };
        updated?: unknown;
      };
      expect(payload.ok).toBe(true);
      expect(payload.dryRun).toBe(true);
      expect(payload.operation).toBe("availability.working-hours.set");
      expect(payload.preview?.operationName).toBe("UpdateWorkingHours");
      expect(payload.preview?.surface).toBe("mobile-gateway");
      // The placeholder profileId is present (no pre-fetch issued).
      expect(payload.preview?.variables?.input?.profileId).toBe("<resolved at apply time>");
      expect(payload.preview?.variables?.input?.profile).toEqual({ workingTimeFrom: "04:00:00" });
      expect(payload.updated).toBeUndefined();

      // Verify the wire was untouched.
      const afterResult = await cli.run(["availability", "show", "-o", "json"]);
      expect(afterResult.exitCode).toBe(0);
      const after = JSON.parse(afterResult.stdout) as SnapshotShape;
      expect(after.workingTimeFrom).toBe(baselineFrom);
    },
  );

  // ---------------------------------------------------------------------
  // Wire-shape snapshot assertions (#461 — Track 1 disposition for
  // mobile-gateway availability ops).
  //
  // The snapshots capture the post-projection shape returned by the core
  // service (`availability.show()` and `availability.allocatedHours.set()`).
  // The `show()` projection is a 1:1 field-name pass-through over the
  // `GetAvailability` query, so its snapshot tracks wire-level drift
  // structurally. `allocatedHours.set()` projects the mutation's
  // discriminated-union result onto a public-API shape; its snapshot
  // tracks our exposed contract, which depends on the wire shape one
  // level removed.
  //
  // Gherkin spec at `features/availability-allocated-hours.feature.md`.
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("GetAvailability wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await availability.show(token);
    expect(() =>
      assertWireShapeStable({
        operationName: "GetAvailability",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });

  it.skipIf(!e2eEnabled)("UpdateAllocatedHours post-projection result shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    // Re-apply the current value (round-trip, no semantic change) — same
    // safety property as the apply test above. The structural snapshot is
    // captured over the applied-outcome shape.
    const snap = await availability.show(token);
    expect(typeof snap.allocatedHours).toBe("number");
    if (typeof snap.allocatedHours !== "number") return;
    const outcome = await availability.allocatedHours.set(token, snap.allocatedHours);
    expect(outcome.kind).toBe("applied");
    expect(() =>
      assertWireShapeStable({
        operationName: "UpdateAllocatedHours",
        surface: "mobile-gateway",
        transport: "stock",
        response: outcome,
      }),
    ).not.toThrow();
  });
});
