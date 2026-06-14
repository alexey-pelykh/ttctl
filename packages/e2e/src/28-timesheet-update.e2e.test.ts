// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl timesheet update` / `ttctl_timesheet_update` (#458).
 *
 * Mandatory per the project's schema/contract validation rule: `UpdateTimesheet`
 * is a hand-authored mutation, not in `codegen.config.ts`, so live-API
 * verification is the only authority on the wire contract. T1 disposition —
 * the structural snapshot lives at `wire-snapshots/UpdateTimesheet.snapshot.json`
 * and is asserted via `assertWireShapeStable`.
 *
 * **Safety**: editing a DRAFT (unsubmitted) cycle is reversible. The round-trip
 * test re-applies the cycle's CURRENT records (identical values, via the
 * service's read-modify-write merge) plus the current comment — no semantic
 * change lands — then verifies persistence. Submitted cycles are never touched.
 *
 * **Why the wire op is only exercised by the positive round-trip**: `update()`
 * is read-modify-write — it `show()`s the cycle before mutating — so a bad id
 * fails at the READ step and the `UpdateTimesheet` mutation is never sent. The
 * positive round-trip on a real unsubmitted cycle is therefore the only path
 * that verifies the mutation document against the live wire. It SKIPS (stderr
 * warning, no failure) when the account has no unsubmitted cycle.
 */

// e2e-covers: UpdateTimesheet

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, timesheet } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

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

describe("timesheet update (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;
  let token: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
    token = loadSandboxBearer(sandboxConfigPath);
  });

  it.skipIf(!e2eEnabled)(
    "round-trip: re-applies the current comment + records on a draft cycle and verifies the wire contract",
    async () => {
      // Find an unsubmitted (draft) cycle — the only kind we may safely edit.
      const pending = await timesheet.list(token);
      const draft = pending.find((c) => !c.timesheetSubmitted);
      if (draft === undefined) {
        process.stderr.write(
          "warning: test account has no unsubmitted timesheet cycle — UpdateTimesheet round-trip skipped.\n",
        );
        return;
      }

      const before = await timesheet.show(token, draft.id);

      // Re-apply identical state: pass the current comment; omit `records` so
      // the read-modify-write merge resends every current day unchanged.
      const outcome = await timesheet.update(
        token,
        draft.id,
        { comment: before.timesheetComment ?? "", timesheetBillingConsentIssued: true },
        // env may also carry TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1; the explicit
        // consent field is sufficient on its own.
      );

      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") throw new Error("expected applied outcome");

      // Structural wire-shape lock (T1).
      expect(() =>
        assertWireShapeStable({
          operationName: "UpdateTimesheet",
          surface: "mobile-gateway",
          transport: "stock",
          response: outcome,
        }),
      ).not.toThrow();

      // Persistence: the day count is preserved (no records nulled) and each
      // day's duration round-trips byte-identically (ADR-006 string discipline).
      const after = await timesheet.show(token, draft.id);
      expect(after.timesheetRecords.length).toBe(before.timesheetRecords.length);
      const beforeByDate = new Map(before.timesheetRecords.map((r) => [r.date, r.duration]));
      for (const rec of after.timesheetRecords) {
        expect(rec.duration).toBe(beforeByDate.get(rec.date));
      }
      expect(after.timesheetComment ?? "").toBe(before.timesheetComment ?? "");
      // Strong "nothing materially changed" guard: the cycle total is unchanged.
      expect(after.hours).toBe(before.hours);
    },
  );

  it.skipIf(!e2eEnabled)(
    "CLI: bad id is rejected at the read step with a clean error envelope (no mutation sent)",
    async () => {
      // Read-modify-write means a non-existent id fails at the show() read before
      // the mutation. Either the Relay decode remap (NOT_FOUND) or the empirical
      // 500-on-bad-id (GRAPHQL_ERROR) is a valid wire surface. Consent is supplied
      // so the gate is not what trips first.
      const result = await cli.run([
        "timesheet",
        "update",
        "VjEtTm9uZXhpc3RlbnRDeWNsZUlkLTA",
        "--comment",
        "e2e probe (should never land)",
        "--consent-timesheet-billing",
        "-o",
        "json",
      ]);
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { ok: boolean; errors: Array<{ code: string }> };
      expect(payload.ok).toBe(false);
      expect(["NOT_FOUND", "GRAPHQL_ERROR"]).toContain(payload.errors[0]?.code);
    },
  );

  it.skipIf(!e2eEnabled)("CLI: missing consent flag → CONSENT_REQUIRED refusal before any wire call", async () => {
    const result = await cli.run(
      ["timesheet", "update", "VjEtQW55Q3ljbGUtMA", "--comment", "no consent", "-o", "json"],
      // Drop the env bypass for this invocation so the gate fires regardless of
      // the parent shell — the assertion is about the consent ceremony itself.
      { env: { TTCTL_ALLOW_INFERRED_DESTRUCTIVE: undefined } },
    );
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; errors: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors[0]?.code).toBe("CONSENT_REQUIRED");
  });

  it.skipIf(!e2eEnabled)("CLI --dry-run: emits the dry-run envelope, exit 0, no wire mutation", async () => {
    const result = await cli.run([
      "--dry-run",
      "timesheet",
      "update",
      "bc_does_not_matter",
      "--comment",
      "preview only",
      "--consent-timesheet-billing",
      "-o",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      dryRun: boolean;
      preview?: { operationName?: string; surface?: string };
      updated?: unknown;
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.preview?.operationName).toBe("UpdateTimesheet");
    expect(payload.preview?.surface).toBe("mobile-gateway");
    expect(payload.updated).toBeUndefined();
  });
});
