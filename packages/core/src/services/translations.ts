// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Server-field ↔ CLI-flag translation tables. Centralizes the mapping
 * between Toptal GraphQL field names (server-side, non-canonical) and the
 * canonical CLI flag names that ttctl exposes to users.
 *
 * Naming policy (see issue #72): the canonical vocabulary is Toptal-faithful
 * with the user-friendly CLI surface as the public API. When a Toptal field
 * name reads poorly as a flag (`quote` for what users would call a
 * "headline", `about` for what users would call a "bio"), this table
 * translates between the two — letting `core` services speak the GraphQL
 * vocabulary while the CLI / MCP surfaces speak the user-friendly one.
 *
 * Conventions:
 *
 * - Each table is a flat `Record<string, string>` from server field name
 *   (key) to CLI flag name (value).
 * - Tables are `as const` so consumers can derive precise key/value union
 *   types when needed.
 * - One table per sub-domain (basic, skills, …). Sub-domains beyond `basic`
 *   land in their respective issues (#70/#71/#73-#76); this file gets
 *   amended, not split, as those land.
 *
 * The CLI / MCP layer is the single consumer of these tables. Service code
 * inside `core` continues to use the GraphQL field names directly — the
 * boundary at which translation happens is the `presentation` boundary
 * (CLI flag parsing, MCP tool input shaping), NOT the service boundary.
 */

/**
 * Server-field → CLI-flag mapping for the `basic` profile sub-domain.
 *
 * Covers every `basic` field whose user-facing CLI flag differs from its
 * GraphQL name. Fields whose CLI flag matches their GraphQL name (e.g.,
 * `email`, `fullName`) are NOT listed — `serverToCli` / `cliToServer`
 * pass unmapped keys through unchanged. Each entry encodes a deliberate
 * vocabulary choice — see the per-line rationale.
 */
export const PROFILE_BASIC_FIELDS = {
  // GraphQL `Profile.quote` is the short tagline shown above the user's
  // photo. "Quote" reads poorly as a CLI flag (`--quote` suggests pricing or
  // an exact citation); the user-facing name is `headline`.
  quote: "headline",
  // GraphQL `Profile.about` is the long-form bio paragraph. The CLI flag
  // calls this `bio` (shorter and idiomatic).
  about: "bio",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Reverse the direction of a translation table — CLI-flag → server-field.
 *
 * Used by `cliToServer` to translate user-supplied option objects into the
 * shape expected by GraphQL inputs. Computed once per import via the
 * `INVERSE_*` constants below; do NOT call this at request time (it
 * allocates a fresh object).
 */
function invertTable(table: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const inverse: Record<string, string> = {};
  for (const [server, cli] of Object.entries(table)) {
    inverse[cli] = server;
  }
  return inverse;
}

const INVERSE_PROFILE_BASIC_FIELDS = invertTable(PROFILE_BASIC_FIELDS);

/**
 * Pre-computed inverse tables (CLI-flag → server-field) keyed by their
 * forward counterpart, so callers can pass either direction's table to a
 * shared helper. Kept private — `cliToServer` resolves the right inverse
 * via `getInverse()` rather than asking callers to pass it.
 */
const INVERSES = new WeakMap<Readonly<Record<string, string>>, Readonly<Record<string, string>>>([
  [PROFILE_BASIC_FIELDS, INVERSE_PROFILE_BASIC_FIELDS],
]);

function getInverse(table: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  // Tables registered above hit the WeakMap; ad-hoc tables (e.g., from a
  // unit test) compute their inverse on the fly. The fast path is the
  // expected one — service code always passes a registered table.
  return INVERSES.get(table) ?? invertTable(table);
}

/**
 * Translate a server-keyed object (GraphQL response shape) to a CLI-keyed
 * object (user-facing flag shape). Keys present in the table are renamed;
 * keys absent from the table pass through unchanged. Values are copied
 * verbatim — translation is a key-rename pass, not a value transform.
 *
 * Returns a fresh object; the input is not mutated.
 */
export function serverToCli<V>(
  serverObj: Readonly<Record<string, V>>,
  table: Readonly<Record<string, string>>,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(serverObj)) {
    const cliKey = table[key] ?? key;
    out[cliKey] = value;
  }
  return out;
}

/**
 * Translate a CLI-keyed object (user-facing flag shape) to a server-keyed
 * object (GraphQL input shape). Symmetric counterpart of `serverToCli`.
 * Keys absent from the inverse mapping pass through unchanged.
 *
 * Returns a fresh object; the input is not mutated.
 */
export function cliToServer<V>(
  cliObj: Readonly<Record<string, V>>,
  table: Readonly<Record<string, string>>,
): Record<string, V> {
  const inverse = getInverse(table);
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(cliObj)) {
    const serverKey = inverse[key] ?? key;
    out[serverKey] = value;
  }
  return out;
}
