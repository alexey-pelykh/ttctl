// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KillSwitchEntry } from "@ttctl/core";

import { runKillSwitchAtStartup } from "../lib/kill-switch-hook.js";

/**
 * Tests for the CLI's preAction kill-switch hook (#312, AC 3).
 *
 * The hook is exercised directly via `runKillSwitchAtStartup` rather than
 * through the full Commander program — the program-level wiring is one
 * line (`.hook("preAction", async () => { await runKillSwitchAtStartup(); })`)
 * and its correctness is verified by the unit tests below.
 *
 * Tests inject `fetchFn`, `exit`, and `writeStderr` to avoid actually
 * hitting the network, terminating the test runner, or polluting stderr.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("runKillSwitchAtStartup (CLI preAction hook)", () => {
  let stderrChunks: string[];
  let exitCode: number | null;
  const exit = vi.fn((code: number) => {
    exitCode = code;
    throw new Error(`__exit_${code.toString()}__`);
  }) as unknown as (code: number) => never;
  const writeStderr = (chunk: string): void => {
    stderrChunks.push(chunk);
  };

  beforeEach(() => {
    stderrChunks = [];
    exitCode = null;
    exit.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits NO stderr and does NOT exit when manifest is empty (no-match)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: [] }));
    await runKillSwitchAtStartup({ version: "0.1.0", fetchFn, exit, writeStderr });
    expect(stderrChunks).toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();
  });

  it("emits NO stderr and does NOT exit when running version is not in known_broken", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        schema_version: 1,
        known_broken: [{ version_spec: "<0.1.0", reason: "old", action: "warn", as_of: "2026-05-15" }],
      }),
    );
    await runKillSwitchAtStartup({ version: "0.2.0", fetchFn, exit, writeStderr });
    expect(stderrChunks).toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();
  });

  it("emits stderr WARNING but does NOT exit when match action=warn", async () => {
    const entry: KillSwitchEntry = {
      version_spec: "0.1.0",
      reason: "Toptal rotated mobile-gateway hashes 2026-05-15",
      action: "warn",
      as_of: "2026-05-15",
    };
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: [entry] }));

    await runKillSwitchAtStartup({ version: "0.1.0", fetchFn, exit, writeStderr });

    expect(stderrChunks.length).toBeGreaterThan(0);
    const allOutput = stderrChunks.join("");
    expect(allOutput).toContain("[WARNING]");
    expect(allOutput).toContain("ttctl 0.1.0");
    expect(allOutput).toContain(entry.reason);
    expect(exit).not.toHaveBeenCalled();
  });

  it("emits stderr REFUSED and exits non-zero when match action=refuse", async () => {
    const entry: KillSwitchEntry = {
      version_spec: "*",
      reason: "Toptal sent C&D",
      action: "refuse",
      as_of: "2026-05-15",
    };
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: [entry] }));

    await expect(runKillSwitchAtStartup({ version: "0.1.0", fetchFn, exit, writeStderr })).rejects.toThrow(
      "__exit_1__",
    );

    const allOutput = stderrChunks.join("");
    expect(allOutput).toContain("[REFUSED]");
    expect(exit).toHaveBeenCalledWith(1);
    expect(exitCode).toBe(1);
  });

  it("NEVER blocks on fetch failure (404 → silent)", async () => {
    const fetchFn = vi.fn(async () => new Response("not found", { status: 404 }));
    await runKillSwitchAtStartup({ version: "0.1.0", fetchFn, exit, writeStderr });
    expect(stderrChunks).toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();
  });

  it("NEVER blocks on fetch failure (timeout → silent)", async () => {
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    await runKillSwitchAtStartup({ version: "0.1.0", fetchFn, exit, writeStderr, timeoutMs: 25 });

    expect(stderrChunks).toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();
  });

  it("NEVER blocks on parse failure (malformed JSON → silent)", async () => {
    const fetchFn = vi.fn(async () => new Response("not json at all", { status: 200 }));
    await runKillSwitchAtStartup({ version: "0.1.0", fetchFn, exit, writeStderr });
    expect(stderrChunks).toHaveLength(0);
    expect(exit).not.toHaveBeenCalled();
  });
});
