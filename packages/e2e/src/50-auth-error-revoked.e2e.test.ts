// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Adversarial E2E case for the typed auth-error contract (issue #77 AC
 * criterion 8). Numeric prefix `50-` places this in the middle of the
 * E2E sequence — between the shared-session signin (`01-`) and the shared-
 * session signout (`99-`).
 *
 * This file uses `withFreshSession()` (NOT `getSharedSession()`) so its
 * deliberate token corruption is ISOLATED to a per-file subdirectory under
 * `<sandbox>/isolated-<id>/`. Sibling `getSharedSession()`-using files
 * (`01-`, `99-`) read the SHARED token at `<sandbox>/auth.token` written
 * by `globalSetup`, which this file never touches. AC #2 of #105:
 * adversarial isolation preserved — corruption does not leak.
 *
 * Validates the CLI error-message format on a deliberately-revoked token:
 *
 *   1. `withFreshSession()` performs a real isolated signin in `beforeAll`,
 *      leaving a valid bearer token on disk in the per-file isolated
 *      subdirectory (`<sandbox>/isolated-<id>/auth.token`). This is the
 *      SECOND of the run's two live signins (the first being globalSetup's
 *      shared signin).
 *   2. The test deliberately corrupts that on-disk isolated token by
 *      overwriting it with a string the gateway will reject.
 *   3. The test runs `ttctl profile show` (configured to read the isolated
 *      token via `TTCTL_CONFIG_FILE=<isolated config path>`). The mobile-
 *      gateway responds with `errors[0].extensions.code =
 *      'AUTHENTICATION_REQUIRED'` (gateway form) or HTTP 401 — both flow
 *      into `AuthRevokedError`.
 *   4. The CLI's `presentTtctlError` formatter emits the
 *      Error / Recovery / Code three-block layout to stderr; exit code 1.
 *
 * Skip-gate: `.skipIf(!e2eEnabled)` matches the suite-wide pattern. Without
 * `TTCTL_E2E=1`, the test reports SKIPPED; the harness's `withFreshSession`
 * setUp is a no-op (env-gated upstream), so no live signin happens either.
 */

import { writeFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, withFreshSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const session = withFreshSession();
const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("auth error: deliberately-revoked token (#77, isolated session)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = session.getContext();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "profile show on a corrupted token surfaces AuthRevokedError in the Error/Recovery/Code format",
    async () => {
      const { tokenPath } = session.getContext();

      // Replace the live-signed-in isolated token with a string the gateway
      // will reject. The token format is plain text + trailing newline (per
      // `saveAuthToken`), so a 32-char nonsense string keeps the same
      // shape and exercises the actual rejection path. Crucially, this
      // token is the ISOLATED one at `<sandbox>/isolated-<id>/auth.token`
      // — the SHARED token at `<sandbox>/auth.token` (consumed by
      // sibling `getSharedSession()`-using tests) is NOT touched.
      writeFileSync(tokenPath, "deliberately-invalid-token-77777\n", { mode: 0o600 });

      const result = await cli.run(["profile", "show"]);

      // Exit 1 — auth-related, user-actionable per `exitCodeForTtctlError`.
      expect(result.exitCode).toBe(1);

      // Error/Recovery/Code three-block layout. We assert the structural
      // pattern (block separators + key fields) rather than the exact
      // message text, since the live API may evolve its prose.
      expect(result.stderr).toMatch(/^Error: /m);
      expect(result.stderr).toMatch(/Recovery: Run `ttctl auth signin` to re-authenticate\./);
      expect(result.stderr).toContain("(Code: AUTH_REVOKED)");
    },
  );
});
