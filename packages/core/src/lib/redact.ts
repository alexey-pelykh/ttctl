// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Centralized redaction primitives for diagnostic logging and pattern-leak
 * detection.
 *
 * This module is the **single source of truth** for "what is a secret" across
 * the project — both the runtime debug-log path (issue #139) and the static
 * `check-secret-leakage` script consume the constants defined here. Any
 * future addition to either redaction (runtime) or detection (lint) MUST
 * extend these exports rather than redefining them locally.
 *
 * Consumers:
 *
 * - `packages/core/src/lib/diagnostic-log.ts` calls {@link redactHeaders} /
 *   {@link redactBody} before emitting any `--verbose` / `--debug` line
 *   to stderr.
 * - `scripts/check-secret-leakage.ts` consumes {@link BEARER_PATTERN_SOURCE}
 *   to scan tracked source for accidentally committed Toptal session
 *   bearers.
 *
 * Wire shape is stable; downstream tools and tests identify redaction sites
 * by exact match against {@link REDACTED}. Patterns are append-only — never
 * remove an entry, only add. Tests assert that no `authToken` value or
 * cookie value can appear verbatim in the output of either consumer.
 */

/**
 * Replacement marker for redacted scalar values. Stable wire-shape so
 * downstream tools and tests can identify redaction sites by exact match.
 */
export const REDACTED = "***REDACTED***" as const;

/**
 * Source pattern for Toptal Talent's session bearer token, exported as a
 * STRING (not a `RegExp`) so non-TypeScript consumers (the
 * `scripts/check-secret-leakage.ts` lint script before its own
 * `new RegExp(..., "g")` construction) can adopt the canonical pattern
 * without paying for any module-load-time `g`-flag state. The TS-side
 * {@link BEARER_PATTERN} below wraps this source in a fresh `RegExp` per
 * import so callers do not share the `lastIndex` cursor (`/g` flag is
 * stateful per-instance).
 *
 * The bearer shape is `user_<24hex>_<20alnum>` — the canonical output of
 * Toptal's `EmailPasswordSignIn` mutation (per
 * `hq/engineering/adr/ADR-005-auth-model.md`). Anchored to character
 * class boundaries: the `user_` literal prefix is TTCtl-specific (no false
 * positives against unrelated `user_` strings in test data), the 24-hex +
 * 20-alphanumeric pair is the empirically observed shape.
 */
export const BEARER_PATTERN_SOURCE = "user_[0-9a-f]{24}_[A-Za-z0-9]{20}" as const;

/**
 * Compiled bearer-shape regex with the `g` (global) flag. A fresh `RegExp`
 * instance constructed at module-load time so callers in this package can
 * use `.test()` / `.exec()` against multiline strings without resetting
 * `lastIndex` between unrelated callers.
 *
 * **Stateful flag warning**: the `g` flag makes `exec` / `test` advance an
 * internal cursor. Callers iterating over multiple inputs must either
 * reset `BEARER_PATTERN.lastIndex = 0` before each input, or construct a
 * fresh instance via `new RegExp(BEARER_PATTERN_SOURCE, "g")`.
 */
export const BEARER_PATTERN: RegExp = new RegExp(BEARER_PATTERN_SOURCE, "g");

/**
 * Header names whose VALUES carry session-bearing or otherwise
 * authentication-sensitive material. Lowercased for case-insensitive
 * matching — runtime code paths normalise the header key to lowercase
 * before lookup. Includes both standard auth headers (`authorization`,
 * `cookie`, `proxy-authorization`) and a small set of vendor-specific
 * variants that historically carry session tokens.
 *
 * `set-cookie` is included because GraphQL responses occasionally echo
 * session-bearing cookies on the response side; redacting it on the
 * response trace keeps the symmetric request/response wire shape clean.
 */
export const SECRET_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-auth-token",
  "x-csrf-token",
  "x-session-token",
  "x-toptal-session",
]);

/**
 * Field names (case-insensitive) whose VALUES carry secrets when they
 * appear inside request or response bodies — GraphQL `variables`, JSON
 * payloads, REST request bodies, error envelopes, etc. Runtime code
 * paths normalise the field key to lowercase before lookup.
 *
 * Conservative on purpose: the cost of redacting a field that turns out
 * to be benign is zero (one fewer scalar visible in debug output); the
 * cost of NOT redacting an actual secret is a credential leak. Add new
 * field names freely.
 */
export const SECRET_BODY_FIELD_NAMES: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authtoken",
  "auth_token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authorization",
  "email",
]);

/**
 * Return a redacted copy of `headers`. Keys are preserved verbatim; values
 * for keys whose lowercase form is in {@link SECRET_HEADER_NAMES} are
 * replaced with {@link REDACTED}. Non-secret headers pass through unchanged.
 *
 * For the `cookie` and `set-cookie` headers, the entire header value is
 * replaced. TTCtl is bearer-only (no cookie jar is configured in either
 * transport — see ADR-005), but a server may still emit `Set-Cookie` on
 * responses (Cloudflare bot-management cookies, Toptal session hints
 * TTCtl ignores). Whole-value redaction is the safe default for that
 * case; cookie names carry no operational signal here because TTCtl
 * never sends them back.
 *
 * Pure — does not mutate the input.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/**
 * Deep-walk `body` and replace values of any field whose key (lowercased)
 * is in {@link SECRET_BODY_FIELD_NAMES} with {@link REDACTED}. Returns a
 * structurally cloned copy — does NOT mutate the input. Non-object inputs
 * pass through unchanged (scalars, null, undefined).
 *
 * Walks both plain objects and arrays. Arrays inherit the parent's
 * redaction rules — e.g., `{credentials: [{password: "..."}]}` redacts
 * the `password` field inside the array element.
 *
 * Designed for GraphQL `variables` payloads (which are arbitrary JSON
 * trees) and REST request bodies. Cycle detection is NOT implemented —
 * GraphQL request/response payloads are tree-shaped by spec, so cycles
 * cannot occur in valid inputs; defensive callers (e.g.,
 * `diagnostic-log.ts`) parse JSON before invoking and pass the parsed
 * tree.
 *
 * The implementation walks keys via `Object.entries` which preserves
 * insertion order in V8 — useful for tests that snapshot the redacted
 * output as JSON.
 */
export function redactBody(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  if (Array.isArray(body)) return body.map((item) => redactBody(item));
  if (typeof body !== "object") return body;
  const input = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_BODY_FIELD_NAMES.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redactBody(value);
    }
  }
  return out;
}

/**
 * True when `text` contains a Toptal Talent session bearer match per
 * {@link BEARER_PATTERN_SOURCE}. Convenience wrapper that constructs a
 * fresh `RegExp` per call so `lastIndex` state on the shared
 * {@link BEARER_PATTERN} cannot leak into the test.
 *
 * Used by `scripts/check-secret-leakage.ts` as the authoritative
 * "contains-bearer" check, replacing the previous in-script regex.
 */
export function containsBearerToken(text: string): boolean {
  return new RegExp(BEARER_PATTERN_SOURCE).test(text);
}
