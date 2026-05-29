// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ttctl/core", async () => {
  // Local error classes so the `instanceof` checks in the shared CLI
  // error router resolve against THESE constructors (vi.mock replaces the
  // imports). `TtctlError` is the branch consent failures route through
  // (ConsentRequiredError extends it); `ApplicationsError` is the domain
  // branch.
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
  const update = vi.fn();
  return {
    applications: {
      ApplicationsError,
      INTERVIEW_NOTE_SECTIONS: [
        "ASK_YOUR_CLIENT",
        "GAPS",
        "JOB_HIGHLIGHTS",
        "POTENTIAL_QUESTIONS",
        "PRO_TIPS",
        "STRENGTHS",
      ] as const,
      interviews: { notes: { update } },
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
import { runApplicationsInterviewNotesUpdate } from "../interview.js";

const mockedUpdate = vi.mocked(applications.interviews.notes.update);
const mockedDryRun = vi.mocked(getCliDryRun);

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

function captureStdout(): { stdout: string[] } {
  const captured = { stdout: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((): boolean => true);
  return captured;
}

const APPLIED_FIXTURE = {
  kind: "applied" as const,
  result: {
    interviewId: "int-1",
    notice: "Saved.",
    notes: [{ id: "n1", section: "STRENGTHS", note: "Mention the AWS cert" }],
  },
};

beforeEach(() => {
  mockedUpdate.mockReset();
  mockedUpdate.mockResolvedValue(APPLIED_FIXTURE);
  mockedDryRun.mockReset();
  mockedDryRun.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runApplicationsInterviewNotesUpdate (#441)", () => {
  it("rejects with VALIDATION_ERROR and never calls the service when no --note is supplied", async () => {
    const exit = captureExit();
    const out = captureStdout();
    await expect(
      runApplicationsInterviewNotesUpdate("int-1", {
        note: [],
        section: [],
        consentInterviewAction: true,
        output: "json",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);
    expect(exit.exit?.code).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    const env = JSON.parse(out.stdout.join("")) as { ok: boolean; errors: { code: string }[] };
    expect(env.ok).toBe(false);
    expect(env.errors[0]?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects with VALIDATION_ERROR when --section count exceeds --note count", async () => {
    const exit = captureExit();
    const out = captureStdout();
    await expect(
      runApplicationsInterviewNotesUpdate("int-1", {
        note: ["only one note"],
        section: ["GAPS", "STRENGTHS"],
        consentInterviewAction: true,
        output: "json",
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);
    expect(exit.exit?.code).toBe(1);
    expect(mockedUpdate).not.toHaveBeenCalled();
    const env = JSON.parse(out.stdout.join("")) as { errors: { code: string }[] };
    expect(env.errors[0]?.code).toBe("VALIDATION_ERROR");
  });

  it("pairs sections to notes by index, forwards the consent flag, and renders the applied echo", async () => {
    const out = captureStdout();
    await runApplicationsInterviewNotesUpdate("int-1", {
      note: ["a", "b", "c"],
      section: ["GAPS", "STRENGTHS"],
      consentInterviewAction: true,
      output: "json",
    });
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    const [token, interviewId, input, options] = mockedUpdate.mock.calls[0] ?? [];
    expect(token).toBe("tok-test-123");
    expect(interviewId).toBe("int-1");
    expect(input).toEqual({
      notes: [{ section: "GAPS", note: "a" }, { section: "STRENGTHS", note: "b" }, { note: "c" }],
      interviewActionConsentIssued: true,
    });
    expect(options).toEqual({ dryRun: false });

    const env = JSON.parse(out.stdout.join("")) as { ok: boolean; updated: { interviewId: string }; notice?: string };
    expect(env.ok).toBe(true);
    expect(env.updated.interviewId).toBe("int-1");
    expect(env.notice).toBe("Saved.");
  });

  it("forwards interviewActionConsentIssued:false when the consent flag is absent", async () => {
    captureStdout();
    await runApplicationsInterviewNotesUpdate("int-1", {
      note: ["a"],
      section: [],
      consentInterviewAction: false,
      output: "json",
    });
    const [, , input] = mockedUpdate.mock.calls[0] ?? [];
    expect(input).toMatchObject({ interviewActionConsentIssued: false });
  });

  it("routes the global --dry-run to the service and emits the dry-run preview envelope", async () => {
    mockedDryRun.mockReturnValue(true);
    mockedUpdate.mockResolvedValue({
      kind: "preview" as const,
      preview: {
        operationName: "UpdateInterviewTalentNotes",
        surface: "mobile-gateway",
        transport: "stock",
        endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
        variables: { interviewId: "int-1", input: { notes: [{ section: "GAPS", note: "a" }] } },
        headers: { authorization: "Token token=<redacted>" },
      },
    });
    const out = captureStdout();
    await runApplicationsInterviewNotesUpdate("int-1", {
      note: ["a"],
      section: ["GAPS"],
      consentInterviewAction: true,
      output: "json",
    });
    const [, , , options] = mockedUpdate.mock.calls[0] ?? [];
    expect(options).toEqual({ dryRun: true });
    const env = JSON.parse(out.stdout.join("")) as { dryRun: boolean; preview: { operationName: string } };
    expect(env.dryRun).toBe(true);
    expect(env.preview.operationName).toBe("UpdateInterviewTalentNotes");
  });
});
