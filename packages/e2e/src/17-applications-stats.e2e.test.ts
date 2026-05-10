// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications stats` (#15).
 *
 * Mandatory per the project's schema/contract validation rule. Validates
 * the live behavior of issuing 5 parallel `JobActivityItems` calls (one
 * per `JobActivityItemStatusGroupEnum` value) and reading each call's
 * server-provided `totalCount`.
 *
 * The numerical relationship `total === sum(groups)` is the strongest
 * cross-check: if any group's count drifts, the sum drifts. The
 * unfiltered list call's `totalCount` is the comparison baseline (the
 * server should report the same overall total).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { applications as applicationsLib } from "@ttctl/core";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("applications stats (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns one count per known status group with total === sum(groups)", async () => {
    const result = await cli.run(["applications", "stats", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      total?: number;
      groups?: Array<{ name?: string; count?: number }>;
    };
    expect(payload.total).toBeTypeOf("number");
    expect(Array.isArray(payload.groups)).toBe(true);
    if (!Array.isArray(payload.groups)) return;

    expect(payload.groups.length).toBe(applicationsLib.STATUS_GROUPS.length);
    const namesReturned = payload.groups.map((g) => g.name).filter((n): n is string => typeof n === "string");
    expect(new Set(namesReturned)).toEqual(new Set(applicationsLib.STATUS_GROUPS));

    const summed = payload.groups.reduce((s, g) => s + (g.count ?? 0), 0);
    expect(summed).toBe(payload.total);
  });

  it.skipIf(!e2eEnabled)("stats total cross-checks against `applications list` row count", async () => {
    // Cheap sanity check: list returns N items (server-default scope),
    // stats.total counts every row across every group. Equality is NOT
    // required (the server's default scope on `list` may exclude some
    // status groups — empirically rare but possible), but stats.total
    // SHOULD be >= list.items.length.
    const [statsResult, listResult] = await Promise.all([
      cli.run(["applications", "stats", "-o", "json"]),
      cli.run(["applications", "list", "-o", "json"]),
    ]);
    expect(statsResult.exitCode).toBe(0);
    expect(listResult.exitCode).toBe(0);

    const stats = JSON.parse(statsResult.stdout) as { total: number };
    const list = JSON.parse(listResult.stdout) as { items: unknown[] };
    expect(stats.total).toBeGreaterThanOrEqual(list.items.length);
  });
});
