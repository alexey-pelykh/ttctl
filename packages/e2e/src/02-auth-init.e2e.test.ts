// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Smoke test for `ttctl auth init` (#114). Two assertions matter against
 * the spawned CLI subprocess:
 *
 *   1. Non-TTY refusal — the e2e harness pipes stdin (not a TTY); the
 *      command MUST exit non-zero before any prompt with a clear
 *      TTY-required message. This is the natural smoke for a CI-style
 *      invocation: a non-zero exit + a recognizable error string proves
 *      the gate fires before we touch the prompt library.
 *   2. Refuse-overwrite — pre-create a fixture file at the target path,
 *      invoke `auth init` with `--config <path>` (no `--force`), assert
 *      the refusal AND that the fixture content is untouched.
 *
 * This file deliberately does NOT exercise the interactive flow (vault
 * picker, form selection): clack requires a real PTY, which the harness
 * doesn't provide. The interactive flow is covered by the unit-test
 * suite at `packages/cli/src/__tests__/auth-init.test.ts`.
 *
 * Prefix `02-` places this file after `01-auth-signin` (which depends on
 * `globalSetup`) and well before `99-auth-signout`. Ordering is not
 * load-bearing — `auth init` doesn't touch the shared session — but the
 * numeric prefix keeps it grouped with the auth tests.
 *
 * Per #105 isolation: this test creates its own temp config under
 * `tmpdir()` and runs `ttctl auth init` with `--config <isolated-path>`.
 * It does NOT touch `getSharedSession()` or the sandbox config that
 * `01-auth-signin` and `99-auth-signout` operate on.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCliClient } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("auth init smoke (CI-style spawn — non-TTY + refuse-overwrite)", () => {
  let cli: CliClient;
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    if (!e2eEnabled) return;
    tmpDir = mkdtempSync(join(tmpdir(), "ttctl-init-e2e-"));
    configPath = join(tmpDir, "init-test.yaml");
    // Build a CLI client without a sandbox config — auth init takes the
    // path via `--config <path>`, so we don't need TTCTL_CONFIG_FILE.
    cli = getCliClient({});
  });

  afterEach(() => {
    if (!e2eEnabled) return;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!e2eEnabled)("non-TTY stdin: exits non-zero with TTY-required message; no file created", async () => {
    expect(existsSync(configPath)).toBe(false);

    // Harness spawns with `stdio: ["pipe", "pipe", "pipe"]` — stdin is a
    // pipe, NOT a TTY. The auth init flow's first gate fires.
    const result = await cli.run(["auth", "init", "--config", configPath]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/interactive|tty/i);
    expect(existsSync(configPath)).toBe(false);
  });

  it.skipIf(!e2eEnabled)(
    "pre-existing file without --force: refused; existing content preserved verbatim",
    async () => {
      // Pre-seed the target with a recognizable fixture so we can later
      // assert byte-for-byte that auth init didn't touch it.
      const fixture = 'auth:\n  credentials: "op://Pre-Existing/fixture"\n';
      writeFileSync(configPath, fixture, { mode: 0o600 });

      const result = await cli.run(["auth", "init", "--config", configPath]);

      expect(result.exitCode).not.toBe(0);
      // The non-TTY gate fires FIRST (before the existence check), so the
      // primary signal is the TTY message — but the file MUST still be
      // intact regardless of which gate fired.
      expect(readFileSync(configPath, "utf8")).toBe(fixture);
    },
  );
});
