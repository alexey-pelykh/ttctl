// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { readFile as defaultReadFile } from "node:fs/promises";
import { resolve as resolveAbsolutePath } from "node:path";

import type { z, ZodType } from "zod";

/**
 * Stable error codes carried by {@link JsonInputError}. Script consumers
 * branch on `error.code` rather than parsing the user-facing prose. Codes
 * intentionally cover only conditions surfaced *before* the helper hands
 * control back to the caller — anything caused by the parsed payload
 * (e.g. server-side rejection of an answer shape) is the caller's domain.
 *
 * Sibling to `FreeTextError` in `freetext.ts`: same diagnostic posture,
 * different input grammar (a bare path here vs. `@path` prefix there).
 *
 * `SCHEMA_ERROR` (#438) fires when {@link parseAsRecovered} rejects the
 * parsed JSON against a recovered Zod schema — i.e. the file syntax is
 * valid JSON but the SHAPE (field names, types, required keys) does not
 * match the recovered SDL input type. Surfaced as the same `VALIDATION_ERROR`
 * envelope as the syntax-level codes by the caller; the JSON-pointer-style
 * field path lives in the error `message`.
 */
export type JsonInputErrorCode =
  "FILE_NOT_FOUND" | "FILE_READ_ERROR" | "PARSE_ERROR" | "SCHEMA_ERROR" | "STDIN_UNAVAILABLE" | "STDIN_DOUBLE_CLAIM";

/**
 * Typed error thrown by {@link readJsonInput} for input mistakes the user
 * must fix before retrying. Callers render the standard
 * `<command> failed (<code>): <message>` shape and exit non-zero.
 *
 * Production failures from the API stay typed as their domain errors
 * (e.g. `applications.ApplicationsError`); this type covers ONLY
 * input-resolution failures that happen on the local machine before any
 * network call.
 */
export class JsonInputError extends Error {
  override readonly name = "JsonInputError";
  constructor(
    public readonly code: JsonInputErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Options for {@link readJsonInput}. The first block tunes behavior; the
 * trailing block (`stdin` / `readFile`) is the test-injection surface —
 * production callers leave these `undefined` and the helper resolves
 * defaults (`process.stdin`, `node:fs/promises`'s `readFile`).
 */
export interface ReadJsonInputOptions {
  /** User-facing flag name used in error messages, e.g. `"answers-file"`. */
  readonly flagName: string;

  /** Test-only: stream consumed for the `-` (stdin) mode. */
  readonly stdin?: NodeJS.ReadableStream;

  /** Test-only: replace the `fs.readFile` used by the path mode. */
  readonly readFile?: (path: string) => Promise<string>;
}

// Module-level guard for the "two flags both want stdin" diagnostic. Once
// any caller has consumed stdin through this helper, a second `-` claim
// throws `STDIN_DOUBLE_CLAIM` instead of reading already-empty input.
// Mirrors the pattern in `freetext.ts` — kept separate so the error
// message names a `--answers-file` / `--pitch-file` flag rather than a
// `freetext` flag. Tests reset this via {@link _resetStdinClaimForTesting}.
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
 * Resolve a JSON-file flag value through two supported input modes:
 *
 * 1. **Stdin** — `rawPath === "-"` reads `process.stdin` (or the injected
 *    stream) until EOF, then parses as JSON. Per ADR-008 § Decision Part
 *    2, this is the pipeable path for agent-authored answers. A non-piped
 *    TTY surfaces `STDIN_UNAVAILABLE` rather than hanging the CLI forever
 *    waiting on an interactive user. Empty stdin surfaces `PARSE_ERROR`
 *    (an empty string is not valid JSON).
 * 2. **File** — any other value is treated as a filesystem path. ENOENT
 *    becomes `FILE_NOT_FOUND` with the **absolute** path in the message
 *    (per scenario "stderr contains the absolute path"); any other read
 *    failure becomes `FILE_READ_ERROR`. Parse failures become
 *    `PARSE_ERROR` with a recovery hint citing the line/column the JSON
 *    parser reported (per AC "Recovery hint cites the parse failure
 *    line/column").
 *
 * The grammar is bare-path (NOT `@path`-prefixed) — `--answers-file
 * answers.json` reads the file at `answers.json`. This matches the
 * ADR-008-locked CLI surface; the `@path` prefix lives on the freetext
 * helper where the flag value can ALSO be inline literal text.
 *
 * Returns the parsed JSON value as `unknown` — the caller is responsible
 * for any narrowing (Stage-1 ADR-008 contract: opaque pass-through to the
 * wire). Throws {@link JsonInputError} for input mistakes; callers
 * surface the error with the AC-mandated `VALIDATION_ERROR` envelope and
 * exit non-zero BEFORE any network call is made.
 */
export async function readJsonInput(rawPath: string, options: ReadJsonInputOptions): Promise<unknown> {
  const { flagName } = options;

  if (rawPath === "-") {
    if (stdinClaimed) {
      throw new JsonInputError(
        "STDIN_DOUBLE_CLAIM",
        `--${flagName}: stdin already consumed by an earlier flag; only one flag may read stdin per invocation`,
      );
    }
    const stream = options.stdin ?? process.stdin;
    if (isTtyStream(stream)) {
      throw new JsonInputError(
        "STDIN_UNAVAILABLE",
        `--${flagName}: stdin requested ('-') but no input is being piped; pipe via shell or pass a file path`,
      );
    }
    stdinClaimed = true;
    const content = await readAllFromStream(stream);
    return parseJsonOrThrow(content, flagName, "<stdin>");
  }

  const reader = options.readFile ?? defaultReader;
  const absolutePath = resolveAbsolutePath(rawPath);
  let content: string;
  try {
    content = await reader(rawPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "ENOENT") {
      throw new JsonInputError("FILE_NOT_FOUND", `--${flagName}: file not found: ${absolutePath}`);
    }
    throw new JsonInputError("FILE_READ_ERROR", `--${flagName}: failed to read ${absolutePath}: ${message}`);
  }
  return parseJsonOrThrow(content, flagName, absolutePath);
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
 * Parse `content` as JSON. On failure, surface a `PARSE_ERROR` with the
 * line/column the parser reported (the AC mandates "Recovery hint cites
 * the parse failure line/column"). The source label (`<stdin>` or an
 * absolute path) anchors the error so a multi-flag invocation makes the
 * origin clear without prose-parsing the message.
 */
function parseJsonOrThrow(content: string, flagName: string, source: string): unknown {
  try {
    return JSON.parse(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const location = extractParseLocation(reason, content);
    const hint = location !== null ? ` (line ${location.line.toString()}, column ${location.column.toString()})` : "";
    throw new JsonInputError("PARSE_ERROR", `--${flagName}: invalid JSON from ${source}: ${reason}${hint}`);
  }
}

/**
 * Validate a previously-parsed JSON value against a recovered Zod schema
 * (#438 W1-2 — Stage-2 surface tightening per ADR-008 § Decision Part 3).
 *
 * Returns the parsed `T` on success; on schema mismatch throws a
 * {@link JsonInputError} with code `SCHEMA_ERROR` and a message that names
 * the failing field path AND the failure reason — built from
 * `ZodError.issues[]` so the caller can map ANY issue to a recovery hint
 * without parsing the prose. Multiple issues fold into a single message
 * separated by `; ` so the envelope stays one error.
 *
 * Two flavors of validation:
 *
 *   - **Single object** — pass a Zod object schema; the value must match
 *     the schema exactly. Use for `--pitch-file`-style single-payload
 *     flags.
 *   - **Array** — wrap the inner object schema with `z.array(...)` at the
 *     call site; per-entry failures surface their array index in the
 *     field path (e.g. `matcherAnswers[2].id: Required`).
 *
 * The helper does NOT read files / streams — it operates on a value the
 * caller has already parsed via {@link readJsonInput}. The separation
 * keeps `readJsonInput` Stage-1-compatible (callers that don't want
 * inner-shape validation can ignore the helper).
 *
 * **Strict-mode posture**: callers pass schemas built from the
 * `__generated__/zod-schemas.ts` factories (e.g.
 * `JobPositionAnswerInputSchema()`). Codegen emits these with implicit
 * "strip unknown keys" semantics — extra keys SILENTLY pass. For the
 * #438 AC "extra unknown key in payload rejected with field-path error",
 * the caller MUST wrap the inner schema with `.strict()` at the call
 * site. See {@link parseAsRecovered} caller in `applications/confirm.ts`
 * for the canonical pattern.
 */
export function parseAsRecovered<T>(value: unknown, schema: ZodType<T>, flagName: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues;
  const formattedIssues = issues.map(formatZodIssue).join("; ");
  throw new JsonInputError(
    "SCHEMA_ERROR",
    `--${flagName}: payload does not match the recovered schema — ${formattedIssues}`,
  );
}

/**
 * Render one Zod issue as `path: code reason` — a field-path-first form
 * that matches the AC's "stderr contains a Zod field-path indicating the
 * unknown key" scenario.
 *
 * Path rendering:
 *   - Empty path (issue at root) → `<root>`
 *   - String segments → dot-joined (`pitchData.mentorship`)
 *   - Numeric segments → square-bracketed (`matcherAnswers[2].id`)
 */
function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = renderZodPath(issue.path);
  const code = issue.code;
  const message = issue.message;
  return `${path}: ${code} (${message})`;
}

function renderZodPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "<root>";
  let buf = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      buf += `[${String(seg)}]`;
    } else {
      if (buf !== "") buf += ".";
      buf += String(seg);
    }
  }
  return buf;
}

/**
 * Best-effort extraction of (line, column) from V8's `SyntaxError`
 * messages. V8 typically emits `Unexpected token X in JSON at position N`
 * (older) or `... at position N (line L column C)` (Node 21+); when only
 * `position N` is available, we compute (line, column) from the source
 * content. Returns `null` if no position is recoverable — the caller
 * falls back to a hint-less error (still typed `PARSE_ERROR`).
 */
function extractParseLocation(message: string, content: string): { line: number; column: number } | null {
  // Modern Node emits "(line L column C)" already.
  const lineCol = /\bline\s+(\d+)\s+column\s+(\d+)\b/i.exec(message);
  if (lineCol !== null && lineCol[1] !== undefined && lineCol[2] !== undefined) {
    return { line: Number(lineCol[1]), column: Number(lineCol[2]) };
  }
  // Older Node emits "at position N" — compute (line, column) from N.
  const pos = /\bposition\s+(\d+)\b/i.exec(message);
  if (pos === null || pos[1] === undefined) return null;
  const idx = Math.min(Number(pos[1]), content.length);
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < idx; i++) {
    if (content[i] === "\n") {
      line++;
      lastBreak = i;
    }
  }
  const column = idx - lastBreak;
  return { line, column };
}
