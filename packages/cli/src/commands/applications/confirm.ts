// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";
import { z } from "zod";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitDryRunSuccess, emitErrorAndExit, emitUpdateSuccess } from "../../lib/envelopes.js";
import { JsonInputError, parseAsRecovered, readJsonInput } from "../../lib/json-input.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Options for `ttctl applications confirm <id>` (#411 + #428). Mirrors
 * the service-layer {@link applications.ConfirmInput} shape with CLI-side
 * argument validation.
 *
 * `answersFile` / `pitchFile` (#428) are CLI-only paths (or `-` for
 * stdin) — the action handler reads + parses the JSON file BEFORE calling
 * into the service, then forwards the parsed payloads as
 * `matcherQuestionsAnswers` / `expertiseQuestionsAnswers` / `pitchInput`
 * (the Stage-1 opaque pass-through; see ADR-008 § Decision Part 3).
 */
export interface ApplicationsConfirmOptions {
  message?: string;
  rate?: string;
  kind?: applications.AvailabilityRequestKind;
  /**
   * Path to a JSON file (or `-` for stdin) containing
   * `{ matcherAnswers: [...], expertiseAnswers: [...] }` per ADR-008
   * § Decision Part 2. Parsed payload forwarded as
   * `matcherQuestionsAnswers` / `expertiseQuestionsAnswers` to the
   * service. Question identifiers come from `applications show
   * <activityId>` output.
   */
  answersFile?: string;
  /**
   * Path to a JSON file (or `-` for stdin) containing a `PitchInput`
   * object. Parsed payload forwarded as `pitchInput` (note: core field
   * is `pitchInput`; wire variable is `$pitchInput` mapping to the
   * mutation's `pitchData` input field — see ADR-008 § Decision Part 2).
   */
  pitchFile?: string;
  output: OutputFormat;
}

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Shape of the parsed `--answers-file` payload. The ADR-008-locked
 * grammar uses the wire-side keys `matcherAnswers` / `expertiseAnswers`
 * (NOT `matcherQuestionsAnswers` — the JSON file shape is the
 * user-facing key set, the service-call argument shape is the wire-side
 * key set). Both keys are optional independently; an empty file `{}` is
 * acceptable (no answers attached) but is normally meaningless and the
 * wire will likely reject — left to the server as the authority.
 *
 * Stage-2 (ADR-008 § Decision Part 3, #438): arrays are typed against
 * the recovered Zod schemas (`JobPositionAnswerInput[]` /
 * `JobExpertiseAnswerInput[]`). The inner schemas are wrapped with
 * `.strict()` at the call site so extra unknown keys reject with a
 * field-path Zod issue (per the AC behavioral scenarios).
 */
interface AnswersFilePayload {
  matcherAnswers?: applications.JobPositionAnswerInput[];
  expertiseAnswers?: applications.JobExpertiseAnswerInput[];
}

/**
 * Stage-2 Zod schemas for `--answers-file` payload validation (#438).
 *
 * Built ONCE at module load — the factory pattern in
 * `__generated__/zod-schemas.ts` returns a fresh `z.object(...)` per
 * call; we materialize each schema once and reuse it across parse
 * invocations.
 *
 * `.strict()` is mandatory at this boundary: codegen emits schemas with
 * default "strip unknown" semantics, which would silently pass extra
 * keys. The AC requires "extra unknown key in payload rejected with
 * field-path error" → wrap each inner schema with `.strict()`.
 *
 * Array wrappers (`z.array(...)`) live at the call site so each element
 * is validated independently; per-entry failures surface their array
 * index in the field path (`matcherAnswers[2].id: …`).
 */
const STRICT_MATCHER_ANSWER_SCHEMA = applications.JobPositionAnswerInputSchema().strict();
const STRICT_EXPERTISE_ANSWER_SCHEMA = applications.JobExpertiseAnswerInputSchema().strict();
const STRICT_PITCH_INPUT_SCHEMA = applications.PitchInputSchema().strict();
const MATCHER_ANSWERS_ARRAY_SCHEMA = z.array(STRICT_MATCHER_ANSWER_SCHEMA);
const EXPERTISE_ANSWERS_ARRAY_SCHEMA = z.array(STRICT_EXPERTISE_ANSWER_SCHEMA);

/**
 * Action handler for `ttctl applications confirm <id>` (#411).
 *
 * Confirms an Interest Request — the wire mutation
 * `ConfirmAvailabilityRequest` (mobile-gateway). The `<id>` is the
 * **AvailabilityRequest id**, NOT the activity-item id; discover it via
 * `ttctl applications show <activityId>` (look for the "Availability
 * request: <id>" line) or read it from the activity row directly.
 *
 * When `--rate` and `--kind` are both omitted, the service issues a
 * `GetAvailabilityRequestKind($id)` pre-fetch and auto-fills both:
 *
 *   - `kind` from the AR's `metadata.__typename`
 *   - `rate` from `metadata.offeredHourlyRate` (Fixed-kind only)
 *
 * Flexible-kind ARs have no recruiter-pinned rate, so callers MUST
 * pass `--rate <decimal>` when the AR is FLEXIBLE / MARKETPLACE_FLEXIBLE.
 *
 * Optional `--answers-file <path>` / `--pitch-file <path>` (#428) — see
 * the option type {@link ApplicationsConfirmOptions} for the file
 * grammar. Both flags accept `-` to read JSON from stdin per commander
 * convention; per ADR-008 § Decision Part 2 only one flag may claim
 * stdin per invocation. Files are read + parsed BEFORE any wire call;
 * malformed JSON refuses with the `VALIDATION_ERROR` envelope and no
 * mutation is issued.
 *
 * **DESTRUCTIVE** — confirming an IR transitions the AR to
 * `AVAILABILITY_REQUEST_CONFIRMED` and creates a `JobApplication`. No
 * withdraw operation is available on the wire. Prefer `--dry-run` to
 * preview the wire payload first.
 */
export async function runApplicationsConfirm(id: string, opts: ApplicationsConfirmOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("applications confirm", opts.output);
  const dryRun = getCliDryRun();

  const input: applications.ConfirmInput = {};
  if (opts.message !== undefined) input.comment = opts.message;
  if (opts.rate !== undefined) {
    if (!DECIMAL_PATTERN.test(opts.rate)) {
      handleApplicationsError(
        "applications confirm",
        new applications.ApplicationsError(
          "MUTATION_ERROR",
          `--rate must be a non-negative decimal (got "${opts.rate}").`,
        ),
        opts.output,
      );
    }
    input.requestedHourlyRate = opts.rate;
  }
  if (opts.kind !== undefined) input.kind = opts.kind;

  // Load + parse answers / pitch JSON BEFORE any wire call (#428). Any
  // parse / file failure short-circuits with a `VALIDATION_ERROR`
  // envelope; no mutation is issued. Both flags surface their typed
  // `JsonInputError` codes through the SAME `VALIDATION_ERROR` envelope
  // for consistency (the AC pins the envelope code, not the inner
  // JsonInputError code).
  if (opts.answersFile !== undefined) {
    const payload = await loadJsonInputOrExit(opts.answersFile, "answers-file", opts.output);
    const answers = narrowAnswersPayload(payload, opts.output);
    if (answers.matcherAnswers !== undefined) input.matcherQuestionsAnswers = answers.matcherAnswers;
    if (answers.expertiseAnswers !== undefined) input.expertiseQuestionsAnswers = answers.expertiseAnswers;
  }
  if (opts.pitchFile !== undefined) {
    const payload = await loadJsonInputOrExit(opts.pitchFile, "pitch-file", opts.output);
    input.pitchInput = narrowPitchPayload(payload, opts.output);
  }

  let outcome: applications.ConfirmOutcome;
  try {
    outcome = await applications.confirm(token, id, input, { dryRun });
  } catch (err) {
    handleApplicationsError("applications confirm", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "applications.confirm",
      format: opts.output,
      preview: outcome.preview,
    });
    return;
  }

  const result = outcome.result;
  const summaryParts: string[] = [`status=${result.statusV2.value}`];
  if (result.requestedHourlyRate !== null) summaryParts.push(`rate=${result.requestedHourlyRate.decimal}`);
  if (result.answeredAt !== null) summaryParts.push(`answered=${result.answeredAt}`);

  emitUpdateSuccess({
    operation: "applications.confirm",
    format: opts.output,
    updated: result,
    prettySummary: `Interest Request ${result.id} (${summaryParts.join(", ")})`,
    prettyEntity: (data) => formatRespondPayload(data),
  });
}

/**
 * Read + parse a JSON file (or stdin) via {@link readJsonInput}. On any
 * {@link JsonInputError} surface a structured `VALIDATION_ERROR` envelope
 * and exit non-zero — the AC pins the envelope code, not the inner
 * JsonInputError code (which appears in the message instead). Non-Error
 * throws are re-raised as-is so the outer handler catches them. Returns
 * the parsed value as `unknown` (Stage-1 opaque pass-through).
 */
async function loadJsonInputOrExit(rawPath: string, flagName: string, format: OutputFormat): Promise<unknown> {
  try {
    return await readJsonInput(rawPath, { flagName });
  } catch (err) {
    if (err instanceof JsonInputError) {
      emitErrorAndExit({
        operation: "applications.confirm",
        format,
        errors: [{ code: "VALIDATION_ERROR", message: err.message, hint: hintForJsonInputCode(err.code) }],
        prettySummary: `applications confirm failed (VALIDATION_ERROR): ${err.message}`,
      });
    }
    throw err;
  }
}

/**
 * Map a {@link JsonInputError} code to an actionable recovery hint
 * surfaced through the `VALIDATION_ERROR` envelope's `hint:` field. The
 * AC mandates "Recovery hint cites the parse failure line/column" for
 * `PARSE_ERROR` — the line/column live in the `message` (formatted by
 * {@link readJsonInput}), so the hint here surfaces the procedural
 * recovery action.
 */
function hintForJsonInputCode(code: string): string {
  switch (code) {
    case "FILE_NOT_FOUND":
      return "Verify the path exists; the absolute path is in the error message.";
    case "FILE_READ_ERROR":
      return "Check filesystem permissions on the file (and its parent directory).";
    case "PARSE_ERROR":
      return "Fix the JSON syntax at the cited line/column; the file shape should be { matcherAnswers: [...], expertiseAnswers: [...] }.";
    case "SCHEMA_ERROR":
      return "Fix the payload to match the recovered shape — matcher answers use { id, answer }; expertise answers use { questionId, other, subjectId }; pitch uses PitchInput.";
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
 * envelope (NOT a wire call) when the top-level wrapper shape is wrong
 * — e.g. a bare array, a string, or a non-object — OR when the inner
 * arrays fail the recovered Zod schemas (per #438 Stage-2 tightening).
 * Each inner schema is wrapped with `.strict()` so extra unknown keys
 * surface as a field-path Zod issue (e.g. `matcherAnswers[2].questionId:
 * unrecognized_keys (Unrecognized key(s) in object)`) — the AC's
 * behavioral scenario 2 "Extra unknown key in payload rejected with
 * field-path error".
 */
function narrowAnswersPayload(payload: unknown, format: OutputFormat): AnswersFilePayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    emitErrorAndExit({
      operation: "applications.confirm",
      format,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "--answers-file: expected a JSON object with `matcherAnswers` and/or `expertiseAnswers` arrays.",
          hint: "File shape: { matcherAnswers: [...], expertiseAnswers: [...] } — both keys are optional but the top-level value must be an object.",
        },
      ],
      prettySummary: "applications confirm failed (VALIDATION_ERROR): --answers-file shape is not a JSON object.",
    });
  }
  const record = payload as Record<string, unknown>;
  const result: AnswersFilePayload = {};
  if (record["matcherAnswers"] !== undefined) {
    result.matcherAnswers = validateRecoveredOrExit(
      record["matcherAnswers"],
      MATCHER_ANSWERS_ARRAY_SCHEMA,
      "answers-file:matcherAnswers",
      format,
    );
  }
  if (record["expertiseAnswers"] !== undefined) {
    result.expertiseAnswers = validateRecoveredOrExit(
      record["expertiseAnswers"],
      EXPERTISE_ANSWERS_ARRAY_SCHEMA,
      "answers-file:expertiseAnswers",
      format,
    );
  }
  return result;
}

/**
 * Narrow the parsed JSON from `--pitch-file` into the `pitchInput`
 * record shape. Stage-2 (#438): the inner shape is validated against
 * the recovered `PitchInput` Zod schema (wrapped with `.strict()` so
 * extra unknown keys reject with a field-path error). Wrong top-level
 * shape (array / string / null) still surfaces as a CLI-level
 * `VALIDATION_ERROR` envelope BEFORE the recovered-schema parse runs —
 * the JSON-object precondition is a precondition of the Zod schema's
 * `z.object(...)` semantics.
 */
function narrowPitchPayload(payload: unknown, format: OutputFormat): applications.PitchInput {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    emitErrorAndExit({
      operation: "applications.confirm",
      format,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "--pitch-file: expected a JSON object matching the `PitchInput` shape.",
          hint: "File shape: a JSON object matching the `PitchInput` schema (see `packages/core/src/__generated__/zod-schemas.ts` § PitchInputSchema).",
        },
      ],
      prettySummary: "applications confirm failed (VALIDATION_ERROR): --pitch-file shape is not a JSON object.",
    });
  }
  return validateRecoveredOrExit(payload, STRICT_PITCH_INPUT_SCHEMA, "pitch-file", format);
}

/**
 * Wrapper around {@link parseAsRecovered} that maps the typed
 * `SCHEMA_ERROR` from {@link JsonInputError} to the structured
 * `VALIDATION_ERROR` envelope this command emits. Mirrors
 * {@link loadJsonInputOrExit} — failure path is uniform across all
 * input-validation errors (parse, syntax, schema).
 */
function validateRecoveredOrExit<T>(value: unknown, schema: z.ZodType<T>, flagName: string, format: OutputFormat): T {
  try {
    return parseAsRecovered(value, schema, flagName);
  } catch (err) {
    if (err instanceof JsonInputError) {
      emitErrorAndExit({
        operation: "applications.confirm",
        format,
        errors: [
          {
            code: "VALIDATION_ERROR",
            message: err.message,
            hint: hintForJsonInputCode(err.code),
          },
        ],
        prettySummary: `applications confirm failed (VALIDATION_ERROR): ${err.message}`,
      });
    }
    throw err;
  }
}

/**
 * Render the post-confirm/reject AR projection as the indented entity
 * preview inside the success-update envelope's pretty block. Shared
 * with `applications reject`. Pure — directly unit-testable.
 */
export function formatRespondPayload(result: applications.AvailabilityRequestRespondPayload): string {
  const lines: string[] = [];
  lines.push(`Status: ${result.statusV2.verbose} (${result.statusV2.value})`);
  if (result.answeredAt !== null) lines.push(`Answered: ${result.answeredAt}`);
  if (result.requestedHourlyRate !== null) {
    lines.push(`Rate: ${result.requestedHourlyRate.verbose} (${result.requestedHourlyRate.decimal})`);
  }
  if (result.talentComment !== null && result.talentComment !== "") {
    lines.push(`Comment: ${result.talentComment}`);
  }
  if (result.rejectReason !== null && result.rejectReason !== "") {
    lines.push(`Reject reason: ${result.rejectReason}`);
  }
  return lines.join("\n");
}
