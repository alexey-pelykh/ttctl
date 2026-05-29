// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `surveys` service module — access to the viewer's pending surveys
 * (post-interview `INTERVIEW_ENDED` feedback, NPS, engagement surveys,
 * etc.): listing them and submitting answers.
 *
 * | Leaf       | Operation           |
 * |------------|---------------------|
 * | `list`     | `PendingSurveys`    |
 * | `submit`   | `SubmitSurvey`      |
 * | `feedback` | `AddSurveyFeedback` |
 *
 * **Routing**: the **mobile-gateway** surface
 * (`https://www.toptal.com/gateway/graphql/talent/graphql`) via
 * `stockTransport` — plain HTTPS, no Cloudflare. Same surface as
 * `applications`, `jobs`, `engagements`.
 *
 * **Operation is hand-authored**. The captured document at
 * `../research/graphql/gateway/operations/mobile/PendingSurveys.graphql`
 * selects `Survey.job` via the full `jobData` fragment (~25 types); the
 * inline query here trims `job` and `createdAt` to the fields the CLI /
 * MCP surface renders (the per-Survey contract: id, kind, title,
 * isMandatory, alreadyAnswered, questions[]). The captured
 * `pendingSurveys(version: 2)` argument is preserved verbatim.
 *
 * **Schema/contract validation rule**: `PendingSurveys` is in
 * `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`) — no typed
 * bindings exist and `Survey.kind` / `Survey.job` / `SurveyQuestion.note`
 * are `Unknown`-typed in the synthesized SDL. The projection here is
 * best-effort INFERRED until the gated `packages/e2e/src/88-surveys-list.e2e.test.ts`
 * passes against a live session (T1 wire-shape snapshot disposition).
 *
 * **`submit`** (`SubmitSurvey`) and **`feedback`** (`AddSurveyFeedback`) are the
 * write sides — both T1 (`*_KNOWN_UNTRUSTED_OPS`), consent-gated on the shared
 * `survey-submission` domain (ADR-009), irreversible, routed to a third party.
 * `submit` resolves `kind` + answer-option ids from `list`; `feedback` resolves
 * only `kind`, or takes an explicit one to reach a non-pending survey.
 */

import type { z } from "zod";

import { ensureDestructiveConsent } from "../../consent.js";
import { callGatewayShared } from "../_shared/transport.js";

// ---------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------

/**
 * Surveys-domain error codes. Superset of `SharedTransportErrorCode`.
 * `NOT_FOUND` / `VALIDATION_ERROR` / `USER_ERROR` are the `submit`
 * mutation codes (`NOT_FOUND`: survey id absent from pending;
 * `VALIDATION_ERROR`: bad answer value or unresolvable kind;
 * `USER_ERROR`: server rejected the submission). Consent failures throw
 * the cross-cutting `ConsentRequiredError`; auth-revoked failures throw
 * `AuthRevokedError` — neither is a code on this enum.
 */
export type SurveysErrorCode =
  | "NO_VIEWER"
  | "GRAPHQL_ERROR"
  | "NETWORK_ERROR"
  | "WIRE_SHAPE_ERROR"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "USER_ERROR"
  | "UNKNOWN";

export class SurveysError extends Error {
  override readonly name = "SurveysError";
  constructor(
    public readonly code: SurveysErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/**
 * One selectable answer option for a {@link SurveyQuestion}. `value` is
 * the wire token to send back when answering; `label` is the display
 * text. `note` is `Unknown`-typed in the SDL → INFERRED nullable.
 */
export interface SurveyAnswerOption {
  id: string;
  label: string | null;
  note: string | null;
  value: string | null;
}

/**
 * A single survey question. `inputType` describes how the answer is
 * collected (e.g. a rating scale, free text); `answers` enumerates the
 * selectable options (empty for free-text questions). Downstream
 * `surveys submit` / `surveys feedback` consume `id` + `inputType` +
 * `answers[].value` to build a valid response.
 */
export interface SurveyQuestion {
  id: string;
  label: string | null;
  note: string | null;
  isMandatory: boolean | null;
  inputType: string | null;
  answers: SurveyAnswerOption[];
}

/**
 * A pending survey. `kind` is a `SurveyKindEnum` value surfaced as a
 * string for forward-compatibility (e.g. `INTERVIEW_ENDED`, `NPS`,
 * `ENGAGEMENT_ENDED`). `alreadyAnswered` distinguishes a fully-answered
 * survey still listed as pending from an untouched one.
 */
export interface Survey {
  id: string;
  kind: string | null;
  title: string | null;
  isMandatory: boolean | null;
  alreadyAnswered: boolean | null;
  questions: SurveyQuestion[];
}

// ---------------------------------------------------------------------
// GraphQL operation (hand-authored — trimmed from the capture)
// ---------------------------------------------------------------------

const PENDING_SURVEYS_QUERY = `query PendingSurveys {
  viewer {
    __typename
    id
    pendingSurveys(version: 2) {
      __typename
      id
      kind
      title
      isMandatory
      alreadyAnswered
      questions {
        __typename
        id
        label
        note
        isMandatory
        inputType
        answers {
          __typename
          id
          label
          note
          value
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------
// Wire shape (best-effort, INFERRED). `pendingSurveys` / `questions` /
// `answers` are non-null lists of nullable items in the SDL; tolerate
// null at every hop and filter in projection.
// ---------------------------------------------------------------------

interface WireAnswerOption {
  id: string;
  label?: string | null;
  note?: string | null;
  value?: string | null;
}

interface WireSurveyQuestion {
  id: string;
  label?: string | null;
  note?: string | null;
  isMandatory?: boolean | null;
  inputType?: string | null;
  answers?: (WireAnswerOption | null)[] | null;
}

interface WireSurvey {
  id: string;
  kind?: string | null;
  title?: string | null;
  isMandatory?: boolean | null;
  alreadyAnswered?: boolean | null;
  questions?: (WireSurveyQuestion | null)[] | null;
}

interface PendingSurveysResponse {
  viewer: {
    id: string;
    pendingSurveys: (WireSurvey | null)[] | null;
  } | null;
}

// ---------------------------------------------------------------------
// Transport helper
// ---------------------------------------------------------------------

/**
 * Thin per-service wrapper around {@link callGatewayShared}. Pins the
 * mobile-gateway surface and the {@link SurveysError} domain class.
 */
async function callGateway<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return callGatewayShared<T, SurveysError>("mobile-gateway", token, operationName, query, variables, SurveysError, {
    schema,
  });
}

// ---------------------------------------------------------------------
// Projection (wire → public, coalescing every INFERRED-nullable hop)
// ---------------------------------------------------------------------

function projectAnswer(wire: WireAnswerOption): SurveyAnswerOption {
  return {
    id: wire.id,
    label: wire.label ?? null,
    note: wire.note ?? null,
    value: wire.value ?? null,
  };
}

function projectQuestion(wire: WireSurveyQuestion): SurveyQuestion {
  return {
    id: wire.id,
    label: wire.label ?? null,
    note: wire.note ?? null,
    isMandatory: wire.isMandatory ?? null,
    inputType: wire.inputType ?? null,
    answers: (wire.answers ?? []).filter((a): a is WireAnswerOption => a != null).map(projectAnswer),
  };
}

function projectSurvey(wire: WireSurvey): Survey {
  return {
    id: wire.id,
    kind: wire.kind ?? null,
    title: wire.title ?? null,
    isMandatory: wire.isMandatory ?? null,
    alreadyAnswered: wire.alreadyAnswered ?? null,
    questions: (wire.questions ?? []).filter((q): q is WireSurveyQuestion => q != null).map(projectQuestion),
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * List the viewer's pending surveys via `viewer.pendingSurveys` on the
 * mobile-gateway surface. Returns surveys in server order. An empty list
 * is a legitimate return value (no pending surveys); callers handle the
 * empty case explicitly.
 *
 * Throws (typed):
 *
 *   - `AuthRevokedError` — session bearer is invalid or expired.
 *   - `SurveysError(NO_VIEWER)` — HTTP 200 + `data.viewer === null`
 *     (session valid but no viewer bound — defensive).
 *   - `SurveysError(GRAPHQL_ERROR)` — top-level GraphQL error, not
 *     auth-revoked.
 *   - `SurveysError(NETWORK_ERROR)` — transport failure.
 *   - `SurveysError(UNKNOWN)` — non-2xx HTTP status or missing `data`.
 */
// e2e-covers: PendingSurveys
export async function list(token: string): Promise<Survey[]> {
  const data = await callGateway<PendingSurveysResponse>(token, "PendingSurveys", PENDING_SURVEYS_QUERY, {});
  if (data.viewer === null) {
    throw new SurveysError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  const wire = data.viewer.pendingSurveys ?? [];
  return wire.filter((s): s is WireSurvey => s != null).map(projectSurvey);
}

// ---------------------------------------------------------------------
// submit — public types
// ---------------------------------------------------------------------

/**
 * One resolved wire answer. `questionId` is the {@link SurveyQuestion} id;
 * `id` is the selected {@link SurveyAnswerOption} id for a multiple-choice
 * question and `null` for free-text; `value` is the option's `value`
 * (multiple-choice) or the free-text answer. Matches the `SurveyAnswerInput`
 * wire shape verified by a live round-trip (2026-05-29).
 */
export interface SurveyAnswerInput {
  questionId: string;
  id: string | null;
  value: string;
}

/**
 * A caller-supplied answer before resolution. For a multiple-choice
 * question the `value` is matched against the question's answer options to
 * recover the option id; for a free-text question it is sent verbatim.
 * {@link buildSurveyAnswers} performs the resolution.
 */
export interface RawSurveyAnswer {
  questionId: string;
  value: string;
}

/**
 * Input to {@link submit} / {@link prepareSubmission}. `kind` is resolved
 * from the survey's own `kind` when omitted; supply it only to override
 * (the `--kind` fallback for a survey whose kind is not surfaced).
 */
export interface SubmitSurveyArgs {
  surveyId: string;
  answers: RawSurveyAnswer[];
  kind?: string | undefined;
}

/**
 * The fully-resolved submission produced by {@link prepareSubmission} (the
 * read-only resolve step) and consumed by {@link submit}.
 */
interface ResolvedSubmission {
  kind: string;
  surveyId: string;
  answers: SurveyAnswerInput[];
}

/**
 * Consent ceremony for {@link submit}. Per ADR-009 (ttctl) the
 * `survey-submission` domain field MUST be `true` — submission is
 * irreversible and routes the talent's feedback to a third party.
 */
export interface SubmitSurveyConsent {
  surveySubmissionConsentIssued: true;
}

/**
 * Server-confirmed result of {@link submit}. `pendingSurveys` is the
 * refreshed pending-survey id list from `viewer.pendingSurveys` — the
 * submitted survey is absent from it on success (the write-read echo).
 */
export interface SubmitSurveyResult {
  notice: string | null;
  pendingSurveys: { id: string }[];
}

// ---------------------------------------------------------------------
// submit — GraphQL operation (hand-authored, portal variant; verified
// against a live round-trip 2026-05-29; `version: 2` hardcoded per capture)
// ---------------------------------------------------------------------

const SUBMIT_SURVEY_MUTATION = `mutation SubmitSurvey($kind: SurveyKindEnum!, $surveyId: ID!, $answers: [SurveyAnswerInput!]!) {
  surveys {
    submit(input: { kind: $kind, surveyId: $surveyId, answers: $answers, version: 2 }) {
      success
      notice
      errors {
        code
        key
        message
      }
      viewer {
        id
        pendingSurveys(version: 2) {
          id
        }
      }
    }
  }
}`;

// ---------------------------------------------------------------------
// submit — wire shape (best-effort, INFERRED-nullable at every hop)
// ---------------------------------------------------------------------

interface WireSubmitUserError {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface WireSubmitPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: (WireSubmitUserError | null)[] | null;
  viewer?: { id?: string | null; pendingSurveys?: ({ id?: string | null } | null)[] | null } | null;
}

interface SubmitSurveyResponse {
  surveys: { submit: WireSubmitPayload | null } | null;
}

// ---------------------------------------------------------------------
// submit — answer resolution
// ---------------------------------------------------------------------

/**
 * Resolve caller-supplied {@link RawSurveyAnswer}s against a {@link Survey}
 * into wire {@link SurveyAnswerInput}s. A question carrying answer options
 * (multiple-choice) has its `value` matched against an option's `value` and
 * the option `id` attached; an option-less question (free-text) sends the
 * `value` verbatim with a `null` id. Throws `SurveysError(VALIDATION_ERROR)`
 * for an unknown question id or a value matching no option of a
 * multiple-choice question.
 */
function buildSurveyAnswers(survey: Survey, raw: RawSurveyAnswer[]): SurveyAnswerInput[] {
  return raw.map((answer) => {
    const question = survey.questions.find((q) => q.id === answer.questionId);
    if (question === undefined) {
      throw new SurveysError("VALIDATION_ERROR", `Survey ${survey.id} has no question "${answer.questionId}".`);
    }
    if (question.answers.length === 0) {
      return { questionId: answer.questionId, id: null, value: answer.value };
    }
    const option = question.answers.find((o) => o.value === answer.value);
    if (option === undefined) {
      const valid = question.answers
        .map((o) => o.value)
        .filter((v): v is string => v !== null)
        .join(", ");
      throw new SurveysError(
        "VALIDATION_ERROR",
        `"${answer.value}" is not a valid answer for question "${answer.questionId}". Valid values: ${valid}.`,
      );
    }
    // `option.value === answer.value` held at the match above, so send the
    // (validated) answer value; the option contributes its `id`.
    return { questionId: answer.questionId, id: option.id, value: answer.value };
  });
}

// ---------------------------------------------------------------------
// submit — public API
// ---------------------------------------------------------------------

/**
 * Resolve {@link SubmitSurveyArgs} into a wire {@link ResolvedSubmission} by
 * fetching the pending-survey list and matching the target survey. Pure
 * read — no mutation, no consent gate. Internal to {@link submit} (called
 * after its consent gate); the dry-run paths preview raw intent without
 * resolving, so this is not on any user-facing surface.
 *
 * Throws (typed):
 *   - `SurveysError(VALIDATION_ERROR)` — empty `answers`, or the survey's
 *     `kind` is neither supplied nor resolvable.
 *   - `SurveysError(NOT_FOUND)` — `surveyId` is not in the pending list.
 *   - `AuthRevokedError` / other `SurveysError` codes from the `list` call.
 */
async function prepareSubmission(token: string, args: SubmitSurveyArgs): Promise<ResolvedSubmission> {
  if (args.answers.length === 0) {
    throw new SurveysError("VALIDATION_ERROR", "At least one answer is required to submit a survey.");
  }
  const pending = await list(token);
  const survey = pending.find((s) => s.id === args.surveyId);
  if (survey === undefined) {
    throw new SurveysError(
      "NOT_FOUND",
      `No pending survey with id "${args.surveyId}". Run \`ttctl surveys list\` to see pending surveys.`,
    );
  }
  const kind = args.kind ?? survey.kind;
  if (kind === null || kind === "") {
    throw new SurveysError(
      "VALIDATION_ERROR",
      `Could not resolve the kind for survey "${args.surveyId}"; pass an explicit kind.`,
    );
  }
  return { kind, surveyId: args.surveyId, answers: buildSurveyAnswers(survey, args.answers) };
}

/**
 * Submit structured answers to a pending survey via `surveys.submit` on the
 * mobile-gateway surface. Resolves `kind` and per-question answer-option ids
 * from `list` ({@link prepareSubmission}), then issues the mutation.
 *
 * **Irreversible**: a submitted survey cannot be un-answered. Gated by the
 * `survey-submission` consent ceremony (ADR-009): refuses with
 * `ConsentRequiredError("CONSENT_REQUIRED")` BEFORE any wire call when
 * `consent.surveySubmissionConsentIssued !== true`. The
 * `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` env-var bypasses the literal check
 * for non-interactive contexts.
 *
 * Throws (typed):
 *   - `ConsentRequiredError("CONSENT_REQUIRED")` — consent not supplied.
 *   - `SurveysError(VALIDATION_ERROR | NOT_FOUND)` — see {@link prepareSubmission}.
 *   - `SurveysError(USER_ERROR)` — server returned `errors[]` or `success: false`.
 *   - `SurveysError(GRAPHQL_ERROR | NETWORK_ERROR | UNKNOWN)` / `AuthRevokedError`.
 */
// e2e-covers: SubmitSurvey
export async function submit(
  token: string,
  args: SubmitSurveyArgs,
  consent: SubmitSurveyConsent,
): Promise<SubmitSurveyResult> {
  // Runtime consent gate — covers `as`-cast bypasses and JSON-sourced
  // inputs from CLI / MCP / agents. Fires BEFORE any wire call (incl. the
  // `prepareSubmission` read). See ADR-009 and packages/core/src/consent.ts.
  ensureDestructiveConsent(
    "SubmitSurvey",
    "survey-submission",
    consent as unknown as { readonly [key: string]: unknown },
  );

  const resolved = await prepareSubmission(token, args);

  const data = await callGateway<SubmitSurveyResponse>(token, "SubmitSurvey", SUBMIT_SURVEY_MUTATION, {
    kind: resolved.kind,
    surveyId: resolved.surveyId,
    answers: resolved.answers,
  });

  const payload = data.surveys?.submit;
  if (!payload) {
    throw new SurveysError("UNKNOWN", "Submit-survey response had no payload.");
  }
  const errors = (payload.errors ?? []).filter((e): e is WireSubmitUserError => e != null);
  if (errors.length > 0) {
    const first = errors[0];
    const keyHint = first?.key ? ` (${first.key})` : "";
    throw new SurveysError("USER_ERROR", `Survey submission rejected${keyHint}: ${first?.message ?? "unknown error"}`);
  }
  if (payload.success === false) {
    throw new SurveysError(
      "USER_ERROR",
      `Survey submission reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }

  const pendingSurveys = (payload.viewer?.pendingSurveys ?? [])
    .filter((s): s is { id?: string | null } => s != null)
    .map((s) => ({ id: s.id ?? "" }))
    .filter((s) => s.id.length > 0);

  return { notice: payload.notice ?? null, pendingSurveys };
}

// ---------------------------------------------------------------------
// addFeedback — public types
// ---------------------------------------------------------------------

/** Input to {@link addFeedback}. `kind` is resolved from `list` when omitted. */
export interface AddSurveyFeedbackArgs {
  surveyId: string;
  feedback: string;
  kind?: string | undefined;
}

/** Consent for {@link addFeedback} — shares `submit`'s `survey-submission` domain (ADR-009). */
export interface AddSurveyFeedbackConsent {
  surveySubmissionConsentIssued: true;
}

/** Result of {@link addFeedback} — `addFeedback` returns only `MutationResult`. */
export interface AddSurveyFeedbackResult {
  notice: string | null;
}

// ---------------------------------------------------------------------
// addFeedback — GraphQL operation. Portal `{kind,surveyId,feedback}` shape sent
// via the mobile-gateway (as for the sibling SubmitSurvey); no `version` arg.
// ---------------------------------------------------------------------

const ADD_SURVEY_FEEDBACK_MUTATION = `mutation AddSurveyFeedback($kind: SurveyKindEnum!, $surveyId: ID!, $feedback: String!) {
  surveys {
    addFeedback(input: { kind: $kind, surveyId: $surveyId, feedback: $feedback }) {
      success
      notice
      errors {
        code
        key
        message
      }
    }
  }
}`;

// ---------------------------------------------------------------------
// addFeedback — wire shape
// ---------------------------------------------------------------------

interface WireAddFeedbackPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: (WireSubmitUserError | null)[] | null;
}

interface AddSurveyFeedbackResponse {
  surveys: { addFeedback: WireAddFeedbackPayload | null } | null;
}

// ---------------------------------------------------------------------
// addFeedback — kind resolution
// ---------------------------------------------------------------------

interface ResolvedFeedback {
  kind: string;
  surveyId: string;
  feedback: string;
}

/**
 * Resolve {@link AddSurveyFeedbackArgs} into wire variables. An explicit `kind`
 * skips the `list` read (feedback needs only kind+id+text), so it reaches a
 * non-pending survey; otherwise `list` resolves the kind and gates a bogus id
 * with `NOT_FOUND`. Pure read — no mutation, no consent gate.
 */
async function prepareFeedback(token: string, args: AddSurveyFeedbackArgs): Promise<ResolvedFeedback> {
  if (args.feedback.trim() === "") {
    throw new SurveysError("VALIDATION_ERROR", "Feedback text is required.");
  }
  if (args.kind !== undefined && args.kind !== "") {
    return { kind: args.kind, surveyId: args.surveyId, feedback: args.feedback };
  }
  const pending = await list(token);
  const survey = pending.find((s) => s.id === args.surveyId);
  if (survey === undefined) {
    throw new SurveysError(
      "NOT_FOUND",
      `No pending survey with id "${args.surveyId}". Run \`ttctl surveys list\`, or pass an explicit kind to add feedback to a non-pending survey.`,
    );
  }
  if (survey.kind === null || survey.kind === "") {
    throw new SurveysError(
      "VALIDATION_ERROR",
      `Could not resolve the kind for survey "${args.surveyId}"; pass an explicit kind.`,
    );
  }
  return { kind: survey.kind, surveyId: args.surveyId, feedback: args.feedback };
}

// ---------------------------------------------------------------------
// addFeedback — public API
// ---------------------------------------------------------------------

/**
 * Add free-text feedback to a survey via `surveys.addFeedback` (mobile-gateway).
 * Irreversible (no un-feedback op) and routed to a third party → gated by the
 * `survey-submission` consent ceremony (ADR-009), which fires before any wire
 * call. `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` bypasses the literal check.
 */
// e2e-covers: AddSurveyFeedback
export async function addFeedback(
  token: string,
  args: AddSurveyFeedbackArgs,
  consent: AddSurveyFeedbackConsent,
): Promise<AddSurveyFeedbackResult> {
  ensureDestructiveConsent(
    "AddSurveyFeedback",
    "survey-submission",
    consent as unknown as { readonly [key: string]: unknown },
  );

  const resolved = await prepareFeedback(token, args);

  const data = await callGateway<AddSurveyFeedbackResponse>(token, "AddSurveyFeedback", ADD_SURVEY_FEEDBACK_MUTATION, {
    kind: resolved.kind,
    surveyId: resolved.surveyId,
    feedback: resolved.feedback,
  });

  const payload = data.surveys?.addFeedback;
  if (!payload) {
    throw new SurveysError("UNKNOWN", "Add-survey-feedback response had no payload.");
  }
  const errors = (payload.errors ?? []).filter((e): e is WireSubmitUserError => e != null);
  if (errors.length > 0) {
    const first = errors[0];
    const keyHint = first?.key ? ` (${first.key})` : "";
    throw new SurveysError("USER_ERROR", `Survey feedback rejected${keyHint}: ${first?.message ?? "unknown error"}`);
  }
  if (payload.success === false) {
    throw new SurveysError(
      "USER_ERROR",
      `Survey feedback reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }

  return { notice: payload.notice ?? null };
}
