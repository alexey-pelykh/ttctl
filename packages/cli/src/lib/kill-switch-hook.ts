// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  checkKillSwitch,
  formatKillSwitchMessage,
  KILL_SWITCH_DEFAULT_TIMEOUT_MS,
  readPackageVersion,
} from "@ttctl/core";

/**
 * CLI-side wire-up for the remote version-killed manifest (#312).
 *
 * Invoked from the root program's `preAction` hook (see `program.ts`).
 * Per AC 3:
 *   - Fetches the manifest at startup (synchronous-await, up to 3s).
 *   - Warns on match (stderr).
 *   - Refuses (exit non-zero) when `entry.action === "refuse"`.
 *   - Never blocks on fetch failure — fail-silent contract.
 *
 * The running version is resolved via `readPackageVersion(import.meta.url)`
 * from this module's location, which points at
 * `packages/cli/package.json` post-build. All workspace packages are
 * stamped to the same version at release time
 * (`pnpm -r exec npm version` in `.github/workflows/release.yml`), so
 * either the cli or the umbrella package's version is correct.
 *
 * Why synchronous (not fire-and-forget): the CLI is a short-lived
 * process. If the warning is printed asynchronously after the action's
 * output, it risks getting buried or missed. Synchronous-await before
 * the action runs ensures the warning is the first thing the user sees
 * when their version is flagged. Worst-case 3s latency (timeout cap);
 * typical 50-200ms against raw.githubusercontent.com.
 *
 * Exposed as a separate `preAction` hook (rather than mixed into the
 * existing one) so the existing hook stays sync — Commander runs
 * registered hooks in order, so the sync hook fires first (diagnostic
 * logger, dry-run capture, format mutex), then this async one.
 *
 * `exit` is parameterised for testability — production callers omit it
 * (defaults to `process.exit`); tests inject a spy that throws instead
 * of terminating the test runner.
 */
export interface KillSwitchHookOptions {
  /** Override for `process.exit`. Defaults to the real exit (refuse path). */
  exit?: (code: number) => never;
  /** Override for stderr writer. Defaults to `process.stderr.write`. */
  writeStderr?: (chunk: string) => void;
  /** Override the running version (default: read from this package's package.json). */
  version?: string;
  /** Override the manifest URL (default: project raw.githubusercontent.com URL). */
  url?: string;
  /** Override the timeout (default: `KILL_SWITCH_DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Injected fetch (default: global). Tests pass a mock. */
  fetchFn?: typeof globalThis.fetch;
}

export async function runKillSwitchAtStartup(opts: KillSwitchHookOptions = {}): Promise<void> {
  const writeStderr =
    opts.writeStderr ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    });
  const exit =
    opts.exit ??
    ((code: number): never => {
      process.exit(code);
    });
  const version = opts.version ?? readPackageVersion(import.meta.url);

  const result = await checkKillSwitch({
    version,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    timeoutMs: opts.timeoutMs ?? KILL_SWITCH_DEFAULT_TIMEOUT_MS,
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
  });

  if (result.status !== "match") {
    // disabled | no-match | fetch-failed — all silent per fail-silent
    // contract. Diagnostic logging of fetch-failed is intentionally
    // omitted to avoid noise in restrictive networks (corporate, CI,
    // offline laptops); users can flip TTCTL_DEBUG_CONFIG to inspect
    // the configWriter taxonomy but kill-switch deliberately stays
    // out of that surface.
    return;
  }

  writeStderr(formatKillSwitchMessage({ toolName: "ttctl", version, entry: result.entry }));

  if (result.entry.action === "refuse") {
    exit(1);
  }
}
