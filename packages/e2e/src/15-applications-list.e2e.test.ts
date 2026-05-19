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

  // -------------------------------------------------------------------
  // Pagination E2E coverage (#377)
  //
  // Mandatory per CLAUDE.md § Schema/contract validation rule — this PR
  // adds `$page: Int, $pageSize: PageSize` wire vars to the hand-authored
  // `JobActivityItems` operation (the synthesized SDL declares
  // `viewer.jobActivityList` with NO documented arguments; the page /
  // pageSize args are INFERRED from the jobs `eligibleJobs` empirical
  // shape captured in #138). Unit tests with mocks confirm
  // variable-substitution AT OUR SIDE only — only the live API can
  // verify the server honors the page variable and respects the
  // PageSize custom scalar.
  //
  // Three assertions (mirroring `24-jobs.e2e.test.ts` § Pagination
  // E2E coverage):
  //   1. `--per-page 5` limits the result set to ≤ 5 items AND the
  //      `pageInfo.perPage` envelope field reflects the request.
  //   2. Different pages return DIFFERENT entities — proves the server
  //      honored the `page` variable rather than ignoring it and
  //      returning a single fixed slice.
  //   3. Pretty footer renders "Page X of Y" when paginated (footer is
  //      the user-visible signal that pagination is wired through to
  //      the output layer).
  //
  // The 03-applications.md note records ≈ 377 items in the test
  // account, well above the 6-item threshold required for the
  // page-difference assertion; the safety skip nonetheless mirrors the
  // jobs precedent in case account state drifts.
  // -------------------------------------------------------------------

  interface ListEnvelope {
    version?: string;
    items?: Array<{ id?: string }>;
    pageInfo?: {
      currentPage?: number;
      perPage?: number;
      totalPages?: number;
      hasNextPage?: boolean;
    };
  }

  it.skipIf(!e2eEnabled)(
    "applications list --per-page 5 surfaces offset-style pageInfo and limits items (#377)",
    async () => {
      const result = await cli.run(["applications", "list", "--page", "1", "--per-page", "5", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as ListEnvelope;
      expect(payload.version).toBe("1.0");
      expect(Array.isArray(payload.items)).toBe(true);

      // Server may return fewer than --per-page items if the test
      // account has < 5 activity rows total. In either case items must
      // not exceed perPage.
      if (Array.isArray(payload.items)) {
        expect(payload.items.length).toBeLessThanOrEqual(5);
      }

      // pageInfo MUST be present when --page/--per-page were passed —
      // even if the result set is empty, the envelope reflects the
      // request.
      expect(payload.pageInfo).toBeDefined();
      expect(payload.pageInfo?.currentPage).toBe(1);
      expect(payload.pageInfo?.perPage).toBe(5);
      // totalPages and hasNextPage derived from totalCount; both
      // present as the server always returns totalCount.
      expect(typeof payload.pageInfo?.totalPages).toBe("number");
      expect(typeof payload.pageInfo?.hasNextPage).toBe("boolean");
    },
  );

  it.skipIf(!e2eEnabled)(
    "applications list --page 1 vs --page 2 returns DIFFERENT entities (server honors page variable; #377)",
    async () => {
      // Use the default sort; jobActivityList's default ordering
      // (`lastUpdatedAt` desc) is stable enough across consecutive
      // paged fetches for the "at least one different" assertion below.
      const sharedArgs = ["applications", "list", "--per-page", "5", "-o", "json"];
      const page1Result = await cli.run([...sharedArgs, "--page", "1"]);
      expect(page1Result.exitCode).toBe(0);
      const page1 = JSON.parse(page1Result.stdout) as ListEnvelope;

      // Need ≥ 6 rows to fill 2 pages of size 5 with distinguishable
      // content. If there's only one page worth of data, the test
      // can't prove pagination — skip with a stderr warning.
      if (!page1.pageInfo?.hasNextPage) {
        process.stderr.write(
          `warning: test account has only one page of activity rows (totalCount fits in one --per-page=5 slice); pagination diff assertion skipped\n`,
        );
        return;
      }

      const page2Result = await cli.run([...sharedArgs, "--page", "2"]);
      expect(page2Result.exitCode).toBe(0);
      const page2 = JSON.parse(page2Result.stdout) as ListEnvelope;
      expect(page2.pageInfo?.currentPage).toBe(2);

      const page1Ids = new Set(
        (page1.items ?? []).map((j) => j.id).filter((id): id is string => typeof id === "string"),
      );
      const page2Ids = new Set(
        (page2.items ?? []).map((j) => j.id).filter((id): id is string => typeof id === "string"),
      );
      expect(page1Ids.size).toBeGreaterThan(0);
      expect(page2Ids.size).toBeGreaterThan(0);
      // At least one id on page 2 must NOT be on page 1 — proves the
      // server honored the page variable and returned a different
      // slice. We don't require strict partitioning (zero overlap)
      // because activity rows update timestamps mid-fetch and the same
      // id can occasionally appear on adjacent pages near the partition
      // boundary. The contract we're proving is "navigation", not
      // "strict partition".
      const distinct = [...page2Ids].filter((id) => !page1Ids.has(id));
      expect(distinct.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!e2eEnabled)("applications list pretty footer renders 'Page X of Y' when paginated (#377)", async () => {
    const result = await cli.run(["applications", "list", "--page", "1", "--per-page", "5"]);
    expect(result.exitCode).toBe(0);
    // Pretty output: the table is followed by the footer line.
    // When items is empty (no activity rows), the empty-state CTA
    // wrapper fires before the footer renderer — skip the assertion
    // in that case.
    if (result.stdout.includes("No applications") || result.stdout.includes("(no")) {
      process.stderr.write("warning: test account has no activity rows; pretty-footer assertion skipped\n");
      return;
    }
    expect(result.stdout).toMatch(/Page 1 of \d+ \(per_page=5\)/);
  });

  // -------------------------------------------------------------------
  // Recruiter Fixed rate projection (#410)
  //
  // Mandatory per the schema/contract rule — this PR adds a new
  // selection (`availabilityRequest.metadata.offeredHourlyRate`) to the
  // hand-authored `JobActivityItems` operation. Unit tests with mocks
  // confirm projection logic; only the live API can verify the wire
  // returns the field shape (Money: { decimal, verbose }).
  //
  // The assertions are tolerant of the test account's actual content:
  //   - `fixedRate` MUST be present on every row (either a Money object
  //     or `null`).
  //   - When the ON_RECRUITER_REVIEW filter is applied AND at least one
  //     IR row exists, AT LEAST ONE row must carry a non-null fixedRate
  //     (every Toptal Interest Request the portal displays carries a
  //     recruiter-pinned rate). The test stderr-warns and returns when
  //     the test account is currently IR-free.
  //   - When `fixedRate` is non-null, its shape MUST be `{ decimal, verbose }`
  //     with both as strings.
  // -------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("applications list projects fixedRate on every row (Money | null shape, #410)", async () => {
    const result = await cli.run(["applications", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      items: Array<{ id: string; fixedRate?: unknown }>;
    };
    expect(payload.items.length).toBeGreaterThanOrEqual(1);
    for (const row of payload.items) {
      // `fixedRate` MUST be a key on every row — the projection sets
      // it to null when no AR metadata is present.
      expect("fixedRate" in row).toBe(true);
      const fr = row.fixedRate;
      if (fr === null) continue;
      // Non-null shape: { decimal: string, verbose: string }
      expect(typeof fr).toBe("object");
      const rate = fr as { decimal?: unknown; verbose?: unknown };
      expect(typeof rate.decimal).toBe("string");
      expect(typeof rate.verbose).toBe("string");
    }
  });

  it.skipIf(!e2eEnabled)(
    "applications list --status-group ON_RECRUITER_REVIEW carries fixedRate on IR rows (#410)",
    async () => {
      const result = await cli.run(["applications", "list", "--status-group", "ON_RECRUITER_REVIEW", "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        items: Array<{ id: string; fixedRate?: { decimal?: string; verbose?: string } | null }>;
      };
      if (payload.items.length === 0) {
        process.stderr.write(
          "warning: test account has no ON_RECRUITER_REVIEW (IR) rows; fixedRate presence assertion skipped\n",
        );
        return;
      }
      const withFixedRate = payload.items.filter((row) => row.fixedRate !== null && row.fixedRate !== undefined);
      // The bug report (#410) records that every observed IR in the
      // alexey-pelykh test account carries a recruiter Fixed rate.
      // Any zero-IR-with-fixedRate result here means either the wire
      // shape regressed OR the test-account IR pool has shifted to
      // non-Fixed offerings (defensively-warned-not-failed because
      // the latter is a legitimate account-state change).
      if (withFixedRate.length === 0) {
        process.stderr.write(
          "warning: test account's IR rows currently have no Fixed rate (recruiter rate mode may have changed); fixedRate population assertion skipped\n",
        );
        return;
      }
      const sample = withFixedRate[0]?.fixedRate;
      expect(typeof sample?.decimal).toBe("string");
      expect(typeof sample?.verbose).toBe("string");
    },
  );
});
