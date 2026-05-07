// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * 1Password item reference for credential resolution.
 *
 * Forms:
 *   - `op://VAULT/ITEM` (2-segment) — relies on `op` CLI default-account or
 *     `OP_ACCOUNT` env. Works for single-account setups.
 *   - `op://ACCOUNT/VAULT/ITEM` (3-segment) — selects a specific account when
 *     the user has multiple `op` accounts configured. ACCOUNT is forwarded
 *     verbatim to `op item get --account` (accepts UUID, shorthand, or sign-in
 *     email — `op` CLI validates).
 *
 * Per-field references (`op://VAULT/ITEM/FIELD` or 4+ segments) are
 * deliberately NOT supported — TTCtl always reads `username` and `password`
 * from a single item. Schema rejects per-field URIs with a clear error.
 */
const OnePasswordItemRefSchema = z
  .string()
  .regex(/^op:\/\/(?:[^/]+\/)?[^/]+\/[^/]+$/, "auth string must be op://[account/]vault/item (no /field suffix)");

/**
 * Literal credentials in YAML — discouraged for daily use; the 1Password form
 * is recommended.
 */
const LiteralCredentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

/**
 * Polymorphic auth schema:
 *   - string  → 1Password item reference
 *   - object  → literal email + password
 *
 * Anything else (including per-field op:// refs) is rejected.
 */
export const AuthSchema = z.union([OnePasswordItemRefSchema, LiteralCredentialsSchema]);

export type AuthValue = z.infer<typeof AuthSchema>;

/**
 * Top-level `.ttctl.yaml` schema. Single-config; no profiles.
 *
 * Optional `auth-token-path` overrides the on-disk path of the persisted
 * session token (the value captured from `SignInPayload.token` and replayed
 * as `Authorization: Token token=<X>` on every GraphQL request). Resolution
 * (handled by `resolveAuthTokenPath` in `authToken.ts`):
 *
 *   - Absolute path → used verbatim
 *   - Relative path → resolved relative to `dirname(configPath)` (the
 *     directory containing this `.ttctl.yaml` file)
 *   - Absent → platform default (`$XDG_DATA_HOME/ttctl/auth.token` if set,
 *     else `~/.ttctl/auth.token` on POSIX; `%APPDATA%/ttctl/auth.token` on
 *     Windows)
 *
 * The kebab-case key matches YAML conventions in this file. The E2E harness
 * relies on the relative-path branch to redirect the token into a sandbox
 * directory (`<repo-root>/.tmp/e2e/.ttctl.yaml` with `auth-token-path:
 * ./auth.token`) so test runs never touch the user's working session at
 * `~/.ttctl/auth.token`.
 */
export const ConfigSchema = z.object({
  auth: AuthSchema,
  "auth-token-path": z.string().min(1).optional(),
});

export type TtctlConfig = z.infer<typeof ConfigSchema>;

/**
 * Discriminator on `ConfigError` so consumers can switch on error class
 * without pattern-matching prose messages.
 *
 *   - `NO_CREDS`   — config not found via the resolution chain, or the
 *                    chosen path doesn't exist on disk.
 *   - `PARSE`      — YAML parse error (malformed file).
 *   - `VALIDATION` — schema validation error (wrong shape, missing fields).
 *   - `PERMISSION` — file exists but is not accessible (EACCES / EPERM).
 *
 * The permission *warning* (group/world readable on POSIX) is non-fatal and
 * does NOT correspond to this code — `PERMISSION` only fires when a read
 * actually fails because the OS denied access.
 */
export type ConfigErrorCode = "NO_CREDS" | "PARSE" | "VALIDATION" | "PERMISSION";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    public readonly code: ConfigErrorCode,
    public readonly path?: string,
  ) {
    super(message);
  }
}

/**
 * Deterministic config-path resolution.
 *
 * Precedence (highest → lowest):
 *
 *   1. Explicit `path` argument (passed by the caller — e.g., `--config`
 *      flag once #93 lands). Used verbatim, no existence check; if it's
 *      bogus, `loadConfigFile` surfaces the failure.
 *   2. `TTCTL_CONFIG_FILE` env var. Same verbatim treatment as `path`.
 *   3. `$XDG_CONFIG_HOME/ttctl/config.yaml`, when `XDG_CONFIG_HOME` is set
 *      AND the file exists on disk.
 *   4. `~/.config/ttctl/config.yaml` (POSIX home default), when the file
 *      exists on disk.
 *
 * Returns `null` when none of the above produce a path. Crucially: the CWD
 * `./.ttctl.yaml` is NOT consulted — that's the breaking change vs prior
 * versions. Callers that want CWD-style discovery must wire their CWD path
 * via the explicit argument or `TTCTL_CONFIG_FILE`.
 */
export function discoverConfigPath(path?: string): string | null {
  if (path !== undefined) return path;

  const envPath = process.env["TTCTL_CONFIG_FILE"];
  if (envPath !== undefined && envPath !== "") return envPath;

  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") {
    const xdgPath = join(xdg, "ttctl", "config.yaml");
    if (existsSync(xdgPath)) return xdgPath;
  }

  const homePath = join(homedir(), ".config", "ttctl", "config.yaml");
  if (existsSync(homePath)) return homePath;

  return null;
}

/**
 * Read, parse, and validate the config file at `path`.
 *
 * Pre-flight `fs.stat`:
 *   - ENOENT → `ConfigError(code: NO_CREDS)` so a missing explicit path or
 *     `TTCTL_CONFIG_FILE` value surfaces uniformly with the
 *     "no config found anywhere" branch in `resolveConfig`.
 *   - EACCES / EPERM → `ConfigError(code: PERMISSION)`.
 *   - Otherwise → emit a stderr warning when group/world bits are set
 *     (POSIX only, irrelevant on Windows where mode bits aren't meaningful).
 *     The file may carry a 1Password reference (low-risk on its own) or, in
 *     literal form, a plaintext password — `0o600` is the right posture.
 */
export function loadConfigFile(path: string): TtctlConfig {
  const stat = (() => {
    try {
      return statSync(path);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new ConfigError(`Config file not found: ${path}`, "NO_CREDS", path);
      }
      if (e.code === "EACCES" || e.code === "EPERM") {
        throw new ConfigError(`Cannot access config file (permission denied): ${path}`, "PERMISSION", path);
      }
      throw new ConfigError(`Cannot stat config file: ${e.message}`, "NO_CREDS", path);
    }
  })();

  if (process.platform !== "win32") {
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      const modeStr = mode.toString(8).padStart(3, "0");
      process.stderr.write(
        `WARNING: config file ${path} is group/world readable (mode 0${modeStr}). ` +
          `It may contain a 1Password reference or plaintext password. ` +
          `Run: chmod 600 ${path}\n`,
      );
    }
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EACCES" || e.code === "EPERM") {
      throw new ConfigError(`Cannot read config file (permission denied): ${path}`, "PERMISSION", path);
    }
    throw new ConfigError(`Cannot read config file: ${e.message}`, "NO_CREDS", path);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`Invalid YAML: ${(err as Error).message}`, "PARSE", path);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Config validation failed: ${result.error.message}`, "VALIDATION", path);
  }
  return result.data;
}

/**
 * Options for `resolveConfig`. Currently only `path`; kept as an options
 * object so future flags (e.g., `strict: true` once permission-warning
 * promotion is desired) don't require another signature break.
 */
export interface ResolveConfigOptions {
  /**
   * Explicit config path. Wins over `TTCTL_CONFIG_FILE` and the XDG/home
   * defaults. Used verbatim — no existence pre-check (`loadConfigFile`
   * surfaces ENOENT as `code: 'NO_CREDS'`).
   */
  path?: string;
}

/**
 * Convenience: discover and load.
 *
 * When the resolution chain returns `null` AND a `./.ttctl.yaml` exists in
 * `process.cwd()`, surface a deprecation message pointing the user at the
 * new escape hatches (`TTCTL_CONFIG_FILE` here; `--config` flag in the
 * companion CLI issue). The CWD file is NEVER auto-loaded — that's the
 * point of the refactor.
 */
export function resolveConfig(options: ResolveConfigOptions = {}): { config: TtctlConfig; path: string } {
  const path = discoverConfigPath(options.path);
  if (path === null) {
    const legacyCwdPath = resolve(process.cwd(), ".ttctl.yaml");
    if (existsSync(legacyCwdPath)) {
      throw new ConfigError(
        `No config found via TTCTL_CONFIG_FILE, $XDG_CONFIG_HOME/ttctl/config.yaml, or ~/.config/ttctl/config.yaml. ` +
          `Note: a CWD .ttctl.yaml was found at ${legacyCwdPath} but is no longer auto-discovered. ` +
          `Set TTCTL_CONFIG_FILE=${legacyCwdPath} to use it, or move it to ~/.config/ttctl/config.yaml.`,
        "NO_CREDS",
      );
    }
    throw new ConfigError(
      "No config found. Set TTCTL_CONFIG_FILE or place config at $XDG_CONFIG_HOME/ttctl/config.yaml or ~/.config/ttctl/config.yaml. See README for setup.",
      "NO_CREDS",
    );
  }
  return { config: loadConfigFile(path), path };
}
