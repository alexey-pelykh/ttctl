// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: keep everything real except the
// `timesheet` namespace's network-touching functions, which we stub.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    timesheet: {
      ...actual.timesheet,
      list: vi.fn(),
      show: vi.fn(),
      submit: vi.fn(),
      resolveCurrentCycle: vi.fn(),
    },
  };
});

// Mock @clack/prompts so confirm() is deterministic in tests.
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    confirm: vi.fn(),
    isCancel: actual.isCancel,
  };
});

import * as clackMod from "@clack/prompts";
import { timesheet } from "@ttctl/core";

import { setCliConfigPath } from "../../../lib/config-context.js";
import { resetCliDryRun, setCliDryRun } from "../../../lib/dry-run.js";
import { runTimesheetSubmit } from "../submit.js";

const MOCKED_SUBMIT = timesheet.submit as ReturnType<typeof vi.fn>;
const MOCKED_RESOLVE = timesheet.resolveCurrentCycle as ReturnType<typeof vi.fn>;
const MOCKED_CONFIRM = clackMod.confirm as unknown as ReturnType<typeof vi.fn>;

const DETAIL: timesheet.TimesheetDetail = {
  id: "bc-1",
  startDate: "2026-05-01",
  endDate: "2026-05-15",
  hours: "40.0",
  minimumCommitment: null,
  timesheetOverdue: false,
  timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
  timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
  timesheetSubmitted: true,
  timesheetApproved: false,
  timesheetRequiresApproval: true,
  status: "submitted",
  timesheetUrl: null,
  timesheetComment: null,
  timesheetRecords: [],
  actualAgreement: null,
  engagement: {
    id: "eng-1",
    job: {
      id: "job-1",
      title: "Backend",
      client: { id: "cli-1", fullName: "Acme" },
    },
    expectedHours: 40,
  },
};

function withConfigFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ttctl-submit-test-"));
  const path = join(dir, ".ttctl.yaml");
  writeFileSync(path, "auth:\n  token: tok-ts-submit-runner\n", { mode: 0o600 });
  setCliConfigPath(path);
  return path;
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let originalIsTty: unknown;

function setStdinTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

beforeEach(() => {
  withConfigFile();
  originalIsTty = process.stdin.isTTY;
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${(code ?? 0).toString()})`);
  }) as unknown as typeof process.exit);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  MOCKED_SUBMIT.mockReset();
  MOCKED_RESOLVE.mockReset();
  MOCKED_CONFIRM.mockReset();
  resetCliDryRun();
});

afterEach(() => {
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
  resetCliDryRun();
  vi.restoreAllMocks();
});

describe("runTimesheetSubmit", () => {
  it("with explicit id + --confirm: submits and emits update envelope on json", async () => {
    MOCKED_SUBMIT.mockResolvedValueOnce({ kind: "applied", result: DETAIL });
    await runTimesheetSubmit("bc-1", { confirm: true, output: "json" });
    expect(MOCKED_SUBMIT).toHaveBeenCalledWith("tok-ts-submit-runner", "bc-1", { dryRun: false });
    expect(MOCKED_CONFIRM).not.toHaveBeenCalled();
    const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(payload).toContain('"ok":true');
    expect(payload).toContain('"operation":"timesheet.submit"');
    expect(payload).toContain('"updated":');
    expect(payload).toContain('"id":"bc-1"');
  });

  it("without --confirm and non-TTY stdin: refuses with CONFIRMATION_REQUIRED error", async () => {
    setStdinTty(false);
    let captured: Error | undefined;
    try {
      await runTimesheetSubmit("bc-1", { confirm: false, output: "json" });
    } catch (err) {
      if (err instanceof Error) captured = err;
    }
    expect(captured?.message).toBe("process.exit(1)");
    expect(MOCKED_SUBMIT).not.toHaveBeenCalled();
    const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(payload).toContain('"code":"CONFIRMATION_REQUIRED"');
  });

  it("without --confirm and TTY stdin: prompts; rejects on user-cancel", async () => {
    setStdinTty(true);
    MOCKED_CONFIRM.mockResolvedValueOnce(false);
    let captured: Error | undefined;
    try {
      await runTimesheetSubmit("bc-1", { confirm: false, output: "json" });
    } catch (err) {
      if (err instanceof Error) captured = err;
    }
    expect(captured?.message).toBe("process.exit(1)");
    expect(MOCKED_CONFIRM).toHaveBeenCalled();
    expect(MOCKED_SUBMIT).not.toHaveBeenCalled();
    const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(payload).toContain('"code":"CONFIRMATION_DECLINED"');
  });

  it("without --confirm and TTY stdin: prompts; proceeds on user-yes", async () => {
    setStdinTty(true);
    MOCKED_CONFIRM.mockResolvedValueOnce(true);
    MOCKED_SUBMIT.mockResolvedValueOnce({ kind: "applied", result: DETAIL });
    await runTimesheetSubmit("bc-1", { confirm: false, output: "json" });
    expect(MOCKED_SUBMIT).toHaveBeenCalledWith("tok-ts-submit-runner", "bc-1", { dryRun: false });
  });

  it("without id + auto-resolve found: submits the resolved cycle", async () => {
    MOCKED_RESOLVE.mockResolvedValueOnce({
      kind: "found",
      cycle: {
        id: "bc-current",
        startDate: "2026-05-01",
        endDate: "2026-05-15",
        hours: "40.0",
        minimumCommitment: null,
        timesheetOverdue: false,
        timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
        timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
        timesheetSubmitted: false,
        engagement: DETAIL.engagement,
      },
    });
    MOCKED_SUBMIT.mockResolvedValueOnce({ kind: "applied", result: { ...DETAIL, id: "bc-current" } });
    await runTimesheetSubmit(undefined, { confirm: true, output: "json" });
    expect(MOCKED_RESOLVE).toHaveBeenCalledWith("tok-ts-submit-runner", {});
    expect(MOCKED_SUBMIT).toHaveBeenCalledWith("tok-ts-submit-runner", "bc-current", { dryRun: false });
  });

  it("without id + auto-resolve none: refuses with NO_CURRENT_CYCLE", async () => {
    MOCKED_RESOLVE.mockResolvedValueOnce({ kind: "none" });
    let captured: Error | undefined;
    try {
      await runTimesheetSubmit(undefined, { confirm: true, output: "json" });
    } catch (err) {
      if (err instanceof Error) captured = err;
    }
    expect(captured?.message).toBe("process.exit(1)");
    expect(MOCKED_SUBMIT).not.toHaveBeenCalled();
    const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(payload).toContain('"code":"NO_CURRENT_CYCLE"');
  });

  it("without id + auto-resolve multiple: refuses with MULTIPLE_CURRENT_CYCLES + candidate hint", async () => {
    MOCKED_RESOLVE.mockResolvedValueOnce({
      kind: "multiple",
      candidates: [
        {
          id: "bc-a",
          startDate: "2026-05-01",
          endDate: "2026-05-15",
          hours: "40.0",
          minimumCommitment: null,
          timesheetOverdue: false,
          timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
          timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
          timesheetSubmitted: false,
          engagement: DETAIL.engagement,
        },
        {
          id: "bc-b",
          startDate: "2026-05-01",
          endDate: "2026-05-15",
          hours: "20.0",
          minimumCommitment: null,
          timesheetOverdue: false,
          timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
          timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
          timesheetSubmitted: false,
          engagement: { ...DETAIL.engagement, id: "eng-2" },
        },
      ],
    });
    let captured: Error | undefined;
    try {
      await runTimesheetSubmit(undefined, { confirm: true, output: "json" });
    } catch (err) {
      if (err instanceof Error) captured = err;
    }
    expect(captured?.message).toBe("process.exit(1)");
    const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(payload).toContain('"code":"MULTIPLE_CURRENT_CYCLES"');
    expect(payload).toContain("bc-a");
    expect(payload).toContain("bc-b");
  });

  it("forwards engagement scope to resolveCurrentCycle when no id supplied", async () => {
    MOCKED_RESOLVE.mockResolvedValueOnce({ kind: "none" });
    try {
      await runTimesheetSubmit(undefined, { confirm: true, engagement: "act-1", output: "json" });
    } catch {
      // process.exit thrown by emitErrorAndExit mock
    }
    expect(MOCKED_RESOLVE).toHaveBeenCalledWith("tok-ts-submit-runner", { engagement: "act-1" });
  });

  it("propagates service TimesheetError through the envelope handler", async () => {
    MOCKED_SUBMIT.mockRejectedValueOnce(new timesheet.TimesheetError("MUTATION_ERROR", "Hours missing for 2026-05-13"));
    let captured: Error | undefined;
    try {
      await runTimesheetSubmit("bc-1", { confirm: true, output: "json" });
    } catch (err) {
      if (err instanceof Error) captured = err;
    }
    expect(captured?.message).toBe("process.exit(1)");
    const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(payload).toContain('"code":"MUTATION_ERROR"');
    expect(payload).toContain("Hours missing");
  });

  describe("--dry-run", () => {
    const PREVIEW: timesheet.SubmitOutcome = {
      kind: "preview",
      preview: {
        operation: "SubmitTimesheet",
        surface: "mobile-gateway",
        transport: "stock",
        endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
        headers: { Authorization: "Token token=<REDACTED>", "Content-Type": "application/json" },
        variables: { id: "bc-1" },
        body: '{"operationName":"SubmitTimesheet","query":"...","variables":{"id":"bc-1"}}',
      },
    };

    it("with explicit id + dry-run: routes { dryRun: true } to core AND skips confirm gate", async () => {
      setCliDryRun(true);
      setStdinTty(false); // non-TTY MUST be tolerated on dry-run (no confirm needed)
      MOCKED_SUBMIT.mockResolvedValueOnce(PREVIEW);
      await runTimesheetSubmit("bc-1", { confirm: false, output: "json" });
      expect(MOCKED_SUBMIT).toHaveBeenCalledWith("tok-ts-submit-runner", "bc-1", { dryRun: true });
      expect(MOCKED_CONFIRM).not.toHaveBeenCalled();
      expect(MOCKED_RESOLVE).not.toHaveBeenCalled();
      const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      expect(payload).toContain('"ok":true');
      expect(payload).toContain('"operation":"timesheet.submit"');
      expect(payload).toContain('"dryRun":');
      expect(payload).toContain('"SubmitTimesheet"');
      expect(payload).not.toContain('"updated":');
    });

    it("without id + dry-run: stamps the auto-resolve placeholder and skips the auto-resolve fetch", async () => {
      setCliDryRun(true);
      MOCKED_SUBMIT.mockResolvedValueOnce({
        ...PREVIEW,
        preview: { ...PREVIEW.preview, variables: { id: "<auto-resolved-at-apply-time>" } },
      } as timesheet.SubmitOutcome);
      await runTimesheetSubmit(undefined, { confirm: false, output: "json" });
      expect(MOCKED_RESOLVE).not.toHaveBeenCalled();
      expect(MOCKED_SUBMIT).toHaveBeenCalledWith("tok-ts-submit-runner", "<auto-resolved-at-apply-time>", {
        dryRun: true,
      });
      const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      expect(payload).toContain('"notice":');
      expect(payload).toContain("placeholder");
    });

    it("apply path explicit (dryRun false) does NOT carry the dry-run flag", async () => {
      setCliDryRun(false);
      MOCKED_SUBMIT.mockResolvedValueOnce({ kind: "applied", result: DETAIL });
      await runTimesheetSubmit("bc-1", { confirm: true, output: "json" });
      expect(MOCKED_SUBMIT).toHaveBeenCalledWith("tok-ts-submit-runner", "bc-1", { dryRun: false });
      const payload = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      expect(payload).toContain('"updated":');
      expect(payload).not.toContain('"dryRun":');
    });
  });
});
