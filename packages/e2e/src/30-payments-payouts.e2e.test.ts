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

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, payments } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors the pattern from `25-timesheet-list.e2e.test.ts:47-55`.
 */
function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("payments payouts (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
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

  // -------------------------------------------------------------------
  // Pagination round-trip (#373) — mandatory per CLAUDE.md
  // § Schema/contract validation rule. The captured mobile `Payments`
  // op hard-coded `offsetPagination: { offset: 0 limit: 20 }`; this
  // PR parameterizes it (`$offset: Int!`, `$limit: Int!`) and adds
  // `totalCount` to the `paymentsData` fragment. Both shapes are
  // directly attested by the captured PORTAL op `GetTalentPayments`
  // against the SAME gateway backend, but remain INFERRED for the
  // mobile op until this test passes against a live session.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("payouts list returns offset-style pageInfo (page/perPage round-trip)", async () => {
    const PER_PAGE = 5;
    const first = await cli.run([
      "payments",
      "payouts",
      "list",
      "--page",
      "1",
      "--per-page",
      String(PER_PAGE),
      "-o",
      "json",
    ]);
    expect(first.exitCode).toBe(0);

    interface PageInfo {
      currentPage: number;
      perPage: number;
      totalPages: number;
      hasNextPage: boolean;
    }
    interface ListEnvelope {
      version?: string;
      items?: unknown[];
      pageInfo?: PageInfo;
    }
    const payload = JSON.parse(first.stdout) as ListEnvelope;
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);

    // pageInfo MUST be present on a paginated leaf (#373) — the
    // schema/contract rule asserts the variable-driven `offsetPagination`
    // wire shape AND the `totalCount` selection round-trip cleanly.
    expect(payload.pageInfo).toBeDefined();
    if (payload.pageInfo === undefined) return;
    expect(payload.pageInfo.currentPage).toBe(1);
    expect(payload.pageInfo.perPage).toBe(PER_PAGE);
    // `totalPages` is derived as `Math.max(1, Math.ceil(totalCount /
    // perPage))` — value alone is trivially `>= 1` under the clamp.
    // Assert the TYPE (matches jobs pattern at 24-jobs.e2e.test.ts:355).
    // The strong wire-attested proof of paginated `totalCount` is the
    // page-2 distinctness check below (only fires when `hasNextPage`).
    expect(typeof payload.pageInfo.totalPages).toBe("number");
    expect(typeof payload.pageInfo.hasNextPage).toBe("boolean");
    // Either the page is full (`items.length === PER_PAGE`) and the
    // server has more (or doesn't — `hasNextPage` reflects totalCount),
    // OR the test account has fewer than PER_PAGE payouts and the page
    // is partial; in both cases items.length <= PER_PAGE is invariant.
    expect((payload.items ?? []).length).toBeLessThanOrEqual(PER_PAGE);

    // Page 2 round-trip — only assert distinctness when the test
    // account actually has > PER_PAGE payouts (no false-negative for
    // small fixtures).
    if (payload.pageInfo.hasNextPage) {
      const second = await cli.run([
        "payments",
        "payouts",
        "list",
        "--page",
        "2",
        "--per-page",
        String(PER_PAGE),
        "-o",
        "json",
      ]);
      expect(second.exitCode).toBe(0);
      const p2 = JSON.parse(second.stdout) as ListEnvelope;
      expect(p2.pageInfo?.currentPage).toBe(2);
      expect(p2.pageInfo?.perPage).toBe(PER_PAGE);
      // totalCount-derived totalPages must match across pages (same
      // filter window).
      expect(p2.pageInfo?.totalPages).toBe(payload.pageInfo.totalPages);
      // The two pages should not overlap by id (offset advanced).
      const ids1 = new Set(((payload.items ?? []) as Array<{ id: string }>).map((p) => p.id));
      const ids2 = ((p2.items ?? []) as Array<{ id: string }>).map((p) => p.id);
      for (const id of ids2) expect(ids1.has(id)).toBe(false);
    } else {
      process.stderr.write(
        `warning: test account has only ${(payload.pageInfo.totalPages * PER_PAGE).toString()}-or-fewer payouts — page-2 distinctness assertion skipped\n`,
      );
    }
  });

  // -------------------------------------------------------------------
  // Wire-shape snapshot assertion (T1 disposition; #373).
  //
  // Track 1 continuous-detection defense for the `Payments` op against
  // the post-merge wire-drift class (e.g., `totalCount` field
  // disappearing, `summary` shape evolving, projected `Payout` field
  // additions). Captured against the projected `PayoutsListResult`
  // since the payments service's projection layer is the surface
  // callers depend on; raw-wire drift inside that projection surfaces
  // as projection-layer breakage (caught upstream) OR projected-shape
  // diff (caught here). Snapshot lives at
  // `packages/e2e/src/wire-snapshots/Payments.snapshot.json`; first
  // authenticated run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` captures it.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("Payments wire shape matches snapshot (projected list)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await payments.payouts.list(token, { page: 1, perPage: 5 });
    if (response.items.length === 0) {
      process.stderr.write(
        "warning: Payments returned 0 rows (test account has no payouts) — wire-shape assertion skipped\n",
      );
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "Payments",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });
});
