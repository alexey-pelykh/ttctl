// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Redaction utilities for E2E test failure output (AC C3).
 *
 * Goals:
 *
 *   - Logging utilities scrub `cookie`, `email`, `password`, and other
 *     well-known credential-bearing keys from arbitrary JSON-shaped values.
 *   - Profile-shaped objects (those carrying a `bio` / `about` / `quote` /
 *     `headline` / `skillSets`) are NEVER dumped wholesale. Tests assert
 *     specific fields and surface only that field — full payloads
 *     collapse to `[redacted profile]`.
 *   - The redactor is conservative: it errs on the side of redacting too
 *     much rather than too little. False positives are recoverable (test
 *     authors can opt out per-call); false negatives leak.
 *
 * Non-goals:
 *
 *   - Generic PII detection. The harness redacts known shapes; freeform
 *     PII (e.g., a user-supplied address embedded in an unrelated field)
 *     is the test author's responsibility to redact by construction.
 *   - Stream-wrapping `console.log` / `process.stdout`. We do not patch
 *     globals; tests opt in by calling `redact()` on values they're about
 *     to log.
 */

const REDACTED = "[REDACTED]" as const;
const REDACTED_PROFILE = "[redacted profile]" as const;

/**
 * Keys whose VALUES are always replaced with `[REDACTED]`. Lower-case
 * comparison; both top-level and nested. Synonyms collected from the auth,
 * cookie, and config layers of `@ttctl/core`.
 *
 * Header-style keys (`set-cookie`, `cookie`) are handled the same as
 * config-style (`password`, `auth`) to avoid divergence. Adding new keys
 * here is the recommended way to extend the redactor — pattern-based
 * matching invariably has surprising blind spots.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "auth",
  "authorization",
  "cookie",
  "cookies",
  "cookieheader",
  "credentials",
  "email",
  "emailaddress",
  "mail",
  "password",
  "passphrase",
  "pwd",
  "secret",
  "session",
  "set-cookie",
  "setcookie",
  "token",
  "username",
]);

/**
 * Top-level field names whose presence on an object indicates a
 * profile-shaped payload. If ANY of these match, the whole object is
 * collapsed to `[redacted profile]` — matching individual fields would
 * still leak the rest of the bio prose.
 */
const PROFILE_MARKER_KEYS: ReadonlySet<string> = new Set([
  "about",
  "bio",
  "headline",
  "quote",
  "skillsets",
  "skills",
  "experiencehistory",
  "skillset",
]);

/**
 * Return a deep clone of `value` with secret-bearing fields scrubbed and
 * profile-shaped subtrees collapsed.
 *
 * Walks objects and arrays recursively. Primitives pass through. Cycles
 * are not handled (test payloads from JSON-RPC / GraphQL are acyclic) —
 * an upstream cyclic structure will throw `RangeError: Maximum call stack`,
 * which is preferable to silently truncating output.
 */
export function redact(value: unknown): unknown {
  return redactInner(value);
}

function redactInner(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(redactInner);
  const obj = value as Record<string, unknown>;
  if (looksLikeProfile(obj)) return REDACTED_PROFILE;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactInner(v);
  }
  return out;
}

function looksLikeProfile(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (PROFILE_MARKER_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

/**
 * Format a redacted value as a stable string for log output. Pretty-prints
 * objects with 2-space indent; primitives use `String(...)` so undefined
 * surfaces as the literal `"undefined"` rather than disappearing.
 *
 * The output format is intentionally compatible with `JSON.stringify` so
 * tests that snapshot redacted output don't depend on Node version
 * formatting quirks.
 */
export function formatRedacted(value: unknown): string {
  const redacted = redact(value);
  if (typeof redacted === "string") return redacted;
  if (redacted === undefined) return "undefined";
  try {
    return JSON.stringify(redacted, null, 2);
  } catch {
    // JSON.stringify failed (cycles or BigInt). The fallback must NOT
    // call `String(redacted)` directly because that risks `[object Object]`
    // for plain objects — eslint's `no-base-to-string` flags this. Surface
    // a safe diagnostic that names the type instead.
    return `[unserializable: typeof=${typeof redacted}]`;
  }
}
