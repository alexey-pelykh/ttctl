// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Crash-recovery harness for #171.
 *
 * Spawns the E2E suite with `TTCTL_E2E=1 TTCTL_E2E_INJECT_CRASH=1`. That
 * triggers `98-crash-injection.e2e.test.ts` to call `process.exit(1)` in
 * the worker fork. vitest reports the run as failed (non-zero exit), and
 * the load-bearing claim of #171 is that `globalSetup`'s returned
 * teardown function (delegating to `runGlobalTeardown`) STILL fires in
 * the parent process despite the worker abnormal exit.
 *
 * Verification primitive is `<sandbox>/.teardown-receipt.json`:
 *
 *   - PRESENT + `succeeded: true` + `cleared: true` → teardown ran and
 *     successfully removed the auth.token field. PASS.
 *   - PRESENT + `cleared: false` → teardown ran but clearAuthToken
 *     failed. FAIL (clearAuthToken regression).
 *   - ABSENT → teardown did NOT run. FAIL (vitest globalTeardown
 *     contract broken — the bug #171 was filed against).
 *
 * Additionally, the sandbox `.ttctl.yaml` is re-parsed; if the auth.token
 * field is still present, that's a stronger FAIL (the receipt's
 * `cleared` flag is a self-report; the YAML inspection is independent
 * evidence).
 *
 * Exit codes (mapped 1:1 in the README's troubleshooting):
 *
 *   0 — verified: teardown ran, token cleared
 *   2 — vitest exited 0 (the crash test was supposed to crash; it didn't)
 *   3 — receipt file missing (globalTeardown did not run — the bug)
 *   4 — receipt records cleared=false (clearAuthToken failed)
 *   5 — sandbox config still has auth.token (independent evidence of failure)
 *   6 — receipt malformed (couldn't parse JSON, wrong shape)
 *
 * The script does NOT require live Toptal credentials by itself — but
 * `globalSetup` will throw on credential resolution if none are
 * available, in which case `runGlobalTeardown`'s try/catch around
 * setup-failure-with-lock-release fires and the rest of the harness
 * never starts. That's a `setup failed before crash injection` path; the
 * wrapper surfaces vitest's nonzero exit and the receipt absence as exit
 * code 3, which is the correct signal (teardown didn't run because setup
 * threw first).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const e2ePackageRoot = resolve(__dirname, "..");
const repoRoot = resolve(e2ePackageRoot, "..", "..");
const sandboxDir = join(repoRoot, ".tmp", "e2e");
const receiptPath = join(sandboxDir, ".teardown-receipt.json");
const sandboxConfigPath = join(sandboxDir, ".ttctl.yaml");

process.stderr.write(`[crash-recovery] repo root      : ${repoRoot}\n`);
process.stderr.write(`[crash-recovery] receipt path   : ${receiptPath}\n`);
process.stderr.write(`[crash-recovery] sandbox config : ${sandboxConfigPath}\n`);

// Step 1: clear stale receipt so the post-mortem isn't confused by a
// previous run. ENOENT is fine (no prior run).
if (existsSync(receiptPath)) {
  unlinkSync(receiptPath);
  process.stderr.write(`[crash-recovery] removed stale receipt\n`);
}

// Step 2: run vitest with crash injection. Invoke the package-local
// `test:e2e` script directly (no turbo) so the wrapper's exit code maps
// 1:1 to vitest's exit code. `stdio: "inherit"` so the developer sees
// the live test output in real time.
const result = spawnSync("pnpm", ["test:e2e"], {
  cwd: e2ePackageRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    TTCTL_E2E: "1",
    TTCTL_E2E_INJECT_CRASH: "1",
  },
});

// Step 3: vitest MUST have exited non-zero — the crash test was supposed
// to crash. A zero exit means either the file was skipped (env-gate
// wrong) or the crash didn't actually happen, neither of which proves
// the regression-detection contract.
if (result.status === 0) {
  process.stderr.write(`[crash-recovery] FAIL: vitest exited 0 — the crash test did not actually crash. exit 2.\n`);
  process.exit(2);
}

// Step 4: receipt file MUST exist. Its absence is the strongest signal
// that globalTeardown did not run.
if (!existsSync(receiptPath)) {
  process.stderr.write(
    `[crash-recovery] FAIL: receipt file missing at ${receiptPath} — globalTeardown did not run. exit 3.\n`,
  );
  process.exit(3);
}

// Step 5: parse + validate receipt shape.
let receipt;
try {
  const raw = readFileSync(receiptPath, "utf8");
  receipt = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`[crash-recovery] FAIL: receipt file unparseable: ${err.message}. exit 6.\n`);
  process.exit(6);
}

if (typeof receipt !== "object" || receipt === null) {
  process.stderr.write(`[crash-recovery] FAIL: receipt is not an object. exit 6.\n`);
  process.exit(6);
}

if (receipt.cleared !== true) {
  process.stderr.write(`[crash-recovery] FAIL: receipt.cleared is not true: ${JSON.stringify(receipt)}. exit 4.\n`);
  process.exit(4);
}

// Step 6: independent evidence — re-parse the sandbox YAML and confirm
// the auth.token field is actually gone. The receipt is a self-report;
// this is the external check.
if (existsSync(sandboxConfigPath)) {
  const rawConfig = readFileSync(sandboxConfigPath, "utf8");
  const parsed = parseYaml(rawConfig);
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.auth &&
    typeof parsed.auth === "object" &&
    "token" in parsed.auth
  ) {
    process.stderr.write(`[crash-recovery] FAIL: sandbox config still has auth.token after teardown. exit 5.\n`);
    process.exit(5);
  }
} else {
  process.stderr.write(
    `[crash-recovery] note: sandbox config missing at ${sandboxConfigPath} — globalSetup likely failed before token write. Treating as cleared.\n`,
  );
}

process.stderr.write(
  `[crash-recovery] OK: globalTeardown ran after worker crash (receipt.ranAt=${receipt.ranAt}); token cleared.\n`,
);
process.exit(0);
