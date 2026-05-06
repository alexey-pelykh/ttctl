// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Captured shape of a lockfile on disk: the PID that holds it and the
 * ISO-8601 timestamp at which it was acquired. Persisted as a single-line
 * JSON object so the file is small enough to read atomically and human-
 * inspectable for diagnostics (`cat .tmp/e2e/.lock`).
 */
export interface LockState {
  pid: number;
  startedAt: string;
}

/**
 * Thrown when an `acquireLock` call refuses to claim the lock because an
 * apparently-live owner already holds it. `state` carries the on-disk
 * payload so the CLI surface can render an actionable error
 * ("PID N started at T — kill it or wait for it to finish").
 *
 * Distinguishable from the stale-PID auto-cleanup path, which logs a
 * warning to stderr but does NOT throw.
 */
export class LockfileError extends Error {
  override readonly name = "LockfileError";

  constructor(
    public readonly state: LockState,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Probe whether `pid` is alive. Uses `process.kill(pid, 0)` — a no-op
 * signal that exists for exactly this purpose.
 *
 * Cross-platform behavior:
 *
 *   - POSIX: `kill(pid, 0)` returns 0 if the PID is alive (same uid),
 *     throws ESRCH if dead, EPERM if the PID is alive but owned by a
 *     different uid (treat as alive — we don't own it but it's there).
 *   - Windows: `process.kill(pid, 0)` returns true if alive, throws an
 *     error otherwise. `process.kill` errors don't carry a stable `code`
 *     on Windows — we treat any throw as "dead" except EPERM (which on
 *     Windows means the process exists but we can't signal it, i.e. alive).
 *
 * The conservative direction is "alive": if we can't tell, refuse to
 * clear the lock and force the user to investigate. False-positive (think
 * a dead PID is alive) is recoverable (delete `.tmp/e2e/.lock` manually).
 * False-negative (think a live PID is dead and proceed) is what we MUST
 * avoid — it would let two harnesses race on the same jar.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

interface AcquireLockOptions {
  /**
   * Where to write the warning when a stale lock (dead PID) is auto-cleared.
   * Defaults to `process.stderr.write`. Tests inject a buffer; production
   * paths should leave this unset.
   */
  warn?: (message: string) => void;
  /**
   * Override the current PID. Tests use this to construct a deterministic
   * `LockState`. Production paths should leave this unset.
   */
  pid?: number;
  /**
   * Override the timestamp. Tests use this to assert the persisted shape.
   * Production paths should leave this unset.
   */
  now?: () => Date;
}

/**
 * Acquire the run-level lock at `path`.
 *
 * Behavior:
 *
 *   - If the file is absent: create the directory if needed, write a
 *     `LockState` JSON payload at mode 0600, return it.
 *   - If the file is present and the recorded PID is alive: throw
 *     `LockfileError` with an actionable message.
 *   - If the file is present but the recorded PID is dead: emit a warning,
 *     unlink the stale file, write a fresh `LockState`, return it.
 *   - If the file is present but malformed: treat as a corrupted lock —
 *     warn and overwrite. Defensive: a developer hand-edited the file.
 */
export function acquireLock(path: string, options: AcquireLockOptions = {}): LockState {
  const warn = options.warn ?? ((m: string) => process.stderr.write(m));
  const pid = options.pid ?? process.pid;
  const now = options.now ?? ((): Date => new Date());

  if (existsSync(path)) {
    const existing = readLockSafely(path);
    if (existing !== null && isPidAlive(existing.pid)) {
      throw new LockfileError(
        existing,
        `E2E lock at ${path} is held by PID ${existing.pid.toString()} (started ${existing.startedAt}). ` +
          `Refusing to start a concurrent E2E run. ` +
          `If that PID is gone, remove ${path} manually and retry.`,
      );
    }
    if (existing === null) {
      warn(`Warning: clearing malformed E2E lockfile at ${path}.\n`);
    } else {
      warn(`Warning: clearing stale E2E lockfile at ${path} (PID ${existing.pid.toString()} no longer alive).\n`);
    }
    try {
      unlinkSync(path);
    } catch {
      // Ignore — the writeFileSync below will overwrite either way.
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  const state: LockState = { pid, startedAt: now().toISOString() };
  writeFileSync(path, JSON.stringify(state) + "\n", { mode: 0o600 });
  return state;
}

/**
 * Best-effort release. Swallows ENOENT (already gone) and any other
 * filesystem error — a failed release is recoverable on the next run via
 * the stale-PID detection path. We deliberately do NOT throw; the caller
 * is typically `afterAll`, where a throw would mask the real test failure.
 */
export function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

/**
 * Read and parse the lockfile contents. Returns null if the file is
 * missing OR malformed (not valid JSON, missing fields, wrong types).
 * Callers treat null as "stale, overwrite".
 */
function readLockSafely(path: string): LockState | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<LockState>;
  if (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid <= 0) return null;
  if (typeof candidate.startedAt !== "string" || candidate.startedAt === "") return null;
  return { pid: candidate.pid, startedAt: candidate.startedAt };
}
