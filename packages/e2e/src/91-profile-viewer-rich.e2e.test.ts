// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.showRich` — the full portal `GetViewer`
 * projection behind `profile show --verbose` (#469).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule.** `GetViewer`
 * is a NEW hand-authored operation, in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`) — EXCLUDED from codegen, so the hand-authored
 * {@link RichViewer} interface is INFERRED (sourced from
 * `research/notes/13-getviewer-empirical-shape.md`). The live API is the
 * only authority on whether it models the wire shape; unit tests pass
 * against whatever the mock returns.
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * no generated operation type → **T1** (wire-shape snapshot).
 * `assertWireShapeStable(...)` diffs the live `RichViewer` shape against the
 * committed `packages/e2e/src/wire-snapshots/GetViewer.snapshot.json`
 * (generated on the first `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run).
 *
 * Round-trip safety: pure READ, no mutation — non-destructive by
 * construction.
 *
 * Coverage:
 *   - **Pure read**: the response carries the load-bearing identity/role
 *     scalars plus the rich-only scopes the trimmed `ProfileShow` default
 *     omits (legal docs, hire-me banner, market condition, rate insight,
 *     permissions).
 *   - **Wire-shape snapshot** (`GetViewer`, T1): structural shape diffed
 *     against the committed snapshot.
 *
 * Note on degeneracy: several operational scopes (`pendingSurveys`,
 * `pendingQuizzes`, `slackApplications.edges`, `jobActivityList.entities`,
 * `scheduledAvailability`, `ongoingRateChangeRequest`, `talentPartner`) come
 * back empty/null on the capture account (note 13 § "What this run does NOT
 * prove"). Their snapshot nodes are degenerate (`array<unknown>` / `null`);
 * triage via `pnpm check-snapshot-degeneracy` and the sidecar
 * `degeneracy-exemptions.json` if strict mode is enabled.
 */

// e2e-covers: GetViewer

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
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

describe("profile showRich — GetViewer (live mobile-gateway, INFERRED wire shape)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  // -------------------------------------------------------------------
  // Pure read — positive shape (schema/contract core)
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("returns the rich viewer projection with identity, role, and rich-only scopes", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const viewer = await profile.showRich(token);

    // Viewer-level identity + the trimmed-default-omitted legal docs.
    expect(typeof viewer.id).toBe("string");
    expect(viewer.id.length).toBeGreaterThan(0);
    expect(typeof viewer.codeOfConduct.id).toBe("string");
    expect(typeof viewer.codeOfConduct.body).toBe("string");
    expect(typeof viewer.termsOfService.body).toBe("string");

    // Role-level scalars (note 13 conventions).
    const role = viewer.viewerRole;
    expect(typeof role.fullName).toBe("string");
    expect(typeof role.email).toBe("string");
    expect(typeof role.roleId).toBe("number");
    expect(typeof role.hourlyRate.decimal).toBe("string"); // BigDecimal as string
    expect(typeof role.timeZone.utcOffset).toBe("number"); // integer seconds

    // Rich-only scopes that ProfileShow trims.
    expect(typeof viewer.hireMeBanner.verificationStatus).toBe("string");
    expect(typeof role.vertical.marketCondition.condition).toBe("string");
    expect(typeof role.rateInsight.hourly.recommendedRate).toBe("string");
    expect(typeof role.permissions.canApplyToJobs).toBe("boolean");
    expect(Array.isArray(viewer.pendingNotifications)).toBe(true);
  });

  // -------------------------------------------------------------------
  // T1 wire-shape snapshot
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("GetViewer wire shape is stable (T1 snapshot)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await profile.showRich(token);
    assertWireShapeStable({
      operationName: "GetViewer",
      surface: "mobile-gateway",
      transport: "stock",
      response,
    });
  });
});
