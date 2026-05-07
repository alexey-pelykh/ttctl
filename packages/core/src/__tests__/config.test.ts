// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AuthSchema, ConfigError, ConfigSchema, discoverConfigPath, loadConfigFile, resolveConfig } from "../config.js";

describe("AuthSchema", () => {
  it("accepts a 1Password item reference (op://vault/item)", () => {
    const result = AuthSchema.safeParse("op://Personal/ttctl");
    expect(result.success).toBe(true);
  });

  it("accepts a 3-segment 1Password reference (op://account/vault/item)", () => {
    const result = AuthSchema.safeParse("op://my-account/Personal/ttctl");
    expect(result.success).toBe(true);
  });

  it("accepts a 3-segment reference with sign-in email as account", () => {
    const result = AuthSchema.safeParse("op://oleksii@example.com/Private/Toptal");
    expect(result.success).toBe(true);
  });

  it("accepts a 3-segment reference with account UUID", () => {
    const result = AuthSchema.safeParse("op://FB4OMM7TV5GW7HGY2A2NCC7PP4/Private/Toptal");
    expect(result.success).toBe(true);
  });

  it("accepts a literal { email, password } object", () => {
    const result = AuthSchema.safeParse({ email: "user@example.com", password: "hunter2" });
    expect(result.success).toBe(true);
  });

  it("REJECTS per-field op:// references (4-segment op://account/vault/item/field)", () => {
    const result = AuthSchema.safeParse("op://my-account/Personal/ttctl/username");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/no \/field suffix/);
    }
  });

  it("REJECTS 1-segment op:// references (op://VAULT only)", () => {
    const result = AuthSchema.safeParse("op://Personal");
    expect(result.success).toBe(false);
  });

  it("REJECTS bare item names without op:// prefix", () => {
    const result = AuthSchema.safeParse("ttctl");
    expect(result.success).toBe(false);
  });

  it("REJECTS malformed objects (missing password)", () => {
    const result = AuthSchema.safeParse({ email: "user@example.com" });
    expect(result.success).toBe(false);
  });

  it("REJECTS objects with non-email values", () => {
    const result = AuthSchema.safeParse({ email: "not-an-email", password: "x" });
    expect(result.success).toBe(false);
  });

  it("REJECTS arrays", () => {
    const result = AuthSchema.safeParse(["op://Personal/ttctl"]);
    expect(result.success).toBe(false);
  });
});

describe("ConfigSchema", () => {
  it("validates a minimal config with op:// auth", () => {
    const result = ConfigSchema.safeParse({ auth: "op://Personal/ttctl" });
    expect(result.success).toBe(true);
  });

  it("validates a config with literal auth", () => {
    const result = ConfigSchema.safeParse({
      auth: { email: "user@example.com", password: "hunter2" },
    });
    expect(result.success).toBe(true);
  });

  it("REJECTS missing auth", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("auth-token-path is optional — config without it is valid (default platform path applies)", () => {
    const result = ConfigSchema.safeParse({ auth: "op://Personal/ttctl" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["auth-token-path"]).toBeUndefined();
    }
  });

  it("accepts an absolute auth-token-path string", () => {
    const result = ConfigSchema.safeParse({
      auth: "op://Personal/ttctl",
      "auth-token-path": "/var/run/ttctl/auth.token",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["auth-token-path"]).toBe("/var/run/ttctl/auth.token");
    }
  });

  it("accepts a relative auth-token-path string (resolved at runtime against the config-file dir)", () => {
    const result = ConfigSchema.safeParse({
      auth: "op://Personal/ttctl",
      "auth-token-path": "./auth.token",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["auth-token-path"]).toBe("./auth.token");
    }
  });

  it("REJECTS empty-string auth-token-path (zod min(1))", () => {
    const result = ConfigSchema.safeParse({ auth: "op://Personal/ttctl", "auth-token-path": "" });
    expect(result.success).toBe(false);
  });

  it("REJECTS non-string auth-token-path", () => {
    const result = ConfigSchema.safeParse({ auth: "op://Personal/ttctl", "auth-token-path": 42 });
    expect(result.success).toBe(false);
  });
});

/**
 * Filesystem-backed tests for the resolution chain. Each test is isolated:
 *
 *   - A fresh tmp dir for fixtures.
 *   - `HOME` / `USERPROFILE` redirected to the tmp dir so `os.homedir()`
 *     points there — the home default (`~/.config/ttctl/config.yaml`) can
 *     therefore be tested deterministically without leaking the real user's
 *     config file.
 *   - `TTCTL_CONFIG_FILE` and `XDG_CONFIG_HOME` cleared per test, set
 *     explicitly when the test exercises them.
 *   - `process.cwd()` left untouched (we use mkdtempSync absolute paths
 *     so legacy CWD `.ttctl.yaml` discovery isn't accidentally exercised).
 */
describe("config resolution", () => {
  let tmpRoot: string;
  let savedEnv: { TTCTL_CONFIG_FILE?: string; XDG_CONFIG_HOME?: string; HOME?: string; USERPROFILE?: string };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-config-test-"));
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

  /**
   * Write a valid config file at `path` (creating parent dirs as needed)
   * and return the path. Used by precedence tests that need fixture files
   * to exist on disk so `existsSync` checks in `discoverConfigPath` pass.
   *
   * Uses `path.dirname` for parent extraction so the helper works on
   * Windows (where `\\` is the separator) as well as POSIX. A naive
   * regex like `/\/[^/]+$/` matches only POSIX paths and silently
   * collapses to the input path on Windows, which then makes
   * `mkdirSync(parent, { recursive: true })` create a directory at the
   * intended file path — `writeFileSync` then fails with `EISDIR`.
   */
  function writeConfig(path: string, body = "auth: op://Personal/ttctl\n"): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  }

  describe("discoverConfigPath", () => {
    it("explicit path argument wins over TTCTL_CONFIG_FILE, XDG, and home defaults", () => {
      const explicit = join(tmpRoot, "explicit.yaml");
      process.env["TTCTL_CONFIG_FILE"] = "/should/not/win.yaml";
      const xdgDir = join(tmpRoot, "xdg");
      writeConfig(join(xdgDir, "ttctl", "config.yaml"));
      process.env["XDG_CONFIG_HOME"] = xdgDir;
      writeConfig(join(tmpRoot, ".config", "ttctl", "config.yaml"));

      // Explicit path is returned verbatim, no existence check.
      expect(discoverConfigPath(explicit)).toBe(explicit);
    });

    it("TTCTL_CONFIG_FILE env wins over XDG and home defaults", () => {
      const envFile = join(tmpRoot, "from-env.yaml");
      process.env["TTCTL_CONFIG_FILE"] = envFile;
      const xdgDir = join(tmpRoot, "xdg");
      writeConfig(join(xdgDir, "ttctl", "config.yaml"));
      process.env["XDG_CONFIG_HOME"] = xdgDir;
      writeConfig(join(tmpRoot, ".config", "ttctl", "config.yaml"));

      // Env value is returned verbatim, no existence check.
      expect(discoverConfigPath()).toBe(envFile);
    });

    it("returns $XDG_CONFIG_HOME/ttctl/config.yaml when set and exists, no env override", () => {
      const xdgDir = join(tmpRoot, "xdg");
      const xdgConfig = writeConfig(join(xdgDir, "ttctl", "config.yaml"));
      process.env["XDG_CONFIG_HOME"] = xdgDir;
      // Also seed home default — XDG should win.
      writeConfig(join(tmpRoot, ".config", "ttctl", "config.yaml"));

      expect(discoverConfigPath()).toBe(xdgConfig);
    });

    it("falls through to ~/.config/ttctl/config.yaml when XDG is unset", () => {
      const homeConfig = writeConfig(join(tmpRoot, ".config", "ttctl", "config.yaml"));

      expect(discoverConfigPath()).toBe(homeConfig);
    });

    it("falls through to ~/.config/ttctl/config.yaml when XDG is set but the XDG config file does not exist", () => {
      process.env["XDG_CONFIG_HOME"] = join(tmpRoot, "xdg-empty");
      const homeConfig = writeConfig(join(tmpRoot, ".config", "ttctl", "config.yaml"));

      expect(discoverConfigPath()).toBe(homeConfig);
    });

    it("returns null when no config can be found anywhere in the chain", () => {
      // No env, no XDG file, no home file. HOME → empty tmpRoot.
      expect(discoverConfigPath()).toBeNull();
    });

    it("does NOT auto-discover ./.ttctl.yaml in CWD (breaking change)", () => {
      // Write a config at the legacy CWD location (within tmpRoot to keep
      // the test hermetic, then chdir into it just for this test).
      const fakeCwd = join(tmpRoot, "fake-cwd");
      mkdirSync(fakeCwd, { recursive: true });
      writeFileSync(join(fakeCwd, ".ttctl.yaml"), "auth: op://Personal/ttctl\n");
      const originalCwd = process.cwd();
      process.chdir(fakeCwd);
      try {
        // Ambient HOME tmpRoot is empty, no XDG, no env. CWD discovery is
        // dropped, so result is null even though `./.ttctl.yaml` exists.
        expect(discoverConfigPath()).toBeNull();
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("resolveConfig", () => {
    it("path option wins over TTCTL_CONFIG_FILE env var", () => {
      const explicit = writeConfig(join(tmpRoot, "explicit.yaml"));
      const envFile = writeConfig(join(tmpRoot, "from-env.yaml"), "auth: op://Personal/from-env\n");
      process.env["TTCTL_CONFIG_FILE"] = envFile;

      const result = resolveConfig({ path: explicit });

      expect(result.path).toBe(explicit);
      expect(result.config.auth).toBe("op://Personal/ttctl");
    });

    it("missing config (resolution chain returns null) → ConfigError code NO_CREDS", () => {
      // No env, no XDG, no home file.
      try {
        resolveConfig();
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("NO_CREDS");
      }
    });

    it("missing config when explicit path doesn't exist → ConfigError code NO_CREDS", () => {
      const missing = join(tmpRoot, "does-not-exist.yaml");
      try {
        resolveConfig({ path: missing });
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("NO_CREDS");
        expect((err as ConfigError).path).toBe(missing);
      }
    });

    it("missing config when TTCTL_CONFIG_FILE points to a non-existent path → ConfigError code NO_CREDS", () => {
      const missing = join(tmpRoot, "env-missing.yaml");
      process.env["TTCTL_CONFIG_FILE"] = missing;
      try {
        resolveConfig();
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("NO_CREDS");
      }
    });

    it("CWD .ttctl.yaml exists but resolution chain finds nothing → migration message in the NO_CREDS error", () => {
      const fakeCwd = join(tmpRoot, "fake-cwd");
      mkdirSync(fakeCwd, { recursive: true });
      writeFileSync(join(fakeCwd, ".ttctl.yaml"), "auth: op://Personal/ttctl\n");
      const originalCwd = process.cwd();
      process.chdir(fakeCwd);
      try {
        resolveConfig();
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("NO_CREDS");
        expect((err as ConfigError).message).toMatch(/CWD \.ttctl\.yaml was found/);
        expect((err as ConfigError).message).toMatch(/TTCTL_CONFIG_FILE=/);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("malformed YAML → ConfigError code PARSE", () => {
      const badPath = writeConfig(join(tmpRoot, "bad.yaml"), "auth: : invalid yaml :::\n");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("PARSE");
        expect((err as ConfigError).path).toBe(badPath);
      }
    });

    it("schema validation failure → ConfigError code VALIDATION", () => {
      const badPath = writeConfig(join(tmpRoot, "invalid.yaml"), "auth: not-a-valid-op-ref\n");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("VALIDATION");
        expect((err as ConfigError).path).toBe(badPath);
      }
    });

    it("permission warning fires for 0o644 config file on POSIX, NOT for 0o600", () => {
      if (process.platform === "win32") {
        // Windows mode bits are not meaningful; chmod is a no-op or noisy.
        return;
      }
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const wide = writeConfig(join(tmpRoot, "wide.yaml"));
        chmodSync(wide, 0o644);
        resolveConfig({ path: wide });
        const wideCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(wideCalls).toMatch(/group\/world readable/);
        expect(wideCalls).toMatch(/mode 0644/);

        stderrSpy.mockClear();

        const tight = writeConfig(join(tmpRoot, "tight.yaml"));
        chmodSync(tight, 0o600);
        resolveConfig({ path: tight });
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("loads a valid config via the explicit path option", () => {
      const path = writeConfig(join(tmpRoot, "good.yaml"));
      const result = resolveConfig({ path });
      expect(result.path).toBe(path);
      expect(result.config.auth).toBe("op://Personal/ttctl");
    });

    it("loads a valid config via TTCTL_CONFIG_FILE env var", () => {
      const path = writeConfig(join(tmpRoot, "good.yaml"));
      process.env["TTCTL_CONFIG_FILE"] = path;
      const result = resolveConfig();
      expect(result.path).toBe(path);
      expect(result.config.auth).toBe("op://Personal/ttctl");
    });

    it("loads a valid config via $XDG_CONFIG_HOME/ttctl/config.yaml", () => {
      const xdgDir = join(tmpRoot, "xdg");
      const path = writeConfig(join(xdgDir, "ttctl", "config.yaml"));
      process.env["XDG_CONFIG_HOME"] = xdgDir;
      const result = resolveConfig();
      expect(result.path).toBe(path);
    });

    it("loads a valid config via ~/.config/ttctl/config.yaml when XDG is unset", () => {
      const path = writeConfig(join(tmpRoot, ".config", "ttctl", "config.yaml"));
      const result = resolveConfig();
      expect(result.path).toBe(path);
    });
  });

  describe("loadConfigFile", () => {
    it("ENOENT on the resolved path → ConfigError code NO_CREDS with path attached", () => {
      const missing = join(tmpRoot, "missing.yaml");
      try {
        loadConfigFile(missing);
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("NO_CREDS");
        expect((err as ConfigError).path).toBe(missing);
      }
    });

    it("EACCES on the resolved path → ConfigError code PERMISSION (POSIX only)", () => {
      if (process.platform === "win32") return;
      // Skip when running as root — chmod 0o000 doesn't restrict root.
      if (typeof process.getuid === "function" && process.getuid() === 0) return;

      const target = join(tmpRoot, "no-read.yaml");
      writeFileSync(target, "auth: op://Personal/ttctl\n");
      chmodSync(target, 0o000);
      try {
        loadConfigFile(target);
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("PERMISSION");
        expect((err as ConfigError).path).toBe(target);
      } finally {
        // Restore so afterEach's rmSync can clean up.
        chmodSync(target, 0o600);
      }
    });
  });
});
