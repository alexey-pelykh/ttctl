// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// e2e-covers: GetPerformedActions

/**
 * E2E coverage for `ttctl me actions list`.
 *
 * **Mandatory per the project's schema/contract validation rule** — the
 * `me` service hand-authors `GetPerformedActions` against the
 * mobile-gateway surface. `viewer.viewerRole.performedActions` and the
 * `PerformedAction` shape are absent from the synthesized gateway SDL
 * (the op is in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`), so codegen carries
 * no typed bindings and the projection is INFERRED. Live-API verification
 * is the only authority on whether the document models the wire shape.
 *
 * Wire-validation track: **T1** (ADR-006) — the projected return shape is
 * asserted against the committed
 * `wire-snapshots/GetPerformedActions.snapshot.json` via
 * `assertWireShapeStable`. The op is gappy in the SDL, so T2 codegen-Zod
 * is unavailable; T1 is the derived disposition.
 *
 * Pagination is ADR-007 row 5 — bare bidirectional cursor (`--before` /
 * `--after` / `--limit`, direct args, no wrapper). The `--limit` round-trip
 * below is the load-bearing check that the wire accepts the bare args.
 *
 * **Skip conditions** (silent — emit stderr warning, do not fail):
 *   - Test account has zero performed actions → empty list, shape +
 *     snapshot assertions skipped (an empty array carries no element shape).
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, me } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
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

describe("me actions list (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the v1.0 list envelope", async () => {
    const result = await cli.run(["me", "actions", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as unknown;
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();
    if (payload === null || typeof payload !== "object") return;

    expect("version" in payload).toBe(true);
    expect("items" in payload).toBe(true);
    expect(Array.isArray((payload as { items: unknown }).items)).toBe(true);
  });

  it.skipIf(!e2eEnabled)(
    "rows carry the PerformedAction projection (id, category, description, occurredAt)",
    async () => {
      const result = await cli.run(["me", "actions", "list", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as { items: unknown[] };
      const first = payload.items[0] as Record<string, unknown> | undefined;

      if (first === undefined) {
        process.stderr.write(
          "warning: me actions list returned 0 rows (test account has no performed actions) — shape assertions skipped\n",
        );
        return;
      }

      expect("id" in first).toBe(true);
      expect("category" in first).toBe(true);
      expect("description" in first).toBe(true);
      expect("occurredAt" in first).toBe(true);
    },
  );

  // Schema/contract live-wire assertion — the projected return shape is
  // diffed against the committed T1 snapshot. Drift throws; refresh via
  // TTCTL_UPDATE_WIRE_SNAPSHOTS=1 after review.
  it.skipIf(!e2eEnabled)("matches the committed GetPerformedActions wire snapshot (T1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await me.actions.list(token);
    if (response.length === 0) {
      process.stderr.write(
        "warning: me actions list returned 0 rows — wire snapshot assertion skipped (empty array carries no element shape)\n",
      );
      return;
    }
    assertWireShapeStable({
      operationName: "GetPerformedActions",
      surface: "mobile-gateway",
      transport: "stock",
      response,
    });
  });

  // Pagination (ADR-007 row 5) — the wire's acceptance of the bare
  // `limit` arg is INFERRED from the captured document; this round-trip
  // is the load-bearing verification that `$limit` is honored.
  it.skipIf(!e2eEnabled)("accepts --limit and returns at most that many rows", async () => {
    const result = await cli.run(["me", "actions", "list", "--limit", "1", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { items: unknown[] };
    expect(payload.items.length).toBeLessThanOrEqual(1);
  });
});
