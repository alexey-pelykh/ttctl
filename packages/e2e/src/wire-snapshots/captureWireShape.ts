// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Wire-shape capture — Track 1 foundation (WS-1).
 *
 * `captureWireShape(response)` distills a GraphQL response (or any JSON-
 * shaped value) into a deterministic STRUCTURE-ONLY manifest: types and
 * nullability, no values. WS-2 will diff two manifests for drift; this
 * file owns the manifest format and the capture algorithm.
 *
 * Design notes:
 *
 *   - Object field keys are sorted alphabetically (insertion order is the
 *     key order in `JSON.stringify` output, so insertion = sort gives a
 *     byte-stable JSON serialization for diff). Numeric-like keys land in
 *     lexicographic position; GraphQL field names are not integer-like,
 *     so the choice is invisible in practice but documented.
 *   - Array unification: every element is captured, then reduced pair-
 *     wise. Fields present in some elements but absent in others are
 *     wrapped in `{ kind: "optional", inner }`. Values null in some,
 *     non-null in others are wrapped in `{ kind: "nullable", inner }`.
 *     Canonical layering when both apply: `optional<nullable<T>>` —
 *     `optional` is the outer wrapper.
 *   - Empty arrays produce `{ kind: "array", item: { kind: "unknown" } }`
 *     (no elements to infer item shape from).
 *   - Incompatible kinds in an array (`["x", 1]`) collapse to
 *     `{ kind: "unknown" }` rather than a sum type — wire-shape drift
 *     across primitive kinds is unusual; encoding it richer than this
 *     does not pay for the algorithmic complexity at WS-1's budget.
 *   - Redaction discipline (per #M3 / #282): no values, no enum-member
 *     enumeration. Enums on the wire are JSON strings and naturally
 *     reduce to `{ kind: "string" }`; nothing additional is needed.
 */

/** Discriminated union representing the wire shape of a JSON-shaped value. */
export type WireShape =
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | { readonly kind: "unknown" }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, WireShape>> }
  | { readonly kind: "array"; readonly item: WireShape }
  | { readonly kind: "nullable"; readonly inner: WireShape }
  | { readonly kind: "optional"; readonly inner: WireShape };

/**
 * Snapshot file format. WS-2 will read/write these from disk; WS-1
 * defines the type so consumers can construct them without depending on
 * the diff helper.
 */
export interface WireSnapshot {
  /** Format version. Bumped only on a breaking format change. */
  readonly version: "1";
  /** ISO 8601 capture timestamp. */
  readonly capturedAt: string;
  /** GraphQL operationName at capture time. */
  readonly operationName: string;
  /** Endpoint family — informational, not load-bearing. */
  readonly surface: WireSnapshotSurface;
  /** Transport used to obtain the response — informational. */
  readonly transport: WireSnapshotTransport;
  /** Structure-only manifest. */
  readonly shape: WireShape;
}

/** Endpoint family — matches the surfaces enumerated in CLAUDE.md. */
export type WireSnapshotSurface = "mobile-gateway" | "talent-profile" | "scheduler";

/** Transport family — matches `packages/core/src/transport.ts`. */
export type WireSnapshotTransport = "stock" | "impersonated";

/** Parameters for `createWireSnapshot`. */
export interface CreateWireSnapshotParams {
  readonly operationName: string;
  readonly surface: WireSnapshotSurface;
  readonly transport: WireSnapshotTransport;
  readonly response: unknown;
  /** Override for tests; defaults to `new Date().toISOString()`. */
  readonly capturedAt?: string;
}

/**
 * Build a complete `WireSnapshot` from a live response. The default
 * `capturedAt` is wall-clock ISO 8601 — pass an explicit value when a
 * deterministic snapshot is required (tests, replay).
 */
export function createWireSnapshot(params: CreateWireSnapshotParams): WireSnapshot {
  return {
    version: "1",
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    operationName: params.operationName,
    surface: params.surface,
    transport: params.transport,
    shape: captureWireShape(params.response),
  };
}

/**
 * Capture the structural shape of `value` as a deterministic manifest.
 * Values themselves are discarded; only types and nullability survive.
 */
export function captureWireShape(value: unknown): WireShape {
  if (value === null) return { kind: "null" };
  if (value === undefined) return { kind: "unknown" };
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: "array", item: { kind: "unknown" } };
    const itemShapes = value.map((element) => captureWireShape(element));
    return { kind: "array", item: unifyShapes(itemShapes) };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const fields: Record<string, WireShape> = {};
    for (const [key, val] of entries) {
      fields[key] = captureWireShape(val);
    }
    return { kind: "object", fields };
  }
  // typeof === "function" | "bigint" | "symbol" — not valid JSON wire values.
  return { kind: "unknown" };
}

/**
 * Reduce a list of element shapes to a single unified shape. Empty
 * arrays must short-circuit before reaching this helper.
 */
function unifyShapes(shapes: readonly WireShape[]): WireShape {
  const [first, ...rest] = shapes;
  if (first === undefined) return { kind: "unknown" };
  let acc: WireShape = first;
  for (const next of rest) {
    acc = unifyPair(acc, next);
  }
  return acc;
}

/**
 * Pair-wise unification. Canonical wrapper layering: `optional` outer,
 * `nullable` inner. Same kind preserves structure; null + T → nullable;
 * mismatched primitives → unknown.
 */
function unifyPair(a: WireShape, b: WireShape): WireShape {
  // Peel optional from either side; the result is optional.
  if (a.kind === "optional" || b.kind === "optional") {
    const innerA = a.kind === "optional" ? a.inner : a;
    const innerB = b.kind === "optional" ? b.inner : b;
    return { kind: "optional", inner: unifyPair(innerA, innerB) };
  }
  if (a.kind === "object" && b.kind === "object") {
    return unifyObjects(a.fields, b.fields);
  }
  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", item: unifyPair(a.item, b.item) };
  }
  if (a.kind === "nullable" && b.kind === "nullable") {
    return { kind: "nullable", inner: unifyPair(a.inner, b.inner) };
  }
  if (a.kind === b.kind) {
    // Same primitive kind ("string"/"number"/"boolean"/"null"/"unknown").
    return a;
  }
  // null + T → nullable<T>; T + null → nullable<T>.
  if (a.kind === "null") return makeNullable(b);
  if (b.kind === "null") return makeNullable(a);
  // nullable<T> + U (U not null, not optional) → nullable<unify(T, U)>.
  if (a.kind === "nullable") return { kind: "nullable", inner: unifyPair(a.inner, b) };
  if (b.kind === "nullable") return { kind: "nullable", inner: unifyPair(b.inner, a) };
  // Mismatched non-null kinds (e.g., string vs number) — unrepresentable.
  return { kind: "unknown" };
}

function makeNullable(s: WireShape): WireShape {
  if (s.kind === "nullable" || s.kind === "null") return s;
  return { kind: "nullable", inner: s };
}

function unifyObjects(a: Readonly<Record<string, WireShape>>, b: Readonly<Record<string, WireShape>>): WireShape {
  const allKeys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const sortedKeys = [...allKeys].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const fields: Record<string, WireShape> = {};
  for (const k of sortedKeys) {
    const fromA = a[k];
    const fromB = b[k];
    if (fromA !== undefined && fromB !== undefined) {
      fields[k] = unifyPair(fromA, fromB);
    } else if (fromA !== undefined) {
      fields[k] = makeOptional(fromA);
    } else if (fromB !== undefined) {
      fields[k] = makeOptional(fromB);
    }
  }
  return { kind: "object", fields };
}

function makeOptional(s: WireShape): WireShape {
  if (s.kind === "optional") return s;
  return { kind: "optional", inner: s };
}
