// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl surveys submit` (#673).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * `SubmitSurvey` mutation is hand-authored against the synthesized schema
 * (it sits in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`; `SurveyAnswerInput`'s
 * scalar types are `Unknown`-typed in the SDL). The mutation input shape
 * (`{ kind, surveyId, answers: [{ questionId, id, value }], version: 2 }`)
 * was verified against a live round-trip on 2026-05-29 before merge; the
 * passing transcript is in the PR body.
 *
 * **Safety**: this file does NOT submit a real survey on the always-on
 * paths. Submission is irreversible (no un-answer wire op) and routes
 * feedback to a third party. The always-on paths exercise the wire
 * contract via the consent gate and the resolution path WITHOUT issuing
 * the mutation:
 *
 *   - Consent-missing refusal: `surveys submit <id> -a q=v` (no
 *     `--consent-survey-submission`) → `CONSENT_REQUIRED` BEFORE any wire
 *     call (the service consent gate fires ahead of the `PendingSurveys`
 *     read). Defense-in-depth.
 *   - Non-existent survey id WITH consent: the consent gate passes, the
 *     `PendingSurveys` read runs, and the bogus id is matched client-side
 *     against the pending list → `NOT_FOUND`. The `SubmitSurvey` mutation
 *     never reaches the wire (the id is never sent). Proves bearer auth +
 *     the read + the resolution path without clobbering survey state.
 *
 * **Gated DESTRUCTIVE positive path**: runs only when
 * `TTCTL_E2E_SUBMIT_SURVEY=<surveyId>` is exported (with
 * `TTCTL_E2E_SUBMIT_SURVEY_ANSWERS="q1=v1,q2=v2"`). The operator opts in by
 * supplying a REAL pending survey they actually want to answer. Submitting
 * is irreversible. The path calls the core service directly so the response
 * can feed `assertWireShapeStable`.
 *
 * **Wire-shape snapshot** (T1 per ADR-006 / `docs/wire-validation-routing.md`):
 * `wire-snapshots/SubmitSurvey.snapshot.json` is committed as a static
 * reference derived from the 2026-05-29 manual real-submit transcript
 * (projected `SubmitSurveyResult` = `{ notice, pendingSurveys[] }`). The
 * gated positive path asserts against it and refreshes it with
 * `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`. The single-capture snapshot pins
 * `notice: null` and a non-empty `pendingSurveys`; a refresh is expected on
 * the first gated run if the live `notice` is non-null or the submitted
 * survey was the last pending one (the structure-only diff flags either).
 * `SubmitSurvey` is in the codegen-exclusion list, so no T2 Zod schema
 * exists — the snapshot is the continuous wire-drift defense.
 */

// e2e-covers: SubmitSurvey

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, surveys } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";
const submitSurveyId = process.env["TTCTL_E2E_SUBMIT_SURVEY"];
const submitAnswersRaw = process.env["TTCTL_E2E_SUBMIT_SURVEY_ANSWERS"];

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

/** Parse `"q1=v1,q2=v2"` into the service's `RawSurveyAnswer[]`. */
function parseAnswerEnv(raw: string | undefined): surveys.RawSurveyAnswer[] {
  return (raw ?? "")
    .split(",")
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return { questionId: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
}

describe("surveys submit (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // ---------------------------------------------------------------------
  // Always-on paths (no real submission)
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "consent-missing refusal: `surveys submit <id> -a q=v` without the consent flag → CONSENT_REQUIRED, no wire mutation",
    async () => {
      const result = await cli.run(["surveys", "submit", "VjEtQW55U3VydmV5LTA", "-a", "q-1=5", "-o", "json"]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: Array<{ code?: string; hint?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("surveys.submit");
      expect(payload.errors?.[0]?.code).toBe("CONSENT_REQUIRED");
      expect(payload.errors?.[0]?.hint).toMatch(/--consent-survey-submission/);
    },
  );

  it.skipIf(!e2eEnabled)(
    "non-existent survey id WITH consent → NOT_FOUND at the resolution step (SubmitSurvey mutation never issued)",
    async () => {
      // The consent gate passes; `prepareSubmission` runs the
      // `PendingSurveys` read and matches the bogus id client-side. The id
      // is never sent on the wire, so survey state is untouched regardless
      // of the account's pending list.
      const fakeId = "VjEtU3VydmV5LTk5OTk5OTk5OQ"; // valid base64, non-existent
      const result = await cli.run([
        "surveys",
        "submit",
        fakeId,
        "-a",
        "q-1=5",
        "--consent-survey-submission",
        "-o",
        "json",
      ]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: Array<{ code?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("surveys.submit");
      expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
    },
  );

  // ---------------------------------------------------------------------
  // Gated DESTRUCTIVE positive path
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled || submitSurveyId === undefined)(
    "positive path (gated by TTCTL_E2E_SUBMIT_SURVEY): submits the supplied survey + asserts the wire-shape snapshot",
    async () => {
      if (submitSurveyId === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);
      const answers = parseAnswerEnv(submitAnswersRaw);

      const result = await surveys.submit(
        token,
        { surveyId: submitSurveyId, answers },
        { surveySubmissionConsentIssued: true },
      );
      // The payload carries the refreshed pending list (the submitted
      // survey is absent on success) and an optional notice.
      expect(Array.isArray(result.pendingSurveys)).toBe(true);
      expect(result.pendingSurveys.every((s) => typeof s.id === "string")).toBe(true);

      // Wire-shape snapshot — asserts against the committed reference;
      // refresh with TTCTL_UPDATE_WIRE_SNAPSHOTS=1.
      expect(() =>
        assertWireShapeStable({
          operationName: "SubmitSurvey",
          surface: "mobile-gateway",
          transport: "stock",
          response: result,
        }),
      ).not.toThrow();
    },
  );
});
