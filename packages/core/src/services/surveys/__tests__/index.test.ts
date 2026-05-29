// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `surveys.list` runs against the mobile-gateway surface via
// `stockTransport` (plain HTTPS). Mock that transport.
vi.mock("../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport.js")>("../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { SurveysError, list } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
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
