// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "../config.js";
import { AuthTokenPersistError, clearAuthToken, persistAuthToken } from "../configWriter.js";

/**
 * Filesystem-backed tests for `persistAuthToken` and `clearAuthToken`.
 * Each test isolates itself in a fresh tmp dir; the suite is a no-op on
 * Windows where mode bits and symlinks are not meaningful.
 */
describe("persistAuthToken — Form A → Form D round-trip", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-persist-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes auth.token alongside auth.credentials (1P reference) — both fields present after persist", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    await persistAuthToken(configPath, "user_abc123def456789012345678_thirty20charBearer");

    const after = readFileSync(configPath, "utf8");
    expect(after).toMatch(/credentials:\s*op:\/\/Personal\/ttctl/);
    expect(after).toMatch(/token:\s*user_abc123def456789012345678_thirty20charBearer/);
  });

  it("writes auth.token alongside auth.credentials (literal {username, password}) — preserves both", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials:\n    username: ada@example.com\n    password: hunter2\n", {
      mode: 0o600,
    });

    await persistAuthToken(configPath, "user_xxx_yyy");

    const after = readFileSync(configPath, "utf8");
    expect(after).toMatch(/username:\s*ada@example\.com/);
    expect(after).toMatch(/password:\s*hunter2/);
    expect(after).toMatch(/token:\s*user_xxx_yyy/);
  });

  it("REPLACES an existing token without re-writing the credentials value (Form D → Form D refresh)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n  token: old_user_token_value_aaa\n", {
      mode: 0o600,
    });

    await persistAuthToken(configPath, "new_user_token_value_zzz");

    const after = readFileSync(configPath, "utf8");
    expect(after).not.toMatch(/old_user_token_value_aaa/);
    expect(after).toMatch(/token:\s*new_user_token_value_zzz/);
    expect(after).toMatch(/credentials:\s*op:\/\/Personal\/ttctl/);
  });

  it("PRESERVES leading and inline comments (yaml comment fidelity per DQ-2)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    const original = [
      "# Top-of-file comment about TTCtl auth",
      "# Created 2026-05-08 — hands off, version-controlled",
      "",
      "auth:",
      "  # 1Password reference for the maintainer's vault",
      "  credentials: op://Personal/ttctl",
      "",
    ].join("\n");
    writeFileSync(configPath, original, { mode: 0o600 });

    await persistAuthToken(configPath, "user_with_preserved_comments_123");

    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("# Top-of-file comment about TTCtl auth");
    expect(after).toContain("# Created 2026-05-08");
    expect(after).toContain("# 1Password reference for the maintainer's vault");
    expect(after).toMatch(/token:\s*user_with_preserved_comments_123/);
  });

  it("post-write file mode is 0o600 (POSIX) — refuse-load gates rely on this", async () => {
    if (process.platform === "win32") return;

    const configPath = join(tmpRoot, ".ttctl.yaml");
    // Author the file with deliberate 0o644 — persist must tighten it.
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o644 });
    chmodSync(configPath, 0o644);

    await persistAuthToken(configPath, "user_mode_test_123");

    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("REJECTS empty token (caller bug — should call clearAuthToken instead)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    await expect(persistAuthToken(configPath, "")).rejects.toBeInstanceOf(AuthTokenPersistError);
  });

  it("non-existent config path → AuthTokenPersistError (signin must not silently create)", async () => {
    const missing = join(tmpRoot, "does-not-exist.yaml");
    await expect(persistAuthToken(missing, "user_xxx_yyy")).rejects.toBeInstanceOf(AuthTokenPersistError);
  });

  it("malformed YAML → AuthTokenPersistError with bearer-rescue line in message", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, ":::\nthis is\n  not valid yaml :::\n", { mode: 0o600 });

    try {
      await persistAuthToken(configPath, "user_rescue_token_xyz");
      expect.fail("expected AuthTokenPersistError");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthTokenPersistError);
      expect((err as AuthTokenPersistError).bearerRescue).toBe("user_rescue_token_xyz");
    }
  });
});

describe("persistAuthToken — security gates", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-persist-security-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("REFUSES symlinked config file with ConfigError(PERMISSION) — closes the symlink-redirection attack", async () => {
    if (process.platform === "win32") return;

    const realConfig = join(tmpRoot, "real.yaml");
    writeFileSync(realConfig, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    const symlinkPath = join(tmpRoot, ".ttctl.yaml");
    symlinkSync(realConfig, symlinkPath);

    try {
      await persistAuthToken(symlinkPath, "user_should_not_persist");
      expect.fail("expected ConfigError(PERMISSION)");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("PERMISSION");
      expect((err as ConfigError).message).toMatch(/symlink/i);
    }

    // Underlying file must NOT be mutated.
    const after = readFileSync(realConfig, "utf8");
    expect(after).not.toMatch(/token:/);
  });

  it("REFUSES paths under ~/Library/Mobile Documents/ (macOS iCloud) with ConfigError(PERMISSION)", async () => {
    if (process.platform === "win32") return;

    const fakeHome = mkdtempSync(join(tmpdir(), "ttctl-fakehome-icloud-"));
    const savedHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
    try {
      const iCloudDir = join(fakeHome, "Library", "Mobile Documents", "com~apple~CloudDocs");
      mkdirSync(iCloudDir, { recursive: true });
      const configPath = join(iCloudDir, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      try {
        await persistAuthToken(configPath, "user_should_not_replicate");
        expect.fail("expected ConfigError(PERMISSION)");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("PERMISSION");
        expect((err as ConfigError).message).toMatch(/sync-root|Mobile Documents/);
      }

      // File must NOT be mutated.
      const after = readFileSync(configPath, "utf8");
      expect(after).not.toMatch(/token:/);
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("REFUSES paths under ~/Dropbox/ with ConfigError(PERMISSION)", async () => {
    if (process.platform === "win32") return;

    const fakeHome = mkdtempSync(join(tmpdir(), "ttctl-fakehome-dropbox-"));
    const savedHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
    try {
      const dropboxDir = join(fakeHome, "Dropbox");
      mkdirSync(dropboxDir, { recursive: true });
      const configPath = join(dropboxDir, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      try {
        await persistAuthToken(configPath, "user_should_not_replicate");
        expect.fail("expected ConfigError(PERMISSION)");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("PERMISSION");
        expect((err as ConfigError).message).toMatch(/sync-root|Dropbox/);
      }
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("ACCEPTS paths under ~/DropboxOther/ (sibling-name false-positive guard)", async () => {
    if (process.platform === "win32") return;

    const fakeHome = mkdtempSync(join(tmpdir(), "ttctl-fakehome-dropbox-other-"));
    const savedHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
    try {
      const dir = join(fakeHome, "DropboxOther");
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      // Should NOT throw — sibling name match is rejected.
      await persistAuthToken(configPath, "user_ok_to_persist_xxx");

      const after = readFileSync(configPath, "utf8");
      expect(after).toMatch(/token:\s*user_ok_to_persist_xxx/);
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("clearAuthToken", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-clear-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("REMOVES auth.token field (not empties to '') and PRESERVES auth.credentials", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n  token: user_existing_xxx_yyy\n", {
      mode: 0o600,
    });

    await clearAuthToken(configPath);

    const after = readFileSync(configPath, "utf8");
    expect(after).toMatch(/credentials:\s*op:\/\/Personal\/ttctl/);
    expect(after).not.toMatch(/token:/);
    // Belt-and-braces: empty-string token is the wrong shape — must be ABSENT, not "".
    expect(after).not.toMatch(/token:\s*['"]['"]/);
    expect(after).not.toMatch(/token:\s*$/m);
  });

  it("idempotent — clearing a Form A config with no token field is a no-op success", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    const original = "auth:\n  credentials: op://Personal/ttctl\n";
    writeFileSync(configPath, original, { mode: 0o600 });

    await clearAuthToken(configPath);

    const after = readFileSync(configPath, "utf8");
    expect(after).toMatch(/credentials:\s*op:\/\/Personal\/ttctl/);
    expect(after).not.toMatch(/token:/);
  });

  it("Form C → empty auth: clearing the only field leaves an empty `auth:` block (acceptable per FR-4.3)", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  token: user_only_xxx\n", { mode: 0o600 });

    await clearAuthToken(configPath);

    const after = readFileSync(configPath, "utf8");
    // The file MUST still exist and parse as YAML; what remains is empty
    // `auth:` (or `auth: {}` after re-emission). The next `loadConfigFile`
    // will fail with NO_CREDS-class VALIDATION error — that's the intended
    // contract per the design doc.
    expect(existsSync(configPath)).toBe(true);
    expect(after).not.toMatch(/token:/);
  });

  it("preserves comments around the auth block when removing the token", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    const original = [
      "# top header",
      "auth:",
      "  # credentials sourced from 1P",
      "  credentials: op://Personal/ttctl",
      "  token: user_to_be_cleared",
      "",
    ].join("\n");
    writeFileSync(configPath, original, { mode: 0o600 });

    await clearAuthToken(configPath);

    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("# top header");
    expect(after).toContain("# credentials sourced from 1P");
    expect(after).not.toMatch(/token:/);
  });
});
