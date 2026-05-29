// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl payments rate current` (#447).
 *
 * Mandatory per CLAUDE.md § Schema/contract validation rule — even
 * though `GetTalentRate` is in the trusted codegen catalog
 * (`GetTalentRateQuery` in `__generated__/gateway.ts`), this is a new
 * call site invoking a new operation against the live wire. The T2
 * Zod schema (`GET_TALENT_RATE_RESPONSE_SCHEMA` in
 * `payments/index.ts`) validates the wire shape at the
 * `callGateway` boundary; a live round-trip with `TTCTL_E2E=1`
 * exercises both the wire format and the schema gate end-to-end.
 *
 * Coverage:
 *   - `payments rate current` returns `{ verbose: string, roleId: number }`.
 *   - `verbose` is a non-empty server-formatted display string.
 *   - `roleId` is a positive integer.
 *
 * Read-only — no side effects.
 *
 * Disposition: **T2** (codegen-Zod schema validation). The T2 schema is
 * hand-composed inline at the call site per the Z-4 (#288) beachhead
 * pattern; `RateChangeFormDetails` is the only other T2 (wired) site.
 */

// e2e-covers: GetTalentRate

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("payments rate current (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("rate current returns the projected RateCurrent shape", async () => {
    const result = await cli.run(["payments", "rate", "current", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    // Shape pin: { verbose: string, roleId: number }
    expect("verbose" in payload).toBe(true);
    expect("roleId" in payload).toBe(true);

    const verbose = payload["verbose"];
    expect(typeof verbose).toBe("string");
    // Server-formatted display string — non-empty, even for accounts
    // where the rate is zero (Toptal still emits a verbose value).
    expect((verbose as string).length).toBeGreaterThan(0);

    const roleId = payload["roleId"];
    expect(typeof roleId).toBe("number");
    expect(Number.isInteger(roleId)).toBe(true);
    expect(roleId as number).toBeGreaterThan(0);
  });

  it.skipIf(!e2eEnabled)("rate current pretty output prints the verbose string verbatim", async () => {
    const result = await cli.run(["payments", "rate", "current"]);
    expect(result.exitCode).toBe(0);
    // The pretty formatter returns just `p.verbose` (see
    // `formatRateCurrent` in `packages/cli/src/commands/payments/rate.ts`),
    // so stdout should be a single non-empty line.
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout.trim().split("\n").length).toBe(1);
  });
});
