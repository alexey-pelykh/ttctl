// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl payments show-many` / `PaymentsByIDs` (#456).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `PaymentsByIDs` is hand-authored (no generated type; listed in
 * `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`), Track 1. The live call IS the
 * wire proof: a wrong `nodes(ids:)` selection 400s. Also validates the
 * two wire-determined behaviors — input-order re-ordering and
 * unresolvable-id handling — against the live API rather than inferring.
 *
 * Read-only — no side effects.
 */

// e2e-covers: PaymentsByIDs

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, payments } from "@ttctl/core";
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

describe("payments show-many (live mobile-gateway, PaymentsByIDs)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "payments.showMany batch-fetches real ids in input order (PaymentsByIDs, Track 1)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      const list = await payments.payouts.list(token, { page: 1, perPage: 5 });
      const ids = list.items.map((p) => p.id);
      if (ids.length === 0) {
        process.stderr.write("warning: no payouts in test account — PaymentsByIDs snapshot skipped\n");
        return;
      }

      // Up to two ids, REVERSED from list order, to prove the result follows
      // INPUT order rather than wire order.
      const probe = ids.slice(0, 2).reverse();
      const response = await payments.showMany(token, probe);

      // Every requested id resolves (these came from `payouts list`), and the
      // result echoes the requested order.
      expect(response.map((p) => p.id)).toEqual(probe);

      // Track 1 wire-shape snapshot of the populated batch result.
      expect(() =>
        assertWireShapeStable({
          operationName: "PaymentsByIDs",
          surface: "mobile-gateway",
          transport: "stock",
          response,
        }),
      ).not.toThrow();
    },
  );

  it.skipIf(!e2eEnabled)(
    "payments.showMany unresolvable-id behavior — malformed rejects, nonexistent drops",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      const list = await payments.payouts.list(token, { page: 1, perPage: 1 });
      const realId = list.items[0]?.id;
      if (realId === undefined) {
        process.stderr.write("warning: no payouts in test account — PaymentsByIDs missing-id check skipped\n");
        return;
      }

      // The "(or error per missing id)" in #456 splits into TWO wire-determined
      // behaviors by id decodability (verified live — see PR transcript):
      //
      //   1. MALFORMED id (undecodable Relay global id) — the gateway rejects
      //      the WHOLE batch with a top-level error (HTTP 200 + errors[], message
      //      "500: Internal Server Error"); the service maps it to GRAPHQL_ERROR.
      const undecodableId = `${realId}-ttctl-nonexistent-zzz`;
      await expect(payments.showMany(token, [realId, undecodableId])).rejects.toMatchObject({
        name: "PaymentsError",
        code: "GRAPHQL_ERROR",
      });

      //   2. DECODABLE-but-NONEXISTENT id (valid Relay shape, no backing record)
      //      — the gateway resolves it to a null node, which the service drops:
      //      the result is the resolved subset in input order, NOT an error.
      //      Construct one by bumping the trailing numeric run of the real id's
      //      decoded form ("V1-TalentPayment-2158706" -> "...-92158706").
      const decoded = Buffer.from(realId, "base64").toString("utf8");
      const mutated = decoded.replace(/(\d+)(?=\D*$)/, (m) => `9${m}`);
      if (mutated === decoded) {
        process.stderr.write("warning: real id has no numeric tail to mutate — nonexistent-id sub-check skipped\n");
        return;
      }
      const nonexistentId = Buffer.from(mutated, "utf8").toString("base64").replace(/=+$/, "");
      const partial = await payments.showMany(token, [realId, nonexistentId]);
      expect(partial.map((p) => p.id)).toEqual([realId]);
    },
  );
});
