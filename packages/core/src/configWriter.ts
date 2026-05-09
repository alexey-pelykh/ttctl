// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parseDocument } from "yaml";

import { ConfigError, ConfigLoadSchema, ConfigWriteSchema } from "./config.js";
import { acquireConfigLock } from "./configLock.js";

/**
 * Failure surface for `persistAuthToken` and `clearAuthToken`. Carries the
 * YAML config path AND, for persist-failures-after-signin, the captured
 * bearer token verbatim as a "rescue line" so the operator can manually
 * write it to disk before re-running signin.
 *
 * The bearer is INTENTIONALLY in the message — without it, a write-back
 * failure (read-only filesystem, full disk, kernel I/O error) silently
 * loses the just-acquired session and forces a full re-signin. The cost of
 * a bearer in stderr is bounded: the user sees it in their own terminal,
 * the persist failure is rare, and the recovery is "save this manually".
 */
export class AuthTokenPersistError extends Error {
  override readonly name = "AuthTokenPersistError";
  constructor(
    message: string,
    public readonly configPath: string,
    public readonly cause?: NodeJS.ErrnoException,
    public readonly bearerRescue?: string,
  ) {
    super(message);
  }
}

/**
 * Sync-root prefixes that are KNOWN to replicate filesystem state to
 * remote storage (off-host backup, cross-device sync). Persisting a
 * bearer token under one of these paths effectively replicates it. We
 * refuse the write to keep the bearer on-host.
 *
 * Resolved against the user's home directory at runtime — so a config
 * file at `~/Library/Mobile Documents/com~apple~CloudDocs/.ttctl.yaml`
 * is rejected (iCloud Drive on macOS), as is `~/Dropbox/.ttctl.yaml`
 * (Dropbox), `~/iCloud Drive/.ttctl.yaml` (alternate iCloud naming),
 * `~/OneDrive/.ttctl.yaml`, `~/Google Drive/.ttctl.yaml`, `~/Box/.ttctl.yaml`.
 *
 * The list is conservative and curated. Aggressive expansion (e.g. matching
 * any directory named "Sync" or "Backup") would produce false positives;
 * users with bespoke sync setups that we don't catch can rely on direnv
 * + per-project config to keep the file out of replication.
 */
const SYNC_ROOT_RELATIVE_PREFIXES = [
  join("Library", "Mobile Documents"),
  "Dropbox",
  "iCloud Drive",
  "OneDrive",
  join("Google Drive"),
  "Box",
  "Box Sync",
];

/**
 * Resolve sync-root prefixes against `homedir()` — once per call so that
 * tests redirecting `HOME` see the redirected paths. Returned paths are
 * absolute and resolve trailing slashes via `node:path.resolve`.
 */
function syncRootPrefixes(home: string): string[] {
  return SYNC_ROOT_RELATIVE_PREFIXES.map((rel) => resolve(home, rel));
}

/**
 * Determine whether `absolutePath` falls under any known sync-root prefix.
 * The check is prefix-based with a path-segment boundary so a sibling like
 * `~/DropboxOther/` does not falsely match `~/Dropbox/`.
 */
function isUnderSyncRoot(absolutePath: string, home: string): string | null {
  const prefixes = syncRootPrefixes(home);
  for (const prefix of prefixes) {
    // Match either the prefix exactly OR the prefix followed by a path separator
    // so siblings like "/home/u/DropboxOther" don't false-positive against "/home/u/Dropbox".
    if (absolutePath === prefix || absolutePath.startsWith(prefix + "/") || absolutePath.startsWith(prefix + "\\")) {
      return prefix;
    }
  }
  return null;
}

/**
 * Pre-flight gate run before any read/mutate path. Refuses the operation
 * with `ConfigError(PERMISSION)` when:
 *   - The path is a symbolic link (`lstat.isSymbolicLink()`). Closes the
 *     attack where an adversary swaps `~/.ttctl.yaml` for a symlink to a
 *     world-writable file under their control, redirecting the captured
 *     bearer to that file.
 *   - The path resolves under a known sync-root prefix. Closes the
 *     unintended off-host replication of bearer state.
 *
 * Returns the absolute path on success.
 */
async function assertSafePath(configPath: string): Promise<string> {
  const absolute = resolve(configPath);

  // Sync-root check — applies on POSIX (where the prefixes match) and is a
  // no-op on Windows (the relative prefixes don't resolve to the user's
  // OneDrive sync folder reliably; Windows users with OneDrive must use
  // direnv to redirect TTCTL_CONFIG_FILE).
  if (process.platform !== "win32") {
    const prefix = isUnderSyncRoot(absolute, homedir());
    if (prefix !== null) {
      throw new ConfigError(
        `Refusing to write config under known sync-root ${prefix}: ${absolute}. ` +
          `Sync clients (iCloud/Dropbox/OneDrive/Google Drive/Box) replicate filesystem ` +
          `state off-host; persisting a captured bearer token there would replicate ` +
          `it. Move the config out of the sync root, or set TTCTL_CONFIG_FILE to a ` +
          `path under your home directory.`,
        "PERMISSION",
        absolute,
      );
    }
  }

  // Symlink check — only applies if the file already exists. A non-existent
  // path falls through (the open() call below will create it normally).
  try {
    const lstatResult = await lstat(absolute);
    if (lstatResult.isSymbolicLink()) {
      throw new ConfigError(
        `Refusing to mutate symlinked config file: ${absolute}. ` +
          `A symlink could redirect the captured bearer to an attacker-controlled location. ` +
          `Replace the symlink with a regular file containing the same auth credentials.`,
        "PERMISSION",
        absolute,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // EACCES, EPERM, etc. — surface as PERMISSION
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`Cannot lstat config file: ${(err as Error).message}`, "PERMISSION", absolute);
    }
  }

  return absolute;
}

interface YamlMutation {
  /** Description for error messages and inline trace. */
  kind: "set-token" | "clear-token";
  /** Closure applied to the parsed yaml.Document — performs the in-place mutation. */
  apply: (doc: ReturnType<typeof parseDocument>) => void;
  /** Bearer to surface in the rescue-message on persist failure. Only for set-token. */
  rescueBearer?: string;
}

/**
 * Atomic YAML mutation primitive shared by `persistAuthToken` and
 * `clearAuthToken`. The flow:
 *
 *   0. Path safety gate (symlink + sync-root refusal). Throws ConfigError
 *      on failure — caller surfaces verbatim. Read-only; does not race.
 *   1. Acquire advisory write-back lock via `acquireConfigLock` (sibling
 *      `<path>.lock` directory, atomic `mkdir`-based, cross-platform).
 *      Released in `finally` regardless of error path. Lock contention
 *      timeout is ≤1s — never blocks indefinitely.
 *   2. Stat baseline — captures mtime so a concurrent overwrite can be
 *      detected before we commit our changes. The lock prevents another
 *      ttctl process from racing here, but the mtime check is preserved
 *      as a second line: a lock-disregarding writer (e.g., manual editor
 *      save) is still caught.
 *   3. Read raw YAML; apply mutation via `parseDocument` + `setIn` /
 *      `deleteIn` (surgical mutation preserves comments and key order).
 *   4. Validate the post-mutation shape against ConfigWriteSchema (catches
 *      pre-existing schema violations before we write a new file that
 *      LOCKS those violations in place).
 *   5. Write to `<path>.tmp` at mode 0600, fsync, defensive chmod 0600,
 *      then concurrency re-check (statSync mtime vs baseline) — refuse
 *      and unlink temp if mtime moved.
 *   6. Atomic rename → final path. Fsync parent dir for crash durability.
 */
async function performYamlMutation(configPath: string, mutation: YamlMutation): Promise<void> {
  const absolute = await assertSafePath(configPath);

  // Acquire lock BEFORE the stat baseline so a concurrent writer can't
  // race us between the stat and the rename. The lock target is a sibling
  // `<absolute>.lock` directory (NOT a self-lock on the config file) —
  // self-locking is broken under our atomic-rename pattern because rename
  // swaps the inode, leaving any flock() on the old inode unenforced
  // against the post-rename writer.
  const lock = await acquireConfigLock(absolute);
  try {
    await runYamlMutationLocked(absolute, mutation);
  } finally {
    // Best-effort release. If the release itself fails, signal-exit (a
    // proper-lockfile transitive dep) registers an exit-handler that
    // auto-cleans the lock on process death. We log nothing here — a
    // failed release is recoverable on the next run.
    try {
      await lock.release();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Inner write/rename/fsync flow, run with the advisory lock already held.
 * Split out from `performYamlMutation` so the lock-acquire/release `try`
 * boundary is visually obvious (no tangled exception bookkeeping). Every
 * error path inside this function unwinds through the outer `finally` →
 * lock release.
 */
async function runYamlMutationLocked(absolute: string, mutation: YamlMutation): Promise<void> {
  // Stat baseline — used to detect concurrent overwrites.
  let beforeMtime: number;
  try {
    const beforeStat = await stat(absolute);
    beforeMtime = beforeStat.mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AuthTokenPersistError(
        `Cannot stat config file at ${absolute}: ${(err as Error).message}`,
        absolute,
        err as NodeJS.ErrnoException,
        mutation.rescueBearer,
      );
    }
    // ENOENT — file doesn't exist yet. Caller bug: persistAuthToken should
    // never fire on a path with no preexisting config (signin must have
    // resolved a real config). Fail clearly rather than silently creating
    // a new file that the user didn't author.
    throw new AuthTokenPersistError(
      `Cannot ${mutation.kind === "set-token" ? "persist token to" : "clear token from"} ` +
        `non-existent config file: ${absolute}. ` +
        `Author a config first (see README § Configuration) and re-run signin.`,
      absolute,
      err as NodeJS.ErrnoException,
      mutation.rescueBearer,
    );
  }

  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (err) {
    throw new AuthTokenPersistError(
      `Cannot read config file at ${absolute}: ${(err as Error).message}`,
      absolute,
      err as NodeJS.ErrnoException,
      mutation.rescueBearer,
    );
  }

  // Surgical mutation — preserves comments, key order, and scalar styles
  // (e.g. quoted vs unquoted op:// strings) per DQ-2 in the design doc.
  // `strict: false` permits anchors / unknown YAML features without
  // throwing; the schema validation below catches actual shape errors.
  const doc = parseDocument(raw, { strict: false });
  if (doc.errors.length > 0) {
    throw new AuthTokenPersistError(
      `Cannot parse config file at ${absolute}: ${doc.errors[0]?.message ?? "unknown YAML error"}`,
      absolute,
      undefined,
      mutation.rescueBearer,
    );
  }

  mutation.apply(doc);

  // Validate the post-mutation shape. Catches pre-existing config drift
  // BEFORE we lock it into a new file. ConfigWriteSchema is permissive so
  // a transient empty `auth: {}` is acceptable mid-lifecycle.
  const postMutation: unknown = doc.toJS();
  const validation = ConfigWriteSchema.safeParse(postMutation);
  if (!validation.success) {
    const summary = validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new AuthTokenPersistError(
      `Config write validation failed: ${summary}. Refusing to write malformed config to ${absolute}.`,
      absolute,
      undefined,
      mutation.rescueBearer,
    );
  }

  const updated = String(doc);
  const tmpPath = `${absolute}.tmp`;

  await mkdir(dirname(absolute), { recursive: true });

  // O_WRONLY | O_CREAT | O_TRUNC with mode 0o600. Existing tmp from a
  // prior crashed write is overwritten.
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(tmpPath, "w", 0o600);
  } catch (err) {
    throw new AuthTokenPersistError(
      `Cannot open temp file ${tmpPath}: ${(err as Error).message}`,
      absolute,
      err as NodeJS.ErrnoException,
      mutation.rescueBearer,
    );
  }
  try {
    try {
      await fh.writeFile(updated, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }

    // Defensive re-chmod in case umask filtered the open() mode.
    if (process.platform !== "win32") {
      try {
        await chmod(tmpPath, 0o600);
      } catch {
        // Some FUSE filesystems refuse POSIX perm changes. The rename
        // below still produces a valid file. Don't block here.
      }
    }

    // Concurrency re-check — refuse if the source moved underneath us
    // (mid-session backup-restore or a lock-disregarding writer like a
    // manual editor save). Lock-disregarding writers exist; mtime drift is
    // the second line.
    const after = await stat(absolute);
    if (after.mtimeMs !== beforeMtime) {
      throw new AuthTokenPersistError(
        `Config file at ${absolute} was modified concurrently (mtime drift detected). ` +
          `Refusing to overwrite. Re-run the command after verifying the file's current ` +
          `contents are what you expect.`,
        absolute,
        undefined,
        mutation.rescueBearer,
      );
    }

    await rename(tmpPath, absolute);
  } catch (err) {
    // Best-effort cleanup of the temp file if anything failed after open().
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    if (err instanceof AuthTokenPersistError) throw err;
    throw new AuthTokenPersistError(
      `Failed to write config file at ${absolute}: ${(err as Error).message}`,
      absolute,
      err as NodeJS.ErrnoException,
      mutation.rescueBearer,
    );
  }

  // Fsync the parent directory — without this, a power-loss between rename
  // and the next implicit metadata flush can leave the file invisible.
  // POSIX-only; NTFS journaling covers this on Windows.
  if (process.platform !== "win32") {
    try {
      const dirHandle = await open(dirname(absolute), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // FUSE / network filesystems may refuse fsync on directory handles.
      // Rename succeeded; skipping dir-fsync only weakens power-loss
      // durability, not process-crash atomicity.
    }
  }
}

/**
 * Persist a captured bearer token to the SAME YAML config file the user
 * authored. Surgically mutates `auth.token` via `yaml.parseDocument` +
 * `setIn` to preserve comments, key order, and scalar styles. Atomic on
 * POSIX (temp + rename + fsync).
 *
 * Path safety gates fire BEFORE the read: symlinks and sync-root paths are
 * refused with `ConfigError(PERMISSION)` (not `AuthTokenPersistError`)
 * because they reflect static filesystem state, not a transient I/O
 * failure. Callers route both error classes through the same user-visible
 * "signin couldn't persist the token" message.
 *
 * On any I/O failure after the bearer was captured, the error message
 * carries the bearer verbatim as a "rescue line" — the operator can copy
 * it into the config manually rather than redoing signin.
 *
 * Cross-process write-back is serialized by an advisory sibling lockfile
 * (`<configPath>.lock`, atomic-mkdir-based via `proper-lockfile`). Two
 * concurrent ttctl processes (e.g., CLI signin AND a long-running MCP
 * tool call) cannot interleave their write-paths — one waits up to 1s and
 * sees the other's committed file, then proceeds with its own
 * read/parse/mutate/write cycle on the up-to-date contents. On contention
 * timeout, throws `ConfigError(LOCKED)` — never blocks indefinitely.
 *
 * The mtime-drift check inside the locked region is the second line of
 * defense for lock-disregarding writers (manual editor save during a
 * persist window) — those still get caught and refused.
 */
export async function persistAuthToken(configPath: string, token: string): Promise<void> {
  if (token === "") {
    // signOut removes the field; an empty-string token is a caller bug.
    throw new AuthTokenPersistError(
      `Refusing to persist empty token to ${configPath}. To remove the token, call clearAuthToken instead.`,
      configPath,
    );
  }
  await performYamlMutation(configPath, {
    kind: "set-token",
    apply: (doc) => {
      doc.setIn(["auth", "token"], doc.createNode(token));
    },
    rescueBearer: token,
  });
}

/**
 * Remove the `auth.token` field from the YAML config file. Distinct from
 * "set token to empty string" — `deleteIn` removes the field entirely so
 * the next load sees Form A/B (credentials only) or Form C/Empty
 * depending on what remains.
 *
 * Per security-architect's Stage 2 input: post-signout state must NEVER
 * be `auth: { token: "" }` — empty-string is data and could be replayed
 * as a (malformed) bearer. Removal is the only safe shape.
 */
export async function clearAuthToken(configPath: string): Promise<void> {
  await performYamlMutation(configPath, {
    kind: "clear-token",
    apply: (doc) => {
      doc.deleteIn(["auth", "token"]);
    },
  });
}

/**
 * Write a freshly-authored config file to `configPath`.
 *
 * Sibling primitive to `performYamlMutation` for the bootstrap case
 * (`ttctl auth init`): no pre-existing file is read or mutated — the YAML
 * content is supplied verbatim by the caller from interactive prompts. The
 * same atomic / safety invariants apply:
 *
 *   - Path safety gate (`assertSafePath`) — refuses sync-roots and
 *     pre-existing symlinks at `configPath`. A non-existent path is
 *     accepted (the whole point of init).
 *   - Pre-existence gate — refuses unless `opts.force` is true. The
 *     refusal is `ConfigError(PERMISSION)` so CLI/MCP error renderers
 *     route it through the same exit-code + message contract as the
 *     other write-path failures.
 *   - Schema validation — the supplied content is parsed and validated
 *     against `ConfigLoadSchema` BEFORE we touch disk. The strict load
 *     schema catches malformed YAML composed by an interactive flow
 *     (e.g. quoting bug) before we lock it in place.
 *   - Atomic write — temp at `0o600`, fsync, defensive chmod, rename,
 *     fsync(parent dir). Same dance as `persistAuthToken`'s temp path so
 *     a crashed init never leaves a partial config.
 *
 * On `force` overwrite: the existing file is replaced atomically; the
 * mtime-drift guard from `performYamlMutation` does NOT apply here because
 * the bootstrap operation explicitly asks for replacement. Symlink and
 * sync-root refusals still fire.
 *
 * Parent directories are created with `mkdir -p` semantics (the bootstrap
 * is allowed to create its own `~/.ttctl.yaml` even if that means creating
 * a fresh home — though in practice the parent is always `homedir()` which
 * already exists; the recursive flag is for `--config <path>` cases that
 * specify a not-yet-existing project dir).
 */
export async function writeNewConfig(
  configPath: string,
  content: string,
  opts: { force: boolean },
): Promise<void> {
  const absolute = await assertSafePath(configPath);

  // Pre-existence gate. `lstat` (via assertSafePath) only refuses on
  // SYMLINK; a regular-file existence is permitted by the safety check
  // and must be gated separately by `force` here.
  let exists = false;
  try {
    await stat(absolute);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(`Cannot stat config file: ${(err as Error).message}`, "PERMISSION", absolute);
    }
  }
  if (exists && !opts.force) {
    throw new ConfigError(
      `Refusing to overwrite existing config at ${absolute}. ` +
        `Use --force to replace, or edit the file manually.`,
      "PERMISSION",
      absolute,
    );
  }

  // Validate the supplied YAML against the strict load schema BEFORE
  // writing. Catches malformed shapes early so we never persist a config
  // that the next `ttctl` invocation will reject at load time.
  let parsedContent: unknown;
  try {
    const doc = parseDocument(content, { strict: false });
    if (doc.errors.length > 0) {
      throw new ConfigError(
        `Cannot parse generated config content: ${doc.errors[0]?.message ?? "unknown YAML error"}`,
        "VALIDATION",
        absolute,
      );
    }
    parsedContent = doc.toJS();
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Cannot parse generated config content: ${(err as Error).message}`, "VALIDATION", absolute);
  }
  const validation = ConfigLoadSchema.safeParse(parsedContent);
  if (!validation.success) {
    const summary = validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(
      `Generated config failed validation: ${summary}. Refusing to write malformed config to ${absolute}.`,
      "VALIDATION",
      absolute,
    );
  }

  await mkdir(dirname(absolute), { recursive: true });

  const tmpPath = `${absolute}.tmp`;
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(tmpPath, "w", 0o600);
  } catch (err) {
    throw new ConfigError(`Cannot open temp file ${tmpPath}: ${(err as Error).message}`, "PERMISSION", absolute);
  }
  try {
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }

    if (process.platform !== "win32") {
      try {
        await chmod(tmpPath, 0o600);
      } catch {
        // FUSE filesystems may refuse POSIX perm changes — same posture
        // as performYamlMutation. Rename below still produces a file
        // with the umask-filtered open() mode.
      }
    }

    await rename(tmpPath, absolute);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(
      `Failed to write config file at ${absolute}: ${(err as Error).message}`,
      "PERMISSION",
      absolute,
    );
  }

  // Fsync the parent directory — same power-loss durability gate as
  // performYamlMutation. POSIX-only; NTFS journaling covers it on Windows.
  if (process.platform !== "win32") {
    try {
      const dirHandle = await open(dirname(absolute), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      /* FUSE / network FS refusal — non-blocking */
    }
  }
}
