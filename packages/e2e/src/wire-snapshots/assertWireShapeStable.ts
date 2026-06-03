// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Wire-shape stability assertion — Track 1 follow-on (WS-2).
 *
 * `assertWireShapeStable(...)` is the E2E-side counterpart to `captureWireShape`.
 * On every `TTCTL_E2E=1` run it diffs the live response's structural shape
 * against a committed on-disk snapshot at
 * `packages/e2e/src/wire-snapshots/<OpName>.snapshot.json`. Drift throws a
 * structured diff; updates require explicit human authorization via
 * `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` (never automatic, never silent).
 *
 * Design notes:
 *
 *   - Diff vocabulary: `+` added field, `-` removed field, `~` type-changed
 *     field. Nullability/optionality are DIRECTIONAL (#689): the snapshot is
 *     the contract and the live shape need only inhabit it, so a narrower live
 *     shape (null, or a bare `T`) does NOT drift against a snapshot
 *     `nullable<T>` / `optional<T>` — but a broader live shape (snapshot `T`,
 *     live `nullable<T>`) still surfaces as a `~` kind mismatch.
 *   - Path syntax: `parent.child` for objects; `parent[]` for "any element
 *     of an array" (arrays are unified per `captureWireShape`'s reduction,
 *     so element-level paths don't carry indices).
 *   - Determinism: child fields are walked in alphabetical order (matches
 *     `captureWireShape`'s sort); diff entries are sorted by path alphabetically
 *     before stringification so the failure output is byte-stable across
 *     runs and reviewable as a git diff.
 *   - File I/O is plain `writeFileSync` — E2E suite runs sequentially under
 *     a run-level lock, so no atomicity guarantee is load-bearing here.
 *   - `operationName` is the filename — sanitized through a strict regex so
 *     a misconfigured caller can't write outside the snapshot directory.
 *   - Imports stay within `@ttctl/e2e` internals (this file and its sibling
 *     `captureWireShape.ts`). No `@ttctl/core` dependency.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureWireShape, createWireSnapshot } from "./captureWireShape.js";
import type { WireShape, WireSnapshot, WireSnapshotSurface, WireSnapshotTransport } from "./captureWireShape.js";

/**
 * Diff entry between two wire shapes. One entry per field change; structured
 * for both human reading (via `formatDiffEntry`) and programmatic assertion.
 */
export type WireShapeDiffEntry =
  | { readonly op: "+"; readonly path: string; readonly type: string }
  | { readonly op: "-"; readonly path: string; readonly type: string }
  | { readonly op: "~"; readonly path: string; readonly expected: string; readonly actual: string };

/**
 * Thrown when the live response shape diverges from the committed snapshot
 * OR when no snapshot exists and the update env-gate is unset. Two failure
 * modes, one error class: the `code` discriminant lets a programmatic caller
 * distinguish, while a default `Error` catcher still sees a useful message.
 */
export class WireSnapshotAssertionError extends Error {
  override readonly name = "WireSnapshotAssertionError";
  readonly code: "drift" | "missing";
  readonly operationName: string;
  readonly diff: readonly WireShapeDiffEntry[];
  readonly snapshotPath: string;

  constructor(params: {
    code: "drift" | "missing";
    operationName: string;
    snapshotPath: string;
    diff: readonly WireShapeDiffEntry[];
    message: string;
  }) {
    super(params.message);
    this.code = params.code;
    this.operationName = params.operationName;
    this.snapshotPath = params.snapshotPath;
    this.diff = params.diff;
  }
}

/** Parameters for `assertWireShapeStable`. */
export interface AssertWireShapeStableParams {
  readonly operationName: string;
  readonly surface: WireSnapshotSurface;
  readonly transport: WireSnapshotTransport;
  readonly response: unknown;
  /** Override the snapshot directory; defaults to this file's directory (i.e., `packages/e2e/src/wire-snapshots`). */
  readonly snapshotDir?: string;
  /** Override `process.env` for testing. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override the captured-at timestamp for deterministic snapshot writes. */
  readonly capturedAt?: string;
  /** Override stderr emit for testing; defaults to `process.stderr.write`. */
  readonly stderr?: (line: string) => void;
}

/** Env var that authorizes snapshot creation/overwrite. */
export const UPDATE_ENV_VAR = "TTCTL_UPDATE_WIRE_SNAPSHOTS";

/** Restricts operationName to a filesystem-safe identifier. */
const OPERATION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Default snapshot directory — co-located with this source file. */
const DEFAULT_SNAPSHOT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Assert that the live response's wire shape matches a committed snapshot.
 *
 * Behaviors:
 *
 *   - **Snapshot exists, shapes match** → returns without throwing.
 *   - **Snapshot exists, shapes differ** → throws `WireSnapshotAssertionError`
 *     with `code: "drift"` and a structured diff.
 *   - **No snapshot, env unset** → throws `WireSnapshotAssertionError` with
 *     `code: "missing"` and a hint to set `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`.
 *   - **No snapshot, env set** → writes a new snapshot and returns (creating,
 *     not asserting).
 *   - **Snapshot exists, env set** → overwrites the snapshot, emits
 *     `[wire-snapshot] updated <path>` to stderr, and returns (refreshing,
 *     not asserting).
 */
export function assertWireShapeStable(params: AssertWireShapeStableParams): void {
  validateOperationName(params.operationName);
  const env = params.env ?? process.env;
  const updateMode = env[UPDATE_ENV_VAR] === "1";
  const snapshotDir = params.snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  const snapshotPath = join(snapshotDir, `${params.operationName}.snapshot.json`);
  const stderr = params.stderr ?? ((line) => process.stderr.write(line));

  const currentShape = captureWireShape(params.response);
  const snapshotExists = existsSync(snapshotPath);

  if (updateMode) {
    const fresh = createWireSnapshot({
      operationName: params.operationName,
      surface: params.surface,
      transport: params.transport,
      response: params.response,
      ...(params.capturedAt !== undefined && { capturedAt: params.capturedAt }),
    });
    writeSnapshot(snapshotPath, fresh);
    if (snapshotExists) {
      stderr(`[wire-snapshot] updated ${snapshotPath}\n`);
    }
    return;
  }

  if (!snapshotExists) {
    throw new WireSnapshotAssertionError({
      code: "missing",
      operationName: params.operationName,
      snapshotPath,
      diff: [],
      message: `No wire snapshot found for operation \`${params.operationName}\` at ${snapshotPath}. Set ${UPDATE_ENV_VAR}=1 to create it.`,
    });
  }

  const existing = readSnapshot(snapshotPath);
  const diff = diffShapes("", existing.shape, currentShape);
  if (diff.length === 0) {
    return;
  }

  throw new WireSnapshotAssertionError({
    code: "drift",
    operationName: params.operationName,
    snapshotPath,
    diff,
    message: formatDriftMessage(params.operationName, snapshotPath, diff),
  });
}

/**
 * Compute the diff between two wire shapes. Exported for white-box tests
 * and re-use; production callers should reach for `assertWireShapeStable`.
 */
export function diffShapes(path: string, expected: WireShape, actual: WireShape): WireShapeDiffEntry[] {
  const out: WireShapeDiffEntry[] = [];
  diffShapesInto(path, expected, actual, out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function diffShapesInto(path: string, expected: WireShape, actual: WireShape, out: WireShapeDiffEntry[]): void {
  // Directional tolerance (#689): the snapshot is the contract; the live shape
  // need only INHABIT it. Peel optional/nullable wrappers for a narrower live
  // inhabitant (a null or bare-T column that capture collapsed) — broader shapes drift.
  if (expected.kind === "optional" && actual.kind !== "optional") {
    diffShapesInto(path, expected.inner, actual, out);
    return;
  }
  if (expected.kind === "nullable" && actual.kind === "null") {
    return;
  }
  if (expected.kind === "nullable" && actual.kind !== "nullable") {
    diffShapesInto(path, expected.inner, actual, out);
    return;
  }
  if (expected.kind !== actual.kind) {
    out.push({
      op: "~",
      path: path === "" ? "<root>" : path,
      expected: renderShape(expected),
      actual: renderShape(actual),
    });
    return;
  }
  switch (expected.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "unknown":
      return;
    case "object": {
      // Narrowed by the kind-equality guard above.
      const actualObj = actual as Extract<WireShape, { kind: "object" }>;
      const allKeys = new Set<string>([...Object.keys(expected.fields), ...Object.keys(actualObj.fields)]);
      const sortedKeys = [...allKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const key of sortedKeys) {
        const childPath = path === "" ? key : `${path}.${key}`;
        const e = expected.fields[key];
        const a = actualObj.fields[key];
        if (e !== undefined && a !== undefined) {
          diffShapesInto(childPath, e, a, out);
        } else if (e !== undefined) {
          out.push({ op: "-", path: childPath, type: renderShape(e) });
        } else if (a !== undefined) {
          out.push({ op: "+", path: childPath, type: renderShape(a) });
        }
      }
      return;
    }
    case "array": {
      const actualArr = actual as Extract<WireShape, { kind: "array" }>;
      const itemPath = path === "" ? "[]" : `${path}[]`;
      diffShapesInto(itemPath, expected.item, actualArr.item, out);
      return;
    }
    case "nullable": {
      const actualNul = actual as Extract<WireShape, { kind: "nullable" }>;
      diffShapesInto(path, expected.inner, actualNul.inner, out);
      return;
    }
    case "optional": {
      const actualOpt = actual as Extract<WireShape, { kind: "optional" }>;
      diffShapesInto(path, expected.inner, actualOpt.inner, out);
      return;
    }
  }
}

/**
 * Render a `WireShape` as a compact, human-readable type string for diff
 * entries. Recurses into wrappers and arrays; objects collapse to `"object"`
 * since structural differences inside are enumerated as their own entries.
 */
export function renderShape(shape: WireShape): string {
  switch (shape.kind) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "unknown":
      return "unknown";
    case "object":
      return "object";
    case "array":
      return `array<${renderShape(shape.item)}>`;
    case "nullable":
      return `nullable<${renderShape(shape.inner)}>`;
    case "optional":
      return `optional<${renderShape(shape.inner)}>`;
  }
}

/** Render a single diff entry as one diff-friendly line. */
export function formatDiffEntry(entry: WireShapeDiffEntry): string {
  switch (entry.op) {
    case "+":
      return `+ ${entry.path}: ${entry.type}`;
    case "-":
      return `- ${entry.path}: ${entry.type}`;
    case "~":
      return `~ ${entry.path}: ${entry.expected} → ${entry.actual}`;
  }
}

function formatDriftMessage(operationName: string, snapshotPath: string, diff: readonly WireShapeDiffEntry[]): string {
  const lines = diff.map((entry) => `  ${formatDiffEntry(entry)}`);
  const count = diff.length;
  const changeWord = count === 1 ? "change" : "changes";
  return [
    `Wire snapshot drift for operation \`${operationName}\` (${String(count)} ${changeWord}) against ${snapshotPath}.`,
    `Run with ${UPDATE_ENV_VAR}=1 to refresh after reviewing the diff.`,
    "",
    ...lines,
  ].join("\n");
}

function validateOperationName(operationName: string): void {
  if (!OPERATION_NAME_PATTERN.test(operationName)) {
    throw new Error(
      `Invalid operationName \`${operationName}\`: must match ${String(OPERATION_NAME_PATTERN)} (GraphQL identifier shape).`,
    );
  }
}

function readSnapshot(path: string): WireSnapshot {
  const raw = readFileSync(path, "utf8");
  // The on-disk format is owned by this package; a malformed file is a
  // local-only failure (the snapshot is hand-committed). We surface the
  // underlying parse error verbatim — there is no recovery path in the
  // helper itself.
  const parsed = JSON.parse(raw) as WireSnapshot;
  return parsed;
}

function writeSnapshot(path: string, snapshot: WireSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  // Pretty-print with 2-space indent and trailing newline — git-friendly,
  // matches the project's Prettier defaults for committed JSON.
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
