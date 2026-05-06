// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findRepoRoot, resolveIsolatedJarPath, resolveLockfilePath, resolveRestoreDir } from "../paths.js";

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
  it("resolveIsolatedJarPath joins .tmp/e2e/session.cookies under the given root", () => {
    expect(resolveIsolatedJarPath("/repo")).toBe(join("/repo", ".tmp", "e2e", "session.cookies"));
  });

  it("resolveLockfilePath joins .tmp/e2e/.lock under the given root", () => {
    expect(resolveLockfilePath("/repo")).toBe(join("/repo", ".tmp", "e2e", ".lock"));
  });

  it("resolveRestoreDir joins .tmp/e2e-restore under the given root", () => {
    expect(resolveRestoreDir("/repo")).toBe(join("/repo", ".tmp", "e2e-restore"));
  });

  it("paths are siblings (lock + jar live in same dir, restore is sibling)", () => {
    const root = "/r";
    const jar = resolveIsolatedJarPath(root);
    const lock = resolveLockfilePath(root);
    const restore = resolveRestoreDir(root);
    expect(jar.startsWith(join(root, ".tmp", "e2e"))).toBe(true);
    expect(lock.startsWith(join(root, ".tmp", "e2e"))).toBe(true);
    expect(restore).toBe(join(root, ".tmp", "e2e-restore"));
  });
});
