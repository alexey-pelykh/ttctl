// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { TtctlConfig } from "./config.js";

export interface ResolveAuthTokenPathOptions {
  /** The TtctlConfig parsed from `.ttctl.yaml` — for the `auth-token-path` field. */
  config: TtctlConfig;
  /** Path to the `.ttctl.yaml` file itself — used to resolve relative `auth-token-path`. */
  configPath: string;
  /** Override `process.platform`; useful for tests. */
  platform?: NodeJS.Platform;
  /** Override `os.homedir()`; useful for tests. */
  homeDir?: string;
  /** Override `process.env`; useful for tests. (Used only for `XDG_DATA_HOME` / `APPDATA` defaults.) */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the on-disk path for the persisted session auth token (the value
 * captured from `SignInPayload.token` and replayed as
 * `Authorization: Token token=<X>` on every GraphQL request).
 *
 * Resolution order:
 *
 *   1. `config["auth-token-path"]` if set and non-empty:
 *      - Absolute path → used verbatim
 *      - Relative path → resolved relative to `dirname(configPath)` (the
 *        directory containing the user's `.ttctl.yaml` file)
 *   2. Windows: `%APPDATA%/ttctl/auth.token`
 *      (fallback `%USERPROFILE%/AppData/Roaming/ttctl/auth.token`).
 *   3. Linux/macOS: `$XDG_DATA_HOME/ttctl/auth.token` if `XDG_DATA_HOME` is
 *      set and non-empty (per XDG spec — empty falls back), else
 *      `~/.ttctl/auth.token`.
 *
 * The relative-path branch is what the E2E harness uses for isolation: it
 * writes a fixture `.ttctl.yaml` at `<repo-root>/.tmp/e2e/.ttctl.yaml` with
 * `auth-token-path: ./auth.token` and spawns the CLI subprocess with
 * `cwd=<repo-root>/.tmp/e2e/`. Config discovery picks up the fixture; the
 * token lands at `<repo-root>/.tmp/e2e/auth.token`. The user's everyday
 * session at `~/.ttctl/auth.token` is untouched.
 */
export function resolveAuthTokenPath(opts: ResolveAuthTokenPathOptions): string {
  const explicit = opts.config["auth-token-path"];
  if (explicit !== undefined && explicit !== "") {
    return isAbsolute(explicit) ? explicit : resolve(dirname(opts.configPath), explicit);
  }

  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.homeDir ?? homedir();

  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (appData !== undefined && appData !== "") {
      return join(appData, "ttctl", "auth.token");
    }
    const userProfile = env["USERPROFILE"];
    const base = userProfile !== undefined && userProfile !== "" ? userProfile : home;
    return join(base, "AppData", "Roaming", "ttctl", "auth.token");
  }

  // POSIX: per XDG Base Directory Specification, an empty value is treated
  // as if unset.
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg !== "") {
    return join(xdg, "ttctl", "auth.token");
  }
  return join(home, ".ttctl", "auth.token");
}

/**
 * Load a persisted auth token from disk. Returns the token verbatim
 * (whitespace-trimmed) or `null` if the file does not exist (first-run
 * case, or after `auth signout`).
 *
 * Throws on read errors other than `ENOENT` so a permission problem is
 * surfaced to the caller rather than silently masked as "no token".
 *
 * The trim is deliberate: an editor that adds a trailing newline must not
 * corrupt the token. The token format is `user_<24hex>_<20alphanum>` —
 * no internal whitespace possible — so trimming is safe.
 */
export async function loadAuthToken(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const token = raw.trim();
  if (token === "") return null;
  return token;
}

/**
 * Persist an auth token to disk.
 *
 * Atomic on POSIX: writes to a sibling `*.tmp` file with mode `0o600`,
 * fsyncs, then renames over the destination. A crash mid-write leaves
 * either the previous valid file or the new valid file — never a partial.
 *
 * Permissions are `0o600` on Unix. Windows ignores the mode; the file
 * lives under the user's profile directory which already restricts access
 * to the owning user via NTFS ACLs.
 *
 * Format is plaintext + trailing newline. The newline is for shell-pipe
 * friendliness (`cat ~/.ttctl/auth.token | xargs ...`); `loadAuthToken`
 * trims whitespace so the round-trip is value-preserving.
 */
export async function saveAuthToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const tmpPath = `${path}.tmp`;
  const content = token + "\n";
  // O_WRONLY | O_CREAT | O_TRUNC with mode 0o600. Existing tmp left over
  // from a prior crashed write is overwritten.
  const fh = await open(tmpPath, "w", 0o600);
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  // Defensive re-chmod in case the umask filtered the open() mode.
  if (process.platform !== "win32") {
    try {
      await chmod(tmpPath, 0o600);
    } catch {
      // chmod can fail on filesystems that don't support POSIX perms (e.g.
      // some FUSE mounts). Don't block the save — the rename below will
      // still produce a valid file.
    }
  }
  try {
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed.
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
  // Fsync the parent directory so the rename's metadata reaches disk —
  // without this, a power-loss between rename and the next implicit metadata
  // flush can leave the file invisible despite the data being durable. POSIX
  // requires opening the directory for read; not supported on Windows, where
  // the rename's NTFS journaling already covers this.
  if (process.platform !== "win32") {
    try {
      const dirHandle = await open(dirname(path), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // Some filesystems (FUSE, network mounts) refuse fsync on directory
      // handles. The rename already succeeded; skipping the dir-fsync only
      // weakens power-loss durability, not process-crash atomicity.
    }
  }
}

/**
 * Delete the persisted auth token, idempotently.
 *
 * Used by `ttctl auth signout`. ENOENT is treated as a no-op success: a
 * second signout, or a signout against a never-signed-in profile, must not
 * be a hard error. Other errors (EACCES, EBUSY, etc.) propagate so the
 * operator can resolve them.
 */
export async function deleteAuthToken(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
