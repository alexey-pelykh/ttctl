// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Cross-process integration test for the advisory write-back lock added by
 * issue #111 (FR-1 of the post-#107 follow-up batch).
 *
 * Strategy: fork two real OS-level Node processes via `child_process.fork()`,
 * each running `configLock-worker.ts` (compiled to
 * `dist/configLock-worker.js` by the e2e package's `tsc` build). Both
 * workers call `persistAuthToken` on the SAME config file. The lock MUST
 * serialize them — both succeed, neither corrupts the file, and exactly
 * one of the two tokens ends up persisted (last-writer-wins post-lock).
 *
 * Why fork() rather than vitest worker pool: vitest workers share Node's
 * module cache and don't simulate true OS-process race conditions.
 * `child_process.fork` gives us genuine separate processes — the same
 * mechanism that would race in production (CLI signin + long-running MCP
 * tool call). Per design doc §6b runtime view + §11 testing strategy.
 *
 * Cross-platform: runs on Linux, macOS, AND Windows — `proper-lockfile`'s
 * atomic-mkdir mechanism is portable, no POSIX-specific syscall.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, "..", "dist", "configLock-worker.js");

interface WorkerInvocation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runWorker(configPath: string, token: string, delayMs = 0): Promise<WorkerInvocation> {
  return new Promise<WorkerInvocation>((resolveRun, rejectRun) => {
    const child = fork(WORKER_PATH, [configPath, token, delayMs.toString()], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      rejectRun(err);
    });
    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal !== null ? -1 : 0);
      resolveRun({ exitCode, stdout, stderr });
    });
  });
}

interface WorkerSuccess {
  ok: true;
  token: string;
}

interface WorkerFailure {
  ok: false;
  token: string;
  error: string;
  code?: string;
  name?: string;
}

type WorkerResult = WorkerSuccess | WorkerFailure;

function parseLastJsonLine(stdout: string): WorkerResult {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error(`worker emitted no JSON output; stdout=${JSON.stringify(stdout)}`);
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error(`worker emitted no JSON output; stdout=${JSON.stringify(stdout)}`);
  return JSON.parse(last) as WorkerResult;
}

describe("configLock — cross-process race serialization", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-lock-cross-"));

    if (!existsSync(WORKER_PATH)) {
      throw new Error(
        `configLock worker not built at ${WORKER_PATH}. Run \`pnpm build\` (or \`pnpm --filter @ttctl/e2e build\`) before running this test.`,
      );
    }
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("two concurrent persistAuthToken processes serialize cleanly (no corruption, exactly one token wins)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    const T1 = "user_proc_aaa_111111111111111111111";
    const T2 = "user_proc_bbb_222222222222222222222";

    // Both forks start in parallel via Promise.all. The OS scheduler decides
    // which mkdir wins the race; the loser retries up to ≤1.25s. With
    // typical persist ≤200ms, both complete well within budget.
    const [r1, r2] = await Promise.all([runWorker(configPath, T1), runWorker(configPath, T2)]);

    // Both workers must exit 0 — neither saw LOCKED contention timeout.
    expect(r1.exitCode, `worker 1 stderr: ${r1.stderr}`).toBe(0);
    expect(r2.exitCode, `worker 2 stderr: ${r2.stderr}`).toBe(0);

    const j1 = parseLastJsonLine(r1.stdout);
    const j2 = parseLastJsonLine(r2.stdout);
    expect(j1.ok).toBe(true);
    expect(j2.ok).toBe(true);

    // File state — well-formed YAML, exactly one of T1/T2 persisted.
    const final = readFileSync(configPath, "utf8");
    expect(final).toMatch(/auth:/);
    expect(final).toMatch(/credentials:\s*op:\/\/Personal\/ttctl/);

    const hasT1 = final.includes(T1);
    const hasT2 = final.includes(T2);
    expect(hasT1 !== hasT2).toBe(true);

    // No leaked sibling lockfile.
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  }, 30_000);

  it("staged race (P2 starts ~50ms after P1) — same outcome: both succeed, file well-formed", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    const T1 = "user_staged_first_aaa_xxxxxxxxxxxx";
    const T2 = "user_staged_second_bbb_yyyyyyyyyyyy";

    // Stage the second worker so it observes contention deterministically:
    // P1 starts immediately, P2 starts after 50ms — by then P1 holds the
    // lock and P2 will retry.
    const [r1, r2] = await Promise.all([runWorker(configPath, T1, 0), runWorker(configPath, T2, 50)]);

    expect(r1.exitCode, `worker 1 stderr: ${r1.stderr}`).toBe(0);
    expect(r2.exitCode, `worker 2 stderr: ${r2.stderr}`).toBe(0);

    const final = readFileSync(configPath, "utf8");
    // P2 won: it ran AFTER P1 released the lock, so its write is the
    // last-writer-wins outcome. P1's token must NOT appear.
    expect(final).toMatch(new RegExp(`token:\\s*${T2}`));
    expect(final).not.toContain(T1);

    expect(existsSync(`${configPath}.lock`)).toBe(false);
  }, 30_000);

  it("file remains well-formed after concurrent persist (no truncated/half-written state)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    // Larger initial content with comments — concurrent writes that
    // interleaved or truncated would lose comment fidelity AND/OR fail to
    // re-parse as YAML.
    const original = [
      "# Top comment about TTCtl auth",
      "# Created 2026-05-09 — round-trip safe",
      "",
      "auth:",
      "  # Maintainer's 1Password vault reference",
      "  credentials: op://Personal/ttctl",
      "",
    ].join("\n");
    writeFileSync(configPath, original, { mode: 0o600 });

    const tokens = ["user_round_aaa_111", "user_round_bbb_222", "user_round_ccc_333"];
    const results = await Promise.all(tokens.map((t) => runWorker(configPath, t)));
    for (const r of results) {
      expect(r.exitCode, `worker stderr: ${r.stderr}`).toBe(0);
    }

    const final = readFileSync(configPath, "utf8");

    // Comments preserved (whichever winner ran, parseDocument+setIn keeps
    // header comments because the auth block is untouched).
    expect(final).toContain("# Top comment about TTCtl auth");
    expect(final).toContain("# Maintainer's 1Password vault reference");
    expect(final).toMatch(/credentials:\s*op:\/\/Personal\/ttctl/);

    // Exactly one token wins.
    const wins = tokens.filter((t) => final.includes(t)).length;
    expect(wins).toBe(1);
  }, 60_000);
});
