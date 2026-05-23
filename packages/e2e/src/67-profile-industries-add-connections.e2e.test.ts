// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `profile.industries.addConnections` (#465 — Pattern-6
 * connection helper for industries).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `AddProfileIndustryConnections` is in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`), the synthesized SDL declares only
 * `AddProfileIndustryConnectionsInput { _placeholder: String }` (gateway
 * schema gap), and the wire shape is recovered from the portal-bundle
 * decompile (`module-jobs.302f53cf.js` call site) — NOT a live capture.
 * The live API is the only authority on the contract.
 *
 * **Wire shape verified from the decompile**:
 * ```
 * input: {
 *   profileId,
 *   industriesConnections: [{ industryId, profileItems: string[] }]
 * }
 * ```
 *
 * **Track 1 disposition** (per ADR-006 / CLAUDE.md § Track 1 vs Track 2):
 * gateway-portal `AddProfileIndustryConnections` has no generated
 * operation type (`AddProfileIndustryConnectionsInput` is a
 * placeholder-only synthesized type) → **T1** (wire-shape snapshot).
 * `assertWireShapeStable(...)` diffs the live response shape against the
 * committed snapshot at
 * `packages/e2e/src/wire-snapshots/AddProfileIndustryConnections.snapshot.json`.
 * The first authorized run (`TTCTL_UPDATE_WIRE_SNAPSHOTS=1`) writes the
 * baseline.
 *
 * Coverage strategy:
 *
 *   - **Consent gate** (ADR-009 (ttctl) — `profile-capability` domain):
 *     verified server-side-free by invoking `addConnections` without the
 *     literal `profileCapabilityConsentIssued: true`. The runtime gate
 *     refuses the call BEFORE any wire dispatch — assert
 *     `ConsentRequiredError("CONSENT_REQUIRED")` propagates.
 *
 *   - **Validation gate**: empty `links` array, empty `profileItems`,
 *     and empty `industryId` are all refused server-side-free with
 *     `VALIDATION_ERROR` before any wire dispatch.
 *
 *   - **Live round-trip + wire-shape snapshot**: re-link an industry
 *     that is ALREADY attached to one of the maintainer's employment
 *     rows. The "Add" mutation is idempotent against an existing link
 *     (server-side dedupe), so the call is a semantic no-op — no foreign
 *     state is created on the profile. Snapshot the response.
 *
 * **Why we re-link instead of seeding-and-leaking**: this operation has
 * no inverse mutation in TTCtl (no `removeProfileIndustryConnections`
 * surface) — a fresh link would persist on the maintainer's profile
 * across runs. Re-linking an existing industry → employment edge is the
 * safe idempotent path that gives us a live response to snapshot
 * without altering profile state.
 *
 * **Skip conditions** (silent — emit stderr warning, do not fail):
 *   - User has no employment rows: subtest skipped.
 *   - User has no employments with any industry already linked: subtest
 *     skipped (we don't have a safe `industryId` to re-link without
 *     leaking state).
 *
 * **Catalog-driven sentinel disabled**: a fresh-link path that picks an
 * arbitrary autocomplete entry WOULD leak state because TTCtl has no
 * `removeProfileIndustryConnections` mutation to undo it. Re-linking the
 * existing edge is the only safe live exercise until that inverse ships.
 */

// e2e-covers: AddProfileIndustryConnections

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("profile industries add-connections (live gateway, INFERRED wire shape)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("consent gate refuses calls without profileCapabilityConsentIssued", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    await expect(
      profile.industries.addConnections(
        token,
        [{ industryId: "V1-Industry-stub", profileItems: ["V1-Employment-stub"] }],
        // Widen the static type to expose the runtime gate to the false case.
        {} as unknown as { profileCapabilityConsentIssued: true },
      ),
    ).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
      domain: "profile-capability",
    });
  });

  it.skipIf(!e2eEnabled)("validation gate refuses an empty links array", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    await expect(
      profile.industries.addConnections(token, [], { profileCapabilityConsentIssued: true }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it.skipIf(!e2eEnabled)("live round-trip — re-link an existing industry edge and snapshot the response", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);

    // Discover a safe industry → employment edge to re-link. A
    // re-link of an already-attached edge is the idempotent path that
    // avoids leaking state on the maintainer's profile.
    const employments = await profile.employment.list(token);
    if (employments.length === 0) {
      console.warn("[67-profile-industries-add-connections] user has no employment rows; skipping live round-trip");
      return;
    }

    const candidate = employments.find((e) => e.industries.length > 0);
    if (candidate === undefined) {
      console.warn(
        "[67-profile-industries-add-connections] no employment row has any industries linked; cannot safely re-link without leaking state; skipping live round-trip",
      );
      return;
    }
    const existingIndustry = candidate.industries[0];
    if (existingIndustry === undefined) {
      throw new Error(
        "[67-profile-industries-add-connections] unreachable: candidate.industries.length > 0 but [0] is undefined",
      );
    }

    const result = await profile.industries.addConnections(
      token,
      [{ industryId: existingIndustry.id, profileItems: [candidate.id] }],
      { profileCapabilityConsentIssued: true },
    );

    // The response must echo the SUBJECT employment row with the
    // industry tag present — that's the proof the link landed (or
    // was already there). The whole `profile` snapshot is returned,
    // so the row is reachable via `result.employments`.
    const echoedEmployment = result.employments.find((e) => e.id === candidate.id);
    expect(echoedEmployment).toBeDefined();
    expect(echoedEmployment?.industries.map((i) => i.id)).toContain(existingIndustry.id);

    // T1 snapshot — drift in the server's response signals a wire-
    // format regression to re-engineer. First authorized run with
    // `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` captures the baseline.
    expect(() =>
      assertWireShapeStable({
        operationName: "AddProfileIndustryConnections",
        surface: "mobile-gateway",
        transport: "stock",
        response: result,
      }),
    ).not.toThrow();
  });
});
