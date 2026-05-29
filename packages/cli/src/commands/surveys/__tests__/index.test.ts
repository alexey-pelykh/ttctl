// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: keep everything real (incl. `SurveysError`,
// `ConsentRequiredError`, `RawSurveyAnswer`) except `surveys.submit`, the
// only network-touching function `runSurveysSubmit` calls.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    surveys: {
      ...actual.surveys,
      submit: vi.fn(),
    },
  };
});

import { ConsentRequiredError, surveys } from "@ttctl/core";

import { setCliConfigPath } from "../../../lib/config-context.js";
import { boolMarker, formatSurveysTable, runSurveysSubmit } from "../index.js";

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

// ---------------------------------------------------------------------------
// runSurveysSubmit — orchestration (answer parsing, consent threading,
// envelope emission, error routing). The service-layer consent gate and
// kind/option-id resolution are tested in core; here `surveys.submit` is
// mocked, so these tests assert the CLI's threading and error routing only.
// ---------------------------------------------------------------------------

const MOCKED_SUBMIT = surveys.submit as ReturnType<typeof vi.fn>;
const TOKEN = "tok-surveys-submit";
const RESULT: surveys.SubmitSurveyResult = { notice: null, pendingSurveys: [{ id: "sv-2" }] };

function withConfigFile(): void {
  const dir = mkdtempSync(join(tmpdir(), "ttctl-surveys-submit-"));
  const path = join(dir, ".ttctl.yaml");
  writeFileSync(path, `auth:\n  token: ${TOKEN}\n`, { mode: 0o600 });
  setCliConfigPath(path);
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function stdout(): string {
  return stdoutSpy.mock.calls.map((c) => c[0] as string).join("");
}

beforeEach(() => {
  withConfigFile();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${(code ?? 0).toString()})`);
  }) as unknown as typeof process.exit);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  MOCKED_SUBMIT.mockReset();
});

afterEach(() => {
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("runSurveysSubmit", () => {
  it("threads parsed answers + consent and omits kind when not given", async () => {
    MOCKED_SUBMIT.mockResolvedValueOnce(RESULT);
    await runSurveysSubmit("sv-1", { answer: ["q-1=5"], consentSurveySubmission: true, output: "json" });
    expect(MOCKED_SUBMIT).toHaveBeenCalledWith(
      TOKEN,
      { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }] },
      { surveySubmissionConsentIssued: true },
    );
    const payload = stdout();
    expect(payload).toContain('"ok":true');
    expect(payload).toContain('"operation":"surveys.submit"');
    expect(payload).toContain('"updated":');
  });

  it("threads the --kind override into the service args", async () => {
    MOCKED_SUBMIT.mockResolvedValueOnce(RESULT);
    await runSurveysSubmit("sv-1", { answer: ["q-1=5"], kind: "NPS", consentSurveySubmission: true, output: "json" });
    expect(MOCKED_SUBMIT).toHaveBeenCalledWith(
      TOKEN,
      { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }], kind: "NPS" },
      { surveySubmissionConsentIssued: true },
    );
  });

  it("splits each --answer on the FIRST '=' so values may contain '='", async () => {
    MOCKED_SUBMIT.mockResolvedValueOnce(RESULT);
    await runSurveysSubmit("sv-1", { answer: ["q-2=a=b=c"], consentSurveySubmission: true, output: "json" });
    expect(MOCKED_SUBMIT).toHaveBeenCalledWith(
      TOKEN,
      { surveyId: "sv-1", answers: [{ questionId: "q-2", value: "a=b=c" }] },
      { surveySubmissionConsentIssued: true },
    );
  });

  it("parses multiple --answer flags in order", async () => {
    MOCKED_SUBMIT.mockResolvedValueOnce(RESULT);
    await runSurveysSubmit("sv-1", { answer: ["q-1=5", "q-2=text"], consentSurveySubmission: true, output: "json" });
    const [, args] = MOCKED_SUBMIT.mock.calls[0] as [string, surveys.SubmitSurveyArgs, unknown];
    expect(args.answers).toEqual([
      { questionId: "q-1", value: "5" },
      { questionId: "q-2", value: "text" },
    ]);
  });

  it("threads consentSurveySubmission=false verbatim (runtime gate is the service's job)", async () => {
    // The static cast in the handler widens `false` past the `true` literal;
    // the mock stands in for the real service whose gate would reject it.
    MOCKED_SUBMIT.mockRejectedValueOnce(
      new ConsentRequiredError("SubmitSurvey", "survey-submission", "consent missing"),
    );
    await expect(
      runSurveysSubmit("sv-1", { answer: ["q-1=5"], consentSurveySubmission: false, output: "json" }),
    ).rejects.toThrow("process.exit(1)");
    expect(MOCKED_SUBMIT).toHaveBeenCalledWith(
      TOKEN,
      { surveyId: "sv-1", answers: [{ questionId: "q-1", value: "5" }] },
      { surveySubmissionConsentIssued: false },
    );
    expect(stdout()).toContain('"code":"CONSENT_REQUIRED"');
  });

  it("refuses an empty --answer set with VALIDATION_ERROR before any wire call", async () => {
    await expect(
      runSurveysSubmit("sv-1", { answer: [], consentSurveySubmission: true, output: "json" }),
    ).rejects.toThrow("process.exit(1)");
    expect(MOCKED_SUBMIT).not.toHaveBeenCalled();
    expect(stdout()).toContain('"code":"VALIDATION_ERROR"');
  });

  it("rejects a malformed --answer (no '=') with VALIDATION_ERROR before any wire call", async () => {
    await expect(
      runSurveysSubmit("sv-1", { answer: ["noequals"], consentSurveySubmission: true, output: "json" }),
    ).rejects.toThrow("process.exit(1)");
    expect(MOCKED_SUBMIT).not.toHaveBeenCalled();
    expect(stdout()).toContain('"code":"VALIDATION_ERROR"');
  });

  it("surfaces a service SurveysError (NOT_FOUND) through the error envelope", async () => {
    MOCKED_SUBMIT.mockRejectedValueOnce(new surveys.SurveysError("NOT_FOUND", 'No pending survey with id "sv-x".'));
    await expect(
      runSurveysSubmit("sv-x", { answer: ["q-1=5"], consentSurveySubmission: true, output: "json" }),
    ).rejects.toThrow("process.exit(1)");
    expect(stdout()).toContain('"code":"NOT_FOUND"');
  });
});
