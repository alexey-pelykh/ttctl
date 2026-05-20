// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications reject` (#411).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * `RejectAvailabilityRequest` is in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`
 * (codegen.config.ts line 259). The captured input shape
 * (`{talentComment, rejectReason}`) and the reject-reason `key` strings
 * are wire-side authorities; only a live call can verify the contract.
 *
 * **Safety**:
 *
 *   - **Always-on**: dry-run path (no wire call) and negative path
 *     against a synthetic AR id.
 *
 *   - **Gated positive path**: only runs when
 *     `TTCTL_E2E_REJECT_INTEREST_REQUEST=<AR_id>` is exported.
 *     **DESTRUCTIVE** — rejecting an IR transitions the AR to
 *     AVAILABILITY_REQUEST_REJECTED (terminal, archived). No undo. Only
 *     set the env var when you intend to actually reject.
 *
 * **Wire-shape snapshot** (T1 per `docs/wire-validation-routing.md`):
 * captured on the gated positive path; committed on first run with
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
const rejectArId = process.env["TTCTL_E2E_REJECT_INTEREST_REQUEST"];

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("applications reject (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "--dry-run emits the RejectAvailabilityRequest preview envelope and makes no wire call",
    async () => {
      const result = await cli.run([
        "--dry-run",
        "applications",
        "reject",
        "ar-doesnt-matter-in-dry-run",
        "--reason",
        "rate_too_low",
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
      expect(payload.operation).toBe("applications.reject");
      expect(payload.preview?.operationName).toBe("RejectAvailabilityRequest");
      expect(payload.preview?.surface).toBe("mobile-gateway");
      expect(payload.preview?.variables?.["id"]).toBe("ar-doesnt-matter-in-dry-run");
      expect(payload.preview?.variables?.["reason"]).toBe("rate_too_low");
      expect(payload.preview?.variables?.["comment"]).toBeNull();
      expect(payload.updated).toBeUndefined();
    },
  );

  it.skipIf(!e2eEnabled)("negative path: synthetic id surfaces a typed error envelope, no state change", async () => {
    const result = await cli.run([
      "applications",
      "reject",
      "ar_synthetic_does_not_exist_411",
      "--reason",
      "rate_too_low",
      "-o",
      "json",
    ]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      errors?: Array<{ code?: string }>;
    };
    expect(payload.ok).toBe(false);
    const code = payload.errors?.[0]?.code ?? "";
    // Bad-id behavior on mutations is operation-specific (project memory
    // `project_toptal_wire_quirks`). Either an envelope-level error
    // (GRAPHQL_ERROR / UNKNOWN / NOT_FOUND from a top-level error) or
    // MUTATION_ERROR (the gateway returns success:false with a typed
    // payload) is acceptable.
    expect(["NOT_FOUND", "GRAPHQL_ERROR", "UNKNOWN", "MUTATION_ERROR"]).toContain(code);
  });

  it.skipIf(!e2eEnabled || rejectArId === undefined)(
    "positive path (gated by TTCTL_E2E_REJECT_INTEREST_REQUEST): rejects the supplied AR + asserts wire shape",
    async () => {
      if (rejectArId === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);

      // Pick a reason key from the live inventory rather than assuming a
      // specific string is valid — the keys are server-localised and may
      // change. `rate_too_low` is widely observed on Fixed-kind ARs;
      // first inventory row is a safe portable fallback.
      const reasonsResult = await cli.run(["applications", "reject-reasons", "-o", "json"]);
      expect(reasonsResult.exitCode).toBe(0);
      const inventory = JSON.parse(reasonsResult.stdout) as {
        fixed?: Array<{ key: string; isMandatory: boolean }>;
        flexible?: Array<{ key: string; isMandatory: boolean }>;
      };
      // Prefer a non-mandatory reason so we don't have to compose a
      // comment — keeps the destructive test minimal.
      const candidate =
        inventory.fixed?.find((r) => !r.isMandatory) ??
        inventory.flexible?.find((r) => !r.isMandatory) ??
        inventory.fixed?.[0] ??
        inventory.flexible?.[0];
      if (candidate === undefined) {
        throw new Error("reject-reasons inventory empty — cannot pick a reason for the gated test");
      }

      const outcome = await applications.reject(
        token,
        rejectArId,
        candidate.isMandatory ? { reason: candidate.key, comment: "automated e2e reject" } : { reason: candidate.key },
      );
      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") return;
      expect(outcome.result.id).toBe(rejectArId);
      expect(outcome.result.statusV2.value).toContain("REJECTED");

      expect(() =>
        assertWireShapeStable({
          operationName: "RejectAvailabilityRequest",
          surface: "mobile-gateway",
          transport: "stock",
          response: outcome.result,
        }),
      ).not.toThrow();
    },
  );
});
