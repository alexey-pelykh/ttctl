// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveToolAuth } from "../auth.js";

/**
 * The MCP server has no CLI flags — `TTCTL_CONFIG_FILE` and the home
 * dotfile (`~/.ttctl.yaml`) are the only knobs a deployment has to point
 * it at a non-default config (CI, agent-driven setups, multi-config dev).
 * These tests pin that integration.
 *
 * `resolveToolAuth` calls `resolveConfig()` parameterless, so the env-var
 * support comes from `discoverConfigPath` in `@ttctl/core`. The tests below
 * verify the wiring end-to-end at the MCP layer rather than re-asserting
 * `discoverConfigPath`'s precedence chain (covered exhaustively in
 * `packages/core/src/__tests__/config.test.ts`).
 *
 * Isolation: each test uses a fresh tmp dir, redirects HOME so
 * `~/.ttctl.yaml` resolves into the fixture, and saves/restores the
 * relevant env vars so the test order is irrelevant.
 */
describe("resolveToolAuth: TTCTL_CONFIG_FILE wiring (post-#107 single-file model)", () => {
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

  it("loads the in-memory token from a Form D config pointed to by TTCTL_CONFIG_FILE", async () => {
    // Form D fixture: credentials + token live in the SAME YAML file post-#107.
    const configPath = join(tmpRoot, "from-env.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n  token: user_abc123_xyz789\n", {
      mode: 0o600,
    });
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("user_abc123_xyz789");
    }
  });

  it("loads the in-memory token from a Form C (token-only) config", async () => {
    const configPath = join(tmpRoot, "token-only.yaml");
    writeFileSync(configPath, "auth:\n  token: user_token_only_xyz\n", { mode: 0o600 });
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("user_token_only_xyz");
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

  it("returns UNAUTHENTICATED response when config is Form A (credentials only, no token)", async () => {
    const configPath = join(tmpRoot, "no-token.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    const result = await resolveToolAuth();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.isError).toBe(true);
      expect(result.response.content[0]?.text).toContain("(Code: UNAUTHENTICATED)");
    }
  });

  it("TTCTL_CONFIG_FILE wins over ~/.ttctl.yaml", async () => {
    // Two valid configs with different token contents. The env-var-pointed
    // one should be the one that loads.
    const envConfig = join(tmpRoot, "from-env.yaml");
    writeFileSync(envConfig, "auth:\n  token: from-env-token-aaa\n", { mode: 0o600 });

    const homeConfig = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(homeConfig, "auth:\n  token: from-home-token-bbb\n", { mode: 0o600 });

    process.env["TTCTL_CONFIG_FILE"] = envConfig;

    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("from-env-token-aaa");
    }
  });

  it("REGRESSION: $XDG_CONFIG_HOME/ttctl/config.yaml is NOT consulted post-#107", async () => {
    // Seed an XDG location with a token; resolveToolAuth must IGNORE it.
    const xdgDir = join(tmpRoot, "xdg");
    const xdgTtctlDir = join(xdgDir, "ttctl");
    mkdirSync(xdgTtctlDir, { recursive: true });
    writeFileSync(join(xdgTtctlDir, "config.yaml"), "auth:\n  token: from-xdg-should-not-be-loaded\n", { mode: 0o600 });
    process.env["XDG_CONFIG_HOME"] = xdgDir;
    // No TTCTL_CONFIG_FILE, no ~/.ttctl.yaml — only the XDG-resident config
    // exists. resolveToolAuth must fall through to NO_CREDS.

    const result = await resolveToolAuth();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.isError).toBe(true);
      expect(result.response.content[0]?.text).toContain("(Code: NO_CREDS)");
    }
  });

  it("falls back to ~/.ttctl.yaml when TTCTL_CONFIG_FILE is unset", async () => {
    const homeConfig = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(homeConfig, "auth:\n  token: from-home-fallback-zzz\n", { mode: 0o600 });

    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("from-home-fallback-zzz");
    }
  });
});
