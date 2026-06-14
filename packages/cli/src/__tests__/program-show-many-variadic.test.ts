// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the `jobs show` / `jobs show-many` action handlers so the parse
// path runs in isolation — no auth resolution, no service/network call.
// The assertion is purely on what Commander threads into the action.
vi.mock("../commands/jobs/show.js", () => ({
  runJobsShow: vi.fn(),
  runJobsShowMany: vi.fn(),
}));

import { runJobsShowMany } from "../commands/jobs/show.js";
import { buildProgram } from "../program.js";

const mockedRunJobsShowMany = vi.mocked(runJobsShowMany);

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

function captureExit(): void {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitInvoked(code ?? 0);
  }) as never);
}

function captureStderr(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

async function parse(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (!(err instanceof ExitInvoked)) throw err;
  }
}

describe("jobs show-many variadic argument parsing", () => {
  beforeEach(() => {
    mockedRunJobsShowMany.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The load-bearing regression: a custom parser on a variadic `<id...>`
  // is invoked once per value with the accumulator threaded as `previous`.
  // A single-value parser would yield only the LAST id — this asserts all
  // of them survive, in order.
  it("accumulates every id, in input order", async () => {
    captureStderr();
    captureExit();

    await parse(["jobs", "show-many", "job_a", "job_b", "job_c"]);

    expect(mockedRunJobsShowMany).toHaveBeenCalledTimes(1);
    expect(mockedRunJobsShowMany).toHaveBeenCalledWith(["job_a", "job_b", "job_c"], "pretty");
  });

  it("threads a single id as a singleton array", async () => {
    captureStderr();
    captureExit();

    await parse(["jobs", "show-many", "job_solo"]);

    expect(mockedRunJobsShowMany).toHaveBeenCalledWith(["job_solo"], "pretty");
  });

  it("carries -o json alongside the variadic ids", async () => {
    captureStderr();
    captureExit();

    await parse(["jobs", "show-many", "job_a", "job_b", "-o", "json"]);

    expect(mockedRunJobsShowMany).toHaveBeenCalledWith(["job_a", "job_b"], "json");
  });

  it("rejects an empty id element at parse time", async () => {
    const stderr = captureStderr();
    captureExit();

    await parse(["jobs", "show-many", "job_a", ""]);

    expect(mockedRunJobsShowMany).not.toHaveBeenCalled();
    expect(stderr.lines.join("")).toContain("id must not be empty");
  });
});
