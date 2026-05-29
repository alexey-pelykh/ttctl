// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl payments summary` (#448).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `GetTalentPaymentSummary` is a hand-authored operation in
 * `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`); no
 * generated type exists. The wire shape is best-effort INFERRED until
 * this file passes against a live session.
 *
 * Coverage:
 *   - `payments summary` returns the six-field `PayoutsSummary` shape
 *     (totalPaid / totalDue / totalOutstanding / totalOverdue /
 *     totalOnHold / totalDisputed), every value a decimal string.
 *   - pretty output renders the labelled "Payment summary" block.
 *   - Wire-shape snapshot assertion (T1 disposition): the projected
 *     summary shape is pinned to
 *     `wire-snapshots/GetTalentPaymentSummary.snapshot.json`.
 *
 * Read-only — no side effects.
 *
 * Disposition: **T1** (wire-shape snapshot). `GetTalentPaymentSummary`
 * is in the codegen-exclusion list, so no T2 Zod schema is generated;
 * `assertWireShapeStable` is the continuous wire-drift defense.
 */

// e2e-covers: GetTalentPaymentSummary

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, payments } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * The six aggregate totals on `PayoutsSummary` — the complete field set
 * the `GetTalentPaymentSummary` `summary` block selects.
 */
const SUMMARY_FIELDS = ["totalDisputed", "totalDue", "totalOnHold", "totalOutstanding", "totalOverdue", "totalPaid"];

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `30-payments-payouts.e2e.test.ts`.
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

describe("payments summary (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("summary returns the six-field PayoutsSummary shape", async () => {
    const result = await cli.run(["payments", "summary", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const field of SUMMARY_FIELDS) {
      expect(field in payload).toBe(true);
      // Decimal-string totals — Toptal emits "0" for a zero balance,
      // never a number and never an empty string.
      expect(typeof payload[field]).toBe("string");
    }
  });

  it.skipIf(!e2eEnabled)("summary pretty output renders the labelled block", async () => {
    const result = await cli.run(["payments", "summary"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Payment summary");
    expect(result.stdout).toContain("Paid:");
  });

  // -------------------------------------------------------------------
  // Wire-shape snapshot assertion (T1 disposition; #448).
  //
  // Track 1 continuous-detection defense for `GetTalentPaymentSummary`
  // against post-merge wire drift (a total field renamed / removed /
  // retyped). Captured against the projected `PayoutsSummary` — the
  // surface callers depend on. No empty-account skip-guard is needed:
  // `summary()` always returns the six-field shape (the all-zero
  // `emptyPayoutsSummary()` fallback is structurally identical to a
  // populated wire summary). Snapshot lives at
  // `wire-snapshots/GetTalentPaymentSummary.snapshot.json`; the first
  // authenticated run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` captures it.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("GetTalentPaymentSummary wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await payments.summary(token);
    expect(() =>
      assertWireShapeStable({
        operationName: "GetTalentPaymentSummary",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });
});
