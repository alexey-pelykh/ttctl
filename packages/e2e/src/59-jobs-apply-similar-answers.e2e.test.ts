// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// e2e-covers: SimilarJobQuestionAnswers

/**
 * E2E coverage for `ttctl jobs apply --suggest-answers` and the
 * `ttctl_jobs_apply_similar_answers` MCP tool (#452).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * `SimilarJobQuestionAnswers` is hand-authored from the captured op at
 * `research/graphql/gateway/operations/mobile/SimilarJobQuestionAnswers.graphql`,
 * and it's listed in `codegen.config.ts`'s
 * `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` (line 273) because the captured
 * op uses the `JobPositionAnswerFiltersInput` shape (with
 * `forQuestionsSimilarToQuestionId` + `uniqueAnswer`) which is not in
 * the synthesized schema (`viewer.jobPositionAnswers` is declared with
 * NO arguments). The live wire is the only authority on whether the
 * filter input + connection-style response are stable.
 *
 * **Safety**: this is a READ-ONLY operation. No mutations are issued.
 *
 *   - Always-on E2E gate: `TTCTL_E2E=1` — runs against the real
 *     gateway with the sandbox bearer.
 *   - The `--suggest-answers` flag requires a job with at least 1
 *     matcher or expertise question; the test selects the first such
 *     job from `applications list --status-group ON_RECRUITER_REVIEW`
 *     (a job with an open Interest Request — typically has matcher
 *     questions). When the test account has no such job, the
 *     positive-path tests skip with a stderr warning.
 *
 * **Wire-shape snapshot** (T1 per `docs/wire-validation-routing.md`):
 * the live response shape is captured at
 * `packages/e2e/src/wire-snapshots/SimilarJobQuestionAnswers.snapshot.json`
 * via `assertWireShapeStable`. Updates require
 * `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`.
 *
 * **Cardinality note**: `similarAnswers()` fans out one
 * SimilarJobQuestionAnswers call per question on the job's apply form.
 * The snapshot assertion targets ONE per-question response (the first
 * matcher question's call); the others are structurally identical.
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, applications } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
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
 * Resolve a job id that has at least one apply-form question. Strategy:
 *
 *   1. List the talent's activity items in `ON_RECRUITER_REVIEW` —
 *      these are the open Interest Requests; typically each carries
 *      matcher questions on the parent job.
 *   2. For each activity item's `job.id`, fetch
 *      `applyQuestions(jobId)`. The first job with >0 questions wins.
 *
 * Returns `null` when the test account has no matching job — the
 * positive-path tests skip with a stderr warning when this happens.
 */
async function resolveJobWithQuestions(token: string): Promise<string | null> {
  const list = await applications.list(token, { statusGroups: ["ON_RECRUITER_REVIEW"] });
  for (const item of list.items) {
    try {
      const questions = await applications.applyQuestions(token, item.job.id);
      if (questions.matcherQuestions.length + questions.expertiseQuestions.length > 0) {
        return item.job.id;
      }
    } catch {
      // Continue scanning — some items may not have a queryable job
      // (e.g. archived rows).
    }
  }
  return null;
}

describe("jobs apply --suggest-answers (live mobile-gateway, #452)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "similarAnswers() returns one SimilarJobAnswerGroup per question on the job's apply form (or empty array)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const jobId = await resolveJobWithQuestions(token);
      if (jobId === null) {
        process.stderr.write(
          "warning: test account has no ON_RECRUITER_REVIEW activity items with apply-form questions — similarAnswers shape assertion skipped\n",
        );
        return;
      }
      const groups = await applications.similarAnswers(token, jobId);
      // Shape assertion: array of {questionId, suggestions: [...]}
      expect(Array.isArray(groups)).toBe(true);
      for (const group of groups) {
        expect(typeof group.questionId).toBe("string");
        expect(Array.isArray(group.suggestions)).toBe(true);
        for (const s of group.suggestions) {
          expect(typeof s.id).toBe("string");
          expect(typeof s.answer).toBe("string");
          expect(typeof s.createdAt).toBe("string");
        }
      }
      // Cardinality: one group per question on the job's apply form.
      const questions = await applications.applyQuestions(token, jobId);
      const expectedGroupCount = questions.matcherQuestions.length + questions.expertiseQuestions.length;
      expect(groups).toHaveLength(expectedGroupCount);
    },
  );

  it.skipIf(!e2eEnabled)(
    "SimilarJobQuestionAnswers wire shape matches snapshot (T1 per docs/wire-validation-routing.md)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const jobId = await resolveJobWithQuestions(token);
      if (jobId === null) {
        process.stderr.write(
          "warning: test account has no ON_RECRUITER_REVIEW activity items with apply-form questions — SimilarJobQuestionAnswers wire-shape assertion skipped\n",
        );
        return;
      }
      // The snapshot captures the public projection's shape
      // (SimilarJobAnswerGroup[]) — consistent with how
      // `Payments.snapshot.json` captures the `PaymentListPage`
      // envelope, not the raw wire response. The N-fan-out responses
      // collapse into one structural manifest per group at the
      // captureWireShape layer (arrays unify their element shapes).
      const groups = await applications.similarAnswers(token, jobId);
      if (groups.length === 0) {
        process.stderr.write(
          "warning: similarAnswers returned 0 groups for the selected job — SimilarJobQuestionAnswers wire-shape assertion skipped\n",
        );
        return;
      }
      // Skip the assertion if EVERY group has an empty suggestions
      // array — the snapshot needs at least one non-empty
      // suggestions array to lock the inner shape; otherwise
      // captureWireShape collapses to `{ kind: "unknown" }` for the
      // inner type and the snapshot can't establish drift.
      const hasAnySuggestion = groups.some((g) => g.suggestions.length > 0);
      if (!hasAnySuggestion) {
        process.stderr.write(
          "warning: similarAnswers returned only empty suggestions arrays — SimilarJobQuestionAnswers inner-shape assertion skipped\n",
        );
        return;
      }
      expect(() =>
        assertWireShapeStable({
          operationName: "SimilarJobQuestionAnswers",
          surface: "mobile-gateway",
          transport: "stock",
          response: groups,
        }),
      ).not.toThrow();
    },
  );

  it.skipIf(!e2eEnabled)("similarAnswers() returns [] when the job has no apply-form questions", async () => {
    // Construct a job-id-with-no-questions scenario by selecting the
    // first eligible job from the platform's job board (these
    // typically don't have matcher questions until a recruiter
    // pings the talent). If the test account has no eligible jobs,
    // skip the assertion.
    const token = loadSandboxBearer(sandboxConfigPath);
    const { jobs } = await import("@ttctl/core");
    const eligible = await jobs.list(token, {});
    if (eligible.items.length === 0) {
      process.stderr.write(
        "warning: test account has no eligible jobs — similarAnswers empty-case assertion skipped\n",
      );
      return;
    }
    // Find a job with no questions.
    let zeroQuestionsJobId: string | null = null;
    for (const j of eligible.items.slice(0, 5)) {
      try {
        const q = await applications.applyQuestions(token, j.id);
        if (q.matcherQuestions.length + q.expertiseQuestions.length === 0) {
          zeroQuestionsJobId = j.id;
          break;
        }
      } catch {
        // skip
      }
    }
    if (zeroQuestionsJobId === null) {
      process.stderr.write(
        "warning: no eligible jobs with zero apply-form questions found in first 5 — similarAnswers empty-case assertion skipped\n",
      );
      return;
    }
    const groups = await applications.similarAnswers(token, zeroQuestionsJobId);
    expect(groups).toEqual([]);
  });

  it.skipIf(!e2eEnabled)("similarAnswers() rejects with NOT_FOUND for a bogus jobId (no state change)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    await expect(applications.similarAnswers(token, "bogus-job-id-doesnt-exist")).rejects.toMatchObject({
      name: "ApplicationsError",
      code: "NOT_FOUND",
    });
  });
});
