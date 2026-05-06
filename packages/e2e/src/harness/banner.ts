// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Pre-flight banner emitted once per process before any network call.
 *
 * The banner is a deliberate, eye-catching warning: the E2E harness signs
 * in to the live Toptal account, which can invalidate any concurrent
 * browser session the user has open. AC E4 requires the banner appear
 * BEFORE any network activity, which is why `withFreshSession`'s
 * `beforeAll` calls `printPreflightBanner()` as its very first step.
 *
 * Idempotency is handled by a module-scoped flag — calling
 * `printPreflightBanner()` repeatedly within the same Node process emits
 * exactly one banner. This matters when multiple test files each call
 * `withFreshSession()`; the user sees one warning at the start of the run.
 *
 * `resetBannerForTesting()` is exported for the unit test only. Production
 * code MUST NOT call it.
 */

let printed = false;

export interface PreflightBannerOptions {
  /**
   * Stream to write to. Defaults to `process.stderr`. Tests inject a
   * buffer to assert content; production callers should leave this unset.
   *
   * stderr (not stdout) is intentional: the banner is operator
   * communication, not test output. A test runner that captures stdout
   * for snapshot comparison should not see this in the snapshot.
   */
  stream?: NodeJS.WritableStream;
}

const BANNER_LINES: readonly string[] = [
  "",
  "================================================================================",
  "TTCtl E2E HARNESS",
  "================================================================================",
  "E2E will sign in to Toptal as the configured account.",
  "Any concurrent browser session may be invalidated.",
  "",
  "This run uses an isolated sandbox at .tmp/e2e/ — fixture .ttctl.yaml + token.",
  "Your working session at ~/.ttctl/auth.token will NOT be modified.",
  "================================================================================",
  "",
];

/**
 * Emit the pre-flight banner once per process. Subsequent calls are
 * no-ops within the same process. The first call wins; the stream chosen
 * by that first call is the one used.
 */
export function printPreflightBanner(options: PreflightBannerOptions = {}): void {
  if (printed) return;
  printed = true;
  const stream = options.stream ?? process.stderr;
  stream.write(BANNER_LINES.join("\n"));
}

/**
 * Reset the printed flag so a unit test can verify the once-per-process
 * semantics across multiple invocations. Production code MUST NOT call
 * this — a test that relies on side-effect ordering is fragile.
 */
export function resetBannerForTesting(): void {
  printed = false;
}
