// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// e2e-covers: GetEngagementPayments

/**
 * E2E coverage for `ttctl engagements payments list` (#388).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * `GetEngagementPayments` is a hand-authored portal op against a schema
 * gap (`GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`; the portal `TalentPayment`
 * fragment adds `kind` / `paymentMethod` / `downloadHtmlUrl` and the
 * billing-cycle `availability` / `hours` / `talentRate` not present in
 * the synthesized SDL). Track 1 — the live call IS the wire proof.
 *
 * READ-only, round-trip safe (no mutation).
 *
 * Coverage:
 *   - `engagements payments list <job-id>` returns exit 0 and a list
 *     envelope for the account's current engagement (addressed by JOB
 *     id — the `job.id` from `engagements list`).
 *   - Track 1 `assertWireShapeStable` diff on the `{ items, totalCount }`
 *     connection projection.
 *
 * **Skip conditions** (silent — emit a stderr warning):
 *   - Test account has zero engagements (no job id to probe).
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, engagements } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

/**
 * Resolve a JOB id from the account's engagements. `engagements payments
 * list` is keyed by the `job.id` (not the activity-item row id), so we
 * read it from the engagements-list envelope's `items[].job.id`.
 */
async function probeJobId(cli: CliClient): Promise<string | undefined> {
  const listResult = await cli.run(["engagements", "list", "-o", "json"]);
  expect(listResult.exitCode).toBe(0);
  const listed = JSON.parse(listResult.stdout) as { items: Array<{ job?: { id?: string } }> };
  return listed.items[0]?.job?.id;
}

describe("engagements payments (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("engagements payments list returns the list envelope for the current engagement", async () => {
    const jobId = await probeJobId(cli);
    if (jobId === undefined) {
      process.stderr.write("warning: no engagements in test account — engagements payments assertions skipped\n");
      return;
    }
    const result = await cli.run(["engagements", "payments", "list", jobId, "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { items: Array<Record<string, unknown>> };
    expect(Array.isArray(payload.items)).toBe(true);
    // When the engagement has payments, assert the projected shape on the
    // first row (positive shape check per the schema/contract rule).
    const first = payload.items[0];
    if (first !== undefined) {
      for (const key of ["id", "number", "amount", "status", "billingCycle", "memorandums"]) {
        expect(key in first).toBe(true);
      }
    } else {
      process.stderr.write("warning: current engagement has no payments — payments row shape assertion skipped\n");
    }
  });

  // Track 1: snapshot the wire-bearing connection projection
  // `{ items, totalCount }` only — the page's `limit` / `after` /
  // `nextCursor` are client-derived pagination metadata (null on a
  // no-arg probe), not wire fields, so they're excluded from the diff.
  // First run with `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` writes the
  // snapshot; subsequent runs diff against it.
  it.skipIf(!e2eEnabled)("GetEngagementPayments wire shape matches snapshot (Track 1)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const jobId = await probeJobId(cli);
    if (jobId === undefined) {
      process.stderr.write("warning: no engagements in test account — GetEngagementPayments snapshot skipped\n");
      return;
    }
    const page = await engagements.payments.list(token, jobId);
    expect(() =>
      assertWireShapeStable({
        operationName: "GetEngagementPayments",
        surface: "mobile-gateway",
        transport: "stock",
        response: { items: page.items, totalCount: page.totalCount },
      }),
    ).not.toThrow();
  });
});
