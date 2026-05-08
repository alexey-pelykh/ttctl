// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  cliConfigPath,
  findRepoRoot,
  resolveIsolatedSessionConfigPath,
  resolveIsolatedSessionDir,
  resolveLockfilePath,
  resolveSandboxConfigPath,
  resolveSandboxDir,
  resolveSharedSessionFilePath,
  writeIsolatedSessionConfig,
  writeSandboxConfig,
} from "../paths.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ttctl-e2e-paths-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("findRepoRoot", () => {
  it("returns the directory containing pnpm-workspace.yaml", async () => {
    const root = join(workDir, "monorepo");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const sub = join(root, "packages", "e2e", "src", "harness");
    await mkdir(sub, { recursive: true });

    expect(findRepoRoot(sub)).toBe(root);
  });

  it("falls back to .git when pnpm-workspace.yaml is absent", async () => {
    const root = join(workDir, "git-only");
    await mkdir(join(root, ".git"), { recursive: true });
    const sub = join(root, "src");
    await mkdir(sub, { recursive: true });

    expect(findRepoRoot(sub)).toBe(root);
  });

  it("prefers pnpm-workspace.yaml when both sentinels exist at the same level", async () => {
    const root = join(workDir, "both");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const sub = join(root, "deep");
    await mkdir(sub, { recursive: true });

    expect(findRepoRoot(sub)).toBe(root);
  });

  it("throws when no sentinel is found before filesystem root", () => {
    expect(() => findRepoRoot(workDir)).toThrow(/walked from .* up to filesystem root/);
  });
});

describe("path helpers", () => {
  it("resolveSandboxDir joins .tmp/e2e under the given root", () => {
    expect(resolveSandboxDir("/repo")).toBe(join("/repo", ".tmp", "e2e"));
  });

  it("resolveSandboxConfigPath joins .tmp/e2e/.ttctl.yaml under the given root", () => {
    expect(resolveSandboxConfigPath("/repo")).toBe(join("/repo", ".tmp", "e2e", ".ttctl.yaml"));
  });

  it("resolveLockfilePath joins .tmp/e2e/.lock under the given root", () => {
    expect(resolveLockfilePath("/repo")).toBe(join("/repo", ".tmp", "e2e", ".lock"));
  });

  it("cliConfigPath returns the same path as resolveSandboxConfigPath (env-injection alias, #94)", () => {
    expect(cliConfigPath("/repo")).toBe(resolveSandboxConfigPath("/repo"));
  });

  it("resolveSharedSessionFilePath joins .tmp/e2e/.session.json under the given root", () => {
    expect(resolveSharedSessionFilePath("/repo")).toBe(join("/repo", ".tmp", "e2e", ".session.json"));
  });

  it("resolveIsolatedSessionDir joins .tmp/e2e/isolated-<id> under the given root", () => {
    expect(resolveIsolatedSessionDir("/repo", "1")).toBe(join("/repo", ".tmp", "e2e", "isolated-1"));
    expect(resolveIsolatedSessionDir("/repo", "42")).toBe(join("/repo", ".tmp", "e2e", "isolated-42"));
  });

  it("resolveIsolatedSessionConfigPath joins .ttctl.yaml inside the isolated subdirectory", () => {
    expect(resolveIsolatedSessionConfigPath("/repo", "1")).toBe(
      join("/repo", ".tmp", "e2e", "isolated-1", ".ttctl.yaml"),
    );
  });

  it("isolated children all live under their own isolated subdirectory (separation from shared sandbox)", () => {
    const root = "/r";
    const isolatedDir = resolveIsolatedSessionDir(root, "1");
    expect(resolveIsolatedSessionConfigPath(root, "1").startsWith(isolatedDir)).toBe(true);
    // Critically, isolated paths do NOT collide with the SHARED config —
    // adversarial corruption is contained to its own subtree.
    expect(resolveIsolatedSessionConfigPath(root, "1")).not.toBe(resolveSandboxConfigPath(root));
  });

  it("isolated subdirectories with different ids do not collide", () => {
    expect(resolveIsolatedSessionDir("/r", "1")).not.toBe(resolveIsolatedSessionDir("/r", "2"));
    expect(resolveIsolatedSessionConfigPath("/r", "1")).not.toBe(resolveIsolatedSessionConfigPath("/r", "2"));
  });

  it("sandbox children all live under resolveSandboxDir", () => {
    const root = "/r";
    const sandbox = resolveSandboxDir(root);
    expect(resolveSandboxConfigPath(root).startsWith(sandbox)).toBe(true);
    expect(cliConfigPath(root).startsWith(sandbox)).toBe(true);
    expect(resolveLockfilePath(root).startsWith(sandbox)).toBe(true);
    expect(resolveSharedSessionFilePath(root).startsWith(sandbox)).toBe(true);
    expect(resolveIsolatedSessionDir(root, "1").startsWith(sandbox)).toBe(true);
  });
});

describe("writeSandboxConfig (post-#107 single-file model)", () => {
  it("creates the sandbox dir and writes a Form C (token-only) fixture .ttctl.yaml", async () => {
    const fixturePath = await writeSandboxConfig(workDir, "user_test_token_xyz_123");

    expect(fixturePath).toBe(resolveSandboxConfigPath(workDir));
    const written = await readFile(fixturePath, "utf8");
    const parsed = parseYaml(written) as Record<string, unknown>;
    expect(parsed["auth"]).toEqual({ token: "user_test_token_xyz_123" });
    // Sandbox MUST NOT carry credentials — only the captured bearer.
    const auth = parsed["auth"] as Record<string, unknown>;
    expect("credentials" in auth).toBe(false);
    // The legacy auth-token-path field is removed entirely post-#107.
    expect("auth-token-path" in parsed).toBe(false);
  });

  it("writes the sandbox config at mode 0o600 (POSIX)", async () => {
    if (process.platform === "win32") return;
    const fixturePath = await writeSandboxConfig(workDir, "user_xxx_yyy");
    const { statSync } = await import("node:fs");
    const mode = statSync(fixturePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-applies mode 0o600 when the sandbox config file already exists at a looser mode", async () => {
    // Regression: Node's writeFile({ mode }) only honors mode on file
    // CREATION; existing files keep their old mode. A stale sandbox at
    // 0o644 from a prior run must not silently survive.
    if (process.platform === "win32") return;
    const { statSync, chmodSync } = await import("node:fs");

    // First write — creates the file at 0o600.
    const fixturePath = await writeSandboxConfig(workDir, "user_aaa_bbb");
    expect(statSync(fixturePath).mode & 0o777).toBe(0o600);

    // Simulate stale-from-prior-run state: deliberately loosen to 0o644.
    chmodSync(fixturePath, 0o644);
    expect(statSync(fixturePath).mode & 0o777).toBe(0o644);

    // Second write must restore 0o600.
    await writeSandboxConfig(workDir, "user_ccc_ddd");
    expect(statSync(fixturePath).mode & 0o777).toBe(0o600);
  });

  it("creates the sandbox directory if it does not already exist", async () => {
    // workDir is empty — no .tmp, no .tmp/e2e.
    const fixturePath = await writeSandboxConfig(workDir, "user_xxx_yyy");

    // Reading the fixture proves the dir was created (writeFile would
    // otherwise reject with ENOENT for the missing parent).
    await expect(readFile(fixturePath, "utf8")).resolves.toContain("token");
  });
});

describe("writeIsolatedSessionConfig (post-#107)", () => {
  it("writes a credentials-only fixture .ttctl.yaml inside .tmp/e2e/isolated-<id>/", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, "auth:\n  credentials: op://Personal/ttctl\n", "utf8");

    const fixturePath = await writeIsolatedSessionConfig(workDir, "1", sourceConfigPath);

    expect(fixturePath).toBe(resolveIsolatedSessionConfigPath(workDir, "1"));
    const parsed = parseYaml(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const auth = parsed["auth"] as Record<string, unknown>;
    expect(auth["credentials"]).toBe("op://Personal/ttctl");
    // No token in the seed — the fresh-session test will sign in to acquire one.
    expect("token" in auth).toBe(false);
  });

  it("DROPS any token from the source config (clean Form A/B start)", async () => {
    // Source is Form D (cred + token); isolated seed must drop the token
    // so the fresh-session test starts clean.
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(
      sourceConfigPath,
      "auth:\n  credentials: op://Personal/ttctl\n  token: source_token_should_not_propagate\n",
      "utf8",
    );

    const fixturePath = await writeIsolatedSessionConfig(workDir, "1", sourceConfigPath);

    const parsed = parseYaml(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const auth = parsed["auth"] as Record<string, unknown>;
    expect("token" in auth).toBe(false);
  });

  it("REJECTS a Form C (token-only) source config — no credentials to seed the isolated signin", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, "auth:\n  token: source_token_only\n", "utf8");

    await expect(writeIsolatedSessionConfig(workDir, "1", sourceConfigPath)).rejects.toThrow(/no auth\.credentials/);
  });

  it("creates the isolated subdirectory if it does not already exist", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, "auth:\n  credentials: op://Personal/ttctl\n", "utf8");

    const fixturePath = await writeIsolatedSessionConfig(workDir, "42", sourceConfigPath);

    await expect(readFile(fixturePath, "utf8")).resolves.toContain("credentials");
    expect(fixturePath).toContain(join(".tmp", "e2e", "isolated-42"));
  });

  it("isolated config is at a different path than the shared sandbox config (separation invariant)", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, "auth:\n  credentials: op://Personal/ttctl\n", "utf8");

    await writeSandboxConfig(workDir, "user_shared_xxx");
    const isolatedPath = await writeIsolatedSessionConfig(workDir, "1", sourceConfigPath);

    expect(isolatedPath).not.toBe(resolveSandboxConfigPath(workDir));
  });
});
