// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, clearAuthToken, loadConfigFile, persistAuthToken } from "../index.js";

/**
 * Integration tests for the post-#107 auth lifecycle. Walks the FULL
 * Form A → Form D → Form A round-trip end-to-end (schema → write-back →
 * re-load) and pins the AC contracts that span multiple primitives:
 *
 *   - AC-1 / AC-2 / AC-3 (schema validation + signin write-back) — Form A
 *     loaded → token persisted → re-load yields Form D with same shape.
 *   - AC-3 (file-mode after persist) — re-load gate accepts 0o600, refuses 0o666.
 *   - AC-3 (yaml comment fidelity) — comments survive the round-trip.
 *   - AC-6 (signout removes auth.token) — clear → re-load yields Form A again.
 *   - AC-9 (refuse-load on world-writable) — chmod 0o666 blocks the load.
 *   - Hidden trap (symlink): persistAuthToken refuses; loadConfigFile permits.
 *
 * Per-primitive tests live in `config-schema.test.ts`, `config.test.ts`,
 * and `persistAuthToken.test.ts` — this file is the integration layer.
 */
describe("auth lifecycle: Form A → Form D → Form A round-trip", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-lifecycle-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("Form A (1P ref) → signin persists token → re-load is Form D → signout removes token → re-load is Form A again", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    // Phase 1: Form A loads cleanly.
    const formA = loadConfigFile(configPath);
    expect(formA.auth.credentials).toBe("op://Personal/ttctl");
    expect(formA.auth.token).toBeUndefined();

    // Phase 2: persist a captured bearer (simulates auth signin success).
    await persistAuthToken(configPath, "user_lifecycle_token_aaa");

    // Phase 3: re-load is Form D — credentials preserved, token now present.
    const formD = loadConfigFile(configPath);
    expect(formD.auth.credentials).toBe("op://Personal/ttctl");
    expect(formD.auth.token).toBe("user_lifecycle_token_aaa");

    // Phase 4: signout (clear token).
    await clearAuthToken(configPath);

    // Phase 5: re-load is Form A again — credentials preserved, token absent.
    const formAAgain = loadConfigFile(configPath);
    expect(formAAgain.auth.credentials).toBe("op://Personal/ttctl");
    expect(formAAgain.auth.token).toBeUndefined();
  });

  it("Form B (literal {username, password}) → signin → re-load is Form D → signout → re-load is Form B", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials:\n    username: ada@example.com\n    password: hunter2\n", {
      mode: 0o600,
    });

    const formB = loadConfigFile(configPath);
    expect(formB.auth.credentials).toEqual({ username: "ada@example.com", password: "hunter2" });

    await persistAuthToken(configPath, "user_form_b_token_bbb");

    const formD = loadConfigFile(configPath);
    expect(formD.auth.credentials).toEqual({ username: "ada@example.com", password: "hunter2" });
    expect(formD.auth.token).toBe("user_form_b_token_bbb");

    await clearAuthToken(configPath);

    const formBAgain = loadConfigFile(configPath);
    expect(formBAgain.auth.credentials).toEqual({ username: "ada@example.com", password: "hunter2" });
    expect(formBAgain.auth.token).toBeUndefined();
  });

  it("FILE MODE — persist always writes 0o600, even when source was 0o644", async () => {
    if (process.platform === "win32") return;

    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o644 });
    chmodSync(configPath, 0o644); // ensure 0o644 (umask may have intervened)

    await persistAuthToken(configPath, "user_mode_test");

    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("REFUSE LOAD — world-writable config (mode 0o666) blocks the load even when the file is otherwise valid", () => {
    if (process.platform === "win32") return;

    const configPath = join(tmpRoot, ".ttctl.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n  token: user_world_writable_xxx\n", {
      mode: 0o600,
    });
    chmodSync(configPath, 0o666);

    try {
      loadConfigFile(configPath);
      expect.fail("expected ConfigError(PERMISSION)");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("PERMISSION");
      expect((err as ConfigError).message).toMatch(/world-writable/);
    }
  });

  it("YAML COMMENT FIDELITY — leading + inline + trailing comments survive a full lifecycle round-trip", async () => {
    const configPath = join(tmpRoot, ".ttctl.yaml");
    const original = [
      "# Canonical TTCtl config",
      "# Maintained: 2026-05-08",
      "",
      "auth:",
      "  # 1Password reference for the maintainer's vault",
      "  credentials: op://Personal/ttctl",
      "",
      "# end of file",
      "",
    ].join("\n");
    writeFileSync(configPath, original, { mode: 0o600 });

    await persistAuthToken(configPath, "user_comment_fidelity_test");

    const afterPersist = readFileSync(configPath, "utf8");
    expect(afterPersist).toContain("# Canonical TTCtl config");
    expect(afterPersist).toContain("# Maintained: 2026-05-08");
    expect(afterPersist).toContain("# 1Password reference for the maintainer's vault");
    expect(afterPersist).toContain("# end of file");
    expect(afterPersist).toMatch(/token:\s*user_comment_fidelity_test/);

    await clearAuthToken(configPath);

    const afterClear = readFileSync(configPath, "utf8");
    expect(afterClear).toContain("# Canonical TTCtl config");
    expect(afterClear).toContain("# 1Password reference for the maintainer's vault");
    expect(afterClear).not.toMatch(/token:/);
  });

  it("SYMLINK ASYMMETRY — load permits symlinked config; persistAuthToken refuses (write-side gate)", async () => {
    if (process.platform === "win32") return;

    const realConfig = join(tmpRoot, "real.yaml");
    writeFileSync(realConfig, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    const linkPath = join(tmpRoot, "link.yaml");
    symlinkSync(realConfig, linkPath);

    // LOAD via symlink: permitted (read-only, no TOCTOU on write).
    const loaded = loadConfigFile(linkPath);
    expect(loaded.auth.credentials).toBe("op://Personal/ttctl");

    // PERSIST via symlink: refused with ConfigError(PERMISSION).
    try {
      await persistAuthToken(linkPath, "user_symlink_attack_xxx");
      expect.fail("expected ConfigError(PERMISSION)");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("PERMISSION");
      expect((err as ConfigError).message).toMatch(/symlink/i);
    }

    // Real file must NOT have been mutated.
    const realAfter = readFileSync(realConfig, "utf8");
    expect(realAfter).not.toMatch(/token:/);
  });

  it("RESOLUTION CHAIN REGRESSION — XDG / CWD / ~/.config paths are not consulted (a config in those locations is invisible to resolveConfig)", async () => {
    if (process.platform === "win32") return;

    // Seed configs at all the paths that USED to be consulted but no
    // longer are. resolveConfig must NOT find any of them.
    mkdirSync(join(tmpRoot, "xdg", "ttctl"), { recursive: true });
    writeFileSync(join(tmpRoot, "xdg", "ttctl", "config.yaml"), "auth:\n  credentials: op://XDG/should-not-load\n", {
      mode: 0o600,
    });
    mkdirSync(join(tmpRoot, ".config", "ttctl"), { recursive: true });
    writeFileSync(
      join(tmpRoot, ".config", "ttctl", "config.yaml"),
      "auth:\n  credentials: op://HomeConfig/should-not-load\n",
      { mode: 0o600 },
    );
    const cwdConfig = join(tmpRoot, "cwd-area", ".ttctl.yaml");
    mkdirSync(join(tmpRoot, "cwd-area"), { recursive: true });
    writeFileSync(cwdConfig, "auth:\n  credentials: op://CWD/should-not-load\n", { mode: 0o600 });

    // No ~/.ttctl.yaml seeded — so the resolution chain must come up empty.
    const savedHome = process.env["HOME"];
    const savedXdg = process.env["XDG_CONFIG_HOME"];
    const savedTtctl = process.env["TTCTL_CONFIG_FILE"];
    process.env["HOME"] = tmpRoot;
    process.env["XDG_CONFIG_HOME"] = join(tmpRoot, "xdg");
    delete process.env["TTCTL_CONFIG_FILE"];

    const originalCwd = process.cwd();
    process.chdir(join(tmpRoot, "cwd-area"));

    try {
      // Re-import to re-resolve env reads — but resolveConfig reads process.env
      // every call, so a direct import is fine.
      const { resolveConfig } = await import("../index.js");

      try {
        resolveConfig();
        expect.fail("expected ConfigError(NO_CREDS)");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("NO_CREDS");
      }
    } finally {
      process.chdir(originalCwd);
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      if (savedXdg !== undefined) process.env["XDG_CONFIG_HOME"] = savedXdg;
      else delete process.env["XDG_CONFIG_HOME"];
      if (savedTtctl !== undefined) process.env["TTCTL_CONFIG_FILE"] = savedTtctl;
      else delete process.env["TTCTL_CONFIG_FILE"];
    }
  });
});
