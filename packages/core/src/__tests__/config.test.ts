// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigError, discoverConfigPath, loadConfigFile, resolveConfig } from "../config.js";

/**
 * Filesystem-backed tests for the post-#107 3-step resolution chain
 * (`--config` → `TTCTL_CONFIG_FILE` → `~/.ttctl.yaml`) and `loadConfigFile`.
 * Schema tests live in `config-schema.test.ts` to keep concerns split.
 *
 * Each test is isolated:
 *   - Fresh tmp dir for fixtures.
 *   - HOME / USERPROFILE redirected to tmp dir so `~/.ttctl.yaml`
 *     resolves into the fixture, not the user's real config.
 *   - TTCTL_CONFIG_FILE / XDG_CONFIG_HOME cleared per test, set explicitly
 *     when the test exercises them.
 *   - process.cwd() left untouched (we use absolute mkdtemp paths so
 *     legacy CWD `.ttctl.yaml` discovery isn't accidentally exercised).
 */
describe("config resolution (3-step chain — post-#107)", () => {
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
   * Write a valid Form A config at `path` (creating parent dirs as needed)
   * and return the path.
   */
  function writeConfig(path: string, body = "auth:\n  credentials: op://Personal/ttctl\n"): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  }

  describe("discoverConfigPath", () => {
    it("step 1: explicit `path` wins over env and home", () => {
      const explicit = join(tmpRoot, "explicit.yaml");
      process.env["TTCTL_CONFIG_FILE"] = "/should/not/win.yaml";
      writeConfig(join(tmpRoot, ".ttctl.yaml"));

      // Explicit path is returned verbatim, no existence check.
      expect(discoverConfigPath(explicit)).toBe(explicit);
    });

    it("step 2: TTCTL_CONFIG_FILE env wins over ~/.ttctl.yaml", () => {
      const envFile = join(tmpRoot, "from-env.yaml");
      process.env["TTCTL_CONFIG_FILE"] = envFile;
      writeConfig(join(tmpRoot, ".ttctl.yaml"));

      // Env value is returned verbatim, no existence check.
      expect(discoverConfigPath()).toBe(envFile);
    });

    it("step 3: ~/.ttctl.yaml when TTCTL_CONFIG_FILE is unset and the file exists", () => {
      const homeFile = writeConfig(join(tmpRoot, ".ttctl.yaml"));

      expect(discoverConfigPath()).toBe(homeFile);
    });

    it("step 3 — empty TTCTL_CONFIG_FILE treated as unset, falls through to ~/.ttctl.yaml", () => {
      const homeFile = writeConfig(join(tmpRoot, ".ttctl.yaml"));
      process.env["TTCTL_CONFIG_FILE"] = "";

      expect(discoverConfigPath()).toBe(homeFile);
    });

    it("returns null when no source produces a path", () => {
      // No env, no home file. HOME → empty tmpRoot.
      expect(discoverConfigPath()).toBeNull();
    });

    it("REGRESSION: does NOT consult $XDG_CONFIG_HOME/ttctl/config.yaml (post-#107)", () => {
      const xdgDir = join(tmpRoot, "xdg");
      writeConfig(join(xdgDir, "ttctl", "config.yaml"));
      process.env["XDG_CONFIG_HOME"] = xdgDir;

      expect(discoverConfigPath()).toBeNull();
    });

    it("REGRESSION: does NOT consult ~/.config/ttctl/config.yaml (post-#107)", () => {
      writeConfig(join(tmpRoot, ".config", "ttctl", "config.yaml"));

      expect(discoverConfigPath()).toBeNull();
    });

    it("REGRESSION: does NOT auto-discover ./.ttctl.yaml in CWD (preserved from #92)", () => {
      // Write a config at the legacy CWD location and chdir into it.
      const fakeCwd = join(tmpRoot, "fake-cwd");
      mkdirSync(fakeCwd, { recursive: true });
      writeFileSync(join(fakeCwd, ".ttctl.yaml"), "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });
      const originalCwd = process.cwd();
      process.chdir(fakeCwd);
      try {
        expect(discoverConfigPath()).toBeNull();
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("resolveConfig", () => {
    it("path option wins over TTCTL_CONFIG_FILE env var", () => {
      const explicit = writeConfig(join(tmpRoot, "explicit.yaml"));
      const envFile = writeConfig(join(tmpRoot, "from-env.yaml"), "auth:\n  credentials: op://Personal/from-env\n");
      process.env["TTCTL_CONFIG_FILE"] = envFile;

      const result = resolveConfig({ path: explicit });

      expect(result.path).toBe(explicit);
      expect(result.config.auth.credentials).toBe("op://Personal/ttctl");
    });

    it("missing config (resolution chain returns null) → ConfigError(NO_CREDS) listing all 3 candidates", () => {
      try {
        resolveConfig();
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("NO_CREDS");
        const message = (err as ConfigError).message;
        expect(message).toMatch(/--config/);
        expect(message).toMatch(/TTCTL_CONFIG_FILE/);
        expect(message).toMatch(/~\/\.ttctl\.yaml/);
      }
    });

    it("explicit path doesn't exist → ConfigError(NO_CREDS) carries the path", () => {
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

    it("TTCTL_CONFIG_FILE points to non-existent path → ConfigError(NO_CREDS)", () => {
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

    it("CWD .ttctl.yaml exists but resolution chain finds nothing → migration message names TTCTL_CONFIG_FILE + ~/.ttctl.yaml", () => {
      const fakeCwd = join(tmpRoot, "fake-cwd");
      mkdirSync(fakeCwd, { recursive: true });
      writeFileSync(join(fakeCwd, ".ttctl.yaml"), "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });
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
        expect((err as ConfigError).message).toMatch(/~\/\.ttctl\.yaml/);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("malformed YAML → ConfigError(PARSE)", () => {
      const badPath = writeConfig(join(tmpRoot, "bad.yaml"), ":::\nthis is\n  not valid yaml :::\n");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("PARSE");
        expect((err as ConfigError).path).toBe(badPath);
      }
    });

    it("schema validation failure → ConfigError(VALIDATION) with field-named message", () => {
      // Use a structurally invalid auth block (object with bad sub-shape) so this
      // test continues to exercise the post-#107 superRefine path. Pre-#107
      // auth-as-string now flows through the dedicated legacy-shape detector
      // (covered separately in the "legacy pre-#107 shape detection" suite).
      const badPath = writeConfig(
        join(tmpRoot, "invalid.yaml"),
        "auth:\n  credentials:\n    username: not-an-email\n    password: hunter2\n",
      );
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("VALIDATION");
        expect((err as ConfigError).path).toBe(badPath);
        expect((err as ConfigError).message).toMatch(/auth\.credentials\.username/);
      }
    });

    it("permission warning fires for 0o644 config (POSIX), NOT for 0o600", () => {
      if (process.platform === "win32") return;
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

    it("REFUSE LOAD — world-writable config (mode 0o666) → ConfigError(PERMISSION)", () => {
      if (process.platform === "win32") return;
      const path = writeConfig(join(tmpRoot, "world-writable.yaml"));
      chmodSync(path, 0o666);

      try {
        resolveConfig({ path });
        expect.fail("expected ConfigError(PERMISSION)");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("PERMISSION");
        expect((err as ConfigError).message).toMatch(/world-writable/i);
        expect((err as ConfigError).message).toMatch(/0666/);
      }
    });

    it("loads a valid Form A config via the explicit path option", () => {
      const path = writeConfig(join(tmpRoot, "good.yaml"));
      const result = resolveConfig({ path });
      expect(result.path).toBe(path);
      expect(result.config.auth.credentials).toBe("op://Personal/ttctl");
    });

    it("loads a valid Form C (token-only) config via TTCTL_CONFIG_FILE env var", () => {
      const path = writeConfig(join(tmpRoot, "token-only.yaml"), "auth:\n  token: user_xxx_yyy\n");
      process.env["TTCTL_CONFIG_FILE"] = path;
      const result = resolveConfig();
      expect(result.path).toBe(path);
      expect(result.config.auth.token).toBe("user_xxx_yyy");
      expect(result.config.auth.credentials).toBeUndefined();
    });

    it("loads a Form D (credentials + token) config via ~/.ttctl.yaml", () => {
      const path = writeConfig(
        join(tmpRoot, ".ttctl.yaml"),
        "auth:\n  credentials: op://Personal/ttctl\n  token: user_xxx_yyy\n",
      );
      const result = resolveConfig();
      expect(result.path).toBe(path);
      expect(result.config.auth.credentials).toBe("op://Personal/ttctl");
      expect(result.config.auth.token).toBe("user_xxx_yyy");
    });
  });

  describe("loadConfigFile", () => {
    it("ENOENT on the resolved path → ConfigError(NO_CREDS) with path attached", () => {
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

    it("EACCES on the resolved path → ConfigError(PERMISSION) (POSIX only)", () => {
      if (process.platform === "win32") return;
      // Skip when running as root — chmod 0o000 doesn't restrict root.
      if (typeof process.getuid === "function" && process.getuid() === 0) return;

      const target = join(tmpRoot, "no-read.yaml");
      writeFileSync(target, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });
      chmodSync(target, 0o000);
      try {
        loadConfigFile(target);
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe("PERMISSION");
        expect((err as ConfigError).path).toBe(target);
      } finally {
        chmodSync(target, 0o600);
      }
    });
  });

  describe("symlink behavior at load time", () => {
    it("ALLOWS loading from a symlink (read-only path); persistAuthToken is the gate that refuses symlinks for WRITE", () => {
      if (process.platform === "win32") return;

      const real = join(tmpRoot, "real.yaml");
      writeFileSync(real, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });
      const link = join(tmpRoot, "link.yaml");
      symlinkSync(real, link);

      // Read is permitted — the load-side risk (TOCTOU on the symlink) is
      // mitigated by the fact that we don't write to the load path. The
      // attack surface that matters is the WRITE path, gated separately
      // in persistAuthToken.
      const result = resolveConfig({ path: link });
      expect(result.config.auth.credentials).toBe("op://Personal/ttctl");
    });
  });

  /**
   * Pre-#107, the user-facing auth shape was a top-level string
   * (`auth: "op://..."`). Post-#107, the structured `{ credentials, token }`
   * block replaced it. A user upgrading without re-authoring would otherwise
   * see opaque Zod "Invalid input" output; the legacy-shape detector
   * intercepts pre-Zod and emits a copy-pasteable migration hint.
   *
   * Detection happens in `loadConfigFile` after `parseYaml` and before
   * `ConfigLoadSchema.safeParse` — the strict load schema rejects auth-as-
   * string at union discrimination, so superRefine never fires and the hint
   * MUST land upstream of Zod.
   */
  describe("legacy pre-#107 shape detection (auth-as-string)", () => {
    it('auth: "op://..." → ConfigError(VALIDATION) with literal offending shape, corrected shape, and CLAUDE.md reference', () => {
      const badPath = writeConfig(join(tmpRoot, "legacy-form-a.yaml"), `auth: "op://Personal/ttctl"\n`);
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
        expect(ce.path).toBe(badPath);

        // Literal offending shape (mechanically copy-pasteable from message back into a YAML file).
        expect(ce.message).toContain(`    auth: "op://Personal/ttctl"`);

        // Corrected shape (also literally valid YAML).
        expect(ce.message).toContain(`    auth:\n      credentials: "op://Personal/ttctl"`);

        // Canonical doc reference.
        expect(ce.message).toContain("CLAUDE.md § Auth Model");

        // Names the legacy provenance so users know WHY they're seeing this.
        expect(ce.message).toContain("legacy pre-#107 shape");
      }
    });

    it("auth: <unquoted-string> → detected (YAML scalar without quotes is still a string)", () => {
      // The unquoted form is what most users actually wrote pre-#107
      // because the value didn't contain any YAML-significant characters.
      const badPath = writeConfig(join(tmpRoot, "legacy-unquoted.yaml"), "auth: op://Personal/ttctl\n");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
        // Message wraps the value in quotes so the corrected shape is valid YAML.
        expect(ce.message).toContain(`    auth: "op://Personal/ttctl"`);
        expect(ce.message).toContain(`    auth:\n      credentials: "op://Personal/ttctl"`);
      }
    });

    it('JSON wire-format: error has shape { code: "VALIDATION", message: <migration text> }', () => {
      const badPath = writeConfig(join(tmpRoot, "legacy-json-wire.yaml"), `auth: "op://Personal/ttctl"\n`);
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        // The CLI/MCP error renderers serialize ConfigError as { code, message };
        // the legacy hint is part of `message`, NOT a separate stderr emit.
        const ce = err as ConfigError;
        const wire: { code: string; message: string } = { code: ce.code, message: ce.message };
        expect(wire.code).toBe("VALIDATION");
        expect(wire.message).toContain("legacy pre-#107 shape");
        expect(wire.message).toContain("CLAUDE.md § Auth Model");
        // Round-trip via JSON.stringify/parse to lock the wire-format invariant.
        const roundTripped = JSON.parse(JSON.stringify(wire)) as { code: string; message: string };
        expect(roundTripped.code).toBe("VALIDATION");
        expect(roundTripped.message).toContain(`    auth:\n      credentials: "op://Personal/ttctl"`);
      }
    });

    it("non-detection: object-shaped auth with malformed sub-fields uses superRefine path (no migration hint)", () => {
      // Object at `auth` is NOT the legacy shape. Falls through to Zod / superRefine.
      const badPath = writeConfig(
        join(tmpRoot, "object-malformed.yaml"),
        "auth:\n  credentials:\n    username: ada@example.com\n    # password missing\n",
      );
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
        // Existing superRefine field-naming should fire.
        expect(ce.message).toMatch(/auth\.credentials/);
        // Migration hint MUST NOT appear for object-shaped auth.
        expect(ce.message).not.toContain("legacy pre-#107 shape");
        expect(ce.message).not.toContain("Migrate to the structured shape");
      }
    });

    it("non-detection: empty auth: {} uses superRefine path (no migration hint)", () => {
      const badPath = writeConfig(join(tmpRoot, "empty-auth.yaml"), "auth: {}\n");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
        expect(ce.message).toMatch(/at least one of/i);
        expect(ce.message).not.toContain("legacy pre-#107 shape");
      }
    });

    it("non-detection: number at auth (auth: 123) falls through to Zod (not auth-as-string)", () => {
      const badPath = writeConfig(join(tmpRoot, "auth-number.yaml"), "auth: 123\n");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
        expect(ce.message).not.toContain("legacy pre-#107 shape");
      }
    });

    it("non-detection: array at auth (auth: [a, b]) falls through to Zod (not auth-as-string)", () => {
      const badPath = writeConfig(join(tmpRoot, "auth-array.yaml"), "auth:\n  - a\n  - b\n");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
        expect(ce.message).not.toContain("legacy pre-#107 shape");
      }
    });

    it("non-detection: missing auth field entirely falls through to Zod", () => {
      const badPath = writeConfig(join(tmpRoot, "no-auth.yaml"), "other: value\n");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
        expect(ce.message).not.toContain("legacy pre-#107 shape");
      }
    });

    it("non-detection: empty YAML (parses to null) falls through to Zod", () => {
      const badPath = writeConfig(join(tmpRoot, "empty.yaml"), "");
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
        expect(ce.message).not.toContain("legacy pre-#107 shape");
      }
    });

    it("legacy-shape detection still uses VALIDATION code (preserves CLI/MCP exit-code contract from #107)", () => {
      // REGRESSION pin: do NOT introduce a new code (e.g. LEGACY_SHAPE) — the
      // CLI/MCP error renderers branch on `code` and `VALIDATION` is the
      // contract for "wrong shape, the file exists and parsed".
      const badPath = writeConfig(join(tmpRoot, "code-pin.yaml"), `auth: "op://Personal/ttctl"\n`);
      try {
        resolveConfig({ path: badPath });
        expect.fail("expected ConfigError");
      } catch (err) {
        const ce = err as ConfigError;
        expect(ce.code).toBe("VALIDATION");
      }
    });
  });
});
