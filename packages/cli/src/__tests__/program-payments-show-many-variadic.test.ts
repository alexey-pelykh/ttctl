// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the `payments show-many` action handler so the parse path runs in
// isolation — no auth resolution, no service/network call. The assertion is
// purely on what Commander threads into the action.
vi.mock("../commands/payments/show-many.js", () => ({
  runPaymentsShowMany: vi.fn(),
}));

import { runPaymentsShowMany } from "../commands/payments/show-many.js";
import { buildProgram } from "../program.js";

const mockedRunPaymentsShowMany = vi.mocked(runPaymentsShowMany);

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

describe("payments show-many variadic argument parsing", () => {
  beforeEach(() => {
    mockedRunPaymentsShowMany.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The load-bearing regression: a custom parser on a variadic `<id...>` is
  // invoked once per value with the accumulator threaded as `previous`. A
  // single-value parser would yield only the LAST id — this asserts all of
  // them survive, in order.
  it("accumulates every id, in input order", async () => {
    captureStderr();
    captureExit();

    await parse(["payments", "show-many", "pmt_a", "pmt_b", "pmt_c"]);

    expect(mockedRunPaymentsShowMany).toHaveBeenCalledTimes(1);
    expect(mockedRunPaymentsShowMany).toHaveBeenCalledWith(["pmt_a", "pmt_b", "pmt_c"], "pretty");
  });

  it("threads a single id as a singleton array", async () => {
    captureStderr();
    captureExit();

    await parse(["payments", "show-many", "pmt_solo"]);

    expect(mockedRunPaymentsShowMany).toHaveBeenCalledWith(["pmt_solo"], "pretty");
  });

  it("carries -o json alongside the variadic ids", async () => {
    captureStderr();
    captureExit();

    await parse(["payments", "show-many", "pmt_a", "pmt_b", "-o", "json"]);

    expect(mockedRunPaymentsShowMany).toHaveBeenCalledWith(["pmt_a", "pmt_b"], "json");
  });

  it("rejects an empty id element at parse time", async () => {
    const stderr = captureStderr();
    captureExit();

    await parse(["payments", "show-many", "pmt_a", ""]);

    expect(mockedRunPaymentsShowMany).not.toHaveBeenCalled();
    expect(stderr.lines.join("")).toContain("id must not be empty");
  });
});
