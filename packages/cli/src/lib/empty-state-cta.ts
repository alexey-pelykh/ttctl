// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Per-command empty-state hint registry and detection helper for the
 * `formatResult` empty-state wrapper (introduced #122; format names
 * updated for the #126 reframe). The wrapper checks for empty
 * collection input BEFORE per-format dispatch and emits a per-format
 * empty payload — `[]` for `json`, prose with create-CTA for `pretty`,
 * normal block-style rendering for `yaml`.
 *
 * This module is the single source of truth for the empty-state CTA
 * wording across all `list` leaves; per-formatter `if (items.length ===
 * 0) return "(no foo)"` branches in individual sub-domain formatters
 * become production-unreachable once the call site opts into the
 * wrapper via `OutputFormatters#empty`.
 */

/**
 * Per-command empty-state metadata. Looked up by canonical command path
 * (e.g. `profile.skills.list`) when the wrapper fires.
 *
 * - `entityPlural`: noun for the "No <entity-plural> found." line
 *   (e.g., `"skills"`, `"portfolio items"`).
 * - `addHint`: optional copy-pasteable command the user can run to
 *   create their first item (e.g., `"ttctl profile skills add <name>"`).
 *   Omitted for sub-domains where empty-state isn't user-resolvable
 *   (e.g., pending reviews are server-driven, not user-created).
 */
export interface EmptyStateCta {
  entityPlural: string;
  addHint?: string;
}

/**
 * Frozen registry mapping canonical command paths to their empty-state
 * metadata. Keys MUST match the `command` value passed by the caller via
 * `OutputFormatters#empty.command`.
 *
 * Extension policy: when adding a new `list` leaf, add a registry entry
 * here AND wire the call site to pass `empty: { command: "<key>" }`.
 * Missing entries fall through to a generic `"No items found."` line —
 * surfaced but not silenced — so the wrapper degrades gracefully when a
 * sub-domain ships before its registry entry.
 */
export const EMPTY_STATE_CTAS: Readonly<Record<string, EmptyStateCta>> = Object.freeze({
  "profile.skills.list": {
    entityPlural: "skills",
    addHint: "ttctl profile skills add <name>",
  },
  "profile.portfolio.list": {
    entityPlural: "portfolio items",
    addHint: "ttctl profile portfolio add",
  },
  "profile.industries.list": {
    entityPlural: "industries",
    addHint: "ttctl profile industries add <name>",
  },
  "profile.visas.list": {
    entityPlural: "travel visas",
    addHint: "ttctl profile visas add",
  },
  // Reviews are pending-review records the server creates when a profile
  // section needs re-attestation; the user resolves them via `approve`,
  // not by adding new ones — the empty case is a happy state, not a
  // call-to-create.
  "profile.reviews.list": {
    entityPlural: "pending section reviews",
  },
  // Activity items (#15) are server-driven — applications, availability
  // requests, interviews, and engagements all materialize when the
  // recruiter / client side acts. Empty case is a happy state for new
  // users; no `addHint` (no `apply` verb in TTCtl per project non-goals).
  "applications.list": {
    entityPlural: "activity items",
  },
  // Performed actions are a server-driven audit log — entries materialize
  // as the viewer acts (status changes, applications submitted). Empty is
  // a happy state for new users; no add verb.
  "me.actions.list": {
    entityPlural: "performed actions",
  },
});

/**
 * Render the empty-state prose line for a given command path. Returns
 * `"No <entity-plural> found. Add one with: <addHint>"` when both
 * `entityPlural` and `addHint` are registered; degrades to
 * `"No <entity-plural> found."` when only the noun is registered; falls
 * back to `"No items found."` when the command is unknown.
 *
 * Pure — directly unit-testable.
 */
export function emptyStateProse(command: string): string {
  const cta = EMPTY_STATE_CTAS[command];
  if (cta === undefined) {
    return "No items found.";
  }
  if (cta.addHint === undefined) {
    return `No ${cta.entityPlural} found.`;
  }
  return `No ${cta.entityPlural} found. Add one with: ${cta.addHint}`;
}

/**
 * Detect collection-shaped input that the empty-state wrapper should
 * intercept. Returns `true` for both `[]` (current top-level list shape)
 * and `{items: []}` (the future `{items, pageInfo?}` envelope reserved
 * by the v0.4 reframe — see #121). Returns `false` for anything else,
 * including non-collection objects, scalars, `null`, and `undefined`,
 * so the wrapper never accidentally fires on a `show` payload.
 *
 * Pure — directly unit-testable.
 */
export function isEmptyCollection(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(value, "items")) {
    return false;
  }
  const items = (value as { items: unknown }).items;
  return Array.isArray(items) && items.length === 0;
}
