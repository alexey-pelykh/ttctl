// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Final shared-session test in the E2E sequence (numeric prefix `99-`).
 *
 * Post-#171: ASSERTION-ONLY. This file no longer runs `ttctl auth
 * signout` — the asserted cleanup action moved to the parent-process
 * `runGlobalTeardown` (see `harness/globalTeardown.ts`) so it fires
 * unconditionally, including after an earlier worker crashes the fork.
 *
 * What this file asserts is the PRE-teardown state: the shared bearer is
 * present in the sandbox config AND validates against the live Toptal
 * gateway. That confirms `globalSetup` produced a working session that
 * the suite consumed end-to-end. The POST-teardown state — bearer field
 * cleared, lockfile released — is recorded in `<sandbox>/.teardown-
 * receipt.json` by `runGlobalTeardown` and verified out-of-band by
 * `pnpm test:e2e:crash-recovery`.
 *
 * The `99-` prefix is preserved so this file remains the LAST worker-
 * side test in the alphabetical sequence: sibling read-side files keep
 * their valid session, and the parent-side teardown still owns cleanup.
 * Putting a `getSharedSession()`-using read-side case AFTER this file
 * would not break anything (the token is still present until teardown
 * runs), but the convention reserves `9N-` for terminal smoke tests.
 */

import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("auth signout — pre-teardown smoke (live Toptal, shared session)", () => {
  let cli: CliClient;
  let email: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    cli = getCliClient({ configPath: session.sandboxConfigPath });
    email = session.email;
  });

  it.skipIf(!e2eEnabled)("shared bearer is present in the sandbox config (globalSetup wrote it)", () => {
    const { sandboxConfigPath } = getSharedSession();
    const raw = readFileSync(sandboxConfigPath, "utf8");
    const parsed = parseYaml(raw) as { auth?: Record<string, unknown> };
    expect(parsed.auth).toBeDefined();
    const token = parsed.auth?.["token"];
    expect(typeof token).toBe("string");
    expect(token as string).not.toBe("");
  });

  it.skipIf(!e2eEnabled)(
    "ttctl auth status reports the session as valid and surfaces the signed-in email",
    async () => {
      const statusResult = await cli.run(["auth", "status"]);
      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain(email);
    },
  );
});
