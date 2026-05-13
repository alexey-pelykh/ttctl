// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl payments payouts` (#149).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * payments service hand-authors every operation (none have generated
 * types; all in `GATEWAY_*_KNOWN_UNTRUSTED_OPS` per `codegen.config.ts`).
 * The `Payments` and `Payment` wire shapes are best-effort INFERRED until
 * this file passes against a live session.
 *
 * Coverage:
 *   - `payments payouts list` returns the v0.4 list envelope with the
 *     projected fields (id, number, amount, status, kindCategory, …).
 *   - `payments payouts show <id>` for a real id returns the projected
 *     payout detail.
 *   - `payments payouts show <id>` for an unknown id returns NOT_FOUND
 *     (remapping of the Relay `Node id "<id>" resolves to ...` error).
 *
 * Read-only — no side effects.
 */

// e2e-covers: Payments
// e2e-covers: Payment

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("payments payouts (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("payouts list returns the list envelope + projection shape", async () => {
    const result = await cli.run(["payments", "payouts", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as { version?: string; items?: unknown };
    expect(typeof payload).toBe("object");
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      process.stderr.write("warning: no payouts in test account — payouts list projection assertions skipped\n");
      return;
    }

    const first = payload.items[0] as Record<string, unknown>;
    expect("id" in first).toBe(true);
    expect("number" in first).toBe(true);
    expect("amount" in first).toBe(true);
    expect("status" in first).toBe(true);
    expect("kindCategory" in first).toBe(true);
    expect("createdAt" in first).toBe(true);
  });

  it.skipIf(!e2eEnabled)("payouts show <id> returns the projected payout detail", async () => {
    // Step 1: find a payout id to use.
    const listResult = await cli.run(["payments", "payouts", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const target = listed.items.find((p) => typeof p.id === "string");
    if (target?.id === undefined) {
      process.stderr.write("warning: no payouts in test account — payouts show round-trip skipped\n");
      return;
    }
    const id = target.id;

    // Step 2: fetch the detail.
    const showResult = await cli.run(["payments", "payouts", "show", id, "-o", "json"]);
    expect(showResult.exitCode).toBe(0);
    const detail = JSON.parse(showResult.stdout) as Record<string, unknown>;
    expect(detail["id"]).toBe(id);
    expect(typeof detail["number"]).toBe("number");
    expect(typeof detail["amount"]).toBe("string");
    expect(typeof detail["status"]).toBe("string");
  });

  it.skipIf(!e2eEnabled)("payouts show <bad-id> returns NOT_FOUND envelope", async () => {
    const result = await cli.run(["payments", "payouts", "show", "pmt-definitely-not-real-xyz", "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });
});
