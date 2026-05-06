// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { dirname, isAbsolute, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAuthTokenPath } from "../authToken.js";
import type { TtctlConfig } from "../config.js";

const baseConfig: TtctlConfig = { auth: "op://Personal/ttctl" };

// Helper: compute the expected resolution the same way the production code
// does, so cross-platform CI (POSIX vs Windows) agrees on the assertion. We
// can't hardcode strings because `node:path.resolve` injects the drive letter
// on Windows when the input is POSIX-rooted, and we can't hardcode Windows
// paths because POSIX `node:path.resolve` doesn't recognize them as absolute.
function expectedFromConfigPath(configPath: string, explicit: string): string {
  return isAbsolute(explicit) ? explicit : resolve(dirname(configPath), explicit);
}

describe("resolveAuthTokenPath — explicit auth-token-path branch", () => {
  it("returns an absolute auth-token-path verbatim (POSIX form)", () => {
    // POSIX `/var/run/...` is absolute on POSIX. On Windows, `node:path.isAbsolute`
    // accepts a leading `/` as drive-relative-absolute, so the verbatim branch
    // also fires. Use the helper so the assertion matches production output.
    const explicit = "/var/run/ttctl/auth.token";
    const config: TtctlConfig = { ...baseConfig, "auth-token-path": explicit };
    const configPath = "/anywhere/.ttctl.yaml";
    expect(resolveAuthTokenPath({ config, configPath, platform: "linux" })).toBe(
      expectedFromConfigPath(configPath, explicit),
    );
  });

  it("resolves a relative auth-token-path against dirname(configPath)", () => {
    const explicit = "./auth.token";
    const config: TtctlConfig = { ...baseConfig, "auth-token-path": explicit };
    const configPath = "/projects/foo/.ttctl.yaml";
    expect(resolveAuthTokenPath({ config, configPath, platform: "linux" })).toBe(
      expectedFromConfigPath(configPath, explicit),
    );
  });

  it("resolves a relative auth-token-path with `../` segments correctly", () => {
    const explicit = "../tokens/auth.token";
    const config: TtctlConfig = { ...baseConfig, "auth-token-path": explicit };
    const configPath = "/projects/foo/.ttctl.yaml";
    expect(resolveAuthTokenPath({ config, configPath, platform: "linux" })).toBe(
      expectedFromConfigPath(configPath, explicit),
    );
  });

  it("falls through to platform default when auth-token-path is undefined", () => {
    // Linux, XDG unset → ~/.ttctl/auth.token
    const result = resolveAuthTokenPath({
      config: baseConfig,
      configPath: "/anywhere/.ttctl.yaml",
      platform: "linux",
      homeDir: "/home/user",
      env: {},
    });
    expect(result).toBe(join("/home/user", ".ttctl", "auth.token"));
  });
});

describe("resolveAuthTokenPath — POSIX platform defaults (no explicit override)", () => {
  it("uses XDG_DATA_HOME when set and non-empty (Linux)", () => {
    const result = resolveAuthTokenPath({
      config: baseConfig,
      configPath: "/anywhere/.ttctl.yaml",
      platform: "linux",
      homeDir: "/home/user",
      env: { XDG_DATA_HOME: "/var/lib/xdg" },
    });
    expect(result).toBe(join("/var/lib/xdg", "ttctl", "auth.token"));
  });

  it("treats empty XDG_DATA_HOME as unset (per XDG Base Directory Specification)", () => {
    const result = resolveAuthTokenPath({
      config: baseConfig,
      configPath: "/anywhere/.ttctl.yaml",
      platform: "linux",
      homeDir: "/home/user",
      env: { XDG_DATA_HOME: "" },
    });
    expect(result).toBe(join("/home/user", ".ttctl", "auth.token"));
  });

  it("falls back to ~/.ttctl/auth.token when XDG_DATA_HOME is missing", () => {
    const result = resolveAuthTokenPath({
      config: baseConfig,
      configPath: "/anywhere/.ttctl.yaml",
      platform: "darwin",
      homeDir: "/Users/alice",
      env: {},
    });
    expect(result).toBe(join("/Users/alice", ".ttctl", "auth.token"));
  });
});

describe("resolveAuthTokenPath — Windows platform defaults (no explicit override)", () => {
  it("uses APPDATA when set and non-empty", () => {
    const result = resolveAuthTokenPath({
      config: baseConfig,
      configPath: "C:\\Users\\bob\\.ttctl.yaml",
      platform: "win32",
      homeDir: "C:\\Users\\bob",
      env: { APPDATA: "C:\\Users\\bob\\AppData\\Roaming" },
    });
    expect(result).toBe(join("C:\\Users\\bob\\AppData\\Roaming", "ttctl", "auth.token"));
  });

  it("falls back to USERPROFILE/AppData/Roaming when APPDATA is missing", () => {
    const result = resolveAuthTokenPath({
      config: baseConfig,
      configPath: "C:\\Users\\bob\\.ttctl.yaml",
      platform: "win32",
      homeDir: "C:\\Users\\bob",
      env: { USERPROFILE: "C:\\Users\\bob" },
    });
    expect(result).toBe(join("C:\\Users\\bob", "AppData", "Roaming", "ttctl", "auth.token"));
  });

  it("falls back to homeDir/AppData/Roaming when neither APPDATA nor USERPROFILE is set", () => {
    const result = resolveAuthTokenPath({
      config: baseConfig,
      configPath: "C:\\Users\\bob\\.ttctl.yaml",
      platform: "win32",
      homeDir: "C:\\Users\\bob",
      env: {},
    });
    expect(result).toBe(join("C:\\Users\\bob", "AppData", "Roaming", "ttctl", "auth.token"));
  });

  it("treats empty APPDATA as unset", () => {
    const result = resolveAuthTokenPath({
      config: baseConfig,
      configPath: "C:\\Users\\bob\\.ttctl.yaml",
      platform: "win32",
      homeDir: "C:\\Users\\bob",
      env: { APPDATA: "", USERPROFILE: "C:\\Users\\bob" },
    });
    expect(result).toBe(join("C:\\Users\\bob", "AppData", "Roaming", "ttctl", "auth.token"));
  });
});

describe("resolveAuthTokenPath — explicit override precedence", () => {
  it("explicit absolute path wins over XDG_DATA_HOME and homeDir", () => {
    const explicit = "/explicit/path/auth.token";
    const config: TtctlConfig = { ...baseConfig, "auth-token-path": explicit };
    const configPath = "/wherever/.ttctl.yaml";
    expect(
      resolveAuthTokenPath({
        config,
        configPath,
        platform: "linux",
        homeDir: "/home/user",
        env: { XDG_DATA_HOME: "/var/lib/xdg" },
      }),
    ).toBe(expectedFromConfigPath(configPath, explicit));
  });

  it("explicit relative path is resolved against configPath dir, not homeDir", () => {
    const explicit = "./auth.token";
    const config: TtctlConfig = { ...baseConfig, "auth-token-path": explicit };
    const configPath = "/etc/ttctl/.ttctl.yaml";
    expect(
      resolveAuthTokenPath({
        config,
        configPath,
        platform: "linux",
        homeDir: "/home/user",
      }),
    ).toBe(expectedFromConfigPath(configPath, explicit));
  });
});
