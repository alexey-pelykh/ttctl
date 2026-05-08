// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Final file in the E2E sequence (numeric prefix `99-`). Runs `ttctl auth
 * signout` against the SHARED session that `globalSetup` established at
 * run start, then asserts the post-state.
 *
 * Must run LAST: signout removes the auth.token field from the sandbox
 * config, which any sibling `getSharedSession()`-using file relies on.
 * The `BaseSequencer` pin in `vitest.e2e.config.ts` + the `99-` numeric
 * prefix enforce this ordering. Removing either invariant would let
 * signout race ahead of sibling tests, breaking the read-side cases (e.g.
 * `01-auth-signin`'s `profile show`).
 *
 * AC #6 of #105 (post-#107 shape): after this file runs, the auth.token
 * field is REMOVED from the sandbox YAML AND `ttctl auth status` reports
 * invalid. globalSetup's teardown ALSO clears the token defensively
 * (idempotent), so there's no race on cleanup if this file was skipped.
 */

import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("auth signout (live Toptal, shared session)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "signout: ttctl auth signout exits 0; sandbox config has no auth.token; subsequent auth status reports no session",
    async () => {
      const { sandboxConfigPath } = getSharedSession();

      // The shared-session signout invocation. Globalsetup's teardown also
      // clears the token, but only AFTER all tests finish — by that point
      // a `getSharedSession`-using file would have already failed if this
      // test didn't run signout first. The CLI invocation here IS the
      // logical signout; the cleanup in teardown is defensive.
      const signoutResult = await cli.run(["auth", "signout"]);
      expect(signoutResult.exitCode).toBe(0);

      // auth.token field gone (signout's contract: remove the field, not
      // empty it). We re-read the YAML and assert the field is absent.
      const raw = readFileSync(sandboxConfigPath, "utf8");
      const parsed = parseYaml(raw) as { auth?: Record<string, unknown> };
      expect(parsed.auth).toBeDefined();
      expect("token" in (parsed.auth ?? {})).toBe(false);

      // Status now reports invalid (exit 1 — no-session branch).
      const statusAfter = await cli.run(["auth", "status"]);
      expect(statusAfter.exitCode).toBe(1);
      expect(statusAfter.stdout).toMatch(/no session|session expired/i);
    },
  );
});
