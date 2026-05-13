// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl payments rate change` (#149).
 *
 * Mandatory per CLAUDE.md § Schema/contract validation rule —
 * `CreateRateChangeRequest` is in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`
 * with `_placeholder: String` `CreateRateChangeRequestInput` in the
 * synthesized SDL. The captured mobile operation pins the 5 input
 * variables explicitly (desiredRate, engagementId, requestType,
 * talentComment, answers).
 *
 * **DRY-RUN ONLY** — this test deliberately does NOT exercise the
 * apply path. Submitting a real rate-change request against the
 * maintainer's Toptal account would:
 *   1. Enter Toptal's compliance review pipeline.
 *   2. Affect the maintainer's actual hourly rate (or be rejected,
 *      polluting account history with test artifacts).
 *
 * The dry-run envelope's wire shape (operation name, surface, redacted
 * headers, variable structure) IS the contract-validation surface
 * here — it asserts that `rate change` would call `CreateRateChangeRequest`
 * with the expected variable shape and bearer redaction, without
 * touching the live API at all (the service short-circuits before any
 * transport call).
 *
 * To validate the apply path against the wire shape, a manual run is
 * required — see PR description for the live-validation transcript.
 *
 * Coverage:
 *   - `payments rate change --dry-run --kind=future-engagements --rate
 *     <r> --confirm` returns the dry-run envelope; the preview pins
 *     the wire shape.
 *   - `payments rate change` (no --confirm) refuses with exit code 1.
 */

// e2e-covers: CreateRateChangeRequest

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("payments rate change (DRY-RUN ONLY, live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("rate change without --confirm refuses with exit 1", async () => {
    const result = await cli.run([
      "payments",
      "rate",
      "change",
      "--kind",
      "future-engagements",
      "--rate",
      "100",
      "-o",
      "json",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--confirm");
  });

  it.skipIf(!e2eEnabled)("rate change --dry-run --confirm returns a dry-run preview WITHOUT executing", async () => {
    const result = await cli.run([
      "--dry-run",
      "payments",
      "rate",
      "change",
      "--kind",
      "future-engagements",
      "--rate",
      "100",
      "--confirm",
      "-o",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      dryRun?: boolean;
      preview?: {
        operationName?: string;
        surface?: string;
        variables?: Record<string, unknown>;
        headers?: Record<string, string>;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.preview?.operationName).toBe("CreateRateChangeRequest");
    expect(payload.preview?.surface).toBe("mobile-gateway");
    expect(payload.preview?.variables?.["requestType"]).toBe("FUTURE_ENGAGEMENTS");
    expect(payload.preview?.variables?.["desiredRate"]).toBe("100");
    // Bearer must be redacted in the preview.
    const auth = payload.preview?.headers?.["authorization"] ?? "";
    expect(auth.toLowerCase()).toContain("redacted");
  });

  it.skipIf(!e2eEnabled)(
    "rate change --kind=current-engagement without --engagement refuses (validation)",
    async () => {
      const result = await cli.run([
        "--dry-run",
        "payments",
        "rate",
        "change",
        "--kind",
        "current-engagement",
        "--rate",
        "100",
        "--confirm",
        "-o",
        "json",
      ]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as { errors?: Array<{ code?: string }> };
      expect(payload.errors?.[0]?.code).toBe("MISSING_INPUT");
    },
  );
});
