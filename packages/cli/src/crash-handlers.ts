// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { redactString } from "@ttctl/core";

/**
 * Discriminator for the two top-level crash paths Node.js exposes.
 * `uncaughtException` fires for synchronous throws that escape every
 * try/catch frame; `unhandledRejection` fires for rejected promises with
 * no `.catch()` or `await` upstream. Both are terminal — the process
 * is exiting; the only question is whether the crash output leaks an
 * in-memory secret on the way out.
 */
export type CrashKind = "uncaughtException" | "unhandledRejection";

/**
 * Build the redacted crash log for an uncaught throw or unhandled
 * promise rejection. Returns a multi-line string suitable for stderr.
 *
 * Wire shape:
 *
 *     [<kind>] <ErrorName>: <message>
 *     <stack>
 *
 * For non-`Error` rejections (`reject("string")`, `reject(42)`,
 * `reject(undefined)`), the name falls back to `UnknownError` and the
 * message is `String(reason)`; there is no stack.
 *
 * **Redaction**: the assembled string is run through {@link redactString}
 * from `@ttctl/core`, replacing every canonical Toptal session bearer
 * (`user_<24hex>_<20alnum>`) with `***REDACTED***`. The crash log
 * intentionally does NOT include `process.env`, command-line arguments,
 * or any other ambient runtime state — those are the load-bearing
 * defenses against process-environment leakage (env vars carrying
 * 1Password session tokens, shell history hints, etc.). Bearer
 * scrubbing is defense-in-depth for the case where a thrown error's
 * message or stack frame interpolates a captured bearer.
 *
 * Pure — no I/O, no process state mutation.
 *
 * See `SECURITY.md` § Crash-output secret invariant for the
 * cross-cutting contract this function satisfies.
 */
export function formatCrashLog(err: unknown, kind: CrashKind): string {
  const isError = err instanceof Error;
  const name = isError ? err.name : "UnknownError";
  const message = isError ? err.message : String(err);
  const stack = isError && err.stack !== undefined && err.stack !== "" ? err.stack : undefined;
  const head = `[${kind}] ${name}: ${message}`;
  const body = stack !== undefined ? `${head}\n${stack}` : head;
  return redactString(body);
}

/**
 * Install global crash handlers for `uncaughtException` and
 * `unhandledRejection` (issue #207). Each handler:
 *
 * 1. Formats the throw via {@link formatCrashLog} (bearer-pattern
 *    scrubbed via `@ttctl/core` `redactString`).
 * 2. Writes the formatted block to `process.stderr` — never `stdout`
 *    (the data channel `-o json` / `-o yaml` is owned by command
 *    handlers and must remain uncontaminated even on crash).
 * 3. Exits with code `1` (non-zero — generic error).
 *
 * Handlers do NOT log `process.env`, `process.argv`, or any other
 * ambient runtime state; those would risk dumping shell-history hints,
 * 1Password session env vars (`OP_SESSION_*`), and other secrets that
 * tested crash-output assertions cannot catch from the application
 * side.
 *
 * The umbrella bin (`packages/ttctl/src/cli.ts`) calls this once at
 * startup before invoking `main()`. Calling twice would register two
 * listeners for each event — Node.js permits this but it doubles the
 * stderr output, so callers should treat this as a startup-only API.
 *
 * Exit channel: writers use `process.stderr.write` directly rather
 * than `console.error` because the latter can be redirected by
 * downstream test infrastructure in surprising ways. `stderr.write` is
 * the most direct path to the parent process's standard-error stream.
 */
export function installCrashHandlers(): void {
  process.on("uncaughtException", (err: Error) => {
    process.stderr.write(formatCrashLog(err, "uncaughtException") + "\n");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    process.stderr.write(formatCrashLog(reason, "unhandledRejection") + "\n");
    process.exit(1);
  });
}
