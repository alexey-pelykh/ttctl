// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitDryRunSuccess, emitErrorAndExit, emitUpdateSuccess } from "../../lib/envelopes.js";
import { JsonInputError, readJsonInput } from "../../lib/json-input.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleApplicationsError, loadAuthTokenOrExit } from "../applications/shared.js";

/**
 * Options for `ttctl jobs apply <id>` (#430). The CLI verb lives on
 * `jobs` (reads naturally: "apply to a job") while the underlying
 * service module is `applications.apply` per ADR-008 § Decision Part 5.
 *
 * `--consent` is the user-side legal-compliance attestation locked by
 * ADR-008 § Decision Part 4 — absence raises `CONSENT_REQUIRED` BEFORE
 * any wire call. Auto-filling this field is forbidden.
 *
 * `--answers-file` / `--pitch-file` follow the ADR-008 § Decision Part 2
 * JSON-file grammar (sibling to `applications confirm` per #428): a
 * path (or `-` for stdin) pointing at a JSON document; the wrapper
 * shape is verified before any wire call, the inner content is
 * Stage-1-opaque pass-through to the wire.
 */
export interface JobsApplyOptions {
  /**
   * Legal-compliance attestation per ADR-008 § Decision Part 4. MUST be
   * supplied by the user — auto-filling is forbidden. Absence raises
   * `CONSENT_REQUIRED` with no wire call issued.
   */
  consent?: boolean;
  /**
   * Optional hourly rate the talent requests (decimal string, matches
   * `BigDecimal!`). When omitted, the service defaults from
   * `PreApplyData.suggestedRate` (REQ-A4). When supplied, must pass the
   * `DECIMAL_PATTERN` regex.
   */
  rate?: string;
  /**
   * Optional talent-side free-text accompanying message. Forwarded to
   * `applications.apply` as `message`, which maps to the wire
   * `$comment` variable on the `JobApply` mutation.
   */
  message?: string;
  /**
   * Path to a JSON file (or `-` for stdin) containing
   * `{ matcherAnswers: [...], expertiseAnswers: [...] }` per ADR-008
   * § Decision Part 2. Wrapper shape verified before any wire call;
   * inner content forwarded opaquely (Stage 1) — Stage 2 (#438)
   * tightens to recovered Zod schemas.
   */
  answersFile?: string;
  /**
   * Path to a JSON file (or `-` for stdin) containing a `PitchInput`
   * object. Forwarded to `applications.apply` as `pitchData`, mapping
   * to the wire `$talentCard` variable. Wrapper shape verified;
   * inner content opaque (Stage 1).
   */
  pitchFile?: string;
  /**
   * Preview-only flag (REQ-Q3). When set, fetches `applyData` +
   * `applyQuestions` and emits the inventory WITHOUT issuing the
   * `JobApply` mutation. Does NOT require `--consent` (read-only
   * path; never reaches the apply mutation).
   */
  showQuestions?: boolean;
  output: OutputFormat;
}

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Shape of the parsed `--answers-file` payload. Mirrors the
 * ADR-008-locked grammar used by `applications confirm` (#428) — the
 * JSON-file keys are `matcherAnswers` / `expertiseAnswers` (wire-side
 * names). Both keys are optional independently; an empty file `{}` is
 * acceptable but normally meaningless and the wire will likely reject —
 * left to the server as the authority.
 *
 * Stage-1 opaque (ADR-008 § Decision Part 3): both arrays are `unknown[]`
 * — the JSON content is forwarded verbatim to the wire. Stage-2 (#438)
 * will narrow these to the recovered Zod schemas
 * (`JobPositionAnswerInput[]` / `JobExpertiseAnswerInput[]`).
 */
interface AnswersFilePayload {
  matcherAnswers?: unknown[];
  expertiseAnswers?: unknown[];
}

/**
 * Projection emitted on the `--show-questions` preview path. Carries
 * the pre-apply context (canApply, applyErrors, suggestedRate,
 * rateValidation) alongside the matcher + expertise question
 * inventories so the user can author an `--answers-file` payload
 * without a separate command. The shape is distinct from the
 * service-layer's {@link applications.PreApplyData} /
 * {@link applications.ApplicationQuestions} types so consumers
 * don't have to reach across two type namespaces.
 */
interface ShowQuestionsProjection {
  jobId: string;
  canApply: boolean;
  applyErrors: applications.ApplyError[];
  suggestedRate: string | null;
  rateValidation: { minRate: string; rateStep: number } | null;
  matcherQuestions: applications.ApplicationQuestion[];
  expertiseQuestions: applications.ApplicationQuestion[];
}

/**
 * Action handler for `ttctl jobs apply <id>` (#430).
 *
 * Issues the direct `JobApply` mutation via `applications.apply()` (per
 * ADR-008 § Decision Part 5: the service module is `applications`; the
 * user-facing verb lives on `jobs`). The handler enforces three
 * pre-wire gates in order:
 *
 *   1. **`--show-questions` preview** — when set, fetches `applyData`
 *      + `applyQuestions` in parallel and emits the projection;
 *      returns BEFORE the consent gate (read-only path).
 *   2. **Consent gate** — `--consent` is REQUIRED per ADR-008 § Decision
 *      Part 4. Absence raises `CONSENT_REQUIRED` with no wire call
 *      issued. The service's own runtime check at `apply()` is
 *      defense-in-depth.
 *   3. **`--rate` validation** — decimal-string format enforced via
 *      {@link DECIMAL_PATTERN} (mirrors the `applications confirm`
 *      pattern). Bad input refuses with `MUTATION_ERROR`.
 *
 * `--answers-file` / `--pitch-file` are loaded + wrapper-shape-validated
 * BEFORE the apply call (mirrors #428 confirm semantics): malformed
 * JSON or wrong wrapper shape refuses with `VALIDATION_ERROR` and no
 * mutation is issued.
 *
 * **DESTRUCTIVE** — applying to a job creates a `JobApplication`
 * record. No `withdraw` operation is available on the wire (per ADR-008
 * § What We're NOT Solving). Prefer `--dry-run` to preview the wire
 * payload first; the AC scenarios pin the dry-run preview shape.
 */
export async function runJobsApply(id: string, opts: JobsApplyOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs apply", opts.output);
  const dryRun = getCliDryRun();

  // ---- 1. --show-questions preview (BEFORE consent gate) ----
  // Read-only path: fetches the pre-apply context the user would need
  // to author an answers-file payload (REQ-Q3). Skips both the consent
  // gate AND the JobApply mutation; matches the AC scenario
  // "--show-questions issues pre-fetch but skips mutation".
  if (opts.showQuestions === true) {
    let preApply: applications.PreApplyData;
    let questions: applications.ApplicationQuestions;
    try {
      [preApply, questions] = await Promise.all([
        applications.applyData(token, id),
        applications.applyQuestions(token, id),
      ]);
    } catch (err) {
      handleApplicationsError("jobs apply", err, opts.output);
    }
    const projection: ShowQuestionsProjection = {
      jobId: id,
      canApply: preApply.canApply,
      applyErrors: preApply.applyErrors,
      suggestedRate: preApply.suggestedRate,
      rateValidation: preApply.rateValidation,
      matcherQuestions: questions.matcherQuestions,
      expertiseQuestions: questions.expertiseQuestions,
    };
    emitResult(projection, opts.output, {
      pretty: (data) => formatShowQuestions(data),
    });
    return;
  }

  // ---- 2. Consent gate (CLI-level refusal; no wire call) ----
  // The service's own check (`applications.apply` line 2598) is
  // defense-in-depth. Refusing at the CLI layer keeps the unit-test
  // signal clean — `applications.apply` is never called when consent
  // is absent, matching the AC "no JobApply wire mutation is sent".
  if (opts.consent !== true) {
    emitErrorAndExit({
      operation: "jobs.apply",
      format: opts.output,
      errors: [
        {
          code: "CONSENT_REQUIRED",
          message:
            "--consent is required to apply: this flag represents your acceptance of Toptal's apply terms (a legal-compliance attestation). Auto-filling on your behalf is forbidden per ADR-008.",
          hint: "Re-run with --consent to attest you have read and accepted Toptal's apply terms. Use --dry-run to preview the wire payload first.",
        },
      ],
      prettySummary: "jobs apply failed (CONSENT_REQUIRED): --consent is required to apply.",
    });
  }

  // ---- 3. Build ApplyInput (with --rate validation + file loads) ----
  const input: applications.ApplyInput = { consentIssued: true };
  if (opts.rate !== undefined) {
    if (!DECIMAL_PATTERN.test(opts.rate)) {
      handleApplicationsError(
        "jobs apply",
        new applications.ApplicationsError(
          "MUTATION_ERROR",
          `--rate must be a non-negative decimal (got "${opts.rate}").`,
        ),
        opts.output,
      );
    }
    input.requestedHourlyRate = opts.rate;
  }
  if (opts.message !== undefined) input.message = opts.message;

  // Load + parse answers / pitch JSON BEFORE any wire call (mirrors the
  // #428 confirm pattern). Parse / file failures short-circuit with a
  // `VALIDATION_ERROR` envelope; no mutation is issued.
  if (opts.answersFile !== undefined) {
    const payload = await loadJsonInputOrExit(opts.answersFile, "answers-file", opts.output);
    const answers = narrowAnswersPayload(payload, opts.output);
    if (answers.matcherAnswers !== undefined) input.matcherAnswers = answers.matcherAnswers;
    if (answers.expertiseAnswers !== undefined) input.expertiseAnswers = answers.expertiseAnswers;
  }
  if (opts.pitchFile !== undefined) {
    const payload = await loadJsonInputOrExit(opts.pitchFile, "pitch-file", opts.output);
    input.pitchData = narrowPitchPayload(payload, opts.output);
  }

  // ---- 4. Issue apply (or dry-run preview) ----
  let outcome: applications.ApplyOutcome;
  try {
    outcome = await applications.apply(token, id, input, { dryRun });
  } catch (err) {
    handleApplicationsError("jobs apply", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "jobs.apply",
      format: opts.output,
      preview: outcome.preview,
    });
    return;
  }

  const result = outcome.result;
  const summaryParts: string[] = [`status=${result.statusV2.value}`];
  if (result.requestedHourlyRate !== null) summaryParts.push(`rate=${result.requestedHourlyRate.decimal}`);

  emitUpdateSuccess({
    operation: "jobs.apply",
    format: opts.output,
    updated: result,
    prettySummary: `Applied to job ${id}: application ${result.id} (${summaryParts.join(", ")})`,
    prettyEntity: (data) => formatJobApplicationRecord(data),
  });
}

/**
 * Read + parse a JSON file (or stdin) via {@link readJsonInput}. On any
 * {@link JsonInputError} surface a structured `VALIDATION_ERROR` envelope
 * and exit non-zero — the AC pins the envelope code, not the inner
 * JsonInputError code (which appears in the message instead). Non-Error
 * throws are re-raised as-is so the outer handler catches them. Returns
 * the parsed value as `unknown` (Stage-1 opaque pass-through).
 *
 * Sibling to `loadJsonInputOrExit` in `applications/confirm.ts` —
 * domain-local twin per the project's one-copy-per-CLI-surface
 * convention (no cross-domain import; the two callers share the
 * `JsonInputError` namespace but render `operation: "jobs.apply"` vs
 * `operation: "applications.confirm"` distinctly).
 */
async function loadJsonInputOrExit(rawPath: string, flagName: string, format: OutputFormat): Promise<unknown> {
  try {
    return await readJsonInput(rawPath, { flagName });
  } catch (err) {
    if (err instanceof JsonInputError) {
      emitErrorAndExit({
        operation: "jobs.apply",
        format,
        errors: [{ code: "VALIDATION_ERROR", message: err.message, hint: hintForJsonInputCode(err.code) }],
        prettySummary: `jobs apply failed (VALIDATION_ERROR): ${err.message}`,
      });
    }
    throw err;
  }
}

/**
 * Map a {@link JsonInputError} code to an actionable recovery hint
 * surfaced through the `VALIDATION_ERROR` envelope's `hint:` field.
 * Sibling to the same function in `applications/confirm.ts` —
 * domain-local twin per the project's one-copy-per-CLI-surface
 * convention.
 */
function hintForJsonInputCode(code: string): string {
  switch (code) {
    case "FILE_NOT_FOUND":
      return "Verify the path exists; the absolute path is in the error message.";
    case "FILE_READ_ERROR":
      return "Check filesystem permissions on the file (and its parent directory).";
    case "PARSE_ERROR":
      return "Fix the JSON syntax at the cited line/column; the file shape should be { matcherAnswers: [...], expertiseAnswers: [...] }.";
    case "STDIN_UNAVAILABLE":
      return "Pipe JSON into stdin (e.g. `cat answers.json | ttctl ...`) or pass a file path.";
    case "STDIN_DOUBLE_CLAIM":
      return "Only one of --answers-file and --pitch-file may read from stdin per invocation; pass a file path for the other.";
    default:
      return "Inspect the input and retry.";
  }
}

/**
 * Narrow the parsed JSON from `--answers-file` into the
 * {@link AnswersFilePayload} shape. Surfaces a `VALIDATION_ERROR`
 * envelope (NOT a wire call) when the top-level shape is wrong — e.g. a
 * bare array, a string, or a non-object. Per ADR-008 § Stage-1 opaque
 * pass-through, the contents of `matcherAnswers` / `expertiseAnswers`
 * are NOT introspected here — only the top-level wrapper shape is
 * verified.
 *
 * Sibling to `narrowAnswersPayload` in `applications/confirm.ts` —
 * domain-local twin per the project's one-copy-per-CLI-surface
 * convention. The two copies stay structurally identical; the only
 * delta is the `operation:` envelope field and the `prettySummary`
 * verb prefix.
 */
function narrowAnswersPayload(payload: unknown, format: OutputFormat): AnswersFilePayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    emitErrorAndExit({
      operation: "jobs.apply",
      format,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "--answers-file: expected a JSON object with `matcherAnswers` and/or `expertiseAnswers` arrays.",
          hint: "File shape: { matcherAnswers: [...], expertiseAnswers: [...] } — both keys are optional but the top-level value must be an object.",
        },
      ],
      prettySummary: "jobs apply failed (VALIDATION_ERROR): --answers-file shape is not a JSON object.",
    });
  }
  const record = payload as Record<string, unknown>;
  const result: AnswersFilePayload = {};
  if (record["matcherAnswers"] !== undefined) {
    if (!Array.isArray(record["matcherAnswers"])) {
      emitErrorAndExit({
        operation: "jobs.apply",
        format,
        errors: [
          {
            code: "VALIDATION_ERROR",
            message: "--answers-file: `matcherAnswers` must be an array (was not).",
          },
        ],
        prettySummary: "jobs apply failed (VALIDATION_ERROR): --answers-file `matcherAnswers` must be an array.",
      });
    }
    result.matcherAnswers = record["matcherAnswers"];
  }
  if (record["expertiseAnswers"] !== undefined) {
    if (!Array.isArray(record["expertiseAnswers"])) {
      emitErrorAndExit({
        operation: "jobs.apply",
        format,
        errors: [
          {
            code: "VALIDATION_ERROR",
            message: "--answers-file: `expertiseAnswers` must be an array (was not).",
          },
        ],
        prettySummary: "jobs apply failed (VALIDATION_ERROR): --answers-file `expertiseAnswers` must be an array.",
      });
    }
    result.expertiseAnswers = record["expertiseAnswers"];
  }
  return result;
}

/**
 * Narrow the parsed JSON from `--pitch-file` into the `pitchData`
 * record shape. Per ADR-008 § Stage-1 opaque pass-through, the inner
 * fields are NOT introspected — only the top-level wrapper shape
 * (object, not array / string / null) is verified.
 *
 * Sibling to `narrowPitchPayload` in `applications/confirm.ts`.
 */
function narrowPitchPayload(payload: unknown, format: OutputFormat): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    emitErrorAndExit({
      operation: "jobs.apply",
      format,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "--pitch-file: expected a JSON object matching the `PitchInput` shape.",
          hint: "File shape: a JSON object (TBD per ADR-008 § Decision Part 2 — Stage-2 will pin the inner Zod schema).",
        },
      ],
      prettySummary: "jobs apply failed (VALIDATION_ERROR): --pitch-file shape is not a JSON object.",
    });
  }
  return payload as Record<string, unknown>;
}

/**
 * Render the post-apply `JobApplicationRecord` as the indented entity
 * preview inside the success-update envelope's pretty block. Pure —
 * directly unit-testable.
 *
 * Fields surfaced: status (value + verbose), requested rate (when
 * present), the wrapping activity-item id so the user can chain
 * `applications show <activity-item-id>` to view the new row.
 */
export function formatJobApplicationRecord(result: applications.JobApplicationRecord): string {
  const lines: string[] = [];
  lines.push(`Application: ${result.id}`);
  lines.push(`Status: ${result.statusV2.verbose} (${result.statusV2.value})`);
  if (result.requestedHourlyRate !== null) {
    lines.push(`Rate: ${result.requestedHourlyRate.decimal}`);
  }
  lines.push(`Activity item: ${result.jobActivityItemId}`);
  lines.push(`(View: ttctl applications show ${result.jobActivityItemId})`);
  return lines.join("\n");
}

/**
 * Render the `--show-questions` projection as a sectioned multi-line
 * block. Surfaces apply readiness (canApply, applyErrors,
 * suggestedRate) AND the question inventories so the user can decide
 * whether to apply AND author the answers-file payload in one glance.
 *
 * Each question renders as `  • <identifier>: <prompt>` (mirrors the
 * `jobs show --with-questions` / #437 format). Empty inventories
 * surface the zero count in the section header so the user reads
 * "Toptal returned an empty inventory" rather than "the CLI silently
 * dropped the section". Pure — directly unit-testable.
 */
export function formatShowQuestions(projection: ShowQuestionsProjection): string {
  const lines: string[] = [];
  lines.push(`Job ${projection.jobId} — Apply Preview`);
  lines.push("");
  lines.push(`Can apply: ${projection.canApply ? "yes" : "no"}`);
  if (projection.applyErrors.length > 0) {
    lines.push("Apply errors:");
    for (const err of projection.applyErrors) {
      lines.push(`  • ${err.code}: ${err.message}`);
    }
  }
  if (projection.suggestedRate !== null) {
    lines.push(`Suggested rate: ${projection.suggestedRate}`);
  }
  if (projection.rateValidation !== null) {
    lines.push(
      `Rate bounds: min=${projection.rateValidation.minRate}, step=${projection.rateValidation.rateStep.toString()}`,
    );
  }
  lines.push("");
  lines.push(`Matcher Questions (${projection.matcherQuestions.length.toString()})`);
  for (const q of projection.matcherQuestions) {
    lines.push(formatQuestionEntry(q));
  }
  lines.push("");
  lines.push(`Expertise Questions (${projection.expertiseQuestions.length.toString()})`);
  for (const q of projection.expertiseQuestions) {
    lines.push(formatQuestionEntry(q));
  }
  return lines.join("\n");
}

function formatQuestionEntry(q: applications.ApplicationQuestion): string {
  const tail = q.prompt === "" ? "" : ` ${q.prompt}`;
  return `  • ${q.identifier}:${tail}`;
}
