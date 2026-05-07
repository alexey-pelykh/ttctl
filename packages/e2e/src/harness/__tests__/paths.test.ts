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
  resolveIsolatedAuthTokenPath,
  resolveIsolatedSessionConfigPath,
  resolveIsolatedSessionDir,
  resolveIsolatedSessionTokenPath,
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
    // workDir itself has neither sentinel and is not in a repo with one
    // upstream that we control. The walk will eventually hit `/` (or a
    // drive root on Windows). On macOS/CI the workDir is under /var/...
    // which has no .git or pnpm-workspace.yaml ancestors.
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

  it("resolveIsolatedAuthTokenPath joins .tmp/e2e/auth.token under the given root", () => {
    expect(resolveIsolatedAuthTokenPath("/repo")).toBe(join("/repo", ".tmp", "e2e", "auth.token"));
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

  it("resolveIsolatedSessionTokenPath joins auth.token inside the isolated subdirectory", () => {
    expect(resolveIsolatedSessionTokenPath("/repo", "1")).toBe(
      join("/repo", ".tmp", "e2e", "isolated-1", "auth.token"),
    );
  });

  it("isolated children all live under their own isolated subdirectory (separation from shared sandbox)", () => {
    const root = "/r";
    const isolatedDir = resolveIsolatedSessionDir(root, "1");
    expect(resolveIsolatedSessionConfigPath(root, "1").startsWith(isolatedDir)).toBe(true);
    expect(resolveIsolatedSessionTokenPath(root, "1").startsWith(isolatedDir)).toBe(true);
    // Critically, isolated paths do NOT collide with the SHARED token/config
    // — adversarial corruption is contained to its own subtree.
    expect(resolveIsolatedSessionTokenPath(root, "1")).not.toBe(resolveIsolatedAuthTokenPath(root));
    expect(resolveIsolatedSessionConfigPath(root, "1")).not.toBe(resolveSandboxConfigPath(root));
  });

  it("isolated subdirectories with different ids do not collide", () => {
    expect(resolveIsolatedSessionDir("/r", "1")).not.toBe(resolveIsolatedSessionDir("/r", "2"));
    expect(resolveIsolatedSessionTokenPath("/r", "1")).not.toBe(resolveIsolatedSessionTokenPath("/r", "2"));
  });

  it("sandbox children all live under resolveSandboxDir", () => {
    const root = "/r";
    const sandbox = resolveSandboxDir(root);
    expect(resolveSandboxConfigPath(root).startsWith(sandbox)).toBe(true);
    expect(cliConfigPath(root).startsWith(sandbox)).toBe(true);
    expect(resolveIsolatedAuthTokenPath(root).startsWith(sandbox)).toBe(true);
    expect(resolveLockfilePath(root).startsWith(sandbox)).toBe(true);
    expect(resolveSharedSessionFilePath(root).startsWith(sandbox)).toBe(true);
    // Isolated subdirs ALSO live under the sandbox — same `rm -rf .tmp/e2e/`
    // cleanup contract.
    expect(resolveIsolatedSessionDir(root, "1").startsWith(sandbox)).toBe(true);
  });
});

describe("writeSandboxConfig", () => {
  it("creates the sandbox dir and writes a fixture .ttctl.yaml mirroring the source `auth` field", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, 'auth: "op://Personal/ttctl"\n', "utf8");

    const fixturePath = await writeSandboxConfig(workDir, sourceConfigPath);

    expect(fixturePath).toBe(resolveSandboxConfigPath(workDir));
    const written = await readFile(fixturePath, "utf8");
    const parsed = parseYaml(written) as Record<string, unknown>;
    expect(parsed["auth"]).toBe("op://Personal/ttctl");
    expect(parsed["auth-token-path"]).toBe("./auth.token");
  });

  it("forces auth-token-path to ./auth.token even if the source config sets a different value", async () => {
    // The harness must own auth-token-path exactly, regardless of what the
    // user has configured — otherwise a user with `auth-token-path:
    // /custom/loc/auth.token` would have E2E write into that custom
    // location, breaking the isolation contract.
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(
      sourceConfigPath,
      ['auth: "op://Personal/ttctl"', 'auth-token-path: "/custom/loc/auth.token"', ""].join("\n"),
      "utf8",
    );

    const fixturePath = await writeSandboxConfig(workDir, sourceConfigPath);

    const parsed = parseYaml(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    expect(parsed["auth-token-path"]).toBe("./auth.token");
  });

  it("mirrors the literal-credentials form (object auth)", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(
      sourceConfigPath,
      ["auth:", '  email: "user@example.com"', '  password: "hunter2"', ""].join("\n"),
      "utf8",
    );

    const fixturePath = await writeSandboxConfig(workDir, sourceConfigPath);

    const parsed = parseYaml(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    const auth = parsed["auth"] as Record<string, unknown>;
    expect(auth["email"]).toBe("user@example.com");
    expect(auth["password"]).toBe("hunter2");
    expect(parsed["auth-token-path"]).toBe("./auth.token");
  });

  it("rejects a malformed source config (validation runs against ConfigSchema)", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    // No `auth` field — ConfigSchema rejects this.
    await writeFile(sourceConfigPath, "not-auth: nope\n", "utf8");

    await expect(writeSandboxConfig(workDir, sourceConfigPath)).rejects.toThrow();
  });

  it("creates the sandbox directory if it does not already exist", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, 'auth: "op://Personal/ttctl"\n', "utf8");
    // workDir is empty — no .tmp, no .tmp/e2e.

    const fixturePath = await writeSandboxConfig(workDir, sourceConfigPath);

    // Reading the fixture proves the dir was created (writeFile would
    // otherwise reject with ENOENT for the missing parent).
    await expect(readFile(fixturePath, "utf8")).resolves.toContain("auth-token-path");
  });
});

describe("writeIsolatedSessionConfig", () => {
  it("writes a fixture .ttctl.yaml inside .tmp/e2e/isolated-<id>/, mirroring the source `auth` field", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, 'auth: "op://Personal/ttctl"\n', "utf8");

    const fixturePath = await writeIsolatedSessionConfig(workDir, "1", sourceConfigPath);

    expect(fixturePath).toBe(resolveIsolatedSessionConfigPath(workDir, "1"));
    const parsed = parseYaml(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    expect(parsed["auth"]).toBe("op://Personal/ttctl");
    expect(parsed["auth-token-path"]).toBe("./auth.token");
  });

  it("forces auth-token-path to ./auth.token even when source sets a different value (isolation contract)", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(
      sourceConfigPath,
      ['auth: "op://Personal/ttctl"', 'auth-token-path: "/custom/loc/auth.token"', ""].join("\n"),
      "utf8",
    );

    const fixturePath = await writeIsolatedSessionConfig(workDir, "1", sourceConfigPath);

    const parsed = parseYaml(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
    expect(parsed["auth-token-path"]).toBe("./auth.token");
  });

  it("creates the isolated subdirectory if it does not already exist", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, 'auth: "op://Personal/ttctl"\n', "utf8");

    const fixturePath = await writeIsolatedSessionConfig(workDir, "42", sourceConfigPath);

    // Reading proves the parent dir was created.
    await expect(readFile(fixturePath, "utf8")).resolves.toContain("auth-token-path");
    expect(fixturePath).toContain(join(".tmp", "e2e", "isolated-42"));
  });

  it("isolated config is at a different path than the shared sandbox config (separation invariant)", async () => {
    const sourceConfigPath = join(workDir, "src.yaml");
    await writeFile(sourceConfigPath, 'auth: "op://Personal/ttctl"\n', "utf8");

    await writeSandboxConfig(workDir, sourceConfigPath);
    const isolatedPath = await writeIsolatedSessionConfig(workDir, "1", sourceConfigPath);

    expect(isolatedPath).not.toBe(resolveSandboxConfigPath(workDir));
  });
});
