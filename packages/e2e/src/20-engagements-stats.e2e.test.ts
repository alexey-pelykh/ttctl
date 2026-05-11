// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl engagements stats` (#147).
 *
 * Mandatory per the project's schema/contract validation rule.
 * Validates issuing 2 parallel `JobActivityItems` calls (one per
 * engagement-bearing status group) and reading each call's
 * server-provided `totalCount`.
 *
 * The numerical relationship `total === sum(groups)` is the strongest
 * cross-check.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { engagements as engagementsLib } from "@ttctl/core";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("engagements stats (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns one count per engagement-status-group with total === sum(groups)", async () => {
    const result = await cli.run(["engagements", "stats", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      total?: number;
      groups?: Array<{ name?: string; count?: number }>;
    };
    expect(payload.total).toBeTypeOf("number");
    expect(Array.isArray(payload.groups)).toBe(true);
    if (!Array.isArray(payload.groups)) return;

    expect(payload.groups.length).toBe(engagementsLib.ENGAGEMENT_STATUS_GROUPS.length);
    const namesReturned = payload.groups.map((g) => g.name).filter((n): n is string => typeof n === "string");
    expect(new Set(namesReturned)).toEqual(new Set(engagementsLib.ENGAGEMENT_STATUS_GROUPS));

    const summed = payload.groups.reduce((s, g) => s + (g.count ?? 0), 0);
    expect(summed).toBe(payload.total);
  });

  it.skipIf(!e2eEnabled)("stats counts cross-check against `engagements list` per status filter", async () => {
    const [statsResult, activeListResult, pastListResult] = await Promise.all([
      cli.run(["engagements", "stats", "-o", "json"]),
      cli.run(["engagements", "list", "--status", "active", "-o", "json"]),
      cli.run(["engagements", "list", "--status", "past", "-o", "json"]),
    ]);
    expect(statsResult.exitCode).toBe(0);
    expect(activeListResult.exitCode).toBe(0);
    expect(pastListResult.exitCode).toBe(0);

    const stats = JSON.parse(statsResult.stdout) as { groups: Array<{ name: string; count: number }> };
    const active = JSON.parse(activeListResult.stdout) as { items: unknown[] };
    const past = JSON.parse(pastListResult.stdout) as { items: unknown[] };

    const activeCount = stats.groups.find((g) => g.name === "ACTIVE_ENGAGEMENT")?.count ?? 0;
    const pastCount = stats.groups.find((g) => g.name === "CLOSED_ENGAGEMENT")?.count ?? 0;

    // Stats count >= list-fetched length (server may cap list page size at
    // some default; stats uses totalCount directly).
    expect(activeCount).toBeGreaterThanOrEqual(active.items.length);
    expect(pastCount).toBeGreaterThanOrEqual(past.items.length);
  });
});
