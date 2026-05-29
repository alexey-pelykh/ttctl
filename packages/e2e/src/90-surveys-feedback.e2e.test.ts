// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E for `ttctl surveys feedback` (`AddSurveyFeedback`). The op is
 * hand-authored against the synthesized SDL (`*_KNOWN_UNTRUSTED_OPS`, T1), so
 * the wire shape is INFERRED until a live round-trip confirms it.
 *
 * Always-on paths add NO real feedback (irreversible, routed to a third party):
 * a consent-missing refusal, and a bogus-id `NOT_FOUND` at the kind-resolution
 * read — both exercise bearer auth without issuing the mutation.
 *
 * The gated positive path issues a real `AddSurveyFeedback` and asserts the T1
 * snapshot. Opt in with `TTCTL_E2E_ADD_SURVEY_FEEDBACK=<surveyId>` (+
 * `TTCTL_E2E_ADD_SURVEY_FEEDBACK_KIND=<kind>` to feedback a non-pending survey).
 * The snapshot pins `notice: null`; a non-null live `notice` drifts the
 * structure-only diff on first run — refresh with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`.
 */

// e2e-covers: AddSurveyFeedback

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, surveys } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";
const feedbackSurveyId = process.env["TTCTL_E2E_ADD_SURVEY_FEEDBACK"];
const feedbackKind = process.env["TTCTL_E2E_ADD_SURVEY_FEEDBACK_KIND"];

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("surveys feedback (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "consent-missing refusal: `surveys feedback <id> --text …` without the consent flag → CONSENT_REQUIRED, no wire call",
    async () => {
      const result = await cli.run(["surveys", "feedback", "VjEtQW55U3VydmV5LTA", "--text", "Nice.", "-o", "json"]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: Array<{ code?: string; hint?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("surveys.feedback");
      expect(payload.errors?.[0]?.code).toBe("CONSENT_REQUIRED");
      expect(payload.errors?.[0]?.hint).toMatch(/--consent-survey-submission/);
    },
  );

  it.skipIf(!e2eEnabled)(
    "non-existent survey id WITH consent (no --kind) → NOT_FOUND at the resolution read (AddSurveyFeedback never issued)",
    async () => {
      const fakeId = "VjEtU3VydmV5LTk5OTk5OTk5OQ"; // valid base64, non-existent
      const result = await cli.run([
        "surveys",
        "feedback",
        fakeId,
        "--text",
        "Nice.",
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
      expect(payload.operation).toBe("surveys.feedback");
      expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
    },
  );

  it.skipIf(!e2eEnabled || feedbackSurveyId === undefined)(
    "positive path (gated by TTCTL_E2E_ADD_SURVEY_FEEDBACK): adds real feedback + asserts the wire-shape snapshot",
    async () => {
      if (feedbackSurveyId === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);

      const args: surveys.AddSurveyFeedbackArgs =
        feedbackKind === undefined
          ? { surveyId: feedbackSurveyId, feedback: "Thanks — submitted via ttctl e2e." }
          : { surveyId: feedbackSurveyId, feedback: "Thanks — submitted via ttctl e2e.", kind: feedbackKind };
      const result = await surveys.addFeedback(token, args, { surveySubmissionConsentIssued: true });

      expect(result).toHaveProperty("notice");

      expect(() =>
        assertWireShapeStable({
          operationName: "AddSurveyFeedback",
          surface: "mobile-gateway",
          transport: "stock",
          response: result,
        }),
      ).not.toThrow();
    },
  );
});
