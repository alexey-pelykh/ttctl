// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getMcpClient } from "../mcp-client.js";

/**
 * Integration tests for the MCP server's startup-time path capture
 * behavior (#113). Unlike the other harness tests in this directory,
 * these spawn the REAL `ttctl mcp` umbrella binary (not a stub) and
 * exercise the entry-point's flag parsing + `buildServer({configPath})`
 * + `resolveConfig` chain end-to-end.
 *
 * The tests are placed here (alongside `mcp-client.test.ts`) rather than
 * under `*.e2e.test.ts` because they DO NOT require a live Toptal session —
 * they only verify startup wiring, which depends on the build artifact at
 * `packages/ttctl/dist/cli.js`. Turbo's `test` task `dependsOn: ["build"]`,
 * so the binary is always present in CI before this file runs.
 *
 * Symmetry guarantees beyond startup wiring (env-shift mid-session does
 * not retarget reads or writes; per-tool callbacks read from captured
 * path) live in `packages/mcp/src/__tests__/{auth,server}.test.ts` —
 * those tests exercise the in-process closure binding directly without
 * subprocess overhead.
 */
describe("ttctl mcp — startup-time path capture (#113)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ttctl-mcp-startup-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("spawns successfully when TTCTL_CONFIG_FILE points to a valid sandbox config", async () => {
    // Form C (token-only) sandbox config — enough for resolveConfig to
    // succeed at startup and for buildServer's resolvers to bind to the
    // captured path. We don't issue any tool calls; the assertion is that
    // the server doesn't fail-fast on startup.
    const sandboxConfig = join(workDir, "sandbox.yaml");
    await writeFile(sandboxConfig, "auth:\n  token: user_smoke_token_aaa\n", { mode: 0o600 });

    const client = getMcpClient({
      configPath: sandboxConfig,
      cwd: workDir,
    });
    try {
      // Give the spawn a beat to pass through resolveConfig + tool
      // registration. If the server were going to fail-fast on a NO_CREDS
      // / PERMISSION error it would do so well within 200ms.
      await waitForStartupSettling();

      expect(client.process.exitCode).toBeNull();
      expect(client.process.signalCode).toBeNull();
    } finally {
      await client.close(2_000);
    }
  });

  // Wall-clock budget widened from 5s → 20s (#300) — Windows CI runners
  // (Azure-hosted, shared) intermittently take longer than 5s to spawn the
  // umbrella binary + run resolveConfig + fail-fast + exit. Two independent
  // post-merge flakes within 24h (commits `a9bd802`, #284) re-running clean
  // with no code changes — pattern is consistent with slow-spawn timing
  // variance, not a regression. 20s preserves the functional contract (the
  // happy-path failure still completes in <1s; the wide budget only matters
  // when the runner is degraded) and the per-test timeout is set explicitly
  // via the vitest 4.x options-object form so the inner 20s budget can fire
  // before vitest's default `testTimeout` (15s from the package config).
  it("FAIL-FAST: spawns and exits non-zero when no config resolves at startup", { timeout: 30_000 }, async () => {
    // No config anywhere: TTCTL_CONFIG_FILE is unset (the harness only
    // injects it when configPath is passed), HOME points at an empty tmp
    // dir, and the spawned process inherits these — so resolveConfig has
    // no candidate and throws ConfigError(NO_CREDS). The umbrella's
    // top-level catch renders `Error (NO_CREDS): …` to stderr and exits
    // with code 1, matching the existing CLI failure shape.
    const client = getMcpClient({
      cwd: workDir,
      // Drop any inherited TTCTL_CONFIG_FILE the test runner may have set.
      env: { TTCTL_CONFIG_FILE: undefined, HOME: workDir, USERPROFILE: workDir, XDG_CONFIG_HOME: undefined },
    });
    try {
      const exitInfo = await waitForExit(client.process, 20_000);
      expect(exitInfo.exitCode).not.toBe(0);
      expect(client.getStderr()).toContain("NO_CREDS");
    } finally {
      await client.close(500);
    }
  });

  it("--config flag overrides TTCTL_CONFIG_FILE at startup (path captured from flag)", async () => {
    // Two configs: one targeted by env (envConfig), one by --config flag
    // (flagConfig). The spawned umbrella's MCP entry must parse --config
    // from argv and thread it into buildServer({configPath}), causing
    // resolveConfig to bind the FLAG path. We verify no startup failure
    // (proves the flag was honored — if the MCP server had instead read
    // env, both paths point at valid configs and the test wouldn't catch
    // the bug; the negative leg is covered by the FAIL-FAST test above
    // and the unit-level captured-path tests).
    const envConfig = join(workDir, "from-env.yaml");
    await writeFile(envConfig, "auth:\n  token: from-env-token\n", { mode: 0o600 });
    const flagConfig = join(workDir, "from-flag.yaml");
    await writeFile(flagConfig, "auth:\n  token: from-flag-token\n", { mode: 0o600 });

    const client = getMcpClient({
      configPath: envConfig, // injects TTCTL_CONFIG_FILE=envConfig
      cwd: workDir,
      mcpFlags: ["--config", flagConfig],
    });
    try {
      await waitForStartupSettling();
      expect(client.process.exitCode).toBeNull();
    } finally {
      await client.close(2_000);
    }
  });
});

/**
 * Wait for an MCP server startup to "settle". The window is tuned to be
 * larger than the worst-case resolveConfig + tool-registration sequence
 * on slow CI runners but well below vitest's default `testTimeout`. The
 * caller asserts on `child.exitCode` and `child.signalCode` after settling.
 */
async function waitForStartupSettling(): Promise<void> {
  await new Promise<void>((resolveSettling) => {
    setTimeout(resolveSettling, 500);
  });
}

/**
 * Wait for a child process to exit, with a hard timeout. If the timeout
 * fires before exit, throw — the test assertion will catch the failure.
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ exitCode: number | null }> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs.toString()}ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit({ exitCode: code });
    });
  });
}
