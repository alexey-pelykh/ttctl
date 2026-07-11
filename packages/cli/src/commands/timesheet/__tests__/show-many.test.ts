// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: keep everything real except
// `timesheet.showMany`, whose wire call we stub.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    timesheet: {
      ...actual.timesheet,
      showMany: vi.fn(),
    },
  };
});

import { timesheet } from "@ttctl/core";

import { setCliConfigPath } from "../../../lib/config-context.js";
import { formatTimesheetShowMany, runTimesheetShowMany } from "../show-many.js";

const mockedShowMany = vi.mocked(timesheet.showMany);

function row(id: string, overrides: Partial<timesheet.TimesheetListItem> = {}): timesheet.TimesheetListItem {
  return {
    id,
    startDate: "2026-05-01",
    endDate: "2026-05-15",
    hours: "80.0",
    minimumCommitment: null,
    timesheetOverdue: false,
    timesheetSubmissionOpenDatetime: "2026-05-16T00:00:00+00:00",
    timesheetSubmissionDeadlineDatetime: "2026-05-20T00:00:00+00:00",
    timesheetSubmitted: true,
    timesheetApproved: false,
    timesheetRequiresApproval: true,
    status: "SUBMITTED",
    engagement: {
      id: "eng-1",
      job: { id: "job-1", title: "Senior Engineer", client: { id: "cli-1", fullName: "Acme" } },
    },
    ...overrides,
  };
}

function withConfigFile(): void {
  const dir = mkdtempSync(join(tmpdir(), "ttctl-ts-showmany-test-"));
  const path = join(dir, ".ttctl.yaml");
  writeFileSync(path, "auth:\n  token: tok-ts-showmany\n", { mode: 0o600 });
  setCliConfigPath(path);
}

function captureStdout(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

beforeEach(() => {
  withConfigFile();
  mockedShowMany.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatTimesheetShowMany", () => {
  it("renders the list table with no trailing line when nothing is missing", () => {
    const out = formatTimesheetShowMany([row("bc-1"), row("bc-2")], []);
    expect(out).toContain("bc-1");
    expect(out).toContain("bc-2");
    expect(out).not.toContain("Not found");
  });

  it("appends a Not-found line listing the unresolved ids", () => {
    const out = formatTimesheetShowMany([row("bc-1")], ["bc-missing", "bc-gone"]);
    expect(out).toContain("bc-1");
    expect(out).toContain("Not found (2): bc-missing, bc-gone");
  });
});

describe("runTimesheetShowMany", () => {
  it("fetches ids in input order and renders both rows (pretty)", async () => {
    const out = captureStdout();
    // service already re-orders to input order; caller asked [bc-2, bc-1].
    mockedShowMany.mockResolvedValueOnce([row("bc-2", { hours: "40.0" }), row("bc-1")]);

    await runTimesheetShowMany(["bc-2", "bc-1"], "pretty");

    expect(mockedShowMany).toHaveBeenCalledWith("tok-ts-showmany", ["bc-2", "bc-1"]);
    const stdout = out.lines.join("");
    expect(stdout).toContain("bc-1");
    expect(stdout).toContain("bc-2");
    // input order preserved in the rendered table
    expect(stdout.indexOf("bc-2")).toBeLessThan(stdout.indexOf("bc-1"));
  });

  it("reports requested ids that were not found", async () => {
    const out = captureStdout();
    mockedShowMany.mockResolvedValueOnce([row("bc-1")]);

    await runTimesheetShowMany(["bc-1", "bc-missing"], "pretty");

    const stdout = out.lines.join("");
    expect(stdout).toContain("bc-1");
    expect(stdout).toContain("Not found (1): bc-missing");
  });

  it("emits the timesheets array for json consumers (no Not-found prose)", async () => {
    const out = captureStdout();
    mockedShowMany.mockResolvedValueOnce([row("bc-2"), row("bc-1")]);

    await runTimesheetShowMany(["bc-2", "bc-1"], "json");

    const stdout = out.lines.join("");
    expect(stdout).toContain("bc-2");
    expect(stdout).toContain("bc-1");
    expect(stdout.indexOf("bc-2")).toBeLessThan(stdout.indexOf("bc-1"));
    expect(stdout).not.toContain("Not found");
  });
});
