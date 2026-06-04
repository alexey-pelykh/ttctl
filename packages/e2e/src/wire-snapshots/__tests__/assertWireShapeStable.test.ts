// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  UPDATE_ENV_VAR,
  WireSnapshotAssertionError,
  assertWireShapeStable,
  diffShapes,
  formatDiffEntry,
  renderShape,
} from "../assertWireShapeStable.js";
import { captureWireShape } from "../captureWireShape.js";
import type { WireShape, WireSnapshot } from "../captureWireShape.js";

/**
 * Helper: build a canonical `WireSnapshot` literal for fixture-style writes.
 * The on-disk format is owned by `createWireSnapshot`; tests construct
 * literals to exercise the diff path against known-good shapes without
 * coupling the test harness to runtime capture.
 */
function buildSnapshot(operationName: string, shape: WireShape): WireSnapshot {
  return {
    version: "1",
    capturedAt: "2026-05-14T00:00:00.000Z",
    operationName,
    surface: "mobile-gateway",
    transport: "stock",
    shape,
  };
}

function writeFixtureSnapshot(dir: string, snapshot: WireSnapshot): string {
  const path = join(dir, `${snapshot.operationName}.snapshot.json`);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return path;
}

describe("assertWireShapeStable — match path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wire-snapshot-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns without throwing when the captured shape matches the snapshot", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("GetBillingCycle", {
        kind: "object",
        fields: {
          hours: { kind: "string" },
          id: { kind: "string" },
        },
      }),
    );

    expect(() =>
      assertWireShapeStable({
        operationName: "GetBillingCycle",
        surface: "mobile-gateway",
        transport: "stock",
        response: { id: "x", hours: "72.0" },
        snapshotDir: dir,
        env: {},
      }),
    ).not.toThrow();
  });

  it("matches deeply nested shapes (objects within arrays within objects)", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("GetTimesheet", {
        kind: "object",
        fields: {
          records: {
            kind: "array",
            item: {
              kind: "object",
              fields: {
                date: { kind: "string" },
                duration: { kind: "string" },
                note: { kind: "nullable", inner: { kind: "string" } },
              },
            },
          },
        },
      }),
    );

    expect(() =>
      assertWireShapeStable({
        operationName: "GetTimesheet",
        surface: "mobile-gateway",
        transport: "stock",
        response: {
          records: [
            { date: "2026-05-01", duration: "480.0", note: "x" },
            { date: "2026-05-02", duration: "0.0", note: null },
          ],
        },
        snapshotDir: dir,
        env: {},
      }),
    ).not.toThrow();
  });

  // #689: a degenerate live subject — a `nullable<T>` field null in EVERY
  // array element (and a null top-level field) this run — collapses under
  // capture to `{kind:"null"}`, yet must still inhabit the richer committed
  // `nullable<string>` contract rather than drifting on account-data state.
  it("does not drift when nullable fields are null in every record (degenerate subject, #689)", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("GetTimesheet", {
        kind: "object",
        fields: {
          timesheetComment: { kind: "nullable", inner: { kind: "string" } },
          records: {
            kind: "array",
            item: {
              kind: "object",
              fields: {
                date: { kind: "string" },
                note: { kind: "nullable", inner: { kind: "string" } },
              },
            },
          },
        },
      }),
    );

    expect(() =>
      assertWireShapeStable({
        operationName: "GetTimesheet",
        surface: "mobile-gateway",
        transport: "stock",
        response: {
          timesheetComment: null,
          records: [
            { date: "2026-05-01", note: null },
            { date: "2026-05-02", note: null },
          ],
        },
        snapshotDir: dir,
        env: {},
      }),
    ).not.toThrow();
  });

  // #692: an array-of-objects column empty THIS run captures as
  // `array<unknown>` and must still inhabit the committed `array<object>`
  // contract — e.g. a pending billing cycle with zero logged records.
  it("does not drift when an array-of-objects column is empty this run (degenerate subject, #692)", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("GetTimesheet", {
        kind: "object",
        fields: {
          timesheetRecords: {
            kind: "array",
            item: {
              kind: "object",
              fields: {
                date: { kind: "string" },
                duration: { kind: "string" },
              },
            },
          },
        },
      }),
    );

    expect(() =>
      assertWireShapeStable({
        operationName: "GetTimesheet",
        surface: "mobile-gateway",
        transport: "stock",
        response: { timesheetRecords: [] },
        snapshotDir: dir,
        env: {},
      }),
    ).not.toThrow();
  });
});

describe("assertWireShapeStable — drift path", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wire-snapshot-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws with `+` entry when a new field is present on the wire", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("Op", {
        kind: "object",
        fields: { id: { kind: "string" } },
      }),
    );

    let error: WireSnapshotAssertionError | undefined;
    try {
      assertWireShapeStable({
        operationName: "Op",
        surface: "mobile-gateway",
        transport: "stock",
        response: { id: "x", newField: "y" },
        snapshotDir: dir,
        env: {},
      });
    } catch (e) {
      error = e as WireSnapshotAssertionError;
    }

    expect(error).toBeInstanceOf(WireSnapshotAssertionError);
    expect(error?.code).toBe("drift");
    expect(error?.diff).toEqual([{ op: "+", path: "newField", type: "string" }]);
    expect(error?.message).toContain("+ newField: string");
    expect(error?.message).toContain(`Run with ${UPDATE_ENV_VAR}=1`);
  });

  it("throws with `-` entry when a field has been dropped from the wire", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("Op", {
        kind: "object",
        fields: {
          id: { kind: "string" },
          deprecated: { kind: "number" },
        },
      }),
    );

    let error: WireSnapshotAssertionError | undefined;
    try {
      assertWireShapeStable({
        operationName: "Op",
        surface: "mobile-gateway",
        transport: "stock",
        response: { id: "x" },
        snapshotDir: dir,
        env: {},
      });
    } catch (e) {
      error = e as WireSnapshotAssertionError;
    }

    expect(error?.code).toBe("drift");
    expect(error?.diff).toEqual([{ op: "-", path: "deprecated", type: "number" }]);
    expect(error?.message).toContain("- deprecated: number");
  });

  it("throws with `~` entry when a field's type has changed (the PR #275 regression class)", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("Op", {
        kind: "object",
        fields: { duration: { kind: "number" } },
      }),
    );

    let error: WireSnapshotAssertionError | undefined;
    try {
      assertWireShapeStable({
        operationName: "Op",
        surface: "mobile-gateway",
        transport: "stock",
        response: { duration: "480.0" },
        snapshotDir: dir,
        env: {},
      });
    } catch (e) {
      error = e as WireSnapshotAssertionError;
    }

    expect(error?.code).toBe("drift");
    expect(error?.diff).toEqual([{ op: "~", path: "duration", expected: "number", actual: "string" }]);
    expect(error?.message).toContain("~ duration: number → string");
  });

  it("treats required→nullable transition as a `~` entry (drift in the opposite direction)", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("Op", {
        kind: "object",
        fields: { records: { kind: "array", item: { kind: "object", fields: { note: { kind: "string" } } } } },
      }),
    );

    let error: WireSnapshotAssertionError | undefined;
    try {
      assertWireShapeStable({
        operationName: "Op",
        surface: "mobile-gateway",
        transport: "stock",
        // Note: array reduction will lift `note` to `nullable<string>` because
        // one element is `null`. The diff must flag the introduction of nullability.
        response: { records: [{ note: "x" }, { note: null }] },
        snapshotDir: dir,
        env: {},
      });
    } catch (e) {
      error = e as WireSnapshotAssertionError;
    }

    expect(error?.code).toBe("drift");
    expect(error?.diff).toEqual([
      {
        op: "~",
        path: "records[].note",
        expected: "string",
        actual: "nullable<string>",
      },
    ]);
    expect(error?.message).toContain("~ records[].note: string → nullable<string>");
  });

  it("renders multiple changes deterministically (alphabetical path order, one line per change)", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("Op", {
        kind: "object",
        fields: {
          alpha: { kind: "number" },
          beta: { kind: "string" },
          gamma: { kind: "string" },
        },
      }),
    );

    let error: WireSnapshotAssertionError | undefined;
    try {
      assertWireShapeStable({
        operationName: "Op",
        surface: "mobile-gateway",
        transport: "stock",
        // alpha type-change, beta removed, delta added, gamma matches
        response: { alpha: "x", gamma: "y", delta: true },
        snapshotDir: dir,
        env: {},
      });
    } catch (e) {
      error = e as WireSnapshotAssertionError;
    }

    expect(error?.diff).toEqual([
      { op: "~", path: "alpha", expected: "number", actual: "string" },
      { op: "-", path: "beta", type: "string" },
      { op: "+", path: "delta", type: "boolean" },
    ]);
    // Each change on its own line.
    expect(
      error?.message
        .split("\n")
        .filter((l) => l.trimStart().startsWith("+") || l.trimStart().startsWith("-") || l.trimStart().startsWith("~")),
    ).toHaveLength(3);
  });
});

describe("assertWireShapeStable — missing snapshot, env unset", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wire-snapshot-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws with `code: missing` and a hint to set the update env-gate", () => {
    let error: WireSnapshotAssertionError | undefined;
    try {
      assertWireShapeStable({
        operationName: "BrandNewOp",
        surface: "talent-profile",
        transport: "impersonated",
        response: { x: 1 },
        snapshotDir: dir,
        env: {},
      });
    } catch (e) {
      error = e as WireSnapshotAssertionError;
    }

    expect(error).toBeInstanceOf(WireSnapshotAssertionError);
    expect(error?.code).toBe("missing");
    expect(error?.message).toContain("No wire snapshot found");
    expect(error?.message).toContain("BrandNewOp");
    expect(error?.message).toContain(`Set ${UPDATE_ENV_VAR}=1`);
  });

  it("does NOT create a snapshot when env is unset", () => {
    expect(() =>
      assertWireShapeStable({
        operationName: "BrandNewOp",
        surface: "mobile-gateway",
        transport: "stock",
        response: { x: 1 },
        snapshotDir: dir,
        env: {},
      }),
    ).toThrow();

    expect(existsSync(join(dir, "BrandNewOp.snapshot.json"))).toBe(false);
  });
});

describe("assertWireShapeStable — update mode (TTCTL_UPDATE_WIRE_SNAPSHOTS=1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wire-snapshot-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new snapshot when none exists and skips assertion", () => {
    const stderrLines: string[] = [];
    expect(() =>
      assertWireShapeStable({
        operationName: "FreshOp",
        surface: "talent-profile",
        transport: "impersonated",
        response: { id: "abc", count: 7 },
        snapshotDir: dir,
        env: { [UPDATE_ENV_VAR]: "1" },
        capturedAt: "2026-05-15T12:00:00.000Z",
        stderr: (line) => stderrLines.push(line),
      }),
    ).not.toThrow();

    const path = join(dir, "FreshOp.snapshot.json");
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8")) as WireSnapshot;
    expect(written).toEqual({
      version: "1",
      capturedAt: "2026-05-15T12:00:00.000Z",
      operationName: "FreshOp",
      surface: "talent-profile",
      transport: "impersonated",
      shape: {
        kind: "object",
        fields: {
          count: { kind: "number" },
          id: { kind: "string" },
        },
      },
    });
    // Creation is silent — stderr emission is reserved for overwrites.
    expect(stderrLines).toEqual([]);
  });

  it("overwrites an existing snapshot and emits `[wire-snapshot] updated <path>` to stderr", () => {
    const existingPath = writeFixtureSnapshot(
      dir,
      buildSnapshot("Refresh", {
        kind: "object",
        fields: { stale: { kind: "string" } },
      }),
    );

    const stderrLines: string[] = [];
    expect(() =>
      assertWireShapeStable({
        operationName: "Refresh",
        surface: "mobile-gateway",
        transport: "stock",
        response: { fresh: 42 },
        snapshotDir: dir,
        env: { [UPDATE_ENV_VAR]: "1" },
        capturedAt: "2026-05-15T12:00:00.000Z",
        stderr: (line) => stderrLines.push(line),
      }),
    ).not.toThrow();

    const written = JSON.parse(readFileSync(existingPath, "utf8")) as WireSnapshot;
    expect(written.shape).toEqual({
      kind: "object",
      fields: { fresh: { kind: "number" } },
    });
    expect(stderrLines).toEqual([`[wire-snapshot] updated ${existingPath}\n`]);
  });

  it("update mode skips assertion even when the captured shape diverges from the existing snapshot", () => {
    writeFixtureSnapshot(
      dir,
      buildSnapshot("Op", {
        kind: "object",
        fields: { stale: { kind: "string" } },
      }),
    );

    // Under update mode, drift is irrelevant — we're refreshing, not asserting.
    expect(() =>
      assertWireShapeStable({
        operationName: "Op",
        surface: "mobile-gateway",
        transport: "stock",
        response: { totallyDifferent: true },
        snapshotDir: dir,
        env: { [UPDATE_ENV_VAR]: "1" },
        capturedAt: "2026-05-15T12:00:00.000Z",
        stderr: () => undefined,
      }),
    ).not.toThrow();
  });

  it("env value other than literal '1' does NOT trigger update mode", () => {
    // Truthy-ish strings that are NOT exactly "1" must be treated as unset
    // so a forgotten `=0` / `=true` / `=yes` doesn't silently regenerate.
    for (const value of ["0", "true", "yes", "TRUE", "", " 1 "]) {
      const env: NodeJS.ProcessEnv = { [UPDATE_ENV_VAR]: value };
      expect(() =>
        assertWireShapeStable({
          operationName: `UnsetSentinel_${value.replace(/\W/g, "_") || "empty"}`,
          surface: "mobile-gateway",
          transport: "stock",
          response: { x: 1 },
          snapshotDir: dir,
          env,
        }),
      ).toThrow(WireSnapshotAssertionError);
    }
  });
});

describe("assertWireShapeStable — operation-name sanitization", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wire-snapshot-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects operationNames that contain path separators or directory traversals", () => {
    for (const bad of ["../escape", "with/slash", "with\\backslash", ".", "..", "", "1leadingDigit"]) {
      expect(() =>
        assertWireShapeStable({
          operationName: bad,
          surface: "mobile-gateway",
          transport: "stock",
          response: {},
          snapshotDir: dir,
          env: {},
        }),
      ).toThrow(/Invalid operationName/);
    }
  });

  it("accepts canonical GraphQL identifier names", () => {
    for (const ok of ["GetBillingCycle", "Op", "snake_case", "_leadingUnderscore", "Op123"]) {
      // Missing-snapshot path — proves the name is accepted by the sanitizer.
      let error: WireSnapshotAssertionError | undefined;
      try {
        assertWireShapeStable({
          operationName: ok,
          surface: "mobile-gateway",
          transport: "stock",
          response: {},
          snapshotDir: dir,
          env: {},
        });
      } catch (e) {
        error = e as WireSnapshotAssertionError;
      }
      expect(error?.code).toBe("missing");
    }
  });
});

describe("diffShapes / renderShape / formatDiffEntry — unit", () => {
  it("renderShape handles every variant in WireShape", () => {
    expect(renderShape({ kind: "string" })).toBe("string");
    expect(renderShape({ kind: "number" })).toBe("number");
    expect(renderShape({ kind: "boolean" })).toBe("boolean");
    expect(renderShape({ kind: "null" })).toBe("null");
    expect(renderShape({ kind: "unknown" })).toBe("unknown");
    expect(renderShape({ kind: "object", fields: { a: { kind: "string" } } })).toBe("object");
    expect(renderShape({ kind: "array", item: { kind: "string" } })).toBe("array<string>");
    expect(renderShape({ kind: "nullable", inner: { kind: "number" } })).toBe("nullable<number>");
    expect(renderShape({ kind: "optional", inner: { kind: "boolean" } })).toBe("optional<boolean>");
    // Nested wrappers — canonical layering: optional<nullable<T>>.
    expect(
      renderShape({
        kind: "optional",
        inner: { kind: "nullable", inner: { kind: "array", item: { kind: "string" } } },
      }),
    ).toBe("optional<nullable<array<string>>>");
  });

  it("formatDiffEntry renders one line per change", () => {
    expect(formatDiffEntry({ op: "+", path: "a.b", type: "string" })).toBe("+ a.b: string");
    expect(formatDiffEntry({ op: "-", path: "a.b", type: "number" })).toBe("- a.b: number");
    expect(formatDiffEntry({ op: "~", path: "a.b", expected: "string", actual: "number" })).toBe(
      "~ a.b: string → number",
    );
  });

  it("diffShapes returns an empty array for identical shapes", () => {
    expect(diffShapes("", { kind: "string" }, { kind: "string" })).toEqual([]);
    expect(
      diffShapes(
        "",
        { kind: "object", fields: { a: { kind: "string" }, b: { kind: "number" } } },
        { kind: "object", fields: { a: { kind: "string" }, b: { kind: "number" } } },
      ),
    ).toEqual([]);
  });

  it("diffShapes flags a root-level kind mismatch with the `<root>` placeholder path", () => {
    expect(diffShapes("", { kind: "string" }, { kind: "number" })).toEqual([
      { op: "~", path: "<root>", expected: "string", actual: "number" },
    ]);
  });

  it("diffShapes recurses into arrays with `[]` path suffix", () => {
    expect(
      diffShapes(
        "",
        { kind: "object", fields: { items: { kind: "array", item: { kind: "string" } } } },
        { kind: "object", fields: { items: { kind: "array", item: { kind: "number" } } } },
      ),
    ).toEqual([{ op: "~", path: "items[]", expected: "string", actual: "number" }]);
  });

  it("diffShapes sorts entries by path alphabetically (byte-stable output)", () => {
    const entries = diffShapes(
      "",
      {
        kind: "object",
        fields: {
          zeta: { kind: "string" },
          alpha: { kind: "string" },
        },
      },
      {
        kind: "object",
        fields: {
          alpha: { kind: "number" }, // ~
          // zeta removed
          beta: { kind: "boolean" }, // +
        },
      },
    );
    expect(entries.map((e) => e.path)).toEqual(["alpha", "beta", "zeta"]);
  });
});

describe("diffShapes — directional wrapper tolerance (#689)", () => {
  // A narrower live shape (null / bare T) inhabits a nullable/optional snapshot; a broader one drifts.
  const STR: WireShape = { kind: "string" };
  const NULLABLE_STR: WireShape = { kind: "nullable", inner: { kind: "string" } };
  const OPTIONAL_STR: WireShape = { kind: "optional", inner: { kind: "string" } };

  it("null inhabits nullable<T> (all-null degenerate column)", () => {
    expect(diffShapes("", NULLABLE_STR, { kind: "null" })).toEqual([]);
  });

  it("bare T inhabits nullable<T> (all-non-null degenerate column)", () => {
    expect(diffShapes("", NULLABLE_STR, STR)).toEqual([]);
  });

  it("bare T inhabits optional<T> (field present in every element this run)", () => {
    expect(diffShapes("", OPTIONAL_STR, STR)).toEqual([]);
  });

  it("null inhabits optional<nullable<T>> (layered wrapper peel)", () => {
    expect(diffShapes("", { kind: "optional", inner: NULLABLE_STR }, { kind: "null" })).toEqual([]);
  });

  it("bare object inhabits nullable<object> by peeling into the object body", () => {
    const obj: WireShape = { kind: "object", fields: { a: { kind: "string" } } };
    expect(diffShapes("", { kind: "nullable", inner: obj }, obj)).toEqual([]);
  });

  it("does NOT tolerate a broader live shape: snapshot string, live nullable<string> drifts", () => {
    expect(diffShapes("", STR, NULLABLE_STR)).toEqual([
      { op: "~", path: "<root>", expected: "string", actual: "nullable<string>" },
    ]);
  });

  it("does NOT tolerate null against a non-nullable contract: snapshot string, live null drifts", () => {
    expect(diffShapes("", STR, { kind: "null" })).toEqual([
      { op: "~", path: "<root>", expected: "string", actual: "null" },
    ]);
  });

  it("still flags an inner type change under a tolerated wrapper: nullable<string> vs number", () => {
    expect(diffShapes("", NULLABLE_STR, { kind: "number" })).toEqual([
      { op: "~", path: "<root>", expected: "string", actual: "number" },
    ]);
  });

  it("still flags an inner type change when both sides are nullable: nullable<string> vs nullable<number>", () => {
    expect(diffShapes("", NULLABLE_STR, { kind: "nullable", inner: { kind: "number" } })).toEqual([
      { op: "~", path: "<root>", expected: "string", actual: "number" },
    ]);
  });
});

describe("diffShapes — empty-array directional tolerance (#692)", () => {
  // An empty live array captures as `array<unknown>` (no elements to infer
  // from) and cannot contradict any element contract — it inhabits every
  // snapshot `array<T>`. A populated live array carries a concrete item
  // shape and is compared normally.
  const ARRAY_OF_OBJECT: WireShape = {
    kind: "array",
    item: { kind: "object", fields: { date: { kind: "string" }, duration: { kind: "string" } } },
  };
  const ARRAY_OF_STRING: WireShape = { kind: "array", item: { kind: "string" } };
  const EMPTY_ARRAY: WireShape = { kind: "array", item: { kind: "unknown" } };

  it("empty live array inhabits array<object> (zero-record degenerate column)", () => {
    expect(diffShapes("", ARRAY_OF_OBJECT, EMPTY_ARRAY)).toEqual([]);
  });

  it("empty live array inhabits array<T> for primitive and wrapped element contracts", () => {
    expect(diffShapes("", ARRAY_OF_STRING, EMPTY_ARRAY)).toEqual([]);
    expect(
      diffShapes("", { kind: "array", item: { kind: "nullable", inner: { kind: "string" } } }, EMPTY_ARRAY),
    ).toEqual([]);
  });

  it("empty live array inhabits a nullable<array<T>> contract (composes with wrapper peel)", () => {
    expect(diffShapes("", { kind: "nullable", inner: ARRAY_OF_OBJECT }, EMPTY_ARRAY)).toEqual([]);
  });

  it("empty NESTED live array inhabits the inner element contract (recursive application)", () => {
    // Live `[[]]` captures as array<array<unknown>>.
    expect(diffShapes("", { kind: "array", item: ARRAY_OF_STRING }, { kind: "array", item: EMPTY_ARRAY })).toEqual([]);
  });

  it("does NOT tolerate a populated live array with a regressed element shape", () => {
    expect(diffShapes("", ARRAY_OF_OBJECT, ARRAY_OF_STRING)).toEqual([
      { op: "~", path: "[]", expected: "object", actual: "string" },
    ]);
  });

  it("does NOT tolerate the reverse direction: degenerate snapshot array<unknown> vs populated live", () => {
    // A snapshot captured from an empty cycle must keep drifting against real
    // data — the remedy is re-capturing it from a populated subject.
    expect(diffShapes("", EMPTY_ARRAY, ARRAY_OF_STRING)).toEqual([
      { op: "~", path: "[]", expected: "unknown", actual: "string" },
    ]);
  });

  it("known limit: a mixed-kind populated array also captures item `unknown` and is tolerated", () => {
    // captureWireShape(["x", 1]) collapses to array<unknown> — indistinguishable
    // from empty at the shape level. GraphQL list fields are homogeneous, so
    // this false-accept vector is accepted as the cost of the empty-array fix.
    expect(captureWireShape(["x", 1])).toEqual(EMPTY_ARRAY);
    expect(diffShapes("", ARRAY_OF_STRING, captureWireShape(["x", 1]))).toEqual([]);
  });
});

describe("WireSnapshotAssertionError", () => {
  it("preserves the `code`, `operationName`, `snapshotPath`, and `diff` fields", () => {
    const error = new WireSnapshotAssertionError({
      code: "drift",
      operationName: "Op",
      snapshotPath: "/tmp/Op.snapshot.json",
      diff: [{ op: "+", path: "f", type: "string" }],
      message: "drift!",
    });
    expect(error.name).toBe("WireSnapshotAssertionError");
    expect(error.code).toBe("drift");
    expect(error.operationName).toBe("Op");
    expect(error.snapshotPath).toBe("/tmp/Op.snapshot.json");
    expect(error.diff).toEqual([{ op: "+", path: "f", type: "string" }]);
    expect(error.message).toBe("drift!");
    expect(error).toBeInstanceOf(Error);
  });
});
