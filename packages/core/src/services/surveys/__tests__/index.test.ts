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

import { SurveysError, addFeedback, list, submit } from "../index.js";
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

// INTERVIEW_ENDED shape with a mandatory CHECKBOX question (the #754 case):
// `answers: []` (no option vocabulary), value is a stringified boolean.
const SURVEY_WITH_CHECKBOX = {
  __typename: "Survey",
  id: "sv-ie",
  kind: "INTERVIEW_ENDED",
  title: "How was your interview?",
  isMandatory: true,
  alreadyAnswered: false,
  questions: [
    {
      __typename: "SurveyQuestion",
      id: "q-rate",
      label: "Rate the interviewer",
      note: null,
      isMandatory: true,
      inputType: "RATING",
      answers: [{ __typename: "SurveyAnswerOption", id: "a-5", label: "Great", note: null, value: "5" }],
    },
    {
      __typename: "SurveyQuestion",
      id: "q-occurred",
      label: "This interview didn't occur.",
      note: null,
      isMandatory: true,
      inputType: "CHECKBOX",
      answers: [],
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
    // Answer the mandatory q-1 too, so the unknown-id path (not the
    // completeness check) is what rejects.
    await expect(
      submit(
        TOKEN,
        {
          surveyId: "sv-1",
          answers: [
            { questionId: "q-1", value: "5" },
            { questionId: "q-nope", value: "5" },
          ],
        },
        CONSENT,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("sends a checkbox answer as a stringified boolean with id null (case-insensitive in, lowercase out)", async () => {
    replyStock(viewerWith([SURVEY_WITH_CHECKBOX]));
    submitReply({ success: true, notice: null, errors: [], viewer: { id: "viewer-1", pendingSurveys: [] } });

    await submit(
      TOKEN,
      {
        surveyId: "sv-ie",
        answers: [
          { questionId: "q-rate", value: "5" },
          { questionId: "q-occurred", value: "False" },
        ],
      },
      CONSENT,
    );

    expect(submitVariables()).toMatchObject({
      answers: [
        { questionId: "q-rate", id: "a-5", value: "5" },
        { questionId: "q-occurred", id: null, value: "false" },
      ],
    });
  });

  it("throws VALIDATION_ERROR for a non-boolean checkbox value (no submit call)", async () => {
    replyStock(viewerWith([SURVEY_WITH_CHECKBOX]));
    await expect(
      submit(
        TOKEN,
        {
          surveyId: "sv-ie",
          answers: [
            { questionId: "q-rate", value: "5" },
            { questionId: "q-occurred", value: "maybe" },
          ],
        },
        CONSENT,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });

  it("throws VALIDATION_ERROR naming an unanswered mandatory question (no submit call) — #754", async () => {
    replyStock(viewerWith([SURVEY_WITH_CHECKBOX]));
    const err: unknown = await submit(
      TOKEN,
      { surveyId: "sv-ie", answers: [{ questionId: "q-rate", value: "5" }] },
      CONSENT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SurveysError);
    expect(err).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((err as SurveysError).message).toContain("q-occurred");
    // The SubmitSurvey mutation is never issued — only the `list` read ran.
    expect(mockedStock).toHaveBeenCalledTimes(1);
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

describe("surveys.addFeedback", () => {
  const CONSENT = { surveySubmissionConsentIssued: true as const };

  function feedbackReply(payload: unknown): void {
    replyStock({ data: { surveys: { addFeedback: payload } } });
  }

  function variablesAt(index: number): Record<string, unknown> {
    const call = mockedStock.mock.calls[index];
    if (!call) throw new Error(`expected a transport call at index ${index.toString()}`);
    const { variables } = call[0].body;
    if (variables === undefined) throw new Error("call carried no variables");
    return variables;
  }

  it("resolves kind from list and returns the notice", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    feedbackReply({ success: true, notice: null, errors: [] });

    const result = await addFeedback(TOKEN, { surveyId: "sv-1", feedback: "Great match!" }, CONSENT);

    expect(result).toEqual({ notice: null });
    expect(variablesAt(1)).toEqual({ kind: "INTERVIEW_ENDED", surveyId: "sv-1", feedback: "Great match!" });
  });

  it("an explicit kind skips the list read (single wire call)", async () => {
    feedbackReply({ success: true, notice: "Thanks!", errors: [] });

    const result = await addFeedback(TOKEN, { surveyId: "sv-x", feedback: "Nice.", kind: "MID_ENGAGEMENT" }, CONSENT);

    expect(result).toEqual({ notice: "Thanks!" });
    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(variablesAt(0)).toEqual({ kind: "MID_ENGAGEMENT", surveyId: "sv-x", feedback: "Nice." });
  });

  it("refuses without consent BEFORE any wire call", async () => {
    vi.stubEnv("TTCTL_ALLOW_INFERRED_DESTRUCTIVE", "");
    await expect(
      addFeedback(TOKEN, { surveyId: "sv-1", feedback: "x" }, {
        surveySubmissionConsentIssued: false,
      } as unknown as { surveySubmissionConsentIssued: true }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("bypasses the consent literal under TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1", async () => {
    vi.stubEnv("TTCTL_ALLOW_INFERRED_DESTRUCTIVE", "1");
    feedbackReply({ success: true, notice: null, errors: [] });
    await expect(
      addFeedback(TOKEN, { surveyId: "sv-1", feedback: "x", kind: "NPS" }, {
        surveySubmissionConsentIssued: false,
      } as unknown as { surveySubmissionConsentIssued: true }),
    ).resolves.toEqual({ notice: null });
  });

  it("throws NOT_FOUND when the survey is not pending (kind omitted, no feedback call)", async () => {
    replyStock(viewerWith([SURVEY_FIXTURE]));
    await expect(addFeedback(TOKEN, { surveyId: "sv-missing", feedback: "x" }, CONSENT)).rejects.toMatchObject({
      name: "SurveysError",
      code: "NOT_FOUND",
    });
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });

  it("throws VALIDATION_ERROR for blank feedback BEFORE any wire call", async () => {
    await expect(addFeedback(TOKEN, { surveyId: "sv-1", feedback: "   ", kind: "NPS" }, CONSENT)).rejects.toMatchObject(
      { code: "VALIDATION_ERROR" },
    );
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("maps server errors[] to USER_ERROR with the field key", async () => {
    feedbackReply({
      success: false,
      notice: null,
      errors: [{ code: "INVALID", key: "feedback", message: "Too long" }],
    });
    const err: unknown = await addFeedback(TOKEN, { surveyId: "sv-1", feedback: "x", kind: "NPS" }, CONSENT).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SurveysError);
    expect(err).toMatchObject({ code: "USER_ERROR" });
    expect((err as SurveysError).message).toContain("feedback");
  });

  it("maps success:false to USER_ERROR", async () => {
    feedbackReply({ success: false, notice: "Nope", errors: [] });
    await expect(addFeedback(TOKEN, { surveyId: "sv-1", feedback: "x", kind: "NPS" }, CONSENT)).rejects.toMatchObject({
      code: "USER_ERROR",
    });
  });
});
