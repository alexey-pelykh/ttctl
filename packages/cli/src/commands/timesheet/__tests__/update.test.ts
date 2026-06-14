// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: keep everything real except the
// network-touching `timesheet.update`, which we stub.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    timesheet: {
      ...actual.timesheet,
      update: vi.fn(),
    },
  };
});

import { timesheet } from "@ttctl/core";

import { setCliConfigPath } from "../../../lib/config-context.js";
import { resetCliDryRun, setCliDryRun } from "../../../lib/dry-run.js";
import { runTimesheetUpdate } from "../update.js";
import type { TimesheetUpdateOptions } from "../update.js";

const MOCKED_UPDATE = timesheet.update as ReturnType<typeof vi.fn>;
const TOKEN = "tok-ts-update-runner";

const DETAIL: timesheet.TimesheetDetail = {
  id: "bc-1",
  startDate: "2026-05-01",
  endDate: "2026-05-15",
  hours: "40.0",
  minimumCommitment: null,
  timesheetOverdue: false,
  timesheetSubmissionOpenDatetime: "2026-05-12T00:00:00+00:00",
  timesheetSubmissionDeadlineDatetime: "2026-05-31T23:59:59+00:00",
  timesheetSubmitted: false,
  timesheetUrl: null,
  timesheetComment: "updated",
  timesheetRecords: [],
  actualAgreement: null,
  engagement: {
    id: "eng-1",
    job: { id: "job-1", title: "Backend", client: { id: "cli-1", fullName: "Acme" } },
    expectedHours: 40,
  },
};

function withConfigFile(): void {
  const dir = mkdtempSync(join(tmpdir(), "ttctl-update-test-"));
  const path = join(dir, ".ttctl.yaml");
  writeFileSync(path, `auth:\n  token: ${TOKEN}\n`, { mode: 0o600 });
  setCliConfigPath(path);
}

/** Base options with no overrides — tests add what they exercise. */
function opts(over: Partial<TimesheetUpdateOptions> = {}): TimesheetUpdateOptions {
  return { record: [], note: [], consentTimesheetBilling: true, output: "json", ...over };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  withConfigFile();
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${(code ?? 0).toString()})`);
  }) as unknown as typeof process.exit);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  MOCKED_UPDATE.mockReset();
  resetCliDryRun();
});

afterEach(() => {
  resetCliDryRun();
  vi.restoreAllMocks();
});

function stdout(): string {
  return stdoutSpy.mock.calls.map((c) => c[0]).join("");
}

describe("runTimesheetUpdate", () => {
  it("comment-only: forwards { comment, consent } and emits the update envelope", async () => {
    MOCKED_UPDATE.mockResolvedValueOnce({ kind: "applied", result: DETAIL });
    await runTimesheetUpdate("bc-1", opts({ comment: "reviewed" }));
    expect(MOCKED_UPDATE).toHaveBeenCalledWith(
      TOKEN,
      "bc-1",
      { timesheetBillingConsentIssued: true, comment: "reviewed" },
      { dryRun: false },
    );
    const payload = stdout();
    expect(payload).toContain('"ok":true');
    expect(payload).toContain('"operation":"timesheet.update"');
    expect(payload).toContain('"updated":');
  });

  it("merges --record and --note for the same date into one record (duration string preserved)", async () => {
    MOCKED_UPDATE.mockResolvedValueOnce({ kind: "applied", result: DETAIL });
    await runTimesheetUpdate("bc-1", opts({ record: ["2026-05-12=480"], note: ["2026-05-12=fixed build"] }));
    expect(MOCKED_UPDATE).toHaveBeenCalledWith(
      TOKEN,
      "bc-1",
      {
        timesheetBillingConsentIssued: true,
        records: [{ date: "2026-05-12", duration: "480", note: "fixed build" }],
      },
      { dryRun: false },
    );
  });

  it("--note with empty value clears the note (sent as '')", async () => {
    MOCKED_UPDATE.mockResolvedValueOnce({ kind: "applied", result: DETAIL });
    await runTimesheetUpdate("bc-1", opts({ note: ["2026-05-12="] }));
    const call = MOCKED_UPDATE.mock.calls[0]?.[2] as timesheet.UpdateTimesheetInput;
    expect(call.records).toEqual([{ date: "2026-05-12", note: "" }]);
  });

  it("propagates the consent flag value through to the core input", async () => {
    MOCKED_UPDATE.mockResolvedValueOnce({ kind: "applied", result: DETAIL });
    await runTimesheetUpdate("bc-1", opts({ comment: "x", consentTimesheetBilling: false }));
    const call = MOCKED_UPDATE.mock.calls[0]?.[2] as timesheet.UpdateTimesheetInput;
    expect(call.timesheetBillingConsentIssued).toBe(false);
  });

  it("malformed --record (no '=') → VALIDATION_ERROR envelope, update never called", async () => {
    await expect(runTimesheetUpdate("bc-1", opts({ record: ["2026-05-12"] }))).rejects.toThrow("process.exit(1)");
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
    expect(stdout()).toContain('"code":"VALIDATION_ERROR"');
  });

  it("malformed --record date → VALIDATION_ERROR", async () => {
    await expect(runTimesheetUpdate("bc-1", opts({ record: ["not-a-date=480"] }))).rejects.toThrow("process.exit(1)");
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
    expect(stdout()).toContain('"code":"VALIDATION_ERROR"');
  });

  it("non-numeric --record minutes → VALIDATION_ERROR", async () => {
    await expect(runTimesheetUpdate("bc-1", opts({ record: ["2026-05-12=eight"] }))).rejects.toThrow("process.exit(1)");
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
    expect(stdout()).toContain('"code":"VALIDATION_ERROR"');
  });

  it("dry-run: routes { dryRun: true }, emits the dry-run envelope with the merge notice", async () => {
    setCliDryRun(true);
    MOCKED_UPDATE.mockResolvedValueOnce({
      kind: "preview",
      preview: {
        operation: "UpdateTimesheet",
        surface: "mobile-gateway",
        transport: "stock",
        endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
        headers: { Authorization: "Token token=<REDACTED>", "Content-Type": "application/json" },
        variables: { id: "bc-1", comment: "x", timesheetRecords: [] },
        body: "{}",
      },
    } as timesheet.UpdateOutcome);
    await runTimesheetUpdate("bc-1", opts({ comment: "x" }));
    expect(MOCKED_UPDATE).toHaveBeenCalledWith(TOKEN, "bc-1", expect.anything(), { dryRun: true });
    const payload = stdout();
    expect(payload).toContain('"dryRun":');
    expect(payload).toContain('"UpdateTimesheet"');
    expect(payload).toContain('"notice":');
    expect(payload).toContain("read-modify-write");
    expect(payload).not.toContain('"updated":');
  });

  it("propagates a service ConsentRequiredError through the envelope handler", async () => {
    MOCKED_UPDATE.mockRejectedValueOnce(new timesheet.TimesheetError("MUTATION_ERROR", "Duration exceeds cycle max"));
    await expect(runTimesheetUpdate("bc-1", opts({ comment: "x" }))).rejects.toThrow("process.exit(1)");
    const payload = stdout();
    expect(payload).toContain('"code":"MUTATION_ERROR"');
    expect(payload).toContain("Duration exceeds cycle max");
  });
});
