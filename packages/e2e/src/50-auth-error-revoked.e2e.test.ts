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
 * (`01-`, `99-`) read the SHARED token at `<sandbox>/.ttctl.yaml` written
 * by `globalSetup`, which this file never touches. AC #2 of #105:
 * adversarial isolation preserved — corruption does not leak.
 *
 * Validates the CLI error-message format on a deliberately-revoked token:
 *
 *   1. `withFreshSession()` performs a real isolated signin in `beforeAll`,
 *      leaving a valid bearer token in the per-file isolated YAML config
 *      (`<sandbox>/isolated-<id>/.ttctl.yaml` — Form D shape post-#107).
 *      This is the SECOND of the run's two live signins (the first being
 *      globalSetup's shared signin).
 *   2. The test deliberately corrupts that on-disk isolated token by
 *      overwriting the YAML's `auth.token` field with a string the gateway
 *      will reject. We use `yaml.parseDocument` + `setIn` to preserve the
 *      surrounding `auth.credentials` field — same primitive the production
 *      code uses for write-back.
 *   3. The test runs `ttctl profile show` (configured to read the isolated
 *      config via `TTCTL_CONFIG_FILE=<isolated config path>`). The mobile-
 *      gateway responds with `errors[0].extensions.code =
 *      'AUTHENTICATION_REQUIRED'` (gateway form) or HTTP 401 — both flow
 *      into `AuthRevokedError`.
 *   4. The CLI's `presentTtctlError` formatter emits the
 *      Error / Recovery / Code three-block layout to stderr; exit code 1.
 *
 * Skip-gate: `.skipIf(!e2eEnabled)` matches the suite-wide pattern.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { parseDocument } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, withFreshSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const session = withFreshSession();
const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("auth error: deliberately-revoked token (isolated session)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = session.getContext();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "profile show on a corrupted token surfaces AuthRevokedError in the Error/Recovery/Code format",
    async () => {
      const { sandboxConfigPath } = session.getContext();

      // Replace the live-signed-in isolated `auth.token` with a string the
      // gateway will reject. yaml.parseDocument + setIn preserves the
      // surrounding `auth.credentials` field — mirrors what the production
      // `persistAuthToken` does. Mode preserved at 0o600.
      const raw = readFileSync(sandboxConfigPath, "utf8");
      const doc = parseDocument(raw, { strict: false });
      doc.setIn(["auth", "token"], doc.createNode("deliberately-invalid-token-77777"));
      writeFileSync(sandboxConfigPath, String(doc), { mode: 0o600 });

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
