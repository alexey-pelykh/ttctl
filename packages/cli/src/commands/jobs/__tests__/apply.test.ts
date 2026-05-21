// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @ttctl/core so the `instanceof` checks in apply.ts and the
// shared error router resolve against THESE constructors (vi.mock
// replaces the imports). Tracks the real shape from
// `packages/core/src/services/applications/index.ts`.
vi.mock("@ttctl/core", async () => {
  class ApplicationsError extends Error {
    override readonly name = "ApplicationsError";
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class TtctlError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly recovery: string,
    ) {
      super(message);
    }
  }
  const apply = vi.fn();
  const applyData = vi.fn();
  const applyQuestions = vi.fn();
  // #438: apply.ts materializes the recovered Zod schemas at module
  // load time (`JobPositionAnswerInputSchema()` etc.). Pull the real
  // schema factories from the un-mocked `@ttctl/core` so the
  // strict-mode tightening assertions are exercised against the actual
  // recovered SDL shape — any schema regression in
  // `__generated__/zod-schemas.ts` therefore surfaces in this test
  // suite as an immediate failure.
  const actual = await vi.importActual<typeof import("@ttctl/core")>("@ttctl/core");
  return {
    applications: {
      ApplicationsError,
      JobExpertiseAnswerInputSchema: actual.applications.JobExpertiseAnswerInputSchema,
      JobPositionAnswerInputSchema: actual.applications.JobPositionAnswerInputSchema,
      PitchInputSchema: actual.applications.PitchInputSchema,
      apply,
      applyData,
      applyQuestions,
    },
    TtctlError,
  };
});

vi.mock("../../../lib/config-context.js", () => ({
  resolveConfigForCli: vi.fn(() => ({
    config: { auth: { token: "tok-test-123" } },
    path: "/fake/.ttctl.yaml",
  })),
}));

vi.mock("../../../lib/dry-run.js", () => ({
  getCliDryRun: vi.fn(() => false),
}));

import { applications } from "@ttctl/core";

import { getCliDryRun } from "../../../lib/dry-run.js";
import { _resetStdinClaimForTesting } from "../../../lib/json-input.js";
import { runJobsApply } from "../apply.js";

const mockedApply = vi.mocked(applications.apply);
const mockedApplyData = vi.mocked(applications.applyData);
const mockedApplyQuestions = vi.mocked(applications.applyQuestions);
const mockedGetCliDryRun = vi.mocked(getCliDryRun);

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

function captureExit(): { exit: { code: number } | null } {
  const captured = { exit: null as { code: number } | null };
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exit = { code: code ?? 0 };
    throw new ExitInvoked(code ?? 0);
  }) as never);
  return captured;
}

function captureStreams(): { stdout: string[]; stderr: string[] } {
  const captured = { stdout: [] as string[], stderr: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

const APPLIED_FIXTURE = {
  kind: "applied" as const,
  result: {
    id: "app-123",
    statusV2: { value: "JOB_APPLICATION_ON_RECRUITER_REVIEW", verbose: "On recruiter review" },
    requestedHourlyRate: { decimal: "95.00" },
    jobActivityItemId: "activity-456",
  },
};

const DRY_RUN_PREVIEW_FIXTURE = {
  kind: "preview" as const,
  preview: {
    operationName: "JobApply",
    transport: "stock" as const,
    surface: "mobile-gateway" as const,
    endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
    headers: { authorization: "Token token=<redacted>" },
    variables: {
      id: "JOB-456",
      comment: null,
      matcherQuestionsAnswers: null,
      expertiseQuestionsAnswers: null,
      consentIssued: true,
      requestedHourlyRate: "<resolved at apply time>",
      talentCard: null,
    },
  },
};

const PRE_APPLY_DATA_FIXTURE = {
  job: { id: "JOB-456", isCoaching: false, hasRequiredApplicationPitch: false },
  applyErrors: [],
  canApply: true,
  suggestedRate: "80.00",
  rateValidation: { minRate: "10.00", rateStep: 5 },
};

const APPLY_QUESTIONS_FIXTURE = {
  matcherQuestions: [
    { identifier: "MQ-1", prompt: "Are you available?", type: "matcher" as const, isMandatory: true },
    { identifier: "MQ-2", prompt: "Years of experience?", type: "matcher" as const, isMandatory: false },
    { identifier: "MQ-3", prompt: "Notice period?", type: "matcher" as const, isMandatory: false },
  ],
  expertiseQuestions: [{ identifier: "EQ-1", prompt: "TypeScript", type: "expertise" as const, isMandatory: true }],
};

beforeEach(() => {
  mockedApply.mockReset();
  mockedApplyData.mockReset();
  mockedApplyQuestions.mockReset();
  mockedGetCliDryRun.mockReset();
  mockedApply.mockResolvedValue(APPLIED_FIXTURE);
  mockedApplyData.mockResolvedValue(PRE_APPLY_DATA_FIXTURE);
  mockedApplyQuestions.mockResolvedValue(APPLY_QUESTIONS_FIXTURE);
  mockedGetCliDryRun.mockReturnValue(false);
  _resetStdinClaimForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- Happy path: apply with consent + all payloads ----------

describe("runJobsApply: happy path with --consent + --answers-file + --rate + --pitch-file (#430)", () => {
  it("forwards consent=true and all payloads to applications.apply()", async () => {
    captureExit();
    captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-jobs-apply-test-"));
    try {
      const answersPath = join(dir, "answers.json");
      const pitchPath = join(dir, "pitch.json");
      const answersPayload = {
        matcherAnswers: [
          { id: "MQ-1", answer: "Yes, available immediately" },
          { id: "MQ-2", answer: "8 years" },
        ],
        expertiseAnswers: [{ questionId: "EQ-1", other: "Strong", subjectId: null }],
      };
      // #438 Stage-2: pitchInput is validated against the recovered
      // `PitchInputSchema().strict()`. Codegen emits nullable fields as
      // required-present-but-null (per `codegen.config.ts` §
      // `nullishBehavior: "nullable"`). Provide every slot explicitly.
      const pitch = {
        certificationPitchItems: null,
        educationPitchItems: null,
        employmentPitchItems: null,
        industryPitchItems: null,
        mentorship: null,
        portfolioPitchItems: null,
        publicationPitchItems: null,
        skillPitchItems: null,
      };
      await writeFile(answersPath, JSON.stringify(answersPayload), "utf-8");
      await writeFile(pitchPath, JSON.stringify(pitch), "utf-8");

      await runJobsApply("JOB-456", {
        consent: true,
        rate: "95.00",
        answersFile: answersPath,
        pitchFile: pitchPath,
        output: "json",
      });

      expect(mockedApply).toHaveBeenCalledTimes(1);
      const [token, jobId, input] = mockedApply.mock.calls[0] ?? [];
      expect(token).toBe("tok-test-123");
      expect(jobId).toBe("JOB-456");
      expect(input).toBeDefined();
      const applyInput = input as {
        consentIssued: unknown;
        requestedHourlyRate?: string;
        matcherAnswers?: unknown;
        expertiseAnswers?: unknown;
        pitchData?: unknown;
        message?: string;
      };
      expect(applyInput.consentIssued).toBe(true);
      expect(applyInput.requestedHourlyRate).toBe("95.00");
      expect(applyInput.matcherAnswers).toEqual(answersPayload.matcherAnswers);
      expect(applyInput.expertiseAnswers).toEqual(answersPayload.expertiseAnswers);
      expect(applyInput.pitchData).toEqual(pitch);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits the new application id on stdout (exit 0)", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    await runJobsApply("JOB-456", { consent: true, output: "json" });
    expect(exit.exit).toBeNull(); // success path: no process.exit invoked
    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as { ok: boolean; updated: { id: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.updated.id).toBe("app-123");
  });

  it("renders the application id + activity item id in pretty output", async () => {
    captureExit();
    const streams = captureStreams();
    await runJobsApply("JOB-456", { consent: true, output: "pretty" });
    const stdout = streams.stdout.join("");
    expect(stdout).toContain("app-123");
    expect(stdout).toContain("activity-456");
    expect(stdout).toContain("ttctl applications show activity-456");
  });
});

// ---------- Missing --consent: refuse with CONSENT_REQUIRED, no wire call ----------

describe("runJobsApply: --consent gate (#430 / ADR-008 § Decision Part 4)", () => {
  it("refuses with CONSENT_REQUIRED and DOES NOT call applications.apply when --consent is missing", async () => {
    const exit = captureExit();
    const streams = captureStreams();

    await expect(
      runJobsApply("JOB-456", {
        output: "json",
        // consent intentionally omitted
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);

    expect(exit.exit?.code).toBe(1);
    // The KEY assertion per AC: "no JobApply wire mutation is sent".
    // CLI-layer gate refuses BEFORE the service call.
    expect(mockedApply).not.toHaveBeenCalled();
    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as { ok: boolean; errors: { code: string; message: string; hint?: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.code).toBe("CONSENT_REQUIRED");
    expect(parsed.errors[0]?.message).toContain("--consent");
  });

  it("refuses with CONSENT_REQUIRED when consent is explicitly false (defense-in-depth)", async () => {
    const exit = captureExit();
    captureStreams();
    await expect(
      runJobsApply("JOB-456", {
        consent: false,
        output: "json",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);
    expect(exit.exit?.code).toBe(1);
    expect(mockedApply).not.toHaveBeenCalled();
  });

  it("pretty mode: stderr indicates --consent is required", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    await expect(
      runJobsApply("JOB-456", {
        output: "pretty",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);
    expect(exit.exit?.code).toBe(1);
    const stderr = streams.stderr.join("");
    expect(stderr.toLowerCase()).toContain("consent");
    expect(stderr).toContain("CONSENT_REQUIRED");
  });
});

// ---------- --dry-run: preview without wire call ----------

describe("runJobsApply: --dry-run preview (#430)", () => {
  it("forwards dryRun=true to applications.apply() and emits the preview envelope", async () => {
    captureExit();
    captureStreams();
    mockedGetCliDryRun.mockReturnValue(true);
    mockedApply.mockResolvedValue(DRY_RUN_PREVIEW_FIXTURE);

    await runJobsApply("JOB-456", { consent: true, output: "json" });

    expect(mockedApply).toHaveBeenCalledTimes(1);
    const [, , , options] = mockedApply.mock.calls[0] ?? [];
    expect(options).toBeDefined();
    expect((options as { dryRun: boolean }).dryRun).toBe(true);
  });

  it("emits a dryRun envelope on stdout when --dry-run is set", async () => {
    captureExit();
    const streams = captureStreams();
    mockedGetCliDryRun.mockReturnValue(true);
    mockedApply.mockResolvedValue(DRY_RUN_PREVIEW_FIXTURE);

    await runJobsApply("JOB-456", { consent: true, output: "json" });

    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string; variables: { consentIssued: boolean } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("JobApply");
    expect(parsed.preview.variables.consentIssued).toBe(true);
  });
});

// ---------- --show-questions: pre-fetch only, no mutation ----------

describe("runJobsApply: --show-questions preview (#430)", () => {
  it("issues pre-fetch (applyData + applyQuestions) but DOES NOT call apply()", async () => {
    captureExit();
    captureStreams();

    await runJobsApply("JOB-456", {
      showQuestions: true,
      output: "json",
      // No consent — --show-questions is a read-only path and does not require it.
    });

    expect(mockedApplyData).toHaveBeenCalledTimes(1);
    expect(mockedApplyData).toHaveBeenCalledWith("tok-test-123", "JOB-456");
    expect(mockedApplyQuestions).toHaveBeenCalledTimes(1);
    expect(mockedApplyQuestions).toHaveBeenCalledWith("tok-test-123", "JOB-456");
    // The KEY assertion: NO apply() mutation call.
    expect(mockedApply).not.toHaveBeenCalled();
  });

  it("does NOT require --consent (read-only preview path)", async () => {
    captureExit();
    const streams = captureStreams();
    // No consent supplied — should still succeed.
    await runJobsApply("JOB-456", {
      showQuestions: true,
      output: "json",
    });
    const stdout = streams.stdout.join("");
    // Should emit a JSON projection, not an error envelope.
    expect(stdout).not.toContain("CONSENT_REQUIRED");
    const parsed = JSON.parse(stdout) as {
      jobId: string;
      matcherQuestions: { identifier: string }[];
      expertiseQuestions: { identifier: string }[];
    };
    expect(parsed.jobId).toBe("JOB-456");
    expect(parsed.matcherQuestions.length).toBe(3);
    expect(parsed.expertiseQuestions.length).toBe(1);
  });

  it("pretty output renders matcher + expertise inventories with counts", async () => {
    captureExit();
    const streams = captureStreams();
    await runJobsApply("JOB-456", { showQuestions: true, output: "pretty" });
    const stdout = streams.stdout.join("");
    expect(stdout).toContain("Matcher Questions (3)");
    expect(stdout).toContain("Expertise Questions (1)");
    expect(stdout).toContain("MQ-1");
    expect(stdout).toContain("EQ-1");
    expect(stdout).toContain("Suggested rate: 80.00");
    expect(stdout).toContain("Can apply: yes");
  });
});

// ---------- ALREADY_APPLIED: surfaced with non-zero exit ----------

describe("runJobsApply: ALREADY_APPLIED error mapping (#430)", () => {
  it("surfaces ALREADY_APPLIED in the error envelope on double-apply", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    mockedApply.mockRejectedValue(
      new applications.ApplicationsError(
        "ALREADY_APPLIED",
        'You have already applied to job "JOB-456". Run `ttctl applications show <activity-id>` to find your existing application.',
      ),
    );

    await expect(
      runJobsApply("JOB-456", {
        consent: true,
        output: "json",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);

    expect(exit.exit?.code).toBe(1);
    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as { ok: boolean; errors: { code: string; message: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.code).toBe("ALREADY_APPLIED");
    expect(parsed.errors[0]?.message).toContain("already applied");
  });

  it("pretty mode: stderr contains the ALREADY_APPLIED code (per AC)", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    mockedApply.mockRejectedValue(new applications.ApplicationsError("ALREADY_APPLIED", "Already applied to JOB-456."));

    await expect(
      runJobsApply("JOB-456", {
        consent: true,
        output: "pretty",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);

    expect(exit.exit?.code).toBe(1);
    const stderr = streams.stderr.join("");
    expect(stderr).toContain("ALREADY_APPLIED");
  });
});

// ---------- Job with no questions: --answers-file optional ----------

describe("runJobsApply: job with no questions — --answers-file optional (#430)", () => {
  it("forwards consent=true and no answer payloads when --answers-file is omitted", async () => {
    captureExit();
    captureStreams();

    await runJobsApply("JOB-empty", {
      consent: true,
      output: "json",
    });

    expect(mockedApply).toHaveBeenCalledTimes(1);
    const [, , input] = mockedApply.mock.calls[0] ?? [];
    const applyInput = input as {
      consentIssued: unknown;
      matcherAnswers?: unknown;
      expertiseAnswers?: unknown;
      pitchData?: unknown;
    };
    expect(applyInput.consentIssued).toBe(true);
    // The "no answer payloads" assertion per AC.
    expect(applyInput.matcherAnswers).toBeUndefined();
    expect(applyInput.expertiseAnswers).toBeUndefined();
    expect(applyInput.pitchData).toBeUndefined();
  });
});

// ---------- --answers-file validation (mirrors #428 confirm semantics) ----------

describe("runJobsApply: --answers-file validation (#430, mirrors #428)", () => {
  it("refuses with VALIDATION_ERROR and DOES NOT call apply() when answers JSON is malformed", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-jobs-apply-test-"));
    try {
      const answersPath = join(dir, "broken.json");
      await writeFile(answersPath, "{ not-json,", "utf-8");

      await expect(
        runJobsApply("JOB-456", {
          consent: true,
          answersFile: answersPath,
          output: "json",
        }),
      ).rejects.toBeInstanceOf(ExitInvoked);

      expect(exit.exit?.code).toBe(1);
      expect(mockedApply).not.toHaveBeenCalled();
      const parsed = JSON.parse(streams.stdout.join("")) as { errors: { code: string; message: string }[] };
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      expect(parsed.errors[0]?.message).toContain("answers-file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses with VALIDATION_ERROR when --answers-file is a bare JSON array (wrapper shape mismatch)", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-jobs-apply-test-"));
    try {
      const answersPath = join(dir, "array.json");
      await writeFile(answersPath, "[1, 2, 3]", "utf-8");

      await expect(
        runJobsApply("JOB-456", {
          consent: true,
          answersFile: answersPath,
          output: "json",
        }),
      ).rejects.toBeInstanceOf(ExitInvoked);

      expect(exit.exit?.code).toBe(1);
      expect(mockedApply).not.toHaveBeenCalled();
      const parsed = JSON.parse(streams.stdout.join("")) as { errors: { code: string; message: string }[] };
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      expect(parsed.errors[0]?.message).toContain("expected a JSON object");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------- --rate decimal validation ----------

describe("runJobsApply: --rate decimal validation (#430)", () => {
  it("refuses with MUTATION_ERROR when --rate is not a non-negative decimal", async () => {
    const exit = captureExit();
    const streams = captureStreams();

    await expect(
      runJobsApply("JOB-456", {
        consent: true,
        rate: "not-a-number",
        output: "json",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);

    expect(exit.exit?.code).toBe(1);
    expect(mockedApply).not.toHaveBeenCalled();
    const parsed = JSON.parse(streams.stdout.join("")) as { errors: { code: string; message: string }[] };
    expect(parsed.errors[0]?.code).toBe("MUTATION_ERROR");
    expect(parsed.errors[0]?.message).toContain("--rate");
  });

  it("accepts integer rate as a valid decimal", async () => {
    captureExit();
    captureStreams();

    await runJobsApply("JOB-456", {
      consent: true,
      rate: "100",
      output: "json",
    });

    expect(mockedApply).toHaveBeenCalledTimes(1);
    const [, , input] = mockedApply.mock.calls[0] ?? [];
    expect((input as { requestedHourlyRate?: string }).requestedHourlyRate).toBe("100");
  });
});

// ---------- --message forwarding ----------

describe("runJobsApply: --message forwarding (#430)", () => {
  it("forwards --message to the apply() input as the `message` field", async () => {
    captureExit();
    captureStreams();

    await runJobsApply("JOB-456", {
      consent: true,
      message: "Excited to apply!",
      output: "json",
    });

    expect(mockedApply).toHaveBeenCalledTimes(1);
    const [, , input] = mockedApply.mock.calls[0] ?? [];
    expect((input as { message?: string }).message).toBe("Excited to apply!");
  });
});
