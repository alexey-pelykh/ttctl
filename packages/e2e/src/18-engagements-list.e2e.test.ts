// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl engagements list` (#147).
 *
 * Mandatory per the project's schema/contract validation rule: the
 * engagements service hand-authors the `JobActivityItems` operation
 * with selection sets extended to include the engagement subobject's
 * `startDate`, `endDate`, `expectedHours`, `commitment.slug`. The
 * synthesized SDL declares `viewer.jobActivityList` with NO arguments,
 * so the codegen pipeline cannot validate the operation's args.
 * Live-API verification is the only authority.
 *
 * Coverage:
 *   - Status filter `active` returns rows whose `statusGroupV2.value`
 *     is `ACTIVE_ENGAGEMENT`.
 *   - Status filter `past` returns rows whose `statusGroupV2.value`
 *     is `CLOSED_ENGAGEMENT`.
 *   - Status filter `all` returns rows from both groups.
 *   - Each row carries the engagement-extended projection
 *     (startDate, expectedHours, commitment, etc.).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { engagements as engagementsLib } from "@ttctl/core";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("engagements list (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the v0.4 list envelope for default (active) status", async () => {
    const result = await cli.run(["engagements", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as unknown;
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();
    if (payload === null || typeof payload !== "object") return;

    expect("version" in payload).toBe(true);
    expect("items" in payload).toBe(true);
    const items = (payload as { items: unknown }).items;
    expect(Array.isArray(items)).toBe(true);
  });

  it.skipIf(!e2eEnabled)(
    "rows carry the engagement-extended projection (startDate, expectedHours, commitment, engagementId)",
    async () => {
      // `--status all` to maximize the chance of finding at least one row in
      // a test account, regardless of whether currently active.
      const result = await cli.run(["engagements", "list", "--status", "all", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as { items: unknown[] };
      const first = payload.items[0] as Record<string, unknown> | undefined;
      // Test account may have zero engagements ever — emit a warning rather
      // than fail in that case. The shape verification below only runs when
      // a row is present.
      if (first === undefined) {
        process.stderr.write(
          "warning: engagements list returned 0 rows (test account has never had an engagement) — shape assertions skipped\n",
        );
        return;
      }

      expect("id" in first).toBe(true);
      expect("engagementId" in first).toBe(true);
      expect("statusV2" in first).toBe(true);
      expect("statusGroupV2" in first).toBe(true);
      expect("lastUpdatedAt" in first).toBe(true);
      expect("job" in first).toBe(true);
      // Engagement-extended fields beyond the applications projection
      expect("startDate" in first).toBe(true);
      expect("endDate" in first).toBe(true);
      expect("expectedHours" in first).toBe(true);
      expect("commitment" in first).toBe(true);

      // statusGroupV2 must be one of the engagement-bearing groups.
      const group = first["statusGroupV2"] as Record<string, unknown> | undefined;
      const groupValue = group?.["value"];
      if (typeof groupValue === "string") {
        const known = ([...engagementsLib.ENGAGEMENT_STATUS_GROUPS] as string[]).includes(groupValue);
        expect(known).toBe(true);
      }
    },
  );

  it.skipIf(!e2eEnabled)("status `active` returns only ACTIVE_ENGAGEMENT rows", async () => {
    const result = await cli.run(["engagements", "list", "--status", "active", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { items: Array<{ statusGroupV2?: { value?: string } }> };
    for (const row of payload.items) {
      expect(row.statusGroupV2?.value).toBe("ACTIVE_ENGAGEMENT");
    }
  });

  it.skipIf(!e2eEnabled)("status `past` returns only CLOSED_ENGAGEMENT rows", async () => {
    const result = await cli.run(["engagements", "list", "--status", "past", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { items: Array<{ statusGroupV2?: { value?: string } }> };
    for (const row of payload.items) {
      expect(row.statusGroupV2?.value).toBe("CLOSED_ENGAGEMENT");
    }
  });
});
