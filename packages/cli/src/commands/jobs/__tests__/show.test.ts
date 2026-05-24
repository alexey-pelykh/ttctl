// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of `@ttctl/core`: re-export everything real (so type
// definitions, error classes, and other helpers resolve unchanged) and
// override `jobs.show` + `applications.applyQuestions` so the
// integration tests can stub the wire-side responses without touching
// the transport. Issue #437 — `jobs show --with-questions` parallel-
// fetch coverage.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    jobs: {
      ...actual.jobs,
      show: vi.fn(),
    },
    applications: {
      ...actual.applications,
      applyQuestions: vi.fn(),
    },
  };
});

// Mock the config-context loader so `loadAuthTokenOrExit` resolves
// against an in-memory token rather than reading `~/.ttctl.yaml`.
vi.mock("../../../lib/config-context.js", () => ({
  resolveConfigForCli: vi.fn(() => ({
    config: { auth: { token: "tok-test-437" } },
    path: "/fake/.ttctl.yaml",
  })),
}));

import { applications, jobs } from "@ttctl/core";

import { runJobsShow } from "../show.js";

const mockedJobsShow = vi.mocked(jobs.show);
const mockedApplyQuestions = vi.mocked(applications.applyQuestions);

const JOB_DETAIL_FIXTURE: jobs.JobDetail = {
  id: "JOB-456",
  title: "Senior React Engineer",
  url: "https://www.toptal.com/jobs/JOB-456",
  client: {
    id: "cli-1",
    fullName: "Acme Inc.",
    city: "San Francisco",
    countryName: "United States",
    foundingYear: null,
    industry: "Software",
    isEnterprise: false,
    website: null,
    linkedin: null,
    teamSize: null,
  },
  commitment: { slug: "full_time" },
  workType: { slug: "remote" },
  specialization: { title: "Frontend" },
  expectedHours: 40,
  maxRate: 120,
  fixedRate: null,
  startDate: "2026-06-01",
  postedWhen: "2 days ago",
  viewed: false,
  saved: false,
  notInterested: false,
  descriptionMd: "We're hiring.",
  minimumHoursPerBillingCycle: null,
  isCoaching: false,
  isToptalProject: false,
  semiMonthlyBilling: false,
  positionsCount: 1,
  jobTimeZone: null,
  skills: [{ id: "sk-1", name: "React", rating: 5, isOptional: false }],
  languages: [],
  contacts: [],
  pointsOfContact: null,
};

const QUESTIONS_FIXTURE: applications.ApplicationQuestions = {
  matcherQuestions: [
    {
      identifier: "MQ-1",
      prompt: "Years of TS?",
      type: "matcher",
      isMandatory: true,
      options: [],
      suggestedAnswer: null,
      inputType: "free-text",
    },
    {
      identifier: "MQ-2",
      prompt: "Remote-only?",
      type: "matcher",
      isMandatory: false,
      options: [],
      suggestedAnswer: null,
      inputType: "free-text",
    },
    {
      identifier: "MQ-3",
      prompt: "Available now?",
      type: "matcher",
      isMandatory: true,
      options: [],
      suggestedAnswer: null,
      inputType: "free-text",
    },
  ],
  expertiseQuestions: [
    {
      identifier: "EQ-1",
      prompt: "React",
      type: "expertise",
      isMandatory: true,
      options: [],
      suggestedAnswer: null,
      inputType: "free-text",
    },
  ],
};

const EMPTY_QUESTIONS_FIXTURE: applications.ApplicationQuestions = {
  matcherQuestions: [],
  expertiseQuestions: [],
};

function captureStdout(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

beforeEach(() => {
  mockedJobsShow.mockReset();
  mockedApplyQuestions.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runJobsShow --with-questions (issue #437)", () => {
  it("Scenario: text output inlines a Matcher Questions / Expertise Questions section with counts", async () => {
    const out = captureStdout();
    mockedJobsShow.mockResolvedValueOnce(JOB_DETAIL_FIXTURE);
    mockedApplyQuestions.mockResolvedValueOnce(QUESTIONS_FIXTURE);

    await runJobsShow("JOB-456", "pretty", { withQuestions: true });

    expect(mockedJobsShow).toHaveBeenCalledTimes(1);
    expect(mockedJobsShow).toHaveBeenCalledWith("tok-test-437", "JOB-456");
    expect(mockedApplyQuestions).toHaveBeenCalledTimes(1);
    expect(mockedApplyQuestions).toHaveBeenCalledWith("tok-test-437", "JOB-456");

    const stdout = out.lines.join("");
    // Standard job summary line still present.
    expect(stdout).toContain("Job JOB-456");
    expect(stdout).toContain("Senior React Engineer");
    // Both sections render with the count in the header (matches the
    // Gherkin scenario verbatim).
    expect(stdout).toContain("Matcher Questions (3)");
    expect(stdout).toContain("Expertise Questions (1)");
    // Each question is rendered with its identifier and prompt.
    expect(stdout).toContain("MQ-1: Years of TS?");
    expect(stdout).toContain("MQ-2: Remote-only?");
    expect(stdout).toContain("MQ-3: Available now?");
    expect(stdout).toContain("EQ-1: React");
  });

  it("Scenario: job with no questions — empty sections (not omitted)", async () => {
    const out = captureStdout();
    mockedJobsShow.mockResolvedValueOnce(JOB_DETAIL_FIXTURE);
    mockedApplyQuestions.mockResolvedValueOnce(EMPTY_QUESTIONS_FIXTURE);

    await runJobsShow("JOB-empty", "pretty", { withQuestions: true });

    const stdout = out.lines.join("");
    expect(stdout).toContain("Matcher Questions (0)");
    expect(stdout).toContain("Expertise Questions (0)");
    // No empty section is silently dropped — both headers must be
    // present even when the inventory is empty.
  });

  it("Scenario: --output json — top-level questions field with matcher + expertise arrays", async () => {
    const out = captureStdout();
    mockedJobsShow.mockResolvedValueOnce(JOB_DETAIL_FIXTURE);
    mockedApplyQuestions.mockResolvedValueOnce(QUESTIONS_FIXTURE);

    await runJobsShow("JOB-456", "json", { withQuestions: true });

    const stdout = out.lines.join("");
    // The helper appends a single trailing newline; strip it before
    // parsing.
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown> & {
      questions?: { matcher?: unknown[]; expertise?: unknown[] };
    };
    expect(parsed["id"]).toBe("JOB-456");
    expect(parsed.questions).toBeDefined();
    expect(Array.isArray(parsed.questions?.matcher)).toBe(true);
    expect(Array.isArray(parsed.questions?.expertise)).toBe(true);
    expect(parsed.questions?.matcher).toHaveLength(3);
    expect(parsed.questions?.expertise).toHaveLength(1);
  });

  it("Scenario: --with-questions omitted — pre-change behavior preserved (no questions wire query)", async () => {
    const out = captureStdout();
    mockedJobsShow.mockResolvedValueOnce(JOB_DETAIL_FIXTURE);

    await runJobsShow("JOB-456", "pretty");

    expect(mockedJobsShow).toHaveBeenCalledTimes(1);
    // The Gherkin "no JobApplicationQuestions wire query is sent" is
    // structurally enforced here — the service-fn mock would have been
    // called if the parallel fetch were unconditional.
    expect(mockedApplyQuestions).not.toHaveBeenCalled();

    const stdout = out.lines.join("");
    expect(stdout).toContain("Job JOB-456");
    // Negation assertions for the two section headers — both must be
    // absent when the flag is omitted.
    expect(stdout).not.toContain("Matcher Questions");
    expect(stdout).not.toContain("Expertise Questions");
  });

  it("explicit --with-questions=false behaves identically to flag omitted", async () => {
    const out = captureStdout();
    mockedJobsShow.mockResolvedValueOnce(JOB_DETAIL_FIXTURE);

    await runJobsShow("JOB-456", "pretty", { withQuestions: false });

    expect(mockedApplyQuestions).not.toHaveBeenCalled();
    const stdout = out.lines.join("");
    expect(stdout).not.toContain("Matcher Questions");
  });
});
