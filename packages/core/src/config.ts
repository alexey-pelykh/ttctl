// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * 1Password item reference for credential resolution.
 *
 * Form: `op://VAULT/ITEM`. Per-field references (`op://VAULT/ITEM/FIELD`) are
 * deliberately NOT supported — TTCtl always reads `username` and `password`
 * from a single item. Schema rejects per-field URIs with a clear error.
 */
const OnePasswordItemRefSchema = z
  .string()
  .regex(/^op:\/\/[^/]+\/[^/]+$/, "auth string must be op://vault/item (no /field suffix)");

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
 */
export const ConfigSchema = z.object({
  auth: AuthSchema,
});

export type TtctlConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message);
  }
}

/**
 * Discovery order for the config file.
 *
 *   1. `./.ttctl.yaml` in CWD (project-scoped)
 *   2. `$XDG_CONFIG_HOME/ttctl/config.yaml` (defaults to `~/.config/ttctl/config.yaml`)
 */
export function discoverConfigPath(cwd: string = process.cwd()): string | null {
  const cwdPath = resolve(cwd, ".ttctl.yaml");
  if (existsSync(cwdPath)) return cwdPath;

  const xdg = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  const xdgPath = join(xdg, "ttctl", "config.yaml");
  if (existsSync(xdgPath)) return xdgPath;

  return null;
}

/**
 * Read, parse, and validate the config file at `path`.
 */
export function loadConfigFile(path: string): TtctlConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config file: ${(err as Error).message}`, path);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`Invalid YAML: ${(err as Error).message}`, path);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Config validation failed: ${result.error.message}`, path);
  }
  return result.data;
}

/**
 * Convenience: discover and load.
 */
export function resolveConfig(cwd?: string): { config: TtctlConfig; path: string } {
  const path = discoverConfigPath(cwd);
  if (path === null) {
    throw new ConfigError("No .ttctl.yaml found in CWD or $XDG_CONFIG_HOME/ttctl/config.yaml. See README for setup.");
  }
  return { config: loadConfigFile(path), path };
}
