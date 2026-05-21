// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolveAbsolutePath } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ttctl/core", async () => {
  // Local error class so the `instanceof` checks in confirm.ts and the
  // shared error router resolve against THESE constructors (vi.mock
  // replaces the imports). Tracks the real shape from
  // `packages/core/src/services/applications/index.ts`.
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
  const confirm = vi.fn();
  const AVAILABILITY_REQUEST_KINDS = ["FIXED", "FLEXIBLE", "MARKETPLACE_FLEXIBLE"] as const;
  // #438: confirm.ts materializes the recovered Zod schemas at module
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
      AVAILABILITY_REQUEST_KINDS,
      JobExpertiseAnswerInputSchema: actual.applications.JobExpertiseAnswerInputSchema,
      JobPositionAnswerInputSchema: actual.applications.JobPositionAnswerInputSchema,
      PitchInputSchema: actual.applications.PitchInputSchema,
      confirm,
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

import { _resetStdinClaimForTesting } from "../../../lib/json-input.js";
import { runApplicationsConfirm } from "../confirm.js";

// Cast through unknown so the mocked vi.fn is callable with vi.mocked
// helpers — vi.mock above replaces the real namespace import.
const mockedConfirm = vi.mocked(applications.confirm);

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
    id: "ar-1",
    answeredAt: "2026-05-21T00:00:00Z",
    statusV2: { value: "AVAILABILITY_REQUEST_CONFIRMED", verbose: "Confirmed" },
    talentComment: null,
    requestedHourlyRate: { decimal: "80.00", verbose: "$80.00/hr" },
    rejectReason: null,
  },
};

beforeEach(() => {
  mockedConfirm.mockReset();
  mockedConfirm.mockResolvedValue(APPLIED_FIXTURE);
  _resetStdinClaimForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- #428 — answers-file / pitch-file forwarding ----------

describe("runApplicationsConfirm: --answers-file / --pitch-file (#428)", () => {
  it("forwards parsed answers payload as matcherQuestionsAnswers + expertiseQuestionsAnswers (happy path)", async () => {
    captureExit();
    captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-test-"));
    try {
      const answersPath = join(dir, "answers.json");
      // #438 Stage-2: matcher answers use `id` (NOT `questionId`) per
      // the recovered `JobPositionAnswerInput`; expertise answers use
      // `questionId` per `JobExpertiseAnswerInput` (asymmetric).
      const payload = {
        matcherAnswers: [
          { id: "MQ-1", answer: "matcher answer one" },
          { id: "MQ-2", answer: "matcher answer two" },
        ],
        expertiseAnswers: [{ questionId: "EQ-1", other: null, subjectId: null }],
      };
      await writeFile(answersPath, JSON.stringify(payload), "utf-8");

      await runApplicationsConfirm("ar-1", {
        kind: "FIXED",
        rate: "80.00",
        answersFile: answersPath,
        output: "json",
      });

      expect(mockedConfirm).toHaveBeenCalledTimes(1);
      const [, , input] = mockedConfirm.mock.calls[0] ?? [];
      expect(input).toBeDefined();
      const confirmInput = input as { matcherQuestionsAnswers?: unknown; expertiseQuestionsAnswers?: unknown };
      expect(confirmInput.matcherQuestionsAnswers).toEqual(payload.matcherAnswers);
      expect(confirmInput.expertiseQuestionsAnswers).toEqual(payload.expertiseAnswers);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forwards parsed pitch payload as pitchInput when --pitch-file is supplied", async () => {
    captureExit();
    captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-test-"));
    try {
      const pitchPath = join(dir, "pitch.json");
      // #438 Stage-2: pitchInput is validated against the recovered
      // `PitchInputSchema().strict()`. Codegen emits nullable fields as
      // required-present-but-null (per `codegen.config.ts` §
      // `nullishBehavior: "nullable"` — "no omitted-field tolerance,
      // desirable for wire-drift detection"). So callers must provide
      // every PitchInput slot explicitly; `null` for the empty case.
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
      await writeFile(pitchPath, JSON.stringify(pitch), "utf-8");

      await runApplicationsConfirm("ar-1", {
        kind: "FIXED",
        rate: "80.00",
        pitchFile: pitchPath,
        output: "json",
      });

      expect(mockedConfirm).toHaveBeenCalledTimes(1);
      const [, , input] = mockedConfirm.mock.calls[0] ?? [];
      const confirmInput = input as { pitchInput?: unknown };
      expect(confirmInput.pitchInput).toEqual(pitch);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forwards BOTH answers and pitch when both files are supplied (happy path)", async () => {
    captureExit();
    captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-test-"));
    try {
      const answersPath = join(dir, "answers.json");
      const pitchPath = join(dir, "pitch.json");
      const answersPayload = {
        matcherAnswers: [{ id: "MQ-1", answer: "ans" }],
        expertiseAnswers: [{ questionId: "EQ-1", other: null, subjectId: null }],
      };
      // #438: Pitch input strict-mode requires every nullable slot
      // explicit. Provide one slot with a real item + the rest null.
      const pitch = {
        certificationPitchItems: null,
        educationPitchItems: null,
        employmentPitchItems: null,
        industryPitchItems: null,
        mentorship: null,
        portfolioPitchItems: null,
        publicationPitchItems: null,
        skillPitchItems: [{ skillSetId: "S1" }],
      };
      await writeFile(answersPath, JSON.stringify(answersPayload), "utf-8");
      await writeFile(pitchPath, JSON.stringify(pitch), "utf-8");

      await runApplicationsConfirm("ar-1", {
        kind: "FIXED",
        rate: "80.00",
        answersFile: answersPath,
        pitchFile: pitchPath,
        output: "json",
      });

      const [, , input] = mockedConfirm.mock.calls[0] ?? [];
      const confirmInput = input as {
        matcherQuestionsAnswers?: unknown;
        expertiseQuestionsAnswers?: unknown;
        pitchInput?: unknown;
      };
      expect(confirmInput.matcherQuestionsAnswers).toEqual(answersPayload.matcherAnswers);
      expect(confirmInput.expertiseQuestionsAnswers).toEqual(answersPayload.expertiseAnswers);
      expect(confirmInput.pitchInput).toEqual(pitch);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses with VALIDATION_ERROR envelope and DOES NOT issue a wire call when --answers-file JSON is malformed", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-test-"));
    try {
      const answersPath = join(dir, "broken.json");
      await writeFile(answersPath, "{ not-json,", "utf-8");

      await expect(
        runApplicationsConfirm("ar-1", {
          kind: "FIXED",
          rate: "80.00",
          answersFile: answersPath,
          output: "json",
        }),
      ).rejects.toBeInstanceOf(ExitInvoked);

      expect(exit.exit?.code).toBe(1);
      expect(mockedConfirm).not.toHaveBeenCalled();
      const stdout = streams.stdout.join("");
      const parsed = JSON.parse(stdout) as { ok: boolean; errors: { code: string; message: string; hint?: string }[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      expect(parsed.errors[0]?.message).toContain("answers-file");
      // AC: "Recovery hint cites the parse failure line/column".
      expect(parsed.errors[0]?.message).toMatch(/line \d+, column \d+/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses with VALIDATION_ERROR and the platform-absolute path when --answers-file path does not exist", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    const rawPath = "/nonexistent-428.json";
    const expectedAbsolute = resolveAbsolutePath(rawPath);
    await expect(
      runApplicationsConfirm("ar-1", {
        kind: "FIXED",
        rate: "80.00",
        answersFile: rawPath,
        output: "json",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);
    expect(exit.exit?.code).toBe(1);
    expect(mockedConfirm).not.toHaveBeenCalled();
    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as { ok: boolean; errors: { code: string; message: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
    // On POSIX, expectedAbsolute === "/nonexistent-428.json"; on Windows,
    // resolveAbsolutePath rewrites it to drive-prefixed form. Either way,
    // the error message must contain the platform-absolute form — that IS
    // the AC's "absolute path" intent.
    expect(parsed.errors[0]?.message).toContain(expectedAbsolute);
  });

  it("refuses with VALIDATION_ERROR when --answers-file top-level value is not an object (e.g. a JSON array)", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-test-"));
    try {
      const answersPath = join(dir, "array.json");
      await writeFile(answersPath, "[1, 2, 3]", "utf-8");

      await expect(
        runApplicationsConfirm("ar-1", {
          kind: "FIXED",
          rate: "80.00",
          answersFile: answersPath,
          output: "json",
        }),
      ).rejects.toBeInstanceOf(ExitInvoked);

      expect(exit.exit?.code).toBe(1);
      expect(mockedConfirm).not.toHaveBeenCalled();
      const parsed = JSON.parse(streams.stdout.join("")) as { errors: { code: string; message: string }[] };
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      expect(parsed.errors[0]?.message).toContain("expected a JSON object");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses with VALIDATION_ERROR when --answers-file has matcherAnswers that is not an array", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-test-"));
    try {
      const answersPath = join(dir, "wrong-shape.json");
      await writeFile(answersPath, '{"matcherAnswers": "not-an-array"}', "utf-8");

      await expect(
        runApplicationsConfirm("ar-1", {
          kind: "FIXED",
          rate: "80.00",
          answersFile: answersPath,
          output: "json",
        }),
      ).rejects.toBeInstanceOf(ExitInvoked);

      expect(exit.exit?.code).toBe(1);
      expect(mockedConfirm).not.toHaveBeenCalled();
      const parsed = JSON.parse(streams.stdout.join("")) as { errors: { code: string; message: string }[] };
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      expect(parsed.errors[0]?.message).toContain("matcherAnswers");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses with VALIDATION_ERROR when --pitch-file top-level value is not a JSON object", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-test-"));
    try {
      const pitchPath = join(dir, "array.json");
      await writeFile(pitchPath, '"just a string"', "utf-8");

      await expect(
        runApplicationsConfirm("ar-1", {
          kind: "FIXED",
          rate: "80.00",
          pitchFile: pitchPath,
          output: "json",
        }),
      ).rejects.toBeInstanceOf(ExitInvoked);

      expect(exit.exit?.code).toBe(1);
      expect(mockedConfirm).not.toHaveBeenCalled();
      const parsed = JSON.parse(streams.stdout.join("")) as { errors: { code: string; message: string }[] };
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      expect(parsed.errors[0]?.message).toContain("pitch-file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("backward compat: existing flags (--message, --rate, --kind) work unchanged when both new flags are absent (#411 regression guard)", async () => {
    captureExit();
    captureStreams();
    await runApplicationsConfirm("ar-1", {
      message: "yes",
      rate: "100.00",
      kind: "FIXED",
      output: "json",
    });
    expect(mockedConfirm).toHaveBeenCalledTimes(1);
    const [, , input] = mockedConfirm.mock.calls[0] ?? [];
    const confirmInput = input as {
      comment?: string;
      requestedHourlyRate?: string;
      kind?: string;
      matcherQuestionsAnswers?: unknown;
      expertiseQuestionsAnswers?: unknown;
      pitchInput?: unknown;
    };
    expect(confirmInput.comment).toBe("yes");
    expect(confirmInput.requestedHourlyRate).toBe("100.00");
    expect(confirmInput.kind).toBe("FIXED");
    // ConfirmInput keys for the new payloads must remain unset when their
    // CLI flags are absent — the service treats `undefined` as "omit"
    // (and `?? null`s into the wire variables map).
    expect(confirmInput.matcherQuestionsAnswers).toBeUndefined();
    expect(confirmInput.expertiseQuestionsAnswers).toBeUndefined();
    expect(confirmInput.pitchInput).toBeUndefined();
  });

  it("ignores keys that are absent from the answers file (an answers file with only matcherAnswers leaves expertise unset)", async () => {
    captureExit();
    captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-test-"));
    try {
      const answersPath = join(dir, "matcher-only.json");
      // #438 Stage-2: matcher answers use `id`, not `questionId`.
      await writeFile(answersPath, '{"matcherAnswers":[{"id":"MQ-1","answer":"a"}]}', "utf-8");

      await runApplicationsConfirm("ar-1", {
        kind: "FIXED",
        rate: "80.00",
        answersFile: answersPath,
        output: "json",
      });

      const [, , input] = mockedConfirm.mock.calls[0] ?? [];
      const confirmInput = input as {
        matcherQuestionsAnswers?: unknown;
        expertiseQuestionsAnswers?: unknown;
      };
      expect(confirmInput.matcherQuestionsAnswers).toEqual([{ id: "MQ-1", answer: "a" }]);
      expect(confirmInput.expertiseQuestionsAnswers).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------- #438 — Stage-2 Zod tightening behavioral scenarios ----------

describe("runApplicationsConfirm: --answers-file / --pitch-file Zod tightening (#438)", () => {
  it("refuses with VALIDATION_ERROR and a field-path message when --answers-file contains a matcher entry with `questionId` (the wrong field — matcher uses `id`)", async () => {
    captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-438-"));
    try {
      const answersPath = join(dir, "answers.json");
      // Behavioral scenario 2: extra unknown key in payload rejected
      // with field-path error. Matcher answers carry `id` (NOT
      // `questionId`) per the recovered SDL — passing `questionId`
      // surfaces as an unknown-keys rejection in strict mode AND as
      // a missing-required-key (`id`) rejection.
      const payload = {
        matcherAnswers: [{ questionId: "MQ-1", answer: "wrong shape" }],
      };
      await writeFile(answersPath, JSON.stringify(payload), "utf-8");

      await expect(
        runApplicationsConfirm("ar-1", {
          kind: "FIXED",
          rate: "80.00",
          answersFile: answersPath,
          output: "json",
        }),
      ).rejects.toThrow(ExitInvoked);

      // The wire call MUST NOT fire when the schema rejects.
      expect(mockedConfirm).not.toHaveBeenCalled();
      // The envelope code is `VALIDATION_ERROR` per the AC, and the
      // message names the offending field.
      const stdout = streams.stdout.join("");
      const parsed = JSON.parse(stdout) as { errors: { code: string; message: string }[] };
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      expect(parsed.errors[0]?.message).toContain("matcherAnswers");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses with VALIDATION_ERROR and a field-path message when --answers-file contains an expertise entry missing the required `questionId`", async () => {
    captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-438-"));
    try {
      const answersPath = join(dir, "answers.json");
      // Behavioral scenario 3: missing required field rejected with
      // field-path error. Expertise answers require `questionId` per
      // `JobExpertiseAnswerInput`.
      const payload = {
        expertiseAnswers: [{ other: null, subjectId: null }],
      };
      await writeFile(answersPath, JSON.stringify(payload), "utf-8");

      await expect(
        runApplicationsConfirm("ar-1", {
          kind: "FIXED",
          rate: "80.00",
          answersFile: answersPath,
          output: "json",
        }),
      ).rejects.toThrow(ExitInvoked);

      expect(mockedConfirm).not.toHaveBeenCalled();
      const stdout = streams.stdout.join("");
      const parsed = JSON.parse(stdout) as { errors: { code: string; message: string }[] };
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      expect(parsed.errors[0]?.message).toContain("expertiseAnswers");
      expect(parsed.errors[0]?.message).toContain("questionId");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses with VALIDATION_ERROR when --pitch-file contains an unknown key (strict-mode rejection of extras)", async () => {
    captureExit();
    const streams = captureStreams();
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-438-"));
    try {
      const pitchPath = join(dir, "pitch.json");
      // Behavioral scenario 2 (pitch flavor): the recovered
      // PitchInput shape uses typed `*PitchItem*Input` arrays; an
      // arbitrary `message: "..."` field is NOT part of the shape and
      // is rejected as `unrecognized_keys` in strict mode.
      const payload = {
        certificationPitchItems: null,
        educationPitchItems: null,
        employmentPitchItems: null,
        industryPitchItems: null,
        mentorship: null,
        portfolioPitchItems: null,
        publicationPitchItems: null,
        skillPitchItems: null,
        message: "extra key not in PitchInput",
      };
      await writeFile(pitchPath, JSON.stringify(payload), "utf-8");

      await expect(
        runApplicationsConfirm("ar-1", {
          kind: "FIXED",
          rate: "80.00",
          pitchFile: pitchPath,
          output: "json",
        }),
      ).rejects.toThrow(ExitInvoked);

      expect(mockedConfirm).not.toHaveBeenCalled();
      const stdout = streams.stdout.join("");
      const parsed = JSON.parse(stdout) as { errors: { code: string; message: string }[] };
      expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
      // Field-path message — strict mode flags the offending key.
      expect(parsed.errors[0]?.message).toContain("pitch-file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("happy path: valid tightened-shape payload threads through unchanged (behavioral scenario 1)", async () => {
    captureExit();
    captureStreams();
    mockedConfirm.mockResolvedValue({
      kind: "applied",
      result: {
        id: "ar-1",
        answeredAt: "2026-05-20T00:00:00Z",
        statusV2: { value: "AVAILABILITY_REQUEST_CONFIRMED", verbose: "Confirmed" },
        talentComment: null,
        requestedHourlyRate: { decimal: "80.00", verbose: "$80.00/hr" },
        rejectReason: null,
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "ttctl-confirm-438-"));
    try {
      const answersPath = join(dir, "answers.json");
      const payload = {
        matcherAnswers: [{ id: "MQ-1", answer: "yes" }],
        expertiseAnswers: [{ questionId: "EQ-1", other: null, subjectId: null }],
      };
      await writeFile(answersPath, JSON.stringify(payload), "utf-8");

      await runApplicationsConfirm("ar-1", {
        kind: "FIXED",
        rate: "80.00",
        answersFile: answersPath,
        output: "json",
      });

      expect(mockedConfirm).toHaveBeenCalledTimes(1);
      const [, , input] = mockedConfirm.mock.calls[0] ?? [];
      const confirmInput = input as { matcherQuestionsAnswers?: unknown; expertiseQuestionsAnswers?: unknown };
      // Behavioral scenario 1: payload threads through byte-identically.
      expect(confirmInput.matcherQuestionsAnswers).toEqual(payload.matcherAnswers);
      expect(confirmInput.expertiseQuestionsAnswers).toEqual(payload.expertiseAnswers);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
