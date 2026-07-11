// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl timesheet show-many` / `TimesheetsByIDs` (#460).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `TimesheetsByIDs` is hand-authored (no generated type; listed in
 * `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`), Track 1. The op's selection is
 * deliberately RICHER than the captured mobile op (it adds the
 * `timesheetApproved`/`timesheetRequiresApproval`/`status` fields so the
 * batch returns a full `TimesheetListItem`), so the live call IS the wire
 * proof: a rejected field selection 400s. Also validates the
 * wire-determined behavior — input-order re-ordering and unresolvable-id
 * handling — against the live API rather than inferring.
 *
 * Read-only — no side effects.
 *
 * **Skip conditions** (silent — emit stderr warning, do not fail):
 *   - Test account has zero pending timesheets → no id to batch against.
 */

// e2e-covers: TimesheetsByIDs

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, timesheet } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/** Load the bearer captured by `globalSetup` into the shared sandbox YAML. */
function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("timesheet show-many (live mobile-gateway, TimesheetsByIDs)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "timesheet.showMany batch-fetches real ids in input order (TimesheetsByIDs, Track 1)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      const pending = await timesheet.list(token);
      const ids = pending.map((t) => t.id);
      if (ids.length === 0) {
        process.stderr.write("warning: no pending timesheets in test account — TimesheetsByIDs snapshot skipped\n");
        return;
      }

      // Up to two ids, REVERSED from list order, to prove the result follows
      // INPUT order rather than wire order.
      const probe = ids.slice(0, 2).reverse();
      const response = await timesheet.showMany(token, probe);

      // Every requested id resolves (these came from `timesheet list`), and the
      // result echoes the requested order.
      expect(response.map((t) => t.id)).toEqual(probe);

      // The batch returns the full list-row projection, including the approval
      // fields the captured mobile op omitted.
      const first = response[0];
      expect(first).toBeDefined();
      expect("timesheetApproved" in (first ?? {})).toBe(true);
      expect("timesheetRequiresApproval" in (first ?? {})).toBe(true);
      expect("status" in (first ?? {})).toBe(true);

      // Track 1 wire-shape snapshot of the populated batch result.
      expect(() =>
        assertWireShapeStable({
          operationName: "TimesheetsByIDs",
          surface: "mobile-gateway",
          transport: "stock",
          response,
        }),
      ).not.toThrow();
    },
  );

  it.skipIf(!e2eEnabled)("timesheet.showMany rejects the whole batch on a nonexistent id (GRAPHQL_ERROR)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    const pending = await timesheet.list(token);
    const realId = pending[0]?.id;
    if (realId === undefined) {
      process.stderr.write(
        "warning: no pending timesheets in test account — TimesheetsByIDs missing-id check skipped\n",
      );
      return;
    }

    // OPERATION-SPECIFIC (verified live #460): unlike `payments.showMany`
    // (where a decodable-but-nonexistent id is dropped), `TimesheetsByIDs`
    // rejects the WHOLE batch with a 500 → domain `GRAPHQL_ERROR` on any id
    // that does not resolve to a real BillingCycle. Construct such an id by
    // bumping the trailing numeric run of the real id's decoded Relay form.
    const decoded = Buffer.from(realId, "base64").toString("utf8");
    const mutated = decoded.replace(/(\d+)(?=\D*$)/, (m) => `9${m}`);
    if (mutated === decoded) {
      process.stderr.write("warning: real id has no numeric tail to mutate — nonexistent-id sub-check skipped\n");
      return;
    }
    const nonexistentId = Buffer.from(mutated, "utf8").toString("base64").replace(/=+$/, "");
    await expect(timesheet.showMany(token, [realId, nonexistentId])).rejects.toMatchObject({
      name: "TimesheetError",
      code: "GRAPHQL_ERROR",
    });
  });
});
