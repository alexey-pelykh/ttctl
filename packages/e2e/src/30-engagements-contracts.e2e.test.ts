// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl engagements contracts {list, show}` (#157).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * the `EngagementContracts` operation is a hand-authored / derived
 * query (not codegen-driven), the wire input shape (`$jobActivityItemId:
 * ID!`) is reused from the `EngagementBreaks` capture pattern, and the
 * projection sub-selection (`currentAgreement.{applicationRate,
 * talentRate, talentHourlyRate, marketplaceMargin, timePeriod,
 * commitment}`) is the same fragment shape used in
 * `JobActivityItem.graphql`'s `currentAgreementRateData` plus the
 * `commitment` sub-selection. Unit tests with mocks accept any shape;
 * only the live API can confirm the contract.
 *
 * Coverage:
 *   - `contracts list <id>` returns the v1.0 list envelope shape with
 *     array-of-one and the full `EngagementContract` projection.
 *   - `contracts show <id>` returns the bare detail with the same
 *     projection.
 *   - Both expose `jobActivityItemId` and `engagementId` (transparency).
 *   - Unknown id surfaces `EngagementsError(NOT_FOUND)` structured
 *     error.
 *
 * The engagement id is discovered from `engagements list --status all`
 * so the test doesn't need a hard-coded fixture id.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("engagements contracts (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the contracts list (array-of-one) for a known engagement id", async () => {
    const listResult = await cli.run(["engagements", "list", "--status", "all", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const list = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const firstId = list.items[0]?.id;
    if (firstId === undefined) {
      process.stderr.write(
        "warning: engagements list returned 0 rows (test account has never had an engagement) — contracts assertions skipped\n",
      );
      return;
    }

    const contractsResult = await cli.run(["engagements", "contracts", "list", firstId, "-o", "json"]);
    expect(contractsResult.exitCode).toBe(0);

    const payload = JSON.parse(contractsResult.stdout) as {
      version?: string;
      items?: Array<Record<string, unknown>>;
    };
    expect(payload.version).toBe("1.0");
    expect(Array.isArray(payload.items)).toBe(true);
    // Wire contract: today the API returns at most ONE current
    // agreement per engagement. If/when Toptal exposes per-engagement
    // history, this assertion can soften to `>= 1`.
    expect(payload.items?.length).toBe(1);

    const contract = payload.items?.[0];
    expect(contract).toBeDefined();
    if (contract === undefined) return;
    expect(contract["jobActivityItemId"]).toBe(firstId);
    expect("engagementId" in contract).toBe(true);
    expect("applicationRate" in contract).toBe(true);
    expect("talentRate" in contract).toBe(true);
    expect("talentHourlyRate" in contract).toBe(true);
    expect("marketplaceMargin" in contract).toBe(true);
    expect("timePeriod" in contract).toBe(true);
    expect("commitment" in contract).toBe(true);
  });

  it.skipIf(!e2eEnabled)("returns the bare contract detail via `contracts show` for the same id", async () => {
    const listResult = await cli.run(["engagements", "list", "--status", "all", "-o", "json"]);
    expect(listResult.exitCode).toBe(0);
    const list = JSON.parse(listResult.stdout) as { items: Array<{ id?: string }> };
    const firstId = list.items[0]?.id;
    if (firstId === undefined) {
      process.stderr.write("warning: engagements list returned 0 rows — contracts show assertions skipped\n");
      return;
    }

    const showResult = await cli.run(["engagements", "contracts", "show", firstId, "-o", "json"]);
    expect(showResult.exitCode).toBe(0);

    const contract = JSON.parse(showResult.stdout) as Record<string, unknown>;
    expect(contract["jobActivityItemId"]).toBe(firstId);
    expect("engagementId" in contract).toBe(true);
    expect("applicationRate" in contract).toBe(true);
    expect("talentRate" in contract).toBe(true);
    expect("talentHourlyRate" in contract).toBe(true);
    expect("marketplaceMargin" in contract).toBe(true);
    expect("timePeriod" in contract).toBe(true);
    expect("commitment" in contract).toBe(true);
    // `show` returns the bare contract — no `version` / `items` envelope
    expect("version" in contract).toBe(false);
    expect("items" in contract).toBe(false);
  });

  it.skipIf(!e2eEnabled)("returns a structured NOT_FOUND error for an unknown id (list)", async () => {
    const fakeId = "act_00000000000000000000000000000000";
    const result = await cli.run(["engagements", "contracts", "list", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });

  it.skipIf(!e2eEnabled)("returns a structured NOT_FOUND error for an unknown id (show)", async () => {
    const fakeId = "act_00000000000000000000000000000000";
    const result = await cli.run(["engagements", "contracts", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; errors?: Array<{ code?: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });
});
