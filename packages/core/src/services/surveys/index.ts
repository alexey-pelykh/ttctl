// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `surveys` service module — read-only access to the viewer's pending
 * surveys (post-interview `INTERVIEW_ENDED` feedback, NPS, engagement
 * surveys, etc.).
 *
 * | Leaf   | Operation        |
 * |--------|------------------|
 * | `list` | `PendingSurveys` |
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
 * **Out of scope** (separate future capabilities): `surveys submit`
 * and `surveys feedback` (the write side). `list` is the prerequisite
 * read those two consume for the survey `id` / `kind` / `questions[]`.
 */

import type { z } from "zod";

import { callGatewayShared } from "../_shared/transport.js";

// ---------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------

/**
 * Surveys-domain error codes. Superset of `SharedTransportErrorCode`.
 * No `NOT_FOUND` (the list takes no id) and no mutation codes
 * (read-only). Auth-revoked failures throw the cross-cutting
 * `AuthRevokedError`, not a code on this enum.
 */
export type SurveysErrorCode = "NO_VIEWER" | "GRAPHQL_ERROR" | "NETWORK_ERROR" | "WIRE_SHAPE_ERROR" | "UNKNOWN";

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
