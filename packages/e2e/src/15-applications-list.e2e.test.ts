// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications list` (#15).
 *
 * Mandatory per the project's schema/contract validation rule: the
 * applications service hand-authors the `JobActivityItems` operation
 * with selection sets trimmed from the captured research artifact. The
 * synthesized SDL declares `viewer.jobActivityList` with NO arguments,
 * so the codegen pipeline cannot validate the operation's `keywords` /
 * `statusGroupV2` args. Live-API verification is the only authority.
 *
 * Coverage:
 *
 *   - Unfiltered list returns a parseable list envelope.
 *   - Each row carries the projected fields (id, statusV2, statusGroupV2,
 *     job, lastUpdatedAt).
 *   - Status group filter works (server narrows to that group).
 *   - All rows in a filtered call share the requested status group.
 *
 * Skip-gated by `TTCTL_E2E=1` per harness convention; vitest reports
 * SKIPPED in CI.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { applications as applicationsLib } from "@ttctl/core";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("applications list (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "returns the v0.4 list envelope with at least one row (assumes test account has activity)",
    async () => {
      const result = await cli.run(["applications", "list", "-o", "json"]);
      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout) as unknown;
      expect(typeof payload).toBe("object");
      expect(payload).not.toBeNull();
      if (payload === null || typeof payload !== "object") return;

      // Envelope shape: { version: "1.0", items: [...] } per #128.
      expect("version" in payload).toBe(true);
      expect("items" in payload).toBe(true);
      const items = (payload as { items: unknown }).items;
      expect(Array.isArray(items)).toBe(true);
      if (!Array.isArray(items)) return;
      // The 03-applications.md note claims 377 items in the test account;
      // a stricter ">= 1" assertion catches a "regression to empty" without
      // pinning the exact count (which would drift over time).
      expect(items.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.skipIf(!e2eEnabled)(
    "each row carries the trimmed projection fields (id, statusV2, statusGroupV2, lastUpdatedAt, job)",
    async () => {
      const result = await cli.run(["applications", "list", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as { items: unknown[] };
      const first = payload.items[0] as Record<string, unknown> | undefined;
      expect(first).toBeDefined();
      if (first === undefined) return;

      // Boolean membership (#21 C3) keeps failure diffs from dumping the row.
      expect("id" in first).toBe(true);
      expect("statusV2" in first).toBe(true);
      expect("statusGroupV2" in first).toBe(true);
      expect("statusColor" in first).toBe(true);
      expect("lastUpdatedAt" in first).toBe(true);
      expect("job" in first).toBe(true);

      // Status structure
      const status = first["statusV2"] as Record<string, unknown> | undefined;
      expect(status).toBeDefined();
      if (status !== undefined) {
        expect("value" in status).toBe(true);
        expect("verbose" in status).toBe(true);
      }
      const group = first["statusGroupV2"] as Record<string, unknown> | undefined;
      expect(group).toBeDefined();
      if (group !== undefined) {
        expect("value" in group).toBe(true);
        const value = group["value"];
        expect(typeof value).toBe("string");
        // Must be one of the five known enum values (or a future addition
        // — the assertion is "is in or NEW", not "must be in"; we surface
        // a NEW value as a warning rather than a failure to avoid breaking
        // CI on a server-side enum extension).
        if (typeof value === "string") {
          const known = ([...applicationsLib.STATUS_GROUPS] as string[]).includes(value);
          if (!known) {
            process.stderr.write(
              `warning: unknown JobActivityItemStatusGroupEnum value "${value}" — add to STATUS_GROUPS if it's stable\n`,
            );
          }
        }
      }

      // Job substructure
      const job = first["job"] as Record<string, unknown> | undefined;
      expect(job).toBeDefined();
      if (job !== undefined) {
        expect("id" in job).toBe(true);
      }
    },
  );

  it.skipIf(!e2eEnabled)(
    "status-group filter narrows the result and every returned row matches the filter",
    async () => {
      // Pick ARCHIVED — overwhelmingly the largest group in the test account
      // per the 03-applications.md note (≈ 116 of 377 items at the time).
      const result = await cli.run(["applications", "list", "--status-group", "ARCHIVED", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as { items: Array<{ statusGroupV2?: { value?: string } }> };
      expect(payload.items.length).toBeGreaterThanOrEqual(1);
      for (const row of payload.items) {
        expect(row.statusGroupV2?.value).toBe("ARCHIVED");
      }
    },
  );
});
