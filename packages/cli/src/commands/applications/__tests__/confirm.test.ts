// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ttctl/core", () => {
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
  return {
    applications: {
      ApplicationsError,
      AVAILABILITY_REQUEST_KINDS,
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
      const payload = {
        matcherAnswers: [
          { questionId: "MQ-1", answer: "matcher answer one" },
          { questionId: "MQ-2", answer: "matcher answer two" },
        ],
        expertiseAnswers: [{ questionId: "EQ-1", answer: "expertise answer" }],
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
      const pitch = { summary: "Strong fit", highlights: ["Years of TS experience"] };
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
        matcherAnswers: [{ questionId: "MQ-1", answer: "ans" }],
        expertiseAnswers: [{ questionId: "EQ-1", answer: "expertise" }],
      };
      const pitch = { message: "Hello" };
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

  it("refuses with VALIDATION_ERROR and the ABSOLUTE path when --answers-file path does not exist", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    await expect(
      runApplicationsConfirm("ar-1", {
        kind: "FIXED",
        rate: "80.00",
        answersFile: "/nonexistent-428.json",
        output: "json",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);
    expect(exit.exit?.code).toBe(1);
    expect(mockedConfirm).not.toHaveBeenCalled();
    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as { ok: boolean; errors: { code: string; message: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
    expect(parsed.errors[0]?.message).toContain("/nonexistent-428.json");
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
      await writeFile(answersPath, '{"matcherAnswers":[{"questionId":"MQ-1","answer":"a"}]}', "utf-8");

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
      expect(confirmInput.matcherQuestionsAnswers).toEqual([{ questionId: "MQ-1", answer: "a" }]);
      expect(confirmInput.expertiseQuestionsAnswers).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
