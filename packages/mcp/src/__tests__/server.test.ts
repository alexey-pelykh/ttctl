// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, persistAuthToken, resolveConfig } from "@ttctl/core";

import { createToolAuthResolver } from "../auth.js";
import { buildServer } from "../server.js";

/**
 * Smoke + path-capture tests for `buildServer`. The MCP SDK doesn't
 * expose an easy "list registered tools" introspection on the public
 * `McpServer` API, so the smoke tests verify the server constructs
 * without throwing. The path-capture tests (#113) cover the new
 * startup-time `resolveConfig` invariant: the resolved absolute path is
 * captured ONCE at construction and bound into closures; mid-session
 * env shifts do NOT retarget reads. Fail-fast on `NO_CREDS` is also
 * pinned here so a half-initialized server can never start.
 */
describe("buildServer", () => {
  let tmpRoot: string;
  let savedEnv: { TTCTL_CONFIG_FILE?: string; HOME?: string; USERPROFILE?: string };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-mcp-server-test-"));
    savedEnv = {
      ...(process.env["TTCTL_CONFIG_FILE"] !== undefined
        ? { TTCTL_CONFIG_FILE: process.env["TTCTL_CONFIG_FILE"] }
        : {}),
      ...(process.env["HOME"] !== undefined ? { HOME: process.env["HOME"] } : {}),
      ...(process.env["USERPROFILE"] !== undefined ? { USERPROFILE: process.env["USERPROFILE"] } : {}),
    };
    delete process.env["TTCTL_CONFIG_FILE"];
    // Repoint HOME / USERPROFILE so a real user-level `~/.ttctl.yaml` on the
    // host running the suite can't leak into the resolution chain. Anything
    // we want to test we write into `tmpRoot` explicitly.
    process.env["HOME"] = tmpRoot;
    process.env["USERPROFILE"] = tmpRoot;
  });

  afterEach(() => {
    if (savedEnv.TTCTL_CONFIG_FILE !== undefined) process.env["TTCTL_CONFIG_FILE"] = savedEnv.TTCTL_CONFIG_FILE;
    else delete process.env["TTCTL_CONFIG_FILE"];
    if (savedEnv.HOME !== undefined) process.env["HOME"] = savedEnv.HOME;
    else delete process.env["HOME"];
    if (savedEnv.USERPROFILE !== undefined) process.env["USERPROFILE"] = savedEnv.USERPROFILE;
    else delete process.env["USERPROFILE"];
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("constructs an MCP server with the ttctl identity (smoke; explicit configPath)", () => {
    const configPath = join(tmpRoot, "smoke.yaml");
    writeFileSync(configPath, "auth:\n  token: smoke-token\n", { mode: 0o600 });

    const server = buildServer({ configPath });
    expect(server).toBeDefined();
  });

  it("registers tools without throwing (smoke; explicit configPath)", () => {
    const configPath = join(tmpRoot, "smoke.yaml");
    writeFileSync(configPath, "auth:\n  token: smoke-token\n", { mode: 0o600 });

    expect(() => buildServer({ configPath })).not.toThrow();
  });

  it("STARTUP CAPTURE: explicit configPath is captured at construction time", () => {
    // The act of constructing the server must succeed for a valid path.
    // We verify the capture indirectly: `resolveConfig({path})` returns
    // the same absolute path the server's resolvers close over.
    const configPath = join(tmpRoot, "captured.yaml");
    writeFileSync(configPath, "auth:\n  token: captured-token\n", { mode: 0o600 });

    expect(() => buildServer({ configPath })).not.toThrow();
    const { path } = resolveConfig({ path: configPath });
    expect(path).toBe(configPath);
  });

  it("STARTUP CAPTURE: env-resolved path is captured when configPath is omitted", () => {
    const envConfigPath = join(tmpRoot, "from-env.yaml");
    writeFileSync(envConfigPath, "auth:\n  token: env-resolved-token\n", { mode: 0o600 });
    process.env["TTCTL_CONFIG_FILE"] = envConfigPath;

    expect(() => buildServer()).not.toThrow();
  });

  it("FAIL-FAST: throws ConfigError(NO_CREDS) when no candidate exists", () => {
    // No env, HOME points to empty tmpRoot — there's no `~/.ttctl.yaml` to
    // fall back on. The startup-time `resolveConfig` MUST throw NO_CREDS
    // and the server MUST NOT start.
    expect(() => buildServer()).toThrow(ConfigError);
    try {
      buildServer();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.code).toBe("NO_CREDS");
      }
    }
  });

  it("FAIL-FAST: throws ConfigError(NO_CREDS) when explicit configPath does not exist", () => {
    const missingPath = join(tmpRoot, "does-not-exist.yaml");

    expect(() => buildServer({ configPath: missingPath })).toThrow(ConfigError);
  });

  it("MID-SESSION SYMMETRY: captured path is honored for the WRITE side via persistAuthToken", async () => {
    // This test pins REQ-2.4 (writes also target captured path). The MCP
    // server is the captor; persistAuthToken is the writer used by `auth
    // signin` and any future MCP-side write tools. Even when env shifts
    // post-startup, a `persistAuthToken(capturedPath, ...)` call writes
    // verbatim to capturedPath.
    const pathA = join(tmpRoot, "captured-write.yaml");
    writeFileSync(pathA, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });
    const pathB = join(tmpRoot, "post-shift.yaml");
    writeFileSync(pathB, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    process.env["TTCTL_CONFIG_FILE"] = pathA;
    // Capture happens here.
    const captured = resolveConfig().path;
    expect(captured).toBe(pathA);
    // Build server with the captured path to mimic the wiring.
    expect(() => buildServer({ configPath: captured })).not.toThrow();

    // Now SHIFT env. A subsequent persistAuthToken called with the
    // captured path MUST land on pathA.
    process.env["TTCTL_CONFIG_FILE"] = pathB;
    await persistAuthToken(captured, "user_post_shift_write");

    // pathA now carries the new token; pathB is untouched.
    const reReadA = resolveConfig({ path: pathA });
    expect(reReadA.config.auth.token).toBe("user_post_shift_write");
    const reReadB = resolveConfig({ path: pathB });
    expect(reReadB.config.auth.token).toBeUndefined();
  });

  it("MID-SESSION SYMMETRY: captured path is honored for the READ side after env shift", async () => {
    // Pair to the WRITE test above — verifies the resolver returned by
    // the factory closure (which is what each tool calls) reads from the
    // captured path even when env shifts mid-session.
    const pathA = join(tmpRoot, "captured-read.yaml");
    writeFileSync(pathA, "auth:\n  token: from-A-captured\n", { mode: 0o600 });
    const pathB = join(tmpRoot, "post-shift-read.yaml");
    writeFileSync(pathB, "auth:\n  token: from-B-shifted\n", { mode: 0o600 });

    process.env["TTCTL_CONFIG_FILE"] = pathA;
    const captured = resolveConfig().path;
    // The resolver factory is the same one buildServer uses internally.
    const resolveToolAuth = createToolAuthResolver(captured);
    process.env["TTCTL_CONFIG_FILE"] = pathB;

    const result = await resolveToolAuth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("from-A-captured");
    }
  });
});
