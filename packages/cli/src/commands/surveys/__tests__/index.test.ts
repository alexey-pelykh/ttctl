// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { surveys } from "@ttctl/core";

import { boolMarker, formatSurveysTable } from "../index.js";

const SURVEY: surveys.Survey = {
  id: "sv-1",
  kind: "INTERVIEW_ENDED",
  title: "How was your interview?",
  isMandatory: true,
  alreadyAnswered: false,
  questions: [
    {
      id: "q-1",
      label: "Rate the interviewer",
      note: null,
      isMandatory: true,
      inputType: "rating",
      answers: [{ id: "a-1", label: "Great", note: null, value: "5" }],
    },
  ],
};

const SURVEY_NPS: surveys.Survey = {
  id: "sv-2",
  kind: "NPS",
  title: "Net Promoter Score",
  isMandatory: false,
  alreadyAnswered: true,
  questions: [],
};

describe("boolMarker", () => {
  it("returns ★ for true, empty for false, ? for null", () => {
    expect(boolMarker(true)).toBe("★");
    expect(boolMarker(false)).toBe("");
    expect(boolMarker(null)).toBe("?");
  });
});

describe("formatSurveysTable", () => {
  it("renders an empty table with the header when there are no items", () => {
    const out = formatSurveysTable([]);
    for (const col of ["id", "kind", "title", "mand.", "answ.", "q#"]) {
      expect(out).toContain(col);
    }
  });

  it("renders rows with kind, title, markers, and question count", () => {
    // Explicit wide width so the title column doesn't word-wrap — keeps the
    // `toContain` assertions independent of the test runner's terminal size.
    const out = formatSurveysTable([SURVEY], 200);
    expect(out).toContain("sv-1");
    expect(out).toContain("INTERVIEW_ENDED");
    expect(out).toContain("How was your interview?");
    expect(out).toContain("★"); // mandatory true
    expect(out).toContain("1"); // one question
  });

  it("renders '—' for null kind/title and zero question count", () => {
    const blank: surveys.Survey = {
      ...SURVEY,
      id: "sv-blank",
      kind: null,
      title: null,
      questions: [],
    };
    const out = formatSurveysTable([blank]);
    expect(out).toContain("sv-blank");
    expect(out).toContain("—");
    expect(out).toContain("0");
  });

  it("renders multiple rows preserving order", () => {
    const out = formatSurveysTable([SURVEY, SURVEY_NPS]);
    const idxFirst = out.indexOf("sv-1");
    const idxSecond = out.indexOf("sv-2");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });
});
