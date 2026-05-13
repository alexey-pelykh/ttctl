// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * MCP-side structured-event diagnostic taxonomy (issue #224). Mirrors the
 * config-write debug taxonomy in `@ttctl/core/configWriter.ts`
 * (`TTCTL_DEBUG_CONFIG=1`) but scoped to the MCP entry point: tool
 * invocations, auth-resolver re-reads, and transport errors observed
 * inside the long-lived MCP process.
 *
 * Two emission paths:
 *
 *   1. **Default env-gated stderr emitter.** Reads `TTCTL_DEBUG_MCP=1`
 *      ONCE at module load so the disabled path constant-folds to a single
 *      comparison in V8 (NFR: zero-cost-when-disabled). Writes one
 *      JSON-encoded record per line to `process.stderr` — the stdio
 *      data channel (`process.stdout`, owned by the MCP protocol) is
 *      never touched.
 *   2. **Injected logger.** Tests (and any future SSE/HTTP transport
 *      wrapper) call {@link setMcpDiagnosticLogger} to replace the
 *      default emitter with a fake that captures records into an array.
 *      The injection point in production code is
 *      {@link runMcpStdio} — wiring the logger ONCE at the entry point
 *      so per-tool callsites stay free of conditional logger plumbing.
 *
 * Bearer-absence is a load-bearing invariant: no record variant in the
 * {@link McpDebugRecord} discriminated union carries a bearer-shaped
 * field, and the runtime `redactBody` pass on `args_redacted` covers
 * the one slot that could plausibly admit one (tool args contributed by
 * the LLM client). The test suite asserts substring-absence across every
 * emission path; the type system enforces it at the call-site.
 */

import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { BEARER_PATTERN_SOURCE, REDACTED, redactBody } from "@ttctl/core";

/**
 * Module-load capture of `TTCTL_DEBUG_MCP=1`. Read ONCE so the disabled
 * path constant-folds to a single `if (DEBUG_ENABLED)` comparison in V8 —
 * the env-unset path pays zero runtime overhead per-event.
 *
 * Tests that exercise both env-set and env-unset paths re-import the
 * module via dynamic `import()` after mutating `process.env`. The
 * injection path via {@link setMcpDiagnosticLogger} sidesteps the env
 * gate entirely (the injected logger is always called) and is the
 * preferred pattern for new tests.
 */
const DEBUG_ENABLED = process.env["TTCTL_DEBUG_MCP"] === "1";

/**
 * Status discriminator for {@link McpToolInvokeEndRecord}. Three values
 * cover the per-call outcome lattice:
 *
 *   - `"ok"` — tool callback resolved and returned a success-shaped
 *     `ToolSuccessResponse` (no `isError: true`).
 *   - `"error"` — tool callback resolved with a `ToolErrorResponse`
 *     (typed domain failure, e.g. `(UNAUTHENTICATED): No auth token
 *     found`). The MCP wire protocol carries this back to the client
 *     verbatim; it is NOT an uncaught exception.
 *   - `"throw"` — tool callback threw an exception that bubbled out of
 *     the wrapper. The wrapper re-throws after emission so the MCP
 *     SDK's default error path runs.
 *
 * Separating `"error"` from `"throw"` lets operators triage typed
 * domain failures (expected, recoverable) from uncaught exceptions
 * (unexpected, often a bug).
 */
export type McpToolInvokeStatus = "ok" | "error" | "throw";

/**
 * Common base for every MCP-side diagnostic record. Mirrors the base
 * fields on `configWriter.ts`'s `DebugRecordBase` so a single
 * `jq 'select(.event == ...)'` filter works across both taxonomies.
 *
 * - `ts` — wall-clock ISO-8601 timestamp; useful for cross-process
 *   correlation when an MCP session and a CLI invocation interleave.
 * - `event` — discriminator naming the variant.
 */
interface McpDebugRecordBase {
  ts: string;
}

/**
 * `mcp_tool_invoke_start` — emitted BEFORE the tool callback runs.
 * Pairs 1:1 with a downstream `mcp_tool_invoke_end` (`{tool, ts}` join key,
 * plus `duration_ms` on the end record).
 *
 * `args_redacted` is the redacted form of the tool input. The redaction
 * runs through `redactBody` from `@ttctl/core` so the canonical bearer
 * pattern (`user_<24hex>_<20alnum>`), cookie strings, and secret-named
 * fields (`password`, `token`, etc. per `SECRET_BODY_FIELD_NAMES`) are
 * replaced with `***REDACTED***` BEFORE the record is constructed. The
 * resulting object is safe to serialize.
 */
export interface McpToolInvokeStartRecord extends McpDebugRecordBase {
  event: "mcp_tool_invoke_start";
  tool: string;
  args_redacted: unknown;
}

/**
 * `mcp_tool_invoke_end` — emitted AFTER the tool callback completes (or
 * throws). `duration_ms` is `performance.now()`-derived monotonic elapsed
 * milliseconds rounded to integer, so the value stays accurate across
 * wall-clock adjustments during the call.
 *
 * The `status` field discriminates the three outcomes (see
 * {@link McpToolInvokeStatus}).
 */
export interface McpToolInvokeEndRecord extends McpDebugRecordBase {
  event: "mcp_tool_invoke_end";
  tool: string;
  duration_ms: number;
  status: McpToolInvokeStatus;
}

/**
 * `mcp_auth_resolve` — emitted on every auth-resolver invocation (every
 * tool call hits the resolver). Useful for cache-miss diagnostics in
 * long-running MCP sessions: a token rotation via a sibling
 * `ttctl auth signin` shows up as `token_fresh: true` on the FIRST
 * post-rotation tool call.
 *
 * Fields:
 *   - `mtime_ms` — mtime of the captured config path at resolve time,
 *     or `null` if the stat failed (file removed, permissions changed
 *     mid-session). Stat overhead is bounded — POSIX stat is microseconds
 *     and only fires when emission is active.
 *   - `token_fresh` — `true` when this resolve produced a token AND the
 *     mtime differs from the prior resolve's mtime, `false` otherwise.
 *     The "first resolve" case (no prior mtime) reports `true` if a
 *     token was found, `false` if `auth.token` was undefined.
 *   - `outcome` — discriminates the three resolve outcomes: `"ok"` when
 *     a token was returned, `"unauthenticated"` when `auth.token` was
 *     undefined, `"config_error"` when the resolver rejected with a
 *     `ConfigError` (NO_CREDS, PARSE, VALIDATION, PERMISSION, LOCKED).
 *
 * The bearer value itself is NEVER in the record — only the boolean
 * presence signal.
 */
export interface McpAuthResolveRecord extends McpDebugRecordBase {
  event: "mcp_auth_resolve";
  mtime_ms: number | null;
  token_fresh: boolean;
  outcome: "ok" | "unauthenticated" | "config_error";
}

/**
 * `mcp_transport_error` — emitted when a transport-layer error
 * (`Cf403Error`, `Cf403PersistentError`, `SchedulerBearerExpired`,
 * other named transport throws) bubbles out of a tool callback.
 * Separates transport-cause failures from domain-cause failures so
 * Cloudflare regressions show up as a single grep target.
 *
 * Fields:
 *   - `tool` — name of the tool whose handler observed the error.
 *   - `surface` — `"talent-profile"` / `"mobile-gateway"` / `"scheduler"`
 *     / `"unknown"`. Extracted from the error class where possible
 *     (`Cf403Error` carries `surface` verbatim); otherwise `"unknown"`.
 *   - `error_class` — `err.name` (`"Cf403Error"`,
 *     `"Cf403PersistentError"`, …). Stable across messages.
 *   - `status` — HTTP status code when the error carries one, else
 *     `null`. `Cf403Error`/`Cf403PersistentError` -> 403,
 *     `SchedulerBearerExpired` -> 401.
 */
export interface McpTransportErrorRecord extends McpDebugRecordBase {
  event: "mcp_transport_error";
  tool: string;
  surface: "talent-profile" | "mobile-gateway" | "scheduler" | "unknown";
  error_class: string;
  status: number | null;
}

/**
 * Discriminated union of every MCP-side diagnostic record. The type
 * system is the FIRST line of bearer-absence enforcement: no variant
 * here admits a bearer-shaped field. The runtime substring-assertion in
 * `__tests__/diagnostic.test.ts` is the SECOND line — catches any
 * accidental bearer leakage via `args_redacted` (the only slot where
 * client-supplied data flows in).
 */
export type McpDebugRecord =
  | McpToolInvokeStartRecord
  | McpToolInvokeEndRecord
  | McpAuthResolveRecord
  | McpTransportErrorRecord;

/**
 * Logger signature: receives a fully-constructed record and emits it
 * somewhere observable (stderr by default; an in-memory array in tests).
 *
 * The logger MUST NOT throw — diagnostic emission is a fire-and-forget
 * side channel and an exception here would unwind the tool call. The
 * default emitter catches and swallows any `process.stderr.write` error
 * (rare on stdio; pipe-broken EPIPE during teardown is the only realistic
 * case). Custom loggers should follow the same posture.
 */
export type McpDiagnosticLogger = (record: McpDebugRecord) => void;

/**
 * Default logger: env-gated stderr emitter. When `TTCTL_DEBUG_MCP=1`,
 * writes one JSON-encoded record per line to `process.stderr`. When
 * unset (or any other value), no-op.
 *
 * The env gate is captured at module load (see {@link DEBUG_ENABLED})
 * so a JIT'd V8 inlines this function down to either:
 *   - `() => undefined` (env unset; constant-folded dead branch), or
 *   - `(record) => process.stderr.write(JSON.stringify(record) + '\n')`
 *     (env set).
 *
 * Stderr is chosen so the stdio data channel (stdout, owned by the MCP
 * JSON-RPC protocol) stays uncontaminated.
 */
const defaultLogger: McpDiagnosticLogger = (record: McpDebugRecord): void => {
  if (!DEBUG_ENABLED) return;
  try {
    process.stderr.write(JSON.stringify(record) + "\n");
  } catch {
    // EPIPE during teardown; nothing meaningful to do. Diagnostic
    // emission must never unwind a tool call.
  }
};

/**
 * Module-scoped logger holder. Mirrors the `currentLevel` pattern in
 * `@ttctl/core/lib/diagnostic-log.ts`: one global, set at entry-point
 * wiring time, read on every emit. Module isolation keeps per-tool
 * callsites focused on their domain (no logger parameter threading)
 * while exposing a single test-injection point.
 */
let currentLogger: McpDiagnosticLogger = defaultLogger;

/**
 * Replace the active MCP diagnostic logger. Wired in production by
 * `runMcpStdio()` at server startup; called by tests in `beforeEach`
 * to inject a capturing logger.
 *
 * Production callers pass `defaultLogger` (re-exported via the index)
 * or any custom logger conforming to {@link McpDiagnosticLogger}.
 */
export function setMcpDiagnosticLogger(logger: McpDiagnosticLogger): void {
  currentLogger = logger;
}

/**
 * Read the currently-installed logger. Tests use this for round-trip
 * verification ("set, then read, then call"). Production code reads via
 * {@link emitMcpDebug} instead.
 */
export function getMcpDiagnosticLogger(): McpDiagnosticLogger {
  return currentLogger;
}

/**
 * Restore the default env-gated stderr logger AND clear the mtime
 * tracker. Tests MUST call this in `afterEach` to avoid state bleeding
 * across cases — both the logger override and the mtime baseline are
 * module-scoped state.
 */
export function resetMcpDiagnosticLogger(): void {
  currentLogger = defaultLogger;
  lastSeenMtime.clear();
}

/**
 * Emit a structured MCP debug record via the current logger. Lazy
 * construction via the `makeRecord` thunk keeps the disabled path
 * zero-allocation when `currentLogger === defaultLogger` and
 * `DEBUG_ENABLED === false`: V8 inlines `defaultLogger` to a no-op and
 * the thunk body is dead code.
 *
 * When a custom logger is installed (test injection), the thunk runs
 * unconditionally — the logger sees every event regardless of env state.
 * This is intentional: tests assert on emission shape without needing
 * to manipulate `process.env`.
 */
export function emitMcpDebug(makeRecord: () => McpDebugRecord): void {
  // Fast-path: default logger + env unset → skip the thunk entirely.
  // Any custom logger (test injection) bypasses the gate.
  if (currentLogger === defaultLogger && !DEBUG_ENABLED) return;
  currentLogger(makeRecord());
}

/**
 * Module-scoped tracker of the last-observed mtime per config path.
 * Lets {@link emitMcpAuthResolve} report `token_fresh: true` on the
 * FIRST tool call after a sibling `ttctl auth signin` rotates the
 * bearer (mtime moves; fresh resolve picks up the new value).
 *
 * Keyed by absolute config path so multi-session callers (theoretical
 * future SSE transport hosting two clients) don't collide. Production
 * use today is single-path: one MCP session = one captured path.
 *
 * Reset by {@link resetMcpDiagnosticLogger} so tests get a clean slate
 * between cases.
 */
const lastSeenMtime: Map<string, number> = new Map();

/**
 * Emit a `mcp_auth_resolve` record summarizing an auth-resolver
 * invocation. Called by the three resolver factories
 * (`createToolAuthResolver`, `createTokenLoader`, `createTokenResolver`)
 * AFTER each per-call `resolveConfig` returns (or throws). The bearer
 * itself is NEVER passed in — only `hasToken: boolean`.
 *
 * `mtime_ms` is captured via a synchronous `statSync` on the captured
 * config path. Sync stat is microseconds and only fires when emission
 * is active (the env-gate / injected-logger fast-path skips the stat
 * entirely on the disabled path). On stat failure (file removed
 * mid-session, permissions changed), `mtime_ms` is `null` and
 * `token_fresh` is `false` (cannot prove freshness without a baseline).
 */
export function emitMcpAuthResolve(
  configPath: string,
  outcome: McpAuthResolveRecord["outcome"],
  hasToken: boolean,
): void {
  if (currentLogger === defaultLogger && !DEBUG_ENABLED) return;
  let mtime_ms: number | null;
  try {
    mtime_ms = statSync(configPath).mtimeMs;
  } catch {
    mtime_ms = null;
  }
  const prior = lastSeenMtime.get(configPath);
  // token_fresh is true ONLY when we have a NEW mtime AND a token.
  // - First call (no prior): true if hasToken (the token "appears fresh"
  //   from the resolver's POV).
  // - mtime moved forward: true if hasToken.
  // - mtime unchanged: false (same file, no rotation since last call).
  // - mtime null: false (cannot prove freshness).
  const token_fresh =
    mtime_ms !== null && hasToken && (prior === undefined || mtime_ms !== prior);
  if (mtime_ms !== null) lastSeenMtime.set(configPath, mtime_ms);
  currentLogger({
    ts: new Date().toISOString(),
    event: "mcp_auth_resolve",
    mtime_ms,
    token_fresh,
    outcome,
  });
}

/**
 * Helper: redact tool args for {@link McpToolInvokeStartRecord}. Two-pass
 * defense:
 *
 *   1. `redactBody` from `@ttctl/core` replaces FIELD values whose key
 *      matches `SECRET_BODY_FIELD_NAMES` (`password`, `token`, etc.).
 *   2. {@link scrubBearerPatternInStrings} walks the result and replaces
 *      any STRING value that matches the canonical bearer pattern
 *      (`user_<24hex>_<20alnum>`). This catches the case where an LLM
 *      client pastes a bearer-shaped value into a free-text arg like
 *      `{ note: "user_abc..." }` that the field-name pass would miss.
 *
 * The MCP tool surface accepts arbitrary client-supplied JSON, so the
 * second pass is the load-bearing defense for bearer-absence in
 * `args_redacted`. The transport-side `redactBody` doesn't need it
 * because GraphQL variables are typed and the bearer never appears in
 * any documented variable slot — MCP args have no such guarantee.
 */
export function redactToolArgs(args: unknown): unknown {
  return scrubBearerPatternInStrings(redactBody(args));
}

/**
 * Walk an arbitrary structure (object / array / scalar) and replace any
 * string value matching the canonical Toptal session bearer pattern
 * with {@link REDACTED}. The pattern source comes from `@ttctl/core` so
 * we never duplicate the bearer regex — the lint-time leakage check
 * uses the same constant.
 *
 * Pure — does not mutate the input. Designed to compose AFTER
 * `redactBody`: any field already replaced with `***REDACTED***` is a
 * non-matching scalar and passes through unchanged.
 */
function scrubBearerPatternInStrings(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    return input.match(new RegExp(BEARER_PATTERN_SOURCE)) !== null ? REDACTED : input;
  }
  if (Array.isArray(input)) return input.map((item: unknown) => scrubBearerPatternInStrings(item));
  if (typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = scrubBearerPatternInStrings(value);
  }
  return out;
}

/**
 * Extract the transport `surface` from an error-shaped value. The
 * `Cf403Error` / `Cf403PersistentError` classes carry `surface` verbatim;
 * `SchedulerBearerExpired` implies `"scheduler"`. Anything else returns
 * `"unknown"` — the operator triages from `error_class` directly.
 *
 * Exported for tests; production code routes through
 * {@link emitMcpTransportError}.
 */
export function extractTransportSurface(err: unknown): McpTransportErrorRecord["surface"] {
  if (typeof err !== "object" || err === null) return "unknown";
  const name = (err as { name?: unknown }).name;
  if (name === "SchedulerBearerExpired") return "scheduler";
  const surface = (err as { surface?: unknown }).surface;
  if (surface === "talent-profile" || surface === "mobile-gateway" || surface === "scheduler") return surface;
  return "unknown";
}

/**
 * Extract HTTP status from a transport error. `Cf403Error` /
 * `Cf403PersistentError` are 403 by construction; `SchedulerBearerExpired`
 * is 401. Errors carrying a numeric `status` field return that value.
 * Anything else returns `null`.
 */
export function extractTransportStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const name = (err as { name?: unknown }).name;
  if (name === "Cf403Error" || name === "Cf403PersistentError") return 403;
  if (name === "SchedulerBearerExpired") return 401;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status;
  return null;
}

/**
 * Recognize transport-class errors so the wrapper can emit
 * {@link McpTransportErrorRecord} only for transport-cause failures
 * (Cloudflare 403, scheduler bearer expired, etc.) and skip domain-cause
 * throws (which the MCP error contract surfaces via `ToolErrorResponse`).
 */
export function isTransportError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "Cf403Error" || name === "Cf403PersistentError" || name === "SchedulerBearerExpired";
}

/**
 * Helper for wrapping a tool callback with the start/end/transport-error
 * emission contract. The wrapped handler:
 *
 *   1. Captures a monotonic start time.
 *   2. Emits `mcp_tool_invoke_start` with `redactToolArgs(input)`.
 *   3. Runs the original handler with all forwarded arguments.
 *   4. On success: emits `mcp_tool_invoke_end` with status `"ok"` /
 *      `"error"` derived from the response shape, plus `duration_ms`.
 *   5. On throw: emits `mcp_tool_invoke_end` with status `"throw"`,
 *      then `mcp_transport_error` if the error class is transport-typed,
 *      then re-throws.
 *
 * The wrapper is a closure over the tool name so the same factory
 * produces a per-tool wrapper that names itself correctly in every
 * emission.
 *
 * The MCP SDK's `ToolCallback<Args>` accepts a two-argument callback
 * `(input, extra)` (where `extra` is `RequestHandlerExtra` carrying
 * the active session / abort signal). Some tool callbacks accept zero
 * arguments (no inputSchema) — the SDK calls them with `(extra)` only.
 * The wrapper forwards `...rest` so both shapes work without per-shape
 * branching at the call site.
 */
export function wrapToolHandler<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  THandler extends (...args: any[]) => Promise<{ isError?: boolean }> | { isError?: boolean },
>(toolName: string, handler: THandler): THandler {
  const wrapped = async (...args: Parameters<THandler>): Promise<Awaited<ReturnType<THandler>>> => {
    const input = args[0] as unknown;
    const start = performance.now();
    emitMcpDebug((): McpToolInvokeStartRecord => {
      return {
        ts: new Date().toISOString(),
        event: "mcp_tool_invoke_start",
        tool: toolName,
        args_redacted: redactToolArgs(input),
      };
    });
    try {
      const result = (await handler(...args)) as Awaited<ReturnType<THandler>>;
      const duration_ms = Math.round(performance.now() - start);
      const status: McpToolInvokeStatus = result.isError === true ? "error" : "ok";
      emitMcpDebug((): McpToolInvokeEndRecord => {
        return {
          ts: new Date().toISOString(),
          event: "mcp_tool_invoke_end",
          tool: toolName,
          duration_ms,
          status,
        };
      });
      return result;
    } catch (err) {
      const duration_ms = Math.round(performance.now() - start);
      emitMcpDebug((): McpToolInvokeEndRecord => {
        return {
          ts: new Date().toISOString(),
          event: "mcp_tool_invoke_end",
          tool: toolName,
          duration_ms,
          status: "throw",
        };
      });
      if (isTransportError(err)) {
        emitMcpDebug((): McpTransportErrorRecord => {
          return {
            ts: new Date().toISOString(),
            event: "mcp_transport_error",
            tool: toolName,
            surface: extractTransportSurface(err),
            error_class: (err as { name?: string }).name ?? "Error",
            status: extractTransportStatus(err),
          };
        });
      }
      throw err;
    }
  };
  return wrapped as unknown as THandler;
}
