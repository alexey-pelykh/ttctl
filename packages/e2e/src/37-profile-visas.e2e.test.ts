// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile visas` (#219, audit CRIT-004 /
 * TEST-001).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — every
 * mutation in `packages/core/src/services/profile/visas/index.ts` routes
 * through `impersonatedTransport` against the Cloudflare-protected
 * `talent-profile` surface, with `[INFERRED]` input wrappers (Pattern
 * 1/2 + Pattern 3 for remove). Live wire verification is the only
 * authority on the wrapper-key correctness.
 *
 * Coverage strategy:
 *
 *   - `createTravelVisa` + `updateTravelVisa` + `removeTravelVisa`:
 *     round-trip with a sentinel record. The `add` mutation requires a
 *     real server-known `countryId` — there's no public catalog and the
 *     id space is not user-guessable. The test resolves this by snapshot-
 *     and-reuse: read existing visas via `visas list`, take the first
 *     record's `countryId`, and use it for the sentinel. The sentinel's
 *     `visaType` is a fingerprint string (`E2E-Sentinel-${ts}`) so a
 *     stray sentinel left behind by a crashed test is identifiable.
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - test account has zero existing visas (no `countryId` to reuse).
 *     This is the only safe way to obtain a real country id without a
 *     server-side enum or autocomplete query (neither exists on the
 *     surfaces ttctl uses today). The maintainer can manually add one
 *     visa via `ttctl profile visas add --country ... --type ...` to
 *     unlock the round-trip locally.
 *
 * **Safety**: the round-trip is `add → update → remove`, all within a
 * single `it` block. `try/finally` ensures the sentinel is removed even
 * on assertion failure. The sentinel's `visaType` carries the
 * `E2E-Sentinel-` prefix so a `ttctl profile visas list` post-run
 * surfaces any leaked record.
 */

// e2e-covers: getTravelVisas, createTravelVisa, updateTravelVisa, removeTravelVisa

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

interface TravelVisaShape {
  id?: string;
  countryId?: string;
  countryName?: string;
  visaType?: string;
  expiryDate?: string | null;
}

describe("profile visas (live talent-profile, INFERRED wire shape)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "createTravelVisa + updateTravelVisa + removeTravelVisa round-trip on a sentinel record",
    async () => {
      // Step 1: snapshot existing visas to find a real countryId.
      const listResult = await cli.run(["profile", "visas", "list", "-o", "json"]);
      expect(listResult.exitCode).toBe(0);
      const listPayload = JSON.parse(listResult.stdout) as { version?: string; items?: TravelVisaShape[] };
      expect(typeof listPayload).toBe("object");
      expect(Array.isArray(listPayload.items)).toBe(true);

      // Skip-on-empty: the round-trip needs a real countryId.
      const reusedCountryId = listPayload.items?.find(
        (v) => typeof v.countryId === "string" && v.countryId.length > 0,
      )?.countryId;
      if (typeof reusedCountryId !== "string") {
        process.stderr.write(
          "warning: test account has zero existing travel visas — visas round-trip skipped " +
            "(no countryId available to reuse). Add one visa manually to unlock the round-trip:\n" +
            "  ttctl profile visas add --country <id> --type <text>\n",
        );
        return;
      }

      // Step 2: add the sentinel.
      const ts = Date.now().toString();
      const sentinelType = `E2E-Sentinel-${ts}`;
      const addResult = await cli.run([
        "profile",
        "visas",
        "add",
        "--country",
        reusedCountryId,
        "--type",
        sentinelType,
        "-o",
        "json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const addPayload = JSON.parse(addResult.stdout) as {
        ok?: boolean;
        operation?: string;
        created?: TravelVisaShape[];
      };
      expect(addPayload.ok).toBe(true);
      expect(addPayload.operation).toBe("profile.visas.add");
      // `created` carries the full post-mutation list.
      const sentinel = (addPayload.created ?? []).find(
        (v) => v.visaType === sentinelType && v.countryId === reusedCountryId,
      );
      expect(sentinel).toBeDefined();
      expect(typeof sentinel?.id).toBe("string");
      if (sentinel?.id === undefined) return;
      const sentinelId = sentinel.id;

      try {
        // Step 3: update the sentinel's expiry (a non-foreign-key field).
        const newExpiry = "2099-12-31";
        const updateResult = await cli.run([
          "profile",
          "visas",
          "update",
          sentinelId,
          "--expires",
          newExpiry,
          "-o",
          "json",
        ]);
        expect(updateResult.exitCode).toBe(0);
        const updatePayload = JSON.parse(updateResult.stdout) as {
          ok?: boolean;
          operation?: string;
          updated?: TravelVisaShape[];
        };
        expect(updatePayload.ok).toBe(true);
        expect(updatePayload.operation).toBe("profile.visas.update");
        const updated = (updatePayload.updated ?? []).find((v) => v.id === sentinelId);
        expect(updated?.expiryDate).toBe(newExpiry);
        // The `visaType` must remain unchanged (we only sent `--expires`).
        expect(updated?.visaType).toBe(sentinelType);

        // T1 wire-shape snapshot — see `docs/wire-validation-routing.md`
        // (updateTravelVisa is gappy-schema, T1 disposition). The
        // snapshot captures the projected read-side `TravelVisa` shape
        // surfaced via the envelope's `updated[]` (matches
        // `mapTravelVisaNode` in `packages/core/src/services/profile/visas/index.ts`).
        // Originating issue: #317.
        expect(() =>
          assertWireShapeStable({
            operationName: "updateTravelVisa",
            surface: "talent-profile",
            transport: "impersonated",
            response: updatePayload.updated ?? [],
          }),
        ).not.toThrow();
      } finally {
        // Step 4 (always-runs): remove the sentinel.
        const removeResult = await cli.run(["profile", "visas", "remove", sentinelId, "-o", "json"]);
        expect(removeResult.exitCode).toBe(0);
        const removePayload = JSON.parse(removeResult.stdout) as {
          ok?: boolean;
          operation?: string;
          removed?: { id?: string };
        };
        expect(removePayload.ok).toBe(true);
        expect(removePayload.operation).toBe("profile.visas.remove");
        expect(removePayload.removed?.id).toBe(sentinelId);
      }
    },
  );
});
