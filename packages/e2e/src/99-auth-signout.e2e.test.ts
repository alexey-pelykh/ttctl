// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Final file in the E2E sequence (numeric prefix `99-`). Runs `ttctl auth
 * signout` against the SHARED session that `globalSetup` established at
 * run start, then asserts the post-state.
 *
 * Must run LAST: signout deletes the shared session token, which any
 * sibling `getSharedSession()`-using file relies on. The `BaseSequencer`
 * pin in `vitest.e2e.config.ts` + the `99-` numeric prefix enforce this
 * ordering. Removing either invariant would let signout race ahead of
 * sibling tests, breaking the read-side cases (e.g. `01-auth-signin`'s
 * `profile show`).
 *
 * AC #6 of #105: after this file runs, the token is deleted AND
 * `ttctl auth status` reports invalid. globalSetup's teardown ALSO unlinks
 * the token defensively (idempotent ENOENT swallow), so there's no race on
 * cleanup if this file was skipped.
 */

import { existsSync } from "node:fs";

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
    "signout: ttctl auth signout exits 0; subsequent auth status reports no session; token deleted",
    async () => {
      const { tokenPath } = getSharedSession();

      // The shared-session signout invocation. Globalsetup's teardown also
      // unlinks the token, but only AFTER all tests finish — by that point
      // a `getSharedSession`-using file would have already failed if this
      // test didn't run signout first. The CLI invocation here IS the
      // logical signout; the cleanup in teardown is defensive.
      const signoutResult = await cli.run(["auth", "signout"]);
      expect(signoutResult.exitCode).toBe(0);

      // Token gone (signout's contract: idempotent unlink).
      expect(existsSync(tokenPath)).toBe(false);

      // Status now reports invalid (exit 1 — no-session branch).
      const statusAfter = await cli.run(["auth", "status"]);
      expect(statusAfter.exitCode).toBe(1);
      // Tolerate either "No session found" (no-session) or "Session
      // expired" (session-expired) — both are user-equivalent and the AC
      // says "shows 'not signed in' (or equivalent)".
      expect(statusAfter.stdout).toMatch(/no session|session expired/i);
    },
  );
});
