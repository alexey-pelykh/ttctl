// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl contracts` (#195).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — every
 * field on the `Contract` type is `Unknown`-typed in the synthesized SDL
 * (`research/graphql/talent_profile/schema.graphql:163-174`). The
 * `GetContracts` operation is in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`
 * per `codegen.config.ts`, so no typed bindings exist. The wire shape
 * (and the existence of the 6 fields beyond the captured 4-field
 * minimal projection) is INFERRED until this file passes against a
 * live session.
 *
 * Coverage:
 *   - `contracts list` returns the v1.0 list envelope with the
 *     projected fields (id, kind, provider, status, billingType,
 *     signedAt, sentAt, isActive, verificationDeadline, title).
 *   - `contracts show <id>` for a real id returns the projected
 *     contract detail.
 *   - `contracts show <id>` for an unknown id returns NOT_FOUND
 *     envelope (client-side filter on the full list).
 *
 * Read-only — no side effects.
 *
 * Routes through `impersonatedTransport` against the **portal** surface
 * (`talent-profile/graphql`), which is Cloudflare-protected. Chrome TLS
 * impersonation (chrome_146 profile) is required to pass the CDN
 * challenge — if the live run reports `Cf403Error`, the identity catalog
 * (per `tls-fingerprinting` skill) is stale and needs refreshing.
 */

// e2e-covers: GetContracts

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("contracts (live talent-profile portal)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("contracts list returns the list envelope + projection shape", async () => {
    const result = await cli.run(["contracts", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as { version?: string; items?: unknown };
    expect(typeof payload).toBe("object");
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      process.stderr.write("warning: no contracts in test account — contracts list projection assertions skipped\n");
      return;
    }

    const first = payload.items[0] as Record<string, unknown>;
    expect("id" in first).toBe(true);
    expect(typeof first["id"]).toBe("string");
    // Every other field may be null (per the conservative projection types)
    // — assert presence only, not value type.
    expect("kind" in first).toBe(true);
    expect("provider" in first).toBe(true);
    expect("status" in first).toBe(true);
    expect("billingType" in first).toBe(true);
    expect("signedAt" in first).toBe(true);
    expect("sentAt" in first).toBe(true);
    expect("isActive" in first).toBe(true);
    expect("verificationDeadline" in first).toBe(true);
    expect("title" in first).toBe(true);
  });

  it.skipIf(!e2eEnabled)("contracts show <id> returns the projected contract detail", async () => {
    // Step 1: find a contract id to use.
    const listResult = await cli.run(["contracts", "list", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const listed = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const target = listed.items.find((c) => typeof c.id === "string");
    if (target?.id === undefined) {
      process.stderr.write("warning: no contracts in test account — contracts show round-trip skipped\n");
      return;
    }
    const id = target.id;

    // Step 2: fetch the detail.
    const showResult = await cli.run(["contracts", "show", id, "-o", "json"]);
    expect(showResult.exitCode).toBe(0);
    const detail = JSON.parse(showResult.stdout) as Record<string, unknown>;
    expect(detail["id"]).toBe(id);
    // Detail carries the same shape as a list row (no extra fields beyond the
    // list projection — the gateway op is a single document).
    expect("kind" in detail).toBe(true);
    expect("provider" in detail).toBe(true);
    expect("status" in detail).toBe(true);
    expect("title" in detail).toBe(true);
  });

  it.skipIf(!e2eEnabled)("contracts show <bad-id> returns NOT_FOUND envelope", async () => {
    const result = await cli.run(["contracts", "show", "ct-definitely-not-real-xyz", "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });
});
