// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolAuthResolver } from "../auth.js";

/**
 * `createToolAuthResolver(configPath)` is the factory closure introduced
 * by #113. The MCP server captures the resolved config path ONCE at
 * `buildServer()` time and binds it into a per-session resolver; per-tool
 * invocations call the bound closure, which targets the captured path
 * verbatim.
 *
 * These tests pin the factory's contract:
 *   - happy paths (Form D / C) return OK with the token from the bound
 *     path,
 *   - failure paths (missing file / Form A no-token) return the
 *     structured `ToolErrorResponse`,
 *   - mid-session `TTCTL_CONFIG_FILE` mutation does NOT retarget the read.
 *
 * Resolution-chain coverage (`TTCTL_CONFIG_FILE` wins over `~/.ttctl.yaml`,
 * `$XDG_CONFIG_HOME` is not consulted, etc.) lives in
 * `packages/core/src/__tests__/config.test.ts` — that's where the
 * `resolveConfig` chain is exercised. Post-#113 the MCP layer no longer
 * re-resolves per call, so duplicating those cases here would test core's
 * behavior through an indirection rather than this layer's contract.
 */
describe("createToolAuthResolver: factory closure binding (#113)", () => {
  let tmpRoot: string;
  let savedEnv: { TTCTL_CONFIG_FILE?: string };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-mcp-auth-test-"));
    savedEnv = {
      ...(process.env["TTCTL_CONFIG_FILE"] !== undefined
        ? { TTCTL_CONFIG_FILE: process.env["TTCTL_CONFIG_FILE"] }
        : {}),
    };
    delete process.env["TTCTL_CONFIG_FILE"];
  });

  afterEach(() => {
    if (savedEnv.TTCTL_CONFIG_FILE !== undefined) process.env["TTCTL_CONFIG_FILE"] = savedEnv.TTCTL_CONFIG_FILE;
    else delete process.env["TTCTL_CONFIG_FILE"];
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("loads the in-memory token from a Form D config bound at factory creation", async () => {
    // Form D fixture: credentials + token in one YAML file (post-#107).
    const configPath = join(tmpRoot, "form-d.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n  token: user_abc123_xyz789\n", {
      mode: 0o600,
    });

    const resolveToolAuth = createToolAuthResolver(configPath);
    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("user_abc123_xyz789");
    }
  });

  it("loads the in-memory token from a Form C (token-only) config bound at factory creation", async () => {
    const configPath = join(tmpRoot, "token-only.yaml");
    writeFileSync(configPath, "auth:\n  token: user_token_only_xyz\n", { mode: 0o600 });

    const resolveToolAuth = createToolAuthResolver(configPath);
    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("user_token_only_xyz");
    }
  });

  it("returns NO_CREDS error response when the bound path does not exist", async () => {
    const missingPath = join(tmpRoot, "does-not-exist.yaml");

    const resolveToolAuth = createToolAuthResolver(missingPath);
    const result = await resolveToolAuth();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.isError).toBe(true);
      expect(result.response.content[0]?.text).toContain("(Code: NO_CREDS)");
    }
  });

  it("returns UNAUTHENTICATED response when bound path is Form A (credentials only, no token)", async () => {
    const configPath = join(tmpRoot, "no-token.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    const resolveToolAuth = createToolAuthResolver(configPath);
    const result = await resolveToolAuth();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.isError).toBe(true);
      expect(result.response.content[0]?.text).toContain("(Code: UNAUTHENTICATED)");
    }
  });

  it("MID-SESSION ENV SHIFT: bound path is honored even when TTCTL_CONFIG_FILE flips after factory creation", async () => {
    // Path A — bound at factory creation. Path B — re-targeted via env mid-session.
    // The factory closes over A; subsequent reads MUST land on A regardless.
    const pathA = join(tmpRoot, "captured.yaml");
    writeFileSync(pathA, "auth:\n  token: from-captured-path-A\n", { mode: 0o600 });
    const pathB = join(tmpRoot, "post-shift.yaml");
    writeFileSync(pathB, "auth:\n  token: from-shifted-path-B\n", { mode: 0o600 });

    // Establish env state at factory creation pointing AT pathA, build the
    // factory, then SHIFT the env to pathB. The factory captured A — the
    // read must still come from A.
    process.env["TTCTL_CONFIG_FILE"] = pathA;
    const resolveToolAuth = createToolAuthResolver(pathA);
    process.env["TTCTL_CONFIG_FILE"] = pathB;

    const result = await resolveToolAuth();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("from-captured-path-A");
    }
  });
});
