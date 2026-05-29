// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications confirm` WITH custom-question
 * answers + pitch payload (#445, #428, #429, ADR-008).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * `ConfirmAvailabilityRequest` is already covered for the no-answers
 * shape by `48-applications-confirm.e2e.test.ts` (#411). This file
 * adds coverage for the **answers-payload** input shape landed in #428
 * (CLI `--answers-file` / `--pitch-file`) and #429 (MCP
 * `matcherAnswers` / `expertiseAnswers` / `pitchData`). The mutation
 * accepts new variables (`$matcherQuestionsAnswers`,
 * `$expertiseQuestionsAnswers`, `$pitchInput` ← `pitchData:`) whose
 * acceptance by the wire was previously unverified.
 *
 * Coverage:
 *
 *   - **Always-on dry-run regression for #411**: `applications confirm
 *     <ar> --rate ... --kind ...` WITHOUT any answers-related flags
 *     emits the original preview shape. The new answers / pitch
 *     variables are present in the preview as `null` (the service
 *     emits `input.field ?? null` regardless of whether `#428` added
 *     the option) — confirming the additive change did not regress
 *     the pre-#428 envelope.
 *
 *   - **Always-on dry-run with answers + pitch files**: feed a small
 *     JSON file (matcherAnswers / expertiseAnswers / pitchData) and
 *     assert the preview's variables echo the file content. No wire
 *     call; exercises the CLI's file load + narrow path landed in
 *     #428.
 *
 *   - **Gated DESTRUCTIVE positive path** (`TTCTL_E2E_CONFIRM_INTEREST_REQUEST_WITH_QUESTIONS=<AR_id>`
 *     + `TTCTL_E2E_ANSWERS_FILE=<path>`): supplies a full answers
 *     payload to a real pending IR with mandatory questions; asserts
 *     the wire accepts and returns the success envelope. Refreshes
 *     the shared `ConfirmAvailabilityRequest.snapshot.json` wire-shape
 *     snapshot (verifying shape unchanged from the no-answers path
 *     covered by `48-applications-confirm.e2e.test.ts`).
 *
 *   - **Gated refusal path** (`TTCTL_E2E_CONFIRM_INTEREST_REQUEST_REQUIRES_ANSWERS=<AR_id>`):
 *     supplies a pending IR known to have mandatory questions but
 *     omits the answers file; asserts the wire rejects the call
 *     (`MUTATION_ERROR` or `GRAPHQL_ERROR` depending on Toptal's
 *     surfacing). Non-destructive — the wire rejects before
 *     transitioning the AR.
 *
 * **Wire-shape snapshot**: this file shares
 * `ConfirmAvailabilityRequest.snapshot.json` with
 * `48-applications-confirm.e2e.test.ts`. Both files assert against the
 * same snapshot; the response shape is identical regardless of
 * whether the input carried answers (the wire echoes the standard
 * AvailabilityRequestRespondPayload). The "verify shape unchanged from
 * #411" AC is satisfied by this shared assertion: drift surfaces from
 * either test.
 */

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigLoadSchema, applications } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

// e2e-covers: ConfirmAvailabilityRequest

const e2eEnabled = process.env["TTCTL_E2E"] === "1";
const acceptWithQuestionsArId = process.env["TTCTL_E2E_CONFIRM_INTEREST_REQUEST_WITH_QUESTIONS"];
const requiresAnswersArId = process.env["TTCTL_E2E_CONFIRM_INTEREST_REQUEST_REQUIRES_ANSWERS"];
const answersFilePathEnv = process.env["TTCTL_E2E_ANSWERS_FILE"];

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

interface ConfirmPreviewEnvelope {
  ok?: boolean;
  version?: string;
  dryRun?: boolean;
  operation?: string;
  preview?: {
    operationName?: string;
    surface?: string;
    transport?: string;
    variables?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  updated?: unknown;
}

describe("applications confirm with questions (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // ---------------------------------------------------------------------
  // Always-on regression for #411: no answers flags = unchanged preview
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "`applications confirm <ar> --rate --kind` WITHOUT --answers-file emits the pre-answers-file envelope shape",
    async () => {
      const result = await cli.run([
        "--dry-run",
        "applications",
        "confirm",
        "ar-doesnt-matter-in-dry-run",
        "--rate",
        "80.00",
        "--kind",
        "FIXED",
        "-o",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as ConfirmPreviewEnvelope;
      expect(payload.ok).toBe(true);
      expect(payload.dryRun).toBe(true);
      expect(payload.operation).toBe("applications.confirm");
      expect(payload.preview?.operationName).toBe("ConfirmAvailabilityRequest");
      expect(payload.preview?.surface).toBe("mobile-gateway");
      // The pre-#428 fields are present and unchanged.
      expect(payload.preview?.variables?.["id"]).toBe("ar-doesnt-matter-in-dry-run");
      expect(payload.preview?.variables?.["requestedHourlyRate"]).toBe("80.00");
      expect(payload.preview?.variables?.["kind"]).toBe("FIXED");
      // The #428-added fields are present in the preview as `null`
      // (the service emits `input.field ?? null` regardless of whether
      // the option was supplied) — confirms the additive change did
      // not regress.
      expect(payload.preview?.variables?.["matcherQuestionsAnswers"]).toBeNull();
      expect(payload.preview?.variables?.["expertiseQuestionsAnswers"]).toBeNull();
      expect(payload.preview?.variables?.["pitchInput"]).toBeNull();
      // Bearer must be redacted.
      expect(payload.preview?.headers?.["authorization"]).toBe("Token token=<redacted>");
      // No `updated` field on the dry-run path.
      expect(payload.updated).toBeUndefined();
    },
  );

  // ---------------------------------------------------------------------
  // Always-on dry-run with answers + pitch files
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "`applications confirm --answers-file --pitch-file` (dry-run) echoes the parsed payload into the preview variables",
    async () => {
      // Fixture shapes match the recovered Zod input schemas tightened
      // by #438 — matcher answers use { id, answer }; expertise answers
      // use { questionId, other, subjectId }; PitchInput requires every
      // nullable slot explicitly present (codegen `nullishBehavior:
      // "nullable"`).
      const tmp = mkdtempSync(join(tmpdir(), "ttctl-e2e-58-"));
      const answersPath = join(tmp, "answers.json");
      const pitchPath = join(tmp, "pitch.json");
      const answersPayload = {
        matcherAnswers: [{ id: "MQ-1", answer: "test-matcher-answer" }],
        expertiseAnswers: [{ questionId: "EQ-1", other: "test-expertise-answer", subjectId: null }],
      };
      const pitchPayload = {
        certificationPitchItems: null,
        educationPitchItems: null,
        employmentPitchItems: null,
        industryPitchItems: null,
        mentorship: "test pitch message",
        portfolioPitchItems: null,
        publicationPitchItems: null,
        skillPitchItems: null,
      };
      writeFileSync(answersPath, JSON.stringify(answersPayload), "utf8");
      writeFileSync(pitchPath, JSON.stringify(pitchPayload), "utf8");

      const result = await cli.run([
        "--dry-run",
        "applications",
        "confirm",
        "ar-doesnt-matter-in-dry-run",
        "--rate",
        "80.00",
        "--kind",
        "FIXED",
        "--answers-file",
        answersPath,
        "--pitch-file",
        pitchPath,
        "-o",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as ConfirmPreviewEnvelope;
      expect(payload.ok).toBe(true);
      expect(payload.dryRun).toBe(true);
      // Preview echoes the parsed JSON content under the wire-side
      // variable names (`matcherQuestionsAnswers`,
      // `expertiseQuestionsAnswers`, `pitchInput`). The wrapper-narrow
      // pass in confirm.ts (`narrowAnswersPayload` / `narrowPitchPayload`)
      // is what binds the JSON `matcherAnswers` key to the wire's
      // `matcherQuestionsAnswers` variable.
      expect(payload.preview?.variables?.["matcherQuestionsAnswers"]).toEqual(answersPayload.matcherAnswers);
      expect(payload.preview?.variables?.["expertiseQuestionsAnswers"]).toEqual(answersPayload.expertiseAnswers);
      expect(payload.preview?.variables?.["pitchInput"]).toEqual(pitchPayload);
    },
  );

  // ---------------------------------------------------------------------
  // Gated DESTRUCTIVE positive path
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled || acceptWithQuestionsArId === undefined || answersFilePathEnv === undefined)(
    "positive path (gated by TTCTL_E2E_CONFIRM_INTEREST_REQUEST_WITH_QUESTIONS + TTCTL_E2E_ANSWERS_FILE): confirms IR with full answers payload + asserts wire shape",
    async () => {
      // Gated by env vars — the operator supplies a REAL pending AR
      // id (with mandatory matcher / expertise questions attached) and
      // a JSON file containing the answers payload they want to send.
      // Confirming is irreversible (transitions AR to
      // AVAILABILITY_REQUEST_CONFIRMED, creates a JobApplication).
      if (acceptWithQuestionsArId === undefined || answersFilePathEnv === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);

      // Read + parse the operator-supplied answers file directly to
      // drive the service layer (so the response is available for the
      // wire-shape snapshot). The CLI surface is exercised on the
      // dry-run path above; this path verifies the apply path
      // semantics end-to-end against the live wire.
      const answersRaw = readFileSync(answersFilePathEnv, "utf8");
      const parsed = JSON.parse(answersRaw) as {
        matcherAnswers?: unknown[];
        expertiseAnswers?: unknown[];
        pitchData?: Record<string, unknown>;
      };
      const input: applications.ConfirmInput = {};
      if (parsed.matcherAnswers !== undefined) input.matcherQuestionsAnswers = parsed.matcherAnswers;
      if (parsed.expertiseAnswers !== undefined) input.expertiseQuestionsAnswers = parsed.expertiseAnswers;
      if (parsed.pitchData !== undefined) input.pitchInput = parsed.pitchData;

      const outcome = await applications.confirm(token, acceptWithQuestionsArId, input);
      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") return;
      expect(outcome.result.id).toBe(acceptWithQuestionsArId);
      // Post-confirm status is terminal-confirmed (the wire's exact
      // value spelling is INFERRED — we assert via verbose membership
      // rather than the value string, mirroring 48-applications-confirm).
      expect(outcome.result.statusV2.value).toContain("CONFIRMED");

      // Wire-shape snapshot — shared with 48-applications-confirm.
      // Asserting here catches drift triggered by the answers-payload
      // input shape (e.g. a response field that only surfaces when
      // mandatory questions exist on the AR).
      expect(() =>
        assertWireShapeStable({
          operationName: "ConfirmAvailabilityRequest",
          surface: "mobile-gateway",
          transport: "stock",
          response: outcome.result,
        }),
      ).not.toThrow();
    },
  );

  // ---------------------------------------------------------------------
  // Gated refusal path — IR with mandatory questions, no --answers-file
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled || requiresAnswersArId === undefined)(
    "refusal path (gated by TTCTL_E2E_CONFIRM_INTEREST_REQUEST_REQUIRES_ANSWERS): confirming a mandatory-questions IR WITHOUT --answers-file surfaces a wire-side error",
    async () => {
      // Gated by env var — the operator supplies an AR id known to
      // have mandatory matcher / expertise questions. The wire
      // SHOULD reject the confirm call when the answers payload is
      // empty, but the exact error code / message is the wire's
      // authority. Non-destructive: the wire rejects before
      // transitioning the AR.
      if (requiresAnswersArId === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);

      let caught: unknown;
      try {
        // Confirm with NO answers payload. Pre-fetch resolves
        // kind/rate; the mutation goes to the wire with
        // `matcherQuestionsAnswers: null` and
        // `expertiseQuestionsAnswers: null`.
        await applications.confirm(token, requiresAnswersArId);
      } catch (err) {
        caught = err;
      }
      // The wire SHOULD reject — assert we caught something. Either a
      // typed ApplicationsError (most likely MUTATION_ERROR or
      // GRAPHQL_ERROR) or an unexpected throw. Record the observation
      // for triage.
      expect(caught).toBeDefined();
      if (caught instanceof applications.ApplicationsError) {
        // Acceptable codes: MUTATION_ERROR (wire returned
        // success: false with an error message about missing answers)
        // or GRAPHQL_ERROR (wire returned a top-level error).
        expect(["MUTATION_ERROR", "GRAPHQL_ERROR", "WIRE_SHAPE_ERROR", "UNKNOWN"]).toContain(caught.code);
        process.stderr.write(
          `[refusal probe] confirm without answers on mandatory-questions IR ${requiresAnswersArId} returned code=${caught.code} message=${caught.message}\n`,
        );
      } else {
        process.stderr.write(
          `[refusal probe] confirm without answers on mandatory-questions IR ${requiresAnswersArId} threw unexpected: ${String(caught)}\n`,
        );
      }
    },
  );
});
