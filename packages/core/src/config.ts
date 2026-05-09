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
 * from a single LOGIN-category item. The regex rejects 4+ segments.
 */
const OnePasswordReferenceSchema = z
  .string()
  .regex(/^op:\/\/(?:[^/]+\/)?[^/]+\/[^/]+$/, "auth.credentials must be op://[account/]vault/item (no /field suffix)");

/**
 * Literal credentials in YAML — discouraged for daily use; the 1Password form
 * is recommended.
 *
 * Field name is `username` (matching 1Password's `USERNAME` purpose semantics
 * and the issue's user-facing schema). The value must be a valid email since
 * Toptal's `EmailPasswordSignIn` mutation only accepts emails.
 */
const LiteralCredentialsSchema = z
  .object({
    username: z.email({ message: "auth.credentials.username must be a valid email address" }),
    password: z.string().min(1, { message: "auth.credentials.password must be a non-empty string" }),
  })
  .strict();

/**
 * Polymorphic credentials value:
 *   - string → 1Password item reference (Form A)
 *   - object → literal { username, password } (Form B)
 *
 * The runtime `signIn()` flow collapses both into the internal `Credentials`
 * shape `{ email, password }` (the GraphQL mutation parameter name is
 * `email` — the YAML/op:// surface uses `username` to match 1Password's
 * USERNAME purpose).
 */
export const AuthCredentialsSchema = z.union([OnePasswordReferenceSchema, LiteralCredentialsSchema]);

export type AuthCredentials = z.infer<typeof AuthCredentialsSchema>;
export type LiteralAuthCredentials = z.infer<typeof LiteralCredentialsSchema>;

/**
 * `auth` block schema for runtime LOAD operations. Strict — rejects unknown
 * fields and rejects an empty `auth: {}` (the user must author at least one
 * of `credentials` or `token` for the runtime to be useful).
 *
 * Four valid lifecycle states (Forms A-D from the design doc):
 *
 *   - **Form A** — `credentials: "op://..."` (1Password reference). No token
 *     yet — `auth signin` will write one.
 *   - **Form B** — `credentials: { username, password }` (literal). No token
 *     yet.
 *   - **Form C** — `token: "..."` only (no credentials). The bearer is
 *     supplied directly; `auth signin` is not applicable. Common in the E2E
 *     sandbox and in deployments that bootstrap a token out-of-band.
 *   - **Form D** — both `credentials` AND `token`. Post-signin state for
 *     Form A or B configs; the captured bearer is persisted alongside the
 *     credentials.
 */
const AuthBlockLoadSchema = z
  .object({
    credentials: AuthCredentialsSchema.optional(),
    token: z.string().min(1, { message: "auth.token must be a non-empty string" }).optional(),
  })
  .strict()
  .superRefine((auth, ctx) => {
    if (auth.credentials === undefined && auth.token === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "auth must contain at least one of 'credentials' (op:// reference or { username, password } object) " +
          "or 'token' (bearer string captured by `ttctl auth signin`)",
        path: [],
      });
    }
  });

export type AuthBlock = z.infer<typeof AuthBlockLoadSchema>;

/**
 * `auth` block schema for runtime WRITE operations. Permissive — both
 * `credentials` and `token` are optional, AND empty `auth: {}` is accepted.
 *
 * Used by `persistAuthToken` and the signout flow during the brief window
 * between mutation and disk-write. The strict load schema rejects empty
 * `auth: {}` at the next file-load — see DQ-6 in the design doc.
 */
const AuthBlockWriteSchema = z
  .object({
    credentials: AuthCredentialsSchema.optional(),
    token: z.string().min(1).optional(),
  })
  .strict();

/**
 * Top-level config schema (load form). Single config; no profiles.
 *
 * Compared to the prior shape:
 *   - Removed top-level `auth` polymorphic value (string or `{email,password}`)
 *     in favor of a structured `auth: { credentials?, token? }` block.
 *   - Removed `auth-token-path` field — the captured bearer now lives inside
 *     the same YAML file at `auth.token`. Project-scoped configs are routed
 *     via direnv (see README § Configuration).
 */
export const ConfigLoadSchema = z
  .object({
    auth: AuthBlockLoadSchema,
  })
  .strict();

/**
 * Top-level config schema (write form). Permits empty `auth: {}` for the
 * post-signout transient state when the source was Form C.
 */
export const ConfigWriteSchema = z
  .object({
    auth: AuthBlockWriteSchema,
  })
  .strict();

/**
 * Runtime-validated config object (load form). The shape clients read from
 * disk after `loadConfigFile`.
 */
export type TtctlConfig = z.infer<typeof ConfigLoadSchema>;

/**
 * Permissive config shape used for write-back (`persistAuthToken`,
 * `signOut`). Empty `auth: {}` is acceptable mid-lifecycle.
 */
export type TtctlConfigWritable = z.infer<typeof ConfigWriteSchema>;

/**
 * Discriminator on `ConfigError` so consumers can switch on error class
 * without pattern-matching prose messages.
 *
 *   - `NO_CREDS`   — config not found via the resolution chain, or the
 *                    chosen path doesn't exist on disk.
 *   - `PARSE`      — YAML parse error (malformed file).
 *   - `VALIDATION` — schema validation error (wrong shape, missing fields).
 *   - `PERMISSION` — file exists but is not accessible (EACCES / EPERM), OR
 *                    file is at an unsafe location (sync-root, symlink) per
 *                    the security gates in the resolution chain.
 *   - `LOCKED`     — advisory write-back lock could not be acquired within
 *                    the contention budget (≤1s). Another ttctl process
 *                    (CLI signin or long-running MCP tool call) holds the
 *                    sibling lockfile. Retry the operation.
 */
export type ConfigErrorCode = "NO_CREDS" | "PARSE" | "VALIDATION" | "PERMISSION" | "LOCKED";

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
 * Map a Zod issue path to a human-friendly field reference for surfacing
 * validation failures. Walks the issue's path array to build a dotted-prose
 * descriptor (e.g. `["auth", "credentials", "password"]` → `auth.credentials.password`).
 *
 * The empty-path case (refinement-level errors) returns `auth` as the
 * operative scope so the message reads naturally.
 */
function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "auth";
  const parts: string[] = [];
  for (const segment of path) {
    if (typeof segment === "number") {
      parts[parts.length - 1] = `${parts[parts.length - 1] ?? ""}[${segment.toString()}]`;
    } else if (typeof segment === "string") {
      parts.push(segment);
    } else {
      // symbol key — zod permits this in object schemas but our config has
      // no symbol-keyed fields. Render via .toString() so the message is
      // still readable rather than dropping the segment.
      parts.push(segment.toString());
    }
  }
  return parts.join(".");
}

/**
 * Render a Zod safe-parse failure into a single-line `ConfigError` message
 * that names the failing branch / field where possible. Defends against the
 * naked `z.union` "Invalid input" UX.
 */
function formatLoadValidationError(err: z.ZodError, path: string): ConfigError {
  const lines: string[] = [];
  for (const issue of err.issues) {
    const fieldPath = formatIssuePath(issue.path);
    lines.push(`${fieldPath}: ${issue.message}`);
  }
  const summary = lines.length === 0 ? "Invalid config shape" : lines.join("; ");
  return new ConfigError(`Config validation failed: ${summary}`, "VALIDATION", path);
}

/**
 * Read, parse, and validate the config file at `path`.
 *
 * Pre-flight `fs.stat`:
 *   - ENOENT → `ConfigError(code: NO_CREDS)` so a missing explicit path or
 *     `TTCTL_CONFIG_FILE` value surfaces uniformly with the
 *     "no config found anywhere" branch in `resolveConfig`.
 *   - EACCES / EPERM → `ConfigError(code: PERMISSION)`.
 *   - Mode-strictness gate (POSIX): refuse to LOAD when the file is
 *     world-writable (`mode & 0o002 != 0` — covers 0666, 0777, etc.).
 *     Closes a TOCTOU window on credential reads. Throws
 *     `ConfigError(PERMISSION)` with the actual mode in the error message.
 *   - Mode-warning (POSIX): emit a stderr warning when group/world bits
 *     other than world-writable are set (e.g. 0644). Non-fatal; the file
 *     may carry a 1Password reference (low-risk on its own) or, in literal
 *     form, a plaintext password — `0o600` is the right posture.
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
    if ((mode & 0o002) !== 0) {
      const modeStr = mode.toString(8).padStart(3, "0");
      throw new ConfigError(
        `Refusing to load world-writable config file ${path} (mode 0${modeStr}). ` +
          `The file may contain a captured bearer token; world-writable mode opens a TOCTOU window. ` +
          `Run: chmod 600 ${path}`,
        "PERMISSION",
        path,
      );
    }
    if ((mode & 0o077) !== 0) {
      const modeStr = mode.toString(8).padStart(3, "0");
      process.stderr.write(
        `WARNING: config file ${path} is group/world readable (mode 0${modeStr}). ` +
          `It may contain a 1Password reference, plaintext password, or captured bearer. ` +
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

  const result = ConfigLoadSchema.safeParse(parsed);
  if (!result.success) {
    throw formatLoadValidationError(result.error, path);
  }
  return result.data;
}

/**
 * Options for `resolveConfig`. Currently only `path`; kept as an options
 * object so future flags don't require another signature break.
 */
export interface ResolveConfigOptions {
  /**
   * Explicit config path. Wins over `TTCTL_CONFIG_FILE` and the home default.
   * Used verbatim — no existence pre-check (`loadConfigFile` surfaces ENOENT
   * as `code: 'NO_CREDS'`).
   */
  path?: string;
}

/**
 * Deterministic config-path resolution.
 *
 * Precedence (highest → lowest):
 *
 *   1. Explicit `path` argument (passed by the caller — e.g., `--config`
 *      flag from #93). Used verbatim, no existence check.
 *   2. `TTCTL_CONFIG_FILE` env var. Same verbatim treatment as `path`.
 *   3. `~/.ttctl.yaml` (POSIX home dotfile), when the file exists on disk.
 *
 * Returns `null` when none of the above produce a path. Callers that want
 * project-scoped configs use `direnv` to set `TTCTL_CONFIG_FILE` per
 * directory — the CWD `./.ttctl.yaml` is NOT consulted (closed since #92).
 *
 * NOTE: XDG paths (`$XDG_CONFIG_HOME/ttctl/config.yaml`,
 * `~/.config/ttctl/config.yaml`) are NO LONGER consulted. The single-file
 * model places the captured bearer in the same YAML; `~/.ttctl.yaml` is
 * the canonical home location.
 */
export function discoverConfigPath(path?: string): string | null {
  if (path !== undefined) return path;

  const envPath = process.env["TTCTL_CONFIG_FILE"];
  if (envPath !== undefined && envPath !== "") return envPath;

  const homePath = join(homedir(), ".ttctl.yaml");
  if (existsSync(homePath)) return homePath;

  return null;
}

/**
 * Convenience: discover and load.
 *
 * When the resolution chain returns `null` AND a `./.ttctl.yaml` exists in
 * `process.cwd()`, surface a deprecation message pointing the user at the
 * supported escape hatches. The CWD file is NEVER auto-loaded.
 */
export function resolveConfig(options: ResolveConfigOptions = {}): { config: TtctlConfig; path: string } {
  const path = discoverConfigPath(options.path);
  if (path === null) {
    const legacyCwdPath = resolve(process.cwd(), ".ttctl.yaml");
    if (existsSync(legacyCwdPath)) {
      throw new ConfigError(
        `No config found via --config, TTCTL_CONFIG_FILE, or ~/.ttctl.yaml. ` +
          `Note: a CWD .ttctl.yaml was found at ${legacyCwdPath} but is not auto-discovered. ` +
          `Set TTCTL_CONFIG_FILE=${legacyCwdPath} (e.g. via direnv) or move it to ~/.ttctl.yaml.`,
        "NO_CREDS",
      );
    }
    throw new ConfigError(
      "No config found. Pass --config <path>, set TTCTL_CONFIG_FILE, or place config at ~/.ttctl.yaml. See README for setup.",
      "NO_CREDS",
    );
  }
  return { config: loadConfigFile(path), path };
}
