// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile external` (#219, audit CRIT-004 /
 * TEST-001).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * external sub-domain bundles 6 operations against the Cloudflare-
 * protected `talent-profile` surface (four reads, two mutations).
 * Every operation routes through `impersonatedTransport`. Input shapes
 * for the mutations follow `[INFERRED]` Pattern 1 from
 * `research/notes/10-mutation-input-patterns.md`.
 *
 * Coverage strategy:
 *
 *   - **`getCustomRequirements`, `getProfileReadiness`,
 *     `getProfileRecommendations`, `getAdvancedProfileData`** (all
 *     pure reads): full envelope-shape coverage. Each test asserts the
 *     response carries the expected top-level keys (the post-#129
 *     formatters' inputs) and at least one nested field.
 *   - **`updateCustomRequirements`**: round-trip via `show → set
 *     --background-check <same> → assert`. The CLI's `set` leaf merges
 *     caller-omitted booleans against the current server state
 *     (`customRequirementsSet` pre-fetches via `customRequirementsShow`),
 *     so re-applying ALL three current booleans is a wire-level no-op
 *     with the full mutation path exercised. Verifies the post-update
 *     response carries the same trio.
 *
 * **Exempted at source** (`packages/core/src/services/profile/external/index.ts`):
 *   - `UpdateExternalProfiles`: no safe round-trip is possible. The
 *     service has no read-side endpoint exposing linkedin / github /
 *     website / twitter / behance / dribbble (basic profile show does
 *     not include them; the response of an UPDATE call gives POST-
 *     state only). Sending a sentinel value cannot be reverted without
 *     a captured pre-state, and overwriting the maintainer's real
 *     URLs with an `e2e-test` value is destructive. The wire shape
 *     (Pattern 1 wrapper key `externalProfiles`) is inferred per
 *     `research/notes/10-mutation-input-patterns.md`; covered by
 *     run-time monitoring if invoked.
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - The custom-requirements `set` round-trip uses the booleans
 *     returned by `show`; if any boolean is `null` (server has no
 *     value yet), `customRequirementsSet` substitutes `false` per the
 *     module's documented merge-with-current logic
 *     (`external/index.ts:574-577`). This is the documented contract,
 *     not a test skip — the round-trip proceeds and the post-update
 *     state will reflect the merged values.
 */

// e2e-covers: getCustomRequirements, updateCustomRequirements, getProfileReadiness, getProfileRecommendations, getAdvancedProfileData

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

interface CustomRequirementsShape {
  backgroundCheck?: boolean | null;
  drugTest?: boolean | null;
  timeTrackingTools?: boolean | null;
}

interface ReadinessShape {
  isPhotoResolutionSatisfied?: boolean | null;
  isBasicInfoSatisfied?: boolean | null;
  isCertificationsSatisfied?: boolean | null;
  isEmploymentsCountSatisfied?: boolean | null;
  isEmploymentConnectionsSatisfied?: boolean | null;
  isSkillValidationsSatisfied?: boolean | null;
  isPortfolioItemsCountSatisfied?: boolean | null;
  isPortfolioItemConnectionsSatisfied?: boolean | null;
  isWorkingHoursSatisfied?: boolean | null;
  submitAvailable?: boolean | null;
  updatedByTalentAt?: string | null;
}

interface RecommendationShape {
  type?: string;
  payload?: Record<string, unknown>;
}

interface AdvancedSnapshotShape {
  wizardStatus?: string | null;
  travelVisaCount?: number;
  travelVisaIds?: string[];
}

describe("profile external (live talent-profile, INFERRED wire shape)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // -----------------------------------------------------------------
  // getCustomRequirements (pure read)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("custom-requirements show returns the boolean trio", async () => {
    const result = await cli.run(["profile", "external", "custom-requirements", "show", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as CustomRequirementsShape;
    expect("backgroundCheck" in payload).toBe(true);
    expect("drugTest" in payload).toBe(true);
    expect("timeTrackingTools" in payload).toBe(true);
    // Each field is either boolean or null (the server may have never
    // surfaced a value, which the service maps to `null`).
    for (const key of ["backgroundCheck", "drugTest", "timeTrackingTools"] as const) {
      const v = payload[key];
      expect(typeof v === "boolean" || v === null).toBe(true);
    }
  });

  // -----------------------------------------------------------------
  // updateCustomRequirements (round-trip via show → set --same)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "custom-requirements set round-trip: re-apply current values via updateCustomRequirements",
    async () => {
      // Step 1: capture current state.
      const showResult = await cli.run(["profile", "external", "custom-requirements", "show", "-o", "json"]);
      expect(showResult.exitCode).toBe(0);
      const before = JSON.parse(showResult.stdout) as CustomRequirementsShape;

      // Step 2: re-apply ALL three booleans explicitly so the wire shape
      // is exercised regardless of which are server-null on this account.
      // The CLI's --background-check / --drug-test / --time-tracking-tools
      // accept "true"/"false" strings; we forward the boolean toString().
      // Null-server-side substitutes to `false` per the module's merge
      // logic — same as what `customRequirementsSet` would do internally.
      const fmtBool = (v: boolean | null | undefined): string => (v === true).toString();

      const setResult = await cli.run([
        "profile",
        "external",
        "custom-requirements",
        "set",
        "--background-check",
        fmtBool(before.backgroundCheck),
        "--drug-test",
        fmtBool(before.drugTest),
        "--time-tracking-tools",
        fmtBool(before.timeTrackingTools),
        "-o",
        "json",
      ]);
      expect(setResult.exitCode).toBe(0);
      const setPayload = JSON.parse(setResult.stdout) as {
        ok?: boolean;
        operation?: string;
        updated?: { profile?: { customRequirements?: CustomRequirementsShape }; notice?: string | null };
      };
      expect(setPayload.ok).toBe(true);
      expect(setPayload.operation).toBe("profile.external.custom-requirements.set");
      const post = setPayload.updated?.profile?.customRequirements;
      // The post-update trio should match what we just applied (the boolean
      // normalisation of the pre-state).
      expect(post?.backgroundCheck).toBe(before.backgroundCheck === true);
      expect(post?.drugTest).toBe(before.drugTest === true);
      expect(post?.timeTrackingTools).toBe(before.timeTrackingTools === true);
    },
  );

  // -----------------------------------------------------------------
  // getProfileReadiness (pure read)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("readiness returns the per-section checklist + rolled-up submit-available flag", async () => {
    const result = await cli.run(["profile", "external", "readiness", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as ReadinessShape;
    // Every documented field must appear in the response (presence,
    // value may be null when the server hasn't computed yet).
    const requiredKeys: (keyof ReadinessShape)[] = [
      "isPhotoResolutionSatisfied",
      "isBasicInfoSatisfied",
      "isCertificationsSatisfied",
      "isEmploymentsCountSatisfied",
      "isEmploymentConnectionsSatisfied",
      "isSkillValidationsSatisfied",
      "isPortfolioItemsCountSatisfied",
      "isPortfolioItemConnectionsSatisfied",
      "isWorkingHoursSatisfied",
      "submitAvailable",
      "updatedByTalentAt",
    ];
    for (const key of requiredKeys) {
      expect(key in payload).toBe(true);
    }
  });

  // -----------------------------------------------------------------
  // getProfileRecommendations (pure read)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("recommendations returns an array of {type, payload} entries (possibly empty)", async () => {
    const result = await cli.run(["profile", "external", "recommendations", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as RecommendationShape[];
    expect(Array.isArray(payload)).toBe(true);
    // If recommendations exist, each entry has a string discriminator
    // and a payload object (possibly empty per the service's union-
    // collapsing logic).
    for (const rec of payload) {
      expect(typeof rec.type).toBe("string");
      expect(rec.type?.length).toBeGreaterThan(0);
      expect(typeof rec.payload).toBe("object");
    }
  });

  // -----------------------------------------------------------------
  // getAdvancedProfileData (pure read)
  // -----------------------------------------------------------------

  it.skipIf(!e2eEnabled)("advanced-wizard show returns the wizard-status + travel-visa summary", async () => {
    const result = await cli.run(["profile", "external", "advanced-wizard", "show", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as AdvancedSnapshotShape;
    expect("wizardStatus" in payload).toBe(true);
    expect(typeof payload.travelVisaCount).toBe("number");
    expect(Array.isArray(payload.travelVisaIds)).toBe(true);
    // Count and id-list cardinality must agree.
    expect(payload.travelVisaIds?.length).toBe(payload.travelVisaCount);
  });
});
