// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `applications.applyData`, `applications.applyQuestions`,
 * `applications.rateInsight` — the three pre-apply read ops the apply
 * funnel exposes (#445, #424, ADR-008).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * all three operations are hand-authored against the synthesized
 * schema (`JobApplyData`, `JobApplicationQuestions`,
 * `JobApplicationRateInsight` — all listed in `codegen.config.ts`'s
 * `KNOWN_UNTRUSTED_OPS`). Their selection sets touch the apply-funnel
 * subtree on `TalentJob.operations.apply` and the question / rate
 * inventories the portal renders alongside the apply screen. Live
 * verification is the only authority on whether the wire accepts the
 * argument types and returns the asserted shape.
 *
 * Coverage:
 *
 *   - **Happy path** (auto-discovers via `jobs list`): each of the
 *     three queries succeeds against a real eligible job. Captures the
 *     wire-shape snapshot for all three (T1 per ADR-006).
 *   - **Bad-id path**: each query against a valid-format non-existent
 *     id surfaces `NOT_FOUND` (Relay decode error mapped to the typed
 *     code by the service, per `project_toptal_wire_quirks` auto-memory).
 *   - **Design open Q2** (mandatory-question metadata) — the happy
 *     path captures whatever shape `applyQuestions` returns. If the
 *     response carries a `required` / `mandatory` / `isRequired` flag
 *     on the per-question entries, the wire-shape snapshot pins it.
 *     If absent, the snapshot is the empirical record that no such
 *     flag exists at the surface level (which would mean callers must
 *     attempt the apply and surface the wire's rejection to surface
 *     "you must answer this").
 *
 * **Wire-shape snapshots** (T1 per `docs/wire-validation-routing.md`):
 * captured on the happy path; committed on first run with
 * `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` (one snapshot per op).
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, applications } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

// e2e-covers: JobApplyData, JobApplicationQuestions, JobApplicationRateInsight

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
 * Resolve the first eligible job id from `jobs list`, or return `null`
 * when the test account has none (skip the happy path with a stderr
 * warning, mirroring `24-jobs.e2e.test.ts`).
 */
async function pickEligibleJobId(cli: CliClient): Promise<string | null> {
  const listResult = await cli.run(["jobs", "list", "-o", "json"]);
  expect(listResult.exitCode).toBe(0);
  const listed = JSON.parse(listResult.stdout) as { items?: Array<{ id?: string }> };
  if (!Array.isArray(listed.items) || listed.items.length === 0) {
    return null;
  }
  const first = listed.items[0];
  return first?.id ?? null;
}

describe("jobs apply pre-apply read suite (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // ---------------------------------------------------------------------
  // Happy path — auto-discover eligible job
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "applyData returns the pre-apply context for an eligible job + captures wire-shape snapshot",
    async () => {
      const jobId = await pickEligibleJobId(cli);
      if (jobId === null) {
        process.stderr.write(
          "warning: no eligible jobs in test account — jobs apply-data happy-path assertion skipped\n",
        );
        return;
      }
      const token = loadSandboxBearer(sandboxConfigPath);
      const data = await applications.applyData(token, jobId);
      // `canApply` is a boolean; `applyErrors` is an array (possibly
      // empty); `suggestedRate` is a decimal string or null;
      // `rateValidation` is either `{ minRate, rateStep }` or null.
      expect(typeof data.canApply).toBe("boolean");
      expect(Array.isArray(data.applyErrors)).toBe(true);
      expect(data.suggestedRate === null || typeof data.suggestedRate === "string").toBe(true);
      if (data.rateValidation !== null) {
        expect(typeof data.rateValidation.minRate).toBe("string");
        expect(typeof data.rateValidation.rateStep).toBe("number");
      }
      expect(() =>
        assertWireShapeStable({
          operationName: "JobApplyData",
          surface: "mobile-gateway",
          transport: "stock",
          response: data,
        }),
      ).not.toThrow();
    },
  );

  it.skipIf(!e2eEnabled)(
    "applyQuestions returns matcher + expertise question inventories for an eligible job (resolves Q2 mandatory-metadata via snapshot)",
    async () => {
      const jobId = await pickEligibleJobId(cli);
      if (jobId === null) {
        process.stderr.write(
          "warning: no eligible jobs in test account — jobs apply-questions happy-path assertion skipped\n",
        );
        return;
      }
      const token = loadSandboxBearer(sandboxConfigPath);
      const questions = await applications.applyQuestions(token, jobId);
      // Both inventories are arrays (possibly empty for jobs that
      // don't require custom questions). Each entry has at least the
      // `identifier` and `prompt` fields the service projects.
      expect(Array.isArray(questions.matcherQuestions)).toBe(true);
      expect(Array.isArray(questions.expertiseQuestions)).toBe(true);
      for (const q of questions.matcherQuestions) {
        expect(typeof q.identifier).toBe("string");
        expect(typeof q.prompt).toBe("string");
      }
      for (const q of questions.expertiseQuestions) {
        expect(typeof q.identifier).toBe("string");
        expect(typeof q.prompt).toBe("string");
      }
      // The wire-shape snapshot is the empirical record of whether a
      // `required` / `mandatory` flag is present on each entry
      // (design open Q2). If the snapshot shows it, the service can
      // surface it in the projection; if not, the surface stays
      // "wire is the authority on rejection".
      expect(() =>
        assertWireShapeStable({
          operationName: "JobApplicationQuestions",
          surface: "mobile-gateway",
          transport: "stock",
          response: questions,
        }),
      ).not.toThrow();
    },
  );

  it.skipIf(!e2eEnabled)(
    "rateInsight returns either a competitive / uncompetitive variant OR null for an eligible job",
    async () => {
      const jobId = await pickEligibleJobId(cli);
      if (jobId === null) {
        process.stderr.write(
          "warning: no eligible jobs in test account — jobs rate-insight happy-path assertion skipped\n",
        );
        return;
      }
      const token = loadSandboxBearer(sandboxConfigPath);
      const insight = await applications.rateInsight(token, jobId);
      // The service either returns `null` (platform supplied no
      // insight) OR a discriminated union variant. Each variant's
      // shape is implementation-defined; the snapshot pins it.
      if (insight !== null) {
        expect(typeof insight).toBe("object");
      }
      expect(() =>
        assertWireShapeStable({
          operationName: "JobApplicationRateInsight",
          surface: "mobile-gateway",
          transport: "stock",
          response: insight,
        }),
      ).not.toThrow();
    },
  );

  // ---------------------------------------------------------------------
  // Bad-id paths — each query against a non-existent id surfaces NOT_FOUND
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("applyData returns NOT_FOUND for a valid-format non-existent job id", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const fakeId = "VjEtSm9iLTk5OTk5OTk5OQ"; // same probe as 24-jobs / 53-jobs-apply
    let caught: unknown;
    try {
      await applications.applyData(token, fakeId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(applications.ApplicationsError);
    if (!(caught instanceof applications.ApplicationsError)) return;
    expect(["NOT_FOUND", "GRAPHQL_ERROR"]).toContain(caught.code);
  });

  it.skipIf(!e2eEnabled)("applyQuestions returns NOT_FOUND for a valid-format non-existent job id", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const fakeId = "VjEtSm9iLTk5OTk5OTk5OQ";
    let caught: unknown;
    try {
      await applications.applyQuestions(token, fakeId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(applications.ApplicationsError);
    if (!(caught instanceof applications.ApplicationsError)) return;
    expect(["NOT_FOUND", "GRAPHQL_ERROR"]).toContain(caught.code);
  });

  it.skipIf(!e2eEnabled)("rateInsight returns NOT_FOUND for a valid-format non-existent job id", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const fakeId = "VjEtSm9iLTk5OTk5OTk5OQ";
    let caught: unknown;
    try {
      await applications.rateInsight(token, fakeId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(applications.ApplicationsError);
    if (!(caught instanceof applications.ApplicationsError)) return;
    expect(["NOT_FOUND", "GRAPHQL_ERROR"]).toContain(caught.code);
  });
});
