// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KillSwitchEntry } from "@ttctl/core";

import { scheduleMcpKillSwitch } from "../kill-switch-hook.js";
import { buildServer } from "../server.js";

/**
 * Tests for the MCP-side kill-switch wire-up (#312, AC 4).
 *
 * Two layers:
 *   1. `scheduleMcpKillSwitch` unit tests — fire-and-forget at startup,
 *      ~24h refetch loop, fail-silent on every error path.
 *   2. `buildServer` integration test — verifies the hook is wired in,
 *      using the injectable `opts.killSwitch` option.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("scheduleMcpKillSwitch (MCP fire-and-forget hook)", () => {
  let stderrChunks: string[];
  const writeStderr = (chunk: string): void => {
    stderrChunks.push(chunk);
  };

  beforeEach(() => {
    stderrChunks = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits stderr WARNING when running version matches a manifest entry", async () => {
    const entry: KillSwitchEntry = {
      version_spec: "0.1.0",
      reason: "Toptal rotated hashes",
      action: "warn",
      as_of: "2026-05-15",
    };
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: [entry] }));

    const handle = scheduleMcpKillSwitch({
      version: "0.1.0",
      fetchFn,
      writeStderr,
      refetchIntervalMs: 60_000,
    });
    await handle.initialCheck;
    handle.stop();

    const allOutput = stderrChunks.join("");
    expect(allOutput).toContain("[WARNING]");
    expect(allOutput).toContain("ttctl mcp 0.1.0");
    expect(allOutput).toContain(entry.reason);
  });

  it("DOES NOT exit even when manifest entry has action=refuse (MCP-side asymmetry)", async () => {
    // The "always warn, never refuse" contract for MCP: we surface the
    // banner but never kill the daemon. Verified by the absence of
    // process.exit calls + presence of the warning banner.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit should NOT be called in MCP");
    }) as never);

    const entry: KillSwitchEntry = {
      version_spec: "*",
      reason: "Toptal sent C&D",
      action: "refuse",
      as_of: "2026-05-15",
    };
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: [entry] }));

    const handle = scheduleMcpKillSwitch({
      version: "0.1.0",
      fetchFn,
      writeStderr,
      refetchIntervalMs: 60_000,
    });
    await handle.initialCheck;
    handle.stop();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain("[REFUSED]");
  });

  it("emits NO stderr on fetch failure (404 → silent)", async () => {
    const fetchFn = vi.fn(async () => new Response("not found", { status: 404 }));

    const handle = scheduleMcpKillSwitch({
      version: "0.1.0",
      fetchFn,
      writeStderr,
      refetchIntervalMs: 60_000,
    });
    await handle.initialCheck;
    handle.stop();

    expect(stderrChunks).toHaveLength(0);
  });

  it("schedules the 24h refetch via setIntervalFn injection (verifiable without waiting)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: [] }));
    const setIntervalFn = vi.fn((cb: () => void, ms: number) => {
      // Return a fake handle with the expected shape. We do NOT actually
      // schedule — the refetch loop's correctness is tested via the
      // unit tests above (single runOnce call); we just verify the
      // setInterval was wired at the expected interval.
      return { unref: vi.fn(), cb, ms } as unknown as ReturnType<typeof setInterval>;
    });

    const handle = scheduleMcpKillSwitch({
      version: "0.1.0",
      fetchFn,
      writeStderr,
      setIntervalFn: setIntervalFn as unknown as typeof globalThis.setInterval,
      refetchIntervalMs: 24 * 60 * 60 * 1000,
    });
    await handle.initialCheck;
    handle.stop();

    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    const [, ms] = setIntervalFn.mock.calls[0] as [() => void, number];
    expect(ms).toBe(24 * 60 * 60 * 1000);
  });

  it("calls .unref() on the timer handle so Node exit semantics are preserved", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: [] }));
    const unrefSpy = vi.fn();
    const setIntervalFn = vi.fn((cb: () => void, ms: number) => {
      return { unref: unrefSpy, cb, ms } as unknown as ReturnType<typeof setInterval>;
    });

    const handle = scheduleMcpKillSwitch({
      version: "0.1.0",
      fetchFn,
      writeStderr,
      setIntervalFn: setIntervalFn as unknown as typeof globalThis.setInterval,
      refetchIntervalMs: 1000,
    });
    await handle.initialCheck;
    handle.stop();

    expect(unrefSpy).toHaveBeenCalledTimes(1);
  });
});

describe("buildServer kill-switch wiring (AC 4 integration)", () => {
  let tmpRoot: string;
  let savedEnv: { TTCTL_CONFIG_FILE?: string; HOME?: string; USERPROFILE?: string };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-mcp-killswitch-test-"));
    savedEnv = {
      ...(process.env["TTCTL_CONFIG_FILE"] !== undefined
        ? { TTCTL_CONFIG_FILE: process.env["TTCTL_CONFIG_FILE"] }
        : {}),
      ...(process.env["HOME"] !== undefined ? { HOME: process.env["HOME"] } : {}),
      ...(process.env["USERPROFILE"] !== undefined ? { USERPROFILE: process.env["USERPROFILE"] } : {}),
    };
    delete process.env["TTCTL_CONFIG_FILE"];
    process.env["HOME"] = tmpRoot;
    process.env["USERPROFILE"] = tmpRoot;
  });

  afterEach(() => {
    if (savedEnv.TTCTL_CONFIG_FILE !== undefined) process.env["TTCTL_CONFIG_FILE"] = savedEnv.TTCTL_CONFIG_FILE;
    else delete process.env["TTCTL_CONFIG_FILE"];
    if (savedEnv.HOME !== undefined) process.env["HOME"] = savedEnv.HOME;
    else delete process.env["HOME"];
    if (savedEnv.USERPROFILE !== undefined) process.env["USERPROFILE"] = savedEnv.USERPROFILE;
    else delete process.env["USERPROFILE"];
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("buildServer fires the kill-switch fetch at construction time", async () => {
    const configPath = join(tmpRoot, "captured.yaml");
    writeFileSync(configPath, "auth:\n  token: smoke-token\n", { mode: 0o600 });

    const fetchFn = vi.fn(async () => jsonResponse({ schema_version: 1, known_broken: [] }));
    const setIntervalFn = vi.fn(
      (cb: () => void, ms: number) => ({ unref: vi.fn(), cb, ms }) as unknown as ReturnType<typeof setInterval>,
    );

    buildServer({
      configPath,
      killSwitch: {
        fetchFn,
        setIntervalFn: setIntervalFn as unknown as typeof globalThis.setInterval,
        writeStderr: vi.fn(),
        version: "0.1.0",
      },
    });

    // Give the detached fire-and-forget Promise one microtask to schedule
    // the fetch — the resolved fetchFn returns a synchronously-completed
    // Response, so the chain stabilises within a single tick.
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
  });

  it("buildServer with killSwitch: null skips the check entirely (opt-out)", () => {
    const configPath = join(tmpRoot, "captured.yaml");
    writeFileSync(configPath, "auth:\n  token: smoke-token\n", { mode: 0o600 });

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    buildServer({ configPath, killSwitch: null });

    // No setInterval call from the kill-switch path. (Other code paths
    // in buildServer may use setInterval indirectly; we assert this
    // specific opt-out by checking the count didn't grow on this
    // construction.) Cheap proxy: the function was never called by us.
    // To be precise we'd snapshot, but the MCP SDK does not currently
    // schedule timers in buildServer, so 0 calls is the expected baseline.
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
