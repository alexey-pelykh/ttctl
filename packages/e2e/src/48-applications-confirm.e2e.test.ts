// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications confirm` (#411).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * `ConfirmAvailabilityRequest` is in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`
 * (codegen.config.ts line 222). The captured operation's input shape
 * (`AvailabilityRequestKindEnum`, `talentComment`, `requestedHourlyRate`,
 * `matcherQuestionsAnswers`, `expertiseQuestionsAnswers`, `pitchData`)
 * is INFERRED from the synthesized schema (the enum declares `_UNKNOWN`
 * at line 2729); the live wire is the only authority on whether the
 * three INFERRED kind spellings (`FIXED`, `FLEXIBLE`,
 * `MARKETPLACE_FLEXIBLE`) are accepted.
 *
 * **Safety**:
 *
 *   - **Always-on**: dry-run path with explicit `--rate` / `--kind` (no
 *     wire call — both values supplied, so no resolution is needed) and
 *     the negative path against a synthetic AR id (the gateway returns
 *     either a top-level GraphQL error or a 500 — both classes are mapped
 *     to typed errors by the service; no state changes).
 *
 *   - **Gated read-only resolve path** (#593): only runs when
 *     `TTCTL_E2E_RESOLVE_INTEREST_REQUEST=<FIXED_AR_id>` is exported. A
 *     `--dry-run` accept with `--rate` / `--kind` OMITTED now performs the
 *     same READ-ONLY `GetAvailabilityRequestKind` resolution the apply
 *     path would, surfacing the concrete recruiter-pinned rate + kind in
 *     the preview instead of placeholders. This is **non-destructive** —
 *     the irreversible `ConfirmAvailabilityRequest` mutation is NEVER sent
 *     under `--dry-run`; only the read-only resolution query runs. Supply a
 *     REAL pending FIXED-kind AR id (`availabilityRequestId` from `ttctl
 *     applications list --status-group ON_RECRUITER_REVIEW`).
 *
 *   - **Gated positive path**: only runs when
 *     `TTCTL_E2E_ACCEPT_INTEREST_REQUEST=<AR_id>` is exported. The user
 *     supplies a REAL pending AR id from `ttctl applications list
 *     --status-group ON_RECRUITER_REVIEW`; the test confirms it. This is
 *     **DESTRUCTIVE** — confirming an IR creates a JobApplication and
 *     transitions the AR to AVAILABILITY_REQUEST_CONFIRMED. No undo
 *     exists on the wire. Only set the env var when you intend to
 *     actually confirm.
 *
 * **Wire-shape snapshot** (T1 per `docs/wire-validation-routing.md`):
 * the gated positive path is the only opportunity to capture the live
 * response shape; the snapshot is committed on first run with
 * `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`.
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, applications } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";
const acceptArId = process.env["TTCTL_E2E_ACCEPT_INTEREST_REQUEST"];
// Read-only (#593): a REAL pending FIXED-kind AR id used to validate that
// `--dry-run` resolves the recruiter-pinned rate + kind. Non-destructive —
// dry-run never issues the irreversible mutation.
const resolveArId = process.env["TTCTL_E2E_RESOLVE_INTEREST_REQUEST"];

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("applications confirm (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "--dry-run emits the ConfirmAvailabilityRequest preview envelope and makes no wire call",
    async () => {
      const result = await cli.run([
        "--dry-run",
        "applications",
        "confirm",
        "ar-doesnt-matter-in-dry-run",
        "--rate",
        "80.00",
        "--kind",
        "FIXED",
        "-o",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        dryRun?: boolean;
        operation?: string;
        preview?: { operationName?: string; surface?: string; variables?: Record<string, unknown> };
        updated?: unknown;
      };
      expect(payload.ok).toBe(true);
      expect(payload.dryRun).toBe(true);
      expect(payload.operation).toBe("applications.confirm");
      expect(payload.preview?.operationName).toBe("ConfirmAvailabilityRequest");
      expect(payload.preview?.surface).toBe("mobile-gateway");
      expect(payload.preview?.variables?.["id"]).toBe("ar-doesnt-matter-in-dry-run");
      expect(payload.preview?.variables?.["requestedHourlyRate"]).toBe("80.00");
      expect(payload.preview?.variables?.["kind"]).toBe("FIXED");
      expect(payload.updated).toBeUndefined();
    },
  );

  it.skipIf(!e2eEnabled || resolveArId === undefined)(
    "--dry-run with rate/kind omitted resolves the real recruiter-pinned rate + kind via GetAvailabilityRequestKind (read-only; no mutation) (#593)",
    async () => {
      // Gated by TTCTL_E2E_RESOLVE_INTEREST_REQUEST=<real pending FIXED AR id>.
      // READ-ONLY and SAFE: dry-run issues only the GetAvailabilityRequestKind
      // resolution query; the irreversible ConfirmAvailabilityRequest mutation
      // is NEVER sent under --dry-run. This validates the live resolution path
      // (the issue's "bonus safety" — catch a rate-resolution wire-break in
      // PREVIEW rather than on the irreversible commit).
      if (resolveArId === undefined) return;
      const result = await cli.run(["--dry-run", "applications", "confirm", resolveArId, "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        dryRun?: boolean;
        preview?: { operationName?: string; surface?: string; variables?: Record<string, unknown> };
        updated?: unknown;
      };
      expect(payload.ok).toBe(true);
      expect(payload.dryRun).toBe(true);
      expect(payload.preview?.operationName).toBe("ConfirmAvailabilityRequest");
      expect(payload.preview?.surface).toBe("mobile-gateway");
      const vars = payload.preview?.variables ?? {};
      // #593 headline: the preview carries CONCRETE resolved values, never
      // the pre-#593 placeholder strings.
      expect(vars["requestedHourlyRate"]).not.toBe("<resolved at apply time>");
      expect(vars["kind"]).not.toBe("<resolved at apply time>");
      expect(typeof vars["requestedHourlyRate"]).toBe("string");
      expect(["FIXED", "FLEXIBLE", "MARKETPLACE_FLEXIBLE"]).toContain(vars["kind"]);
      // Dry-run never mutates.
      expect(payload.updated).toBeUndefined();
    },
  );

  it.skipIf(!e2eEnabled)(
    "negative path: synthetic id surfaces NOT_FOUND or GRAPHQL_ERROR (mutation against bad id, no state change)",
    async () => {
      // Per `project_toptal_wire_quirks` auto-memory: mutations against
      // bad ids sometimes 500 (top-level GRAPHQL_ERROR), reads return a
      // typed Relay decode error. The `confirm` service issues a pre-fetch
      // (read) FIRST when kind/rate are omitted — that pre-fetch is what
      // surfaces NOT_FOUND for unknown ids. Either NOT_FOUND or
      // GRAPHQL_ERROR is acceptable.
      const result = await cli.run(["applications", "confirm", "ar_synthetic_does_not_exist_411", "-o", "json"]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        errors?: Array<{ code?: string }>;
      };
      expect(payload.ok).toBe(false);
      const code = payload.errors?.[0]?.code ?? "";
      expect(["NOT_FOUND", "GRAPHQL_ERROR", "UNKNOWN", "MUTATION_ERROR"]).toContain(code);
    },
  );

  it.skipIf(!e2eEnabled || acceptArId === undefined)(
    "positive path (gated by TTCTL_E2E_ACCEPT_INTEREST_REQUEST): confirms the supplied AR + asserts wire shape",
    async () => {
      // Gated by env var — the operator opts in by exporting a REAL
      // pending AR id. Confirming is irreversible.
      if (acceptArId === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);

      // Call the core service directly so we can pass the response to
      // `assertWireShapeStable` for the T1 snapshot. The CLI surface is
      // exercised on the dry-run path above; the apply path semantics
      // are the same.
      const outcome = await applications.confirm(token, acceptArId);
      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") return;
      expect(outcome.result.id).toBe(acceptArId);
      // Post-confirm status MUST be terminal-confirmed (the wire's exact
      // value spelling is INFERRED — we assert via verbose membership
      // rather than the value string).
      expect(outcome.result.statusV2.value).toContain("CONFIRMED");
      // Wire-shape snapshot — captures on first run with
      // TTCTL_UPDATE_WIRE_SNAPSHOTS=1; asserts thereafter.
      expect(() =>
        assertWireShapeStable({
          operationName: "ConfirmAvailabilityRequest",
          surface: "mobile-gateway",
          transport: "stock",
          response: outcome.result,
        }),
      ).not.toThrow();
    },
  );
});
