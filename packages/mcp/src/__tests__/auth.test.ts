// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveToolAuth } from "../auth.js";

/**
 * The MCP server has no CLI flags — `TTCTL_CONFIG_FILE` is the only knob a
 * deployment has to point it at a non-default config path (CI, agent-driven
 * setups, multi-config dev). These tests pin that integration.
 *
 * `resolveToolAuth` calls `resolveConfig()` parameterless, so the env-var
 * support comes from `discoverConfigPath` in `@ttctl/core`. The tests below
 * verify the wiring end-to-end at the MCP layer rather than re-asserting
 * `discoverConfigPath`'s precedence chain (covered exhaustively in
 * `packages/core/src/__tests__/config.test.ts`).
 *
 * Isolation: each test uses a fresh tmp dir, sets `auth-token-path` to a
 * relative path so the token lands inside the tmp dir (not the user's real
 * `~/.ttctl/auth.token`), and saves/restores the relevant env vars so the
 * test order is irrelevant.
 */
describe("resolveToolAuth: TTCTL_CONFIG_FILE wiring (#95)", () => {
  let tmpRoot: string;
  let savedEnv: { TTCTL_CONFIG_FILE?: string; XDG_CONFIG_HOME?: string; HOME?: string; USERPROFILE?: string };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-mcp-auth-test-"));
    savedEnv = {
      ...(process.env["TTCTL_CONFIG_FILE"] !== undefined
        ? { TTCTL_CONFIG_FILE: process.env["TTCTL_CONFIG_FILE"] }
        : {}),
      ...(process.env["XDG_CONFIG_HOME"] !== undefined ? { XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] } : {}),
      ...(process.env["HOME"] !== undefined ? { HOME: process.env["HOME"] } : {}),
      ...(process.env["USERPROFILE"] !== undefined ? { USERPROFILE: process.env["USERPROFILE"] } : {}),
    };
    delete process.env["TTCTL_CONFIG_FILE"];
    delete process.env["XDG_CONFIG_HOME"];
    // Redirect HOME so the home default (`~/.config/ttctl/config.yaml`) and
    // the home-default token path (`~/.ttctl/auth.token`) cannot accidentally
    // pick up the user's real files. The tests then explicitly opt into the
    // env-var path via `TTCTL_CONFIG_FILE`.
    process.env["HOME"] = tmpRoot;
    process.env["USERPROFILE"] = tmpRoot;
  });

  afterEach(() => {
    if (savedEnv.TTCTL_CONFIG_FILE !== undefined) process.env["TTCTL_CONFIG_FILE"] = savedEnv.TTCTL_CONFIG_FILE;
    else delete process.env["TTCTL_CONFIG_FILE"];
    if (savedEnv.XDG_CONFIG_HOME !== undefined) process.env["XDG_CONFIG_HOME"] = savedEnv.XDG_CONFIG_HOME;
    else delete process.env["XDG_CONFIG_HOME"];
    if (savedEnv.HOME !== undefined) process.env["HOME"] = savedEnv.HOME;
    else delete process.env["HOME"];
    if (savedEnv.USERPROFILE !== undefined) process.env["USERPROFILE"] = savedEnv.USERPROFILE;
    else delete process.env["USERPROFILE"];
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("loads the token from a config file pointed to by TTCTL_CONFIG_FILE", async () => {
    // Fixture: a config that pins the token alongside it (relative-path
    // branch of `resolveAuthTokenPath`) so the test can pre-seed a known
    // token without touching the user's home directory.
    const configPath = join(tmpRoot, "from-env.yaml");
    writeFileSync(configPath, "auth: op://Personal/ttctl\nauth-token-path: ./auth.token\n");
    writeFileSync(join(tmpRoot, "auth.token"), "user_abc123_xyz789\n");
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("user_abc123_xyz789");
    }
  });

  it("returns NO_CREDS error response when TTCTL_CONFIG_FILE points to a non-existent file", async () => {
    process.env["TTCTL_CONFIG_FILE"] = join(tmpRoot, "does-not-exist.yaml");

    const result = await resolveToolAuth();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.isError).toBe(true);
      expect(result.response.content[0]?.text).toContain("(Code: NO_CREDS)");
    }
  });

  it("returns UNAUTHENTICATED response when TTCTL_CONFIG_FILE is valid but the token file is missing", async () => {
    // Config exists and parses, but no token has been persisted yet (the
    // first-run case before `ttctl auth signin`). MCP must surface the
    // UNAUTHENTICATED hint, not a generic config error.
    const configPath = join(tmpRoot, "no-token.yaml");
    writeFileSync(configPath, "auth: op://Personal/ttctl\nauth-token-path: ./auth.token\n");
    // Deliberately no auth.token file alongside.
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    const result = await resolveToolAuth();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.isError).toBe(true);
      expect(result.response.content[0]?.text).toContain("(Code: UNAUTHENTICATED)");
    }
  });

  it("TTCTL_CONFIG_FILE wins over $XDG_CONFIG_HOME/ttctl/config.yaml", async () => {
    // Two valid configs with different token contents. The env-var-pointed
    // one should be the one that loads.
    const envConfig = join(tmpRoot, "from-env.yaml");
    writeFileSync(envConfig, "auth: op://Personal/from-env\nauth-token-path: ./from-env.token\n");
    writeFileSync(join(tmpRoot, "from-env.token"), "from-env-token\n");

    const xdgDir = join(tmpRoot, "xdg");
    const xdgTtctlDir = join(xdgDir, "ttctl");
    mkdirSync(xdgTtctlDir, { recursive: true });
    writeFileSync(
      join(xdgTtctlDir, "config.yaml"),
      "auth: op://Personal/from-xdg\nauth-token-path: ./from-xdg.token\n",
    );
    writeFileSync(join(xdgTtctlDir, "from-xdg.token"), "from-xdg-token\n");

    process.env["TTCTL_CONFIG_FILE"] = envConfig;
    process.env["XDG_CONFIG_HOME"] = xdgDir;

    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("from-env-token");
    }
  });
});
