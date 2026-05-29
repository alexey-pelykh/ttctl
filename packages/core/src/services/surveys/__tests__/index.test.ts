// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `surveys.list` runs against the mobile-gateway surface via
// `stockTransport` (plain HTTPS). Mock that transport.
vi.mock("../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport.js")>("../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { SurveysError, list, submit } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { ConsentRequiredError } from "../../../consent.js";
import { stockTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-abc-123";

function replyStock(body: unknown, status = 200): void {
  mockedStock.mockResolvedValueOnce({ status, headers: {}, body } satisfies TransportResponse);
}

const SURVEY_FIXTURE = {
  __typename: "Survey",
  id: "sv-1",
  kind: "INTERVIEW_ENDED",
  title: "How was your interview?",
  isMandatory: true,
  alreadyAnswered: false,
  questions: [
    {
      __typename: "SurveyQuestion",
      id: "q-1",
      label: "Rate the interviewer",
      note: "1 = poor, 5 = great",
      isMandatory: true,
      inputType: "rating",
      answers: [
        { __typename: "SurveyAnswerOption", id: "a-1", label: "Poor", note: null, value: "1" },
        { __typename: "SurveyAnswerOption", id: "a-5", label: "Great", note: null, value: "5" },
      ],
    },
  ],
};

function viewerWith(surveys: unknown[]): unknown {
  return { data: { viewer: { __typename: "Viewer", id: "viewer-1", pendingSurveys: surveys } } };
}

beforeEach(() => {
  mockedStock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("surveys.list", () => {
  it("projects a full survey with nested questions and answers", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    const result = await list(TOKEN);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "sv-1",
      kind: "INTERVIEW_ENDED",
      title: "How was your interview?",
      isMandatory: true,
      alreadyAnswered: false,
      questions: [
        {
          id: "q-1",
          label: "Rate the interviewer",
          note: "1 = poor, 5 = great",
          isMandatory: true,
          inputType: "rating",
          answers: [
            { id: "a-1", label: "Poor", note: null, value: "1" },
            { id: "a-5", label: "Great", note: null, value: "5" },
          ],
        },
      ],
    });
  });

  it("returns an empty array when there are no pending surveys", async () => {
    replyStock(viewerWith([]));
    expect(await list(TOKEN)).toEqual([]);
  });

  it("coalesces null scalars and absent arrays defensively", async () => {
    replyStock(
      viewerWith([
        {
          __typename: "Survey",
          id: "sv-min",
          kind: null,
          title: null,
          isMandatory: null,
          alreadyAnswered: null,
          questions: null,
        },
      ]),
    );
    const result = await list(TOKEN);
    expect(result[0]).toEqual({
      id: "sv-min",
      kind: null,
      title: null,
      isMandatory: null,
      alreadyAnswered: null,
      questions: [],
    });
  });

  it("filters null list items (surveys, questions, answers)", async () => {
    replyStock(
      viewerWith([
        null,
        {
          __typename: "Survey",
          id: "sv-2",
          kind: "NPS",
          title: "NPS",
          isMandatory: false,
          alreadyAnswered: false,
          questions: [
            null,
            {
              __typename: "SurveyQuestion",
              id: "q-2",
              label: "Score",
              note: null,
              isMandatory: false,
              inputType: "nps",
              answers: [null, { __typename: "SurveyAnswerOption", id: "a-9", label: "9", note: null, value: "9" }],
            },
          ],
        },
      ]),
    );
    const result = await list(TOKEN);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("sv-2");
    expect(result[0]?.questions).toHaveLength(1);
    expect(result[0]?.questions[0]?.answers).toEqual([{ id: "a-9", label: "9", note: null, value: "9" }]);
  });

  it("treats a null pendingSurveys field as an empty list", async () => {
    replyStock(viewerWith(null as unknown as unknown[]));
    expect(await list(TOKEN)).toEqual([]);
  });

  it("throws NO_VIEWER when the response viewer is null", async () => {
    replyStock({ data: { viewer: null } });
    await expect(list(TOKEN)).rejects.toMatchObject({ name: "SurveysError", code: "NO_VIEWER" });
  });

  it("maps a top-level GraphQL error to GRAPHQL_ERROR", async () => {
    replyStock({ errors: [{ message: "Something broke" }] });
    const err: unknown = await list(TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SurveysError);
    expect(err).toMatchObject({ code: "GRAPHQL_ERROR" });
  });

  it("propagates AuthRevokedError on HTTP 401", async () => {
    replyStock({}, 401);
    await expect(list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("surveys.submit", () => {
  const CONSENT = { surveySubmissionConsentIssued: true as const };

  /** Reply to the `SubmitSurvey` mutation call (the 2nd stock call after `list`). */
  function submitReply(payload: unknown): void {
    replyStock({ data: { surveys: { submit: payload } } });
  }

  /** The wire variables of the SubmitSurvey mutation call (the 2nd stock call). */
  function submitVariables(): Record<string, unknown> {
    const call = mockedStock.mock.calls[1];
    if (!call) throw new Error("expected a SubmitSurvey transport call");
    const { variables } = call[0].body;
    if (variables === undefined) throw new Error("SubmitSurvey call carried no variables");
    return variables;
  }

  it("resolves kind + option ids from list and returns the refreshed pending list", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    submitReply({
      success: true,
      notice: null,
      errors: [],
      viewer: { id: "viewer-1", pendingSurveys: [{ id: "sv-next" }] },
    });

    const result = await submit(TOKEN, { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }] }, CONSENT);

    expect(result).toEqual({ notice: null, pendingSurveys: [{ id: "sv-next" }] });
    // `kind` lifted from the survey; option id `a-5` recovered by matching value "5".
    expect(submitVariables()).toEqual({
      kind: "INTERVIEW_ENDED",
      surveyId: "sv-1",
      answers: [{ questionId: "q-1", id: "a-5", value: "5" }],
    });
  });

  it("sends id: null for a free-text question (no answer options)", async () => {
    const freeText = {
      __typename: "Survey",
      id: "sv-ft",
      kind: "INTERVIEW_ENDED",
      title: "Feedback",
      isMandatory: false,
      alreadyAnswered: false,
      questions: [
        {
          __typename: "SurveyQuestion",
          id: "q-ft",
          label: "Comments",
          note: null,
          isMandatory: false,
          inputType: "text",
          answers: [],
        },
      ],
    };
    replyStock(viewerWith([freeText]));
    submitReply({ success: true, notice: "Thanks!", errors: [], viewer: { id: "viewer-1", pendingSurveys: [] } });

    const result = await submit(
      TOKEN,
      { surveyId: "sv-ft", answers: [{ questionId: "q-ft", value: "Great match!" }] },
      CONSENT,
    );

    expect(result).toEqual({ notice: "Thanks!", pendingSurveys: [] });
    expect(submitVariables()).toMatchObject({ answers: [{ questionId: "q-ft", id: null, value: "Great match!" }] });
  });

  it("honours an explicit kind override when the survey kind is absent", async () => {
    replyStock(viewerWith([{ ...SURVEY_FIXTURE, kind: null }]));
    submitReply({ success: true, notice: null, errors: [], viewer: { id: "viewer-1", pendingSurveys: [] } });

    await submit(TOKEN, { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }], kind: "NPS" }, CONSENT);

    expect(submitVariables()).toMatchObject({ kind: "NPS" });
  });

  it("refuses without consent BEFORE any wire call", async () => {
    vi.stubEnv("TTCTL_ALLOW_INFERRED_DESTRUCTIVE", "");
    await expect(
      submit(TOKEN, { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }] }, {
        surveySubmissionConsentIssued: false,
      } as unknown as { surveySubmissionConsentIssued: true }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("bypasses the consent literal under TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1", async () => {
    vi.stubEnv("TTCTL_ALLOW_INFERRED_DESTRUCTIVE", "1");
    replyStock(viewerWith([SURVEY_FIXTURE]));
    submitReply({ success: true, notice: null, errors: [], viewer: { id: "viewer-1", pendingSurveys: [] } });

    await expect(
      submit(TOKEN, { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }] }, {
        surveySubmissionConsentIssued: false,
      } as unknown as { surveySubmissionConsentIssued: true }),
    ).resolves.toEqual({ notice: null, pendingSurveys: [] });
  });

  it("throws NOT_FOUND when the survey is not pending (list only, no submit call)", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    await expect(
      submit(TOKEN, { surveyId: "sv-missing", answers: [{ questionId: "q-1", value: "5" }] }, CONSENT),
    ).rejects.toMatchObject({ name: "SurveysError", code: "NOT_FOUND" });
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });

  it("throws VALIDATION_ERROR for a value matching no answer option", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    await expect(
      submit(TOKEN, { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "999" }] }, CONSENT),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("throws VALIDATION_ERROR for an unknown question id", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    await expect(
      submit(TOKEN, { surveyId: "sv-1", answers: [{ questionId: "q-nope", value: "5" }] }, CONSENT),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("throws VALIDATION_ERROR for empty answers BEFORE any wire call", async () => {
    await expect(submit(TOKEN, { surveyId: "sv-1", answers: [] }, CONSENT)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("maps server errors[] to USER_ERROR with the field key", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    submitReply({
      success: false,
      notice: null,
      errors: [{ code: "INVALID", key: "q-1", message: "Out of range" }],
      viewer: null,
    });
    const err: unknown = await submit(
      TOKEN,
      { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }] },
      CONSENT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SurveysError);
    expect(err).toMatchObject({ code: "USER_ERROR" });
    expect((err as SurveysError).message).toContain("q-1");
    expect((err as SurveysError).message).toContain("Out of range");
  });

  it("maps success:false to USER_ERROR", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    submitReply({ success: false, notice: "Already answered", errors: [], viewer: null });
    await expect(
      submit(TOKEN, { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }] }, CONSENT),
    ).rejects.toMatchObject({ code: "USER_ERROR" });
  });
});
