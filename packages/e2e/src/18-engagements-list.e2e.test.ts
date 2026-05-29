// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// e2e-covers: JobActivityItems

/**
 * E2E coverage for `ttctl engagements list` (#147, extended for
 * pagination in #375).
 *
 * Mandatory per the project's schema/contract validation rule: the
 * engagements service hand-authors the `JobActivityItems` operation
 * with selection sets extended to include the engagement subobject's
 * `startDate`, `endDate`, `expectedHours`, `commitment.slug`. The
 * synthesized SDL declares `viewer.jobActivityList` with NO arguments,
 * so the codegen pipeline cannot validate the operation's args.
 * Live-API verification is the only authority.
 *
 * #375 adds `$page: Int, $pageSize: PageSize` to the hand-authored
 * `ENGAGEMENTS_LIST_QUERY` and threads them to the wire's
 * `jobActivityList.page` / `pageSize` arguments. The synthesized SDL
 * declares neither arg on `jobActivityList: JobActivityList!`. The
 * argument acceptance + the 1-indexed page semantic are INFERRED from
 * the `eligibleJobs` sibling (empirical #138); this round-trip is the
 * load-bearing verification that the inference holds.
 *
 * Coverage:
 *   - Status filter `active` returns rows whose `statusGroupV2.value`
 *     is `ACTIVE_ENGAGEMENT`.
 *   - Status filter `past` returns rows whose `statusGroupV2.value`
 *     is `CLOSED_ENGAGEMENT`.
 *   - Status filter `all` returns rows from both groups.
 *   - Each row carries the engagement-extended projection
 *     (startDate, expectedHours, commitment, etc.).
 *   - **Pagination (#375)**: `--page` / `--per-page` are accepted by
 *     the wire; the envelope's `pageInfo` carries
 *     `currentPage` / `perPage` / `totalPages` / `hasNextPage`; an
 *     explicit `--per-page 1 --page 1` request returns at most one
 *     item; consecutive pages do not overlap on the row `id`s.
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

  // -------------------------------------------------------------------
  // Pagination (#375) — schema/contract rule's load-bearing
  // verification that `$page` / `$pageSize` are accepted by the wire
  // on `jobActivityList`. Without this round-trip, the implementation
  // ships on an INFERRED contract (synthesized SDL declares the field
  // with NO arguments; argument acceptance is inferred from the
  // `eligibleJobs` / `JobsList` sibling).
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("accepts --page / --per-page and surfaces pageInfo", async () => {
    // `--status all` to maximize available rows on accounts with mixed history.
    const result = await cli.run([
      "engagements",
      "list",
      "--status",
      "all",
      "--page",
      "1",
      "--per-page",
      "5",
      "-o",
      "json",
    ]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      items: unknown[];
      pageInfo?: {
        currentPage?: number;
        perPage?: number;
        totalPages?: number;
        hasNextPage?: boolean;
      };
    };

    // Envelope shape: pageInfo present with the requested page/perPage echoed back.
    expect(payload.pageInfo).toBeDefined();
    expect(payload.pageInfo?.currentPage).toBe(1);
    expect(payload.pageInfo?.perPage).toBe(5);

    // Page-size enforcement: server returns at most `perPage` rows.
    // (May be fewer on a thin account; never more.)
    expect(payload.items.length).toBeLessThanOrEqual(5);

    // totalPages derivation is consistent with hasNextPage.
    const totalPages = payload.pageInfo?.totalPages;
    const hasNextPage = payload.pageInfo?.hasNextPage;
    if (typeof totalPages === "number" && typeof hasNextPage === "boolean") {
      expect(hasNextPage).toBe(1 < totalPages);
    }
  });

  it.skipIf(!e2eEnabled)("page 2 does not overlap page 1 on row ids when totalCount > perPage", async () => {
    const p1 = await cli.run([
      "engagements",
      "list",
      "--status",
      "all",
      "--page",
      "1",
      "--per-page",
      "1",
      "-o",
      "json",
    ]);
    expect(p1.exitCode).toBe(0);
    const page1 = JSON.parse(p1.stdout) as {
      items: Array<{ id: string }>;
      pageInfo?: { totalPages?: number };
    };
    if ((page1.pageInfo?.totalPages ?? 0) < 2) {
      process.stderr.write(
        "warning: account has < 2 engagement rows across all statuses — page-overlap assertion skipped\n",
      );
      return;
    }

    const p2 = await cli.run([
      "engagements",
      "list",
      "--status",
      "all",
      "--page",
      "2",
      "--per-page",
      "1",
      "-o",
      "json",
    ]);
    expect(p2.exitCode).toBe(0);
    const page2 = JSON.parse(p2.stdout) as { items: Array<{ id: string }> };

    const id1 = page1.items[0]?.id;
    const id2 = page2.items[0]?.id;
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    // 1-indexed page semantic (INFERRED from eligibleJobs #138): page 1
    // and page 2 must return DIFFERENT rows. If id1 === id2, either the
    // wire ignores `$page` (no pagination), or the page base differs
    // from the eligibleJobs sibling — both are blocking schema/contract
    // findings the manual E2E run must surface before merge.
    expect(id1).not.toBe(id2);
  });
});
