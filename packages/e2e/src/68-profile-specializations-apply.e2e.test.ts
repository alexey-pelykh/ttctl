// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile specializations apply` (#467).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `ApplyForSpecialization` is a hand-authored gateway-portal mutation
 * in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`); no
 * generated type exists. The wire shape (`specialization(id:).apply(input: {})
 * { success notice errors { code key message } }`) is verbatim from
 * the captured op document — but the live wire is the only authority
 * on whether the empty-input shape and the boolean/notice/errors echo
 * are stable.
 *
 * Coverage:
 *
 *   - **Always-on**: dry-run preview (no wire call), consent-missing
 *     refusal (no wire call), and a negative path against a synthetic
 *     non-existent specialization id (no destructive state change).
 *     These pin the envelope shape, the consent-gate's `CONSENT_REQUIRED`
 *     code, and the operationName forwarding without touching real
 *     application state.
 *
 *   - **Gated DESTRUCTIVE positive path**: only runs when
 *     `TTCTL_E2E_APPLY_SPECIALIZATION=<specializationId>` is exported.
 *     The operator supplies a specialization id they actually want to
 *     apply to (e.g. Marketplace, Expert Crowd). Applying submits the
 *     talent's application to that track's review/training pipeline;
 *     no withdraw mutation exists on the wire. Only set the env var
 *     when you intend to actually apply.
 *
 * **Wire-shape snapshot** (T1 per ADR-006 / `docs/wire-validation-routing.md`):
 * the gated positive path captures `ApplyForSpecialization.snapshot.json`
 * on first run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`; thereafter
 * `assertWireShapeStable(...)` runs on every `TTCTL_E2E=1` invocation
 * (gated by the env var — the snapshot can only be captured when the
 * operator opts into the destructive call).
 *
 * Disposition: **T1** (wire-shape snapshot). `ApplyForSpecialization`
 * is in the codegen-exclusion list, so no T2 Zod schema is generated;
 * `assertWireShapeStable` is the continuous wire-drift defense.
 */

// e2e-covers: ApplyForSpecialization

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";
const applySpecializationId = process.env["TTCTL_E2E_APPLY_SPECIALIZATION"];

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("profile specializations apply (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // ---------------------------------------------------------------------
  // Always-on paths
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "--dry-run emits the ApplyForSpecialization preview envelope and makes no wire call",
    async () => {
      const result = await cli.run([
        "--dry-run",
        "profile",
        "specializations",
        "apply",
        "spec-fake-id-dry-run-doesnt-matter",
        "--consent-profile-capability",
        "-o",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        version?: string;
        dryRun?: boolean;
        operation?: string;
        preview?: {
          operationName?: string;
          surface?: string;
          transport?: string;
          variables?: Record<string, unknown>;
          headers?: Record<string, string>;
        };
        updated?: unknown;
      };
      expect(payload.ok).toBe(true);
      expect(payload.version).toBe("1.0");
      expect(payload.dryRun).toBe(true);
      expect(payload.operation).toBe("profile.specializations.apply");
      expect(payload.preview?.operationName).toBe("ApplyForSpecialization");
      expect(payload.preview?.surface).toBe("mobile-gateway");
      expect(payload.preview?.transport).toBe("stock");
      expect(payload.preview?.variables?.["specializationId"]).toBe("spec-fake-id-dry-run-doesnt-matter");
      // Bearer redacted in the preview headers.
      expect(payload.preview?.headers?.["authorization"]).toBe("Token token=<redacted>");
      // No `updated` field on the dry-run path.
      expect(payload.updated).toBeUndefined();
    },
  );

  it.skipIf(!e2eEnabled)(
    "consent-missing refusal: `profile specializations apply` without --consent-profile-capability emits CONSENT_REQUIRED and makes NO wire call",
    async () => {
      // The service-layer consent gate refuses BEFORE the wire call.
      // The CLI threads the omitted flag as `false`; the service raises
      // `ConsentRequiredError("CONSENT_REQUIRED")` which the CLI handler
      // surfaces as a structured error envelope.
      const result = await cli.run(["profile", "specializations", "apply", "spec-fake-id-no-wire-call", "-o", "json"]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: Array<{ code?: string; message?: string; hint?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("profile.specializations.apply");
      expect(payload.errors?.[0]?.code).toBe("CONSENT_REQUIRED");
      // The hint must point the operator at re-running with the consent
      // flag (and/or at the env-var bypass).
      expect(payload.errors?.[0]?.hint).toMatch(/consent/i);
    },
  );

  it.skipIf(!e2eEnabled)(
    "negative path: non-existent specialization id surfaces USER_ERROR (no destructive state change)",
    async () => {
      // The wire either resolves `specialization(id:)` to `null` (no
      // such track) — mapped to USER_ERROR by the service — or returns
      // a top-level GraphQL error (e.g. Relay decode failure for an
      // ill-formed id), mapped to GRAPHQL_ERROR. Either is acceptable —
      // record the observed code via the assertion.
      const fakeId = "spec-fake-id-does-not-exist-12345"; // not a real specialization id
      const result = await cli.run([
        "profile",
        "specializations",
        "apply",
        fakeId,
        "--consent-profile-capability",
        "-o",
        "json",
      ]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: Array<{ code?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("profile.specializations.apply");
      const code = payload.errors?.[0]?.code ?? "";
      expect(["USER_ERROR", "GRAPHQL_ERROR", "UNKNOWN"]).toContain(code);
    },
  );

  // ---------------------------------------------------------------------
  // Gated DESTRUCTIVE positive path
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled || applySpecializationId === undefined)(
    "positive path (gated by TTCTL_E2E_APPLY_SPECIALIZATION): applies to the supplied specialization + captures wire-shape snapshot",
    async () => {
      // Gated by env var — the operator opts in by exporting a REAL
      // specialization id they actually want to apply to. Applying is
      // irreversible (no withdraw operation in TTCtl).
      if (applySpecializationId === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);

      // Call the core service directly so we can pass the response to
      // `assertWireShapeStable` for the T1 snapshot. The CLI surface
      // is exercised on the dry-run path above; the apply path
      // semantics are the same. The `profileCapabilityConsentIssued:
      // true` literal is the type-system + runtime gate per ADR-009
      // (ttctl) § Decision Part 1.
      const outcome = await profile.specializations.apply(token, applySpecializationId, {
        profileCapabilityConsentIssued: true,
      });
      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") return;
      const result = outcome.result;
      // The result echoes the supplied id and the wire-supplied notice
      // (which may be null when the server returns no notice).
      expect(result.specializationId).toBe(applySpecializationId);
      expect(typeof result.specializationId).toBe("string");
      // `notice` may be null on success — the assertion accepts both.
      expect(result.notice === null || typeof result.notice === "string").toBe(true);

      // Wire-shape snapshot — captures on first run with
      // TTCTL_UPDATE_WIRE_SNAPSHOTS=1; asserts thereafter.
      expect(() =>
        assertWireShapeStable({
          operationName: "ApplyForSpecialization",
          surface: "mobile-gateway",
          transport: "stock",
          response: result,
        }),
      ).not.toThrow();

      // Cross-check write-read symmetry: the affected row now surfaces
      // on `show()` with `operations.apply.callable` transitioned away
      // from `"ENABLED"` (the wire flips it once an application is in
      // progress; disabled value is platform-controlled, so assert
      // "not ENABLED" rather than coupling to an INFERRED disabled enum).
      const allSpecs = await profile.specializations.show(token);
      const applied = allSpecs.find((s) => s.id === applySpecializationId);
      expect(applied).toBeDefined();
      if (applied !== undefined) {
        // applicationStatus transitions away from the prospective
        // state — exact value depends on the platform's post-submit
        // state (PENDING, IN_REVIEW, ACCEPTED depending on track
        // gating). Just assert the field is populated.
        expect(typeof applied.applicationStatus).toBe("string");
        expect(typeof applied.operations.apply.callable).toBe("string");
        expect(applied.operations.apply.callable).not.toBe("ENABLED");
      }
    },
  );
});
