// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Opt-in crash-injection test that proves vitest's globalTeardown
 * (delegated through `globalSetup`'s returned function to
 * `runGlobalTeardown`) runs even when the worker fork is unrecoverably
 * killed by a signal that nothing inside the worker can catch or shim.
 *
 * Triggered ONLY when BOTH env vars are set:
 *
 *   TTCTL_E2E=1                — base opt-in (per `vitest.e2e.config.ts`)
 *   TTCTL_E2E_INJECT_CRASH=1   — crash-injection opt-in
 *
 * On default `pnpm test:e2e` runs (`TTCTL_E2E=1` only), the body is
 * skipped via `it.skipIf` — the file LOADS but the kill signal never
 * fires. On `pnpm test:e2e:crash-recovery` runs (both env vars), the
 * body fires, the worker dies, and `99-auth-signout` never executes
 * (the worker is already gone). The wrapper script (`scripts/run-crash-
 * recovery.mjs`) EXPECTS the non-zero exit and verifies cleanup via
 * `<sandbox>/.teardown-receipt.json`.
 *
 * Why SIGKILL instead of `process.exit(1)` or `throw`:
 *
 *   - `process.exit(1)` is shimmed by vitest 4: the call is converted
 *     to a synthetic test-failure error AND the worker continues
 *     running the next file. That tests "test failure → teardown still
 *     runs" (which is vitest's default behavior anyway), not the actual
 *     #171 contract ("worker death → teardown still runs").
 *   - `throw` is similar — caught by vitest's test runner.
 *   - SIGKILL is POSIX-uncatchable: the kernel terminates the process
 *     immediately, no userland code (including vitest's shims) runs. On
 *     Windows, `process.kill(pid, 'SIGKILL')` maps to TerminateProcess,
 *     which is similarly uncatchable. This is the closest portable
 *     proxy to a segfault / OOM-kill / hard timeout that #171 cited.
 *
 * Numeric prefix `98-` places this file between adversarial cases (50-
 * range) and the load-bearing terminal smoke (`99-auth-signout`). The
 * file-ordering invariant (alphabetical-by-filename, strictly increasing
 * prefixes) is preserved — `50 < 98 < 99`.
 */

import { describe, it } from "vitest";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";
const injectCrash = process.env["TTCTL_E2E_INJECT_CRASH"] === "1";

describe("crash injection — proves globalTeardown runs after unrecoverable worker death", () => {
  it.skipIf(!e2eEnabled || !injectCrash)(
    "SIGKILL on the worker fork — globalTeardown MUST still fire in the parent",
    () => {
      // Stderr marker so the crash-recovery wrapper can confirm this
      // path executed (distinct from "the suite skipped for some
      // unrelated reason"). The wrapper's stdio is inherited, so this
      // line surfaces in the wrapper's output before the worker dies.
      process.stderr.write(
        "[crash-injection] about to send SIGKILL to self (worker PID " + process.pid.toString() + ")\n",
      );
      // Synchronous, uncatchable termination of the worker fork. The
      // kernel sends SIGKILL; no shim, no signal handler, no atexit
      // hook runs. vitest's parent observes the abnormal exit and (per
      // #171's contract) still invokes the registered teardown function.
      process.kill(process.pid, "SIGKILL");
    },
  );
});
