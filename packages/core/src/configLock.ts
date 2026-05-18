// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import lockfile from "proper-lockfile";

import { ConfigError } from "./config.js";

/**
 * Handle returned by `acquireConfigLock`. The caller MUST `release()` the
 * handle when done — the recommended pattern is `try { ... } finally { await
 * handle.release(); }` so the lock is released on every error path
 * (read-fail, parse-fail, mtime-drift, write-fail, rename-fail, post-rename
 * verify-fail).
 *
 * `release` is idempotent in practice — `proper-lockfile` registers an
 * exit-handler via `signal-exit` that auto-cleans the lock on process death,
 * so a missed release doesn't strand the lock across runs. But explicit
 * release is still required for the in-process retry semantics: a deferred
 * release means the next `acquireConfigLock` in the SAME process would see
 * the lock held by itself and deadlock.
 */
export interface ConfigLockHandle {
  release: () => Promise<void>;
}

/**
 * Wall-clock budget for `acquireConfigLock` contention timeout. The macOS /
 * Linux baseline configuration produces ≤1.0s total wait: 5 retries × max
 * 250ms backoff = 1250ms ceiling, but with `factor: 1` the backoff stays
 * flat at `minTimeout`-`maxTimeout` so the practical envelope is closer to
 * 5×100ms to 5×250ms = 500ms-1250ms with jitter. Tightens the upper bound
 * below NFR-LOCK-1's 1.0s plan on the OSes the NFR was authored against.
 * Windows operates on a 3x carve-out — see the Windows section below.
 *
 * Windows carve-out (#362): on Windows CI runners (Azure-hosted, shared,
 * higher scheduler variance than Linux/macOS), the 1.0s envelope is too
 * tight for the cross-process serialization test pair in
 * `configLock-cross-process.test.ts` — both `staged race` and the 2-worker
 * `serialize cleanly` variant have flaked when the second worker loses its
 * scheduling slice long enough for its mkdir contention budget to expire
 * before the first worker releases. Sibling prior art: #171, #180, #270
 * (all Windows-specific timing fixes for the same `persistAuthToken`
 * cross-process write path). Extending Windows to ~3.0s (15 retries × 100-
 * 250ms = 1500-3750ms practical envelope) absorbs the variance without
 * changing the NFR-LOCK-1 invariant on the OSes where it applies.
 *
 * Production impact: a real LOCKED contention surfaces in ~3s on Windows
 * (vs ~1s elsewhere). The user-facing message already says "typically ≤2s"
 * — the 3s ceiling does not contradict it, and contended writes are rare
 * (CLI signin + concurrent MCP tool call on the same config).
 */
const WINDOWS_BUDGET_MULTIPLIER = process.platform === "win32" ? 3 : 1;

const LOCK_RETRY_OPTIONS = {
  retries: 5 * WINDOWS_BUDGET_MULTIPLIER,
  factor: 1,
  minTimeout: 100,
  maxTimeout: 250,
};

/**
 * Stale-lock threshold. If a lockfile is older than this without a refresh,
 * `proper-lockfile` treats it as abandoned and overrides it. Defends against
 * a crashed CLI/MCP that didn't release its lock on exit. The exit-handler
 * via `signal-exit` is best-effort; the stale threshold is the second line.
 *
 * Set to 10s — long enough that a slow signin (network-bound ~2-5s) won't
 * trip the threshold, short enough that a stranded lock from a SIGKILL'd
 * process clears within a single user-perceptible retry window.
 */
const LOCK_STALE_MS = 10_000;

/**
 * Acquire an advisory exclusive lock for `configPath`.
 *
 * Implementation: `proper-lockfile` creates `<configPath>.lock` as a
 * sibling DIRECTORY via atomic `mkdir(2)`. The `mkdir` syscall is atomic on
 * ext4, APFS, NTFS, and any other filesystem with POSIX-equivalent
 * semantics — `EEXIST` is the contention signal.
 *
 * Why sibling-lockfile and NOT self-lock: the atomic-rename pattern in
 * `performYamlMutation` swaps the inode at `<configPath>` mid-operation. A
 * `flock(fd)` on the original inode does NOT survive the rename and a
 * concurrent locker on the post-rename inode sees no contention. The
 * sibling pattern sidesteps this — the `.lock` directory's existence is the
 * lock signal, independent of the config file's inode.
 *
 * Cross-platform: works identically on Linux/macOS/Windows — `mkdir`-based
 * atomic creation is portable. No Windows no-op needed (in contrast to the
 * existing POSIX-mode logic in `loadConfigFile` and `performYamlMutation`,
 * which IS Windows-skipped because mode bits aren't meaningful).
 *
 * Contention: ≤1.0s wall-clock budget per `LOCK_RETRY_OPTIONS` on macOS /
 * Linux, ≤3.0s on Windows (Windows scheduler-variance carve-out — see
 * `LOCK_RETRY_OPTIONS` JSDoc + #362). On timeout, throws
 * `ConfigError(LOCKED)` naming the path and suggesting retry — never blocks
 * indefinitely.
 *
 * `realpath: false` skips proper-lockfile's pre-flight `realpath()` check.
 * The caller has already resolved `configPath` to an absolute, symlink-free
 * path via `assertSafePath`, AND the config file may not exist yet (e.g.,
 * the lock is acquired BEFORE the stat baseline that throws ENOENT). With
 * `realpath: true` (the library default), a missing file would surface as
 * an opaque proper-lockfile error before our own ENOENT path runs.
 */
export async function acquireConfigLock(configPath: string): Promise<ConfigLockHandle> {
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(configPath, {
      stale: LOCK_STALE_MS,
      retries: LOCK_RETRY_OPTIONS,
      realpath: false,
    });
  } catch (err) {
    // proper-lockfile throws an Error with a `code` property of "ELOCKED"
    // when contention exhausts retries. Surface as ConfigError(LOCKED) so
    // CLI/MCP error renderers can branch on the code rather than the
    // library-specific marker.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOCKED") {
      throw new ConfigError(
        `Refusing to acquire config lock at ${configPath}.lock: another ttctl process holds it. ` +
          `Wait for it to finish (CLI signin / MCP tool call typically ≤2s) and retry.`,
        "LOCKED",
        configPath,
      );
    }
    // Any other error (EACCES on the parent dir, EROFS, etc.) — surface as
    // PERMISSION so the caller can branch on it. Lock acquisition is
    // mechanically a write to the parent directory, so permission errors
    // are the natural failure mode.
    throw new ConfigError(
      `Cannot acquire config lock at ${configPath}.lock: ${(err as Error).message}`,
      "PERMISSION",
      configPath,
    );
  }
  return { release };
}
