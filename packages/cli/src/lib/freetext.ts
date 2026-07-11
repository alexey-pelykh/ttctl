// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { type ChildProcess, spawn as defaultSpawn } from "node:child_process";
import { mkdtemp, readFile as defaultReadFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stable error codes carried by {@link FreeTextError}. Script consumers
 * branch on `error.code` rather than parsing the user-facing prose. Codes
 * intentionally cover only conditions surfaced *before* the helper hands
 * control back to the caller — anything caused by the underlying value
 * (e.g. server-side rejection of an empty bio) is the caller's domain.
 */
export type FreeTextErrorCode =
  "MODE_CONFLICT" | "FILE_NOT_FOUND" | "FILE_READ_ERROR" | "STDIN_UNAVAILABLE" | "STDIN_DOUBLE_CLAIM" | "EDITOR_FAILED";

/**
 * Typed error thrown by {@link resolveFreeText} for input mistakes the user
 * must fix before retrying. Callers render the standard
 * `<command> failed (<code>): <message>` shape and exit non-zero.
 *
 * Production failures from the API or the platform stay typed as their
 * domain errors (e.g. `profile.basic.ProfileError`, `TtctlError`); this
 * type covers ONLY input-resolution failures that happen on the local
 * machine before any network call.
 */
export class FreeTextError extends Error {
  override readonly name = "FreeTextError";
  constructor(
    public readonly code: FreeTextErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Options for {@link resolveFreeText}. The first block tunes behavior; the
 * trailing block (`stdin` / `readFile` / `spawn`) is the test-injection
 * surface — production callers leave these `undefined` and the helper
 * resolves defaults (`process.stdin`, `node:fs/promises`'s `readFile`,
 * `node:child_process`'s `spawn`).
 */
export interface ResolveFreeTextOptions {
  /** User-facing flag name used in error messages, e.g. `"bio"`. */
  readonly flagName: string;

  /** Initial editor buffer for `--edit` mode. Empty string when omitted. */
  readonly currentValue?: string;

  /** Whether the caller's `--edit`-style boolean flag was set. */
  readonly enableEditor?: boolean;

  /** Override the `$EDITOR` lookup. Falls back to `process.env.EDITOR ?? "vi"`. */
  readonly editorEnv?: string;

  /** Test-only: stream consumed for the `-` (stdin) mode. */
  readonly stdin?: NodeJS.ReadableStream;

  /** Test-only: replace the `fs.readFile` used by the `@path` mode. */
  readonly readFile?: (path: string) => Promise<string>;

  /** Test-only: replace `child_process.spawn` used by the editor mode. */
  readonly spawn?: typeof defaultSpawn;
}

// Module-level guard for the "two flags both want stdin" diagnostic. Once
// any caller has consumed stdin in this process, a second `-` claim throws
// `STDIN_DOUBLE_CLAIM` instead of reading already-empty input. Tests reset
// this via {@link _resetStdinClaimForTesting}.
let stdinClaimed = false;

/**
 * Reset the module-level stdin-claim guard. Test-only. Production callers
 * must not call this — the guard exists precisely to prevent the same
 * process from consuming stdin twice in a single CLI invocation.
 *
 * @internal
 */
export function _resetStdinClaimForTesting(): void {
  stdinClaimed = false;
}

/**
 * Resolve a free-text flag value through the four supported input modes.
 *
 * Modes (in priority order):
 *
 * 1. **Editor** — `enableEditor === true` opens `$EDITOR` seeded with
 *    `currentValue` and returns the saved buffer. Combining `enableEditor`
 *    with a defined `rawValue` is ambiguous; the helper rejects it before
 *    any I/O.
 * 2. **Stdin** — `rawValue === "-"` reads `process.stdin` (or the injected
 *    stream) until EOF. Empty stdin is NOT an error — it returns the empty
 *    string, per AC. A non-piped TTY surfaces `STDIN_UNAVAILABLE` rather
 *    than hanging the CLI forever waiting on an interactive user.
 * 3. **File** — `rawValue.startsWith("@")` reads the file at the path that
 *    follows the `@` and returns its UTF-8 contents. ENOENT becomes
 *    `FILE_NOT_FOUND`; any other read failure becomes `FILE_READ_ERROR`.
 * 4. **Inline** — any other defined `rawValue` is returned verbatim.
 *
 * Returns `undefined` when neither `rawValue` is defined nor `enableEditor`
 * is set — this is the "user did not pass the flag" case, which the caller
 * usually branches on to leave the field unchanged.
 *
 * Throws {@link FreeTextError} for input mistakes; callers are expected to
 * surface the error with the standard `(<code>): <message>` rendering and
 * exit non-zero before any network call is made.
 */
export async function resolveFreeText(
  rawValue: string | undefined,
  options: ResolveFreeTextOptions,
): Promise<string | undefined> {
  const { flagName } = options;
  const enableEditor = options.enableEditor ?? false;

  // Mode-conflict gate: combining `--edit` with any concrete value (inline,
  // `-`, or `@path`) is ambiguous about which side wins, so we refuse to
  // guess. Catches all three cross-mode combinations in a single check.
  if (enableEditor && rawValue !== undefined) {
    throw new FreeTextError(
      "MODE_CONFLICT",
      `--edit cannot be combined with --${flagName} <value>; pick one input mode`,
    );
  }

  if (enableEditor) {
    const editor = options.editorEnv ?? process.env.EDITOR ?? "vi";
    const seed = options.currentValue ?? "";
    return invokeEditor(editor, seed, options.spawn ?? defaultSpawn);
  }

  if (rawValue === undefined) return undefined;

  if (rawValue === "-") {
    if (stdinClaimed) {
      throw new FreeTextError(
        "STDIN_DOUBLE_CLAIM",
        `--${flagName}: stdin already consumed by an earlier flag; only one flag may read stdin per invocation`,
      );
    }
    const stream = options.stdin ?? process.stdin;
    if (isTtyStream(stream)) {
      throw new FreeTextError(
        "STDIN_UNAVAILABLE",
        `--${flagName}: stdin requested ('-') but no input is being piped; pipe via shell or use @path`,
      );
    }
    stdinClaimed = true;
    return readAllFromStream(stream);
  }

  if (rawValue.startsWith("@")) {
    const filePath = rawValue.slice(1);
    const reader = options.readFile ?? defaultReader;
    try {
      return await reader(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "ENOENT") {
        throw new FreeTextError("FILE_NOT_FOUND", `--${flagName}: file not found: ${filePath}`);
      }
      throw new FreeTextError("FILE_READ_ERROR", `--${flagName}: failed to read ${filePath}: ${message}`);
    }
  }

  return rawValue;
}

const defaultReader = (path: string): Promise<string> => defaultReadFile(path, "utf-8");

function isTtyStream(stream: NodeJS.ReadableStream): boolean {
  // `process.stdin` (a `tty.ReadStream`) carries `isTTY: true` when the
  // user is running an interactive shell with no piped input. Non-TTY
  // streams (test fakes, real pipes) lack the property at runtime even
  // though `NodeJS.ReadStream` types it as a definite `boolean` — narrow
  // through a structural cast so the missing-property case becomes
  // `false` rather than a thrown access.
  const maybeTty = stream as { readonly isTTY?: boolean };
  return maybeTty.isTTY === true;
}

/**
 * Read the entire stream as a UTF-8 string. The encoding is set on the
 * stream so iteration yields strings, not Buffers — this also keeps a
 * single decoder across chunks (avoids splitting a multi-byte character
 * across two reads).
 */
async function readAllFromStream(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding("utf-8");
  let buf = "";
  for await (const chunk of stream) {
    buf += String(chunk);
  }
  return buf;
}

/**
 * Edit-in-`$EDITOR` flow. Writes `seed` to a randomly-named file in
 * `os.tmpdir()`, spawns the editor with `stdio: "inherit"` so the editor
 * directly owns the user's TTY, awaits exit, reads the saved buffer, and
 * cleans up the temp directory in `finally` even on editor failure.
 *
 * The editor process inherits stdio so the user sees the editor UI
 * directly; the helper itself produces no terminal output during the edit.
 */
async function invokeEditor(editor: string, seed: string, spawn: typeof defaultSpawn): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ttctl-edit-"));
  const tempFile = join(dir, "buffer.txt");
  try {
    await writeFile(tempFile, seed, "utf-8");
    await new Promise<void>((resolve, reject) => {
      const child: ChildProcess = spawn(editor, [tempFile], { stdio: "inherit" });
      let settled = false;
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new FreeTextError("EDITOR_FAILED", `failed to launch editor '${editor}': ${err.message}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve();
        } else {
          reject(new FreeTextError("EDITOR_FAILED", `editor '${editor}' exited with code ${String(code)}`));
        }
      });
    });
    // `return await` inside try/finally ensures the cleanup in `finally`
    // runs AFTER the read settles, not concurrently with it.
    return await defaultReadFile(tempFile, "utf-8");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // Cleanup is best-effort: the OS reaps `tmpdir` entries periodically
      // anyway, and surfacing a cleanup failure would mask the actual
      // editor result the caller cares about.
    });
  }
}
