// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl payments methods` (#149).
 *
 * Mandatory per CLAUDE.md § Schema/contract validation rule —
 * `PaymentOptions` is hand-authored on the mobile-gateway endpoint
 * (no captured mobile sibling exists; the portal-captured
 * `GetTalentPaymentOptions` informs the response shape).
 *
 * Coverage:
 *   - `payments methods list` returns the list envelope with the
 *     projected fields (id, paymentMethod, preferredOption, …) plus the
 *     `availableMethods` sibling array (viewerRole.availablePaymentMethods).
 *   - `payments methods show <id>` returns the projected detail for
 *     a real id.
 *   - `payments methods show <bad-id>` returns NOT_FOUND envelope
 *     (client-side filter — no per-id wire op exists).
 *
 * Read-only — no side effects.
 */

// e2e-covers: PaymentOptions

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("payments methods (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("methods list returns the list envelope + projection shape", async () => {
    const result = await cli.run(["payments", "methods", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as { version?: string; items?: unknown; availableMethods?: unknown };
    expect(typeof payload).toBe("object");
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);
    // availableMethods (#812) — viewerRole.availablePaymentMethods. Shape
    // assertion only; the list is empty on the maintainer's account, so
    // element values stay unobservable (degenerate-capture posture).
    expect(Array.isArray(payload.availableMethods)).toBe(true);

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      process.stderr.write(
        "warning: no payment methods in test account — methods list projection assertions skipped\n",
      );
      return;
    }

    const first = payload.items[0] as Record<string, unknown>;
    expect("id" in first).toBe(true);
    expect("paymentMethod" in first).toBe(true);
    expect("preferredOption" in first).toBe(true);
  });

  it.skipIf(!e2eEnabled)("methods show <id> returns the projected method detail", async () => {
    const listResult = await cli.run(["payments", "methods", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const target = listed.items.find((m) => typeof m.id === "string");
    if (target?.id === undefined) {
      process.stderr.write("warning: no payment methods in test account — methods show round-trip skipped\n");
      return;
    }
    const id = target.id;

    const showResult = await cli.run(["payments", "methods", "show", id, "-o", "json"]);
    expect(showResult.exitCode).toBe(0);
    const detail = JSON.parse(showResult.stdout) as Record<string, unknown>;
    expect(detail["id"]).toBe(id);
    expect(typeof detail["paymentMethod"]).toBe("string");
  });

  it.skipIf(!e2eEnabled)("methods show <bad-id> returns NOT_FOUND envelope", async () => {
    const result = await cli.run(["payments", "methods", "show", "pm-definitely-not-real-xyz", "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });
});
