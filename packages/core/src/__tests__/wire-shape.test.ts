// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildWireShapeError,
  buildWireShapeMessage,
  MAX_VALUE_LENGTH,
  projectZodErrorToDiff,
  WIRE_SHAPE_HINT,
} from "../lib/wire-shape.js";

/**
 * Tests for the shared `wire-shape` helper (Z-3 / #286) — the
 * structured payload builder that powers every service-level
 * `WIRE_SHAPE_ERROR`. The helper consumes a `z.ZodError` from a failed
 * `schema.parse(body.data)` call and projects it into
 * `{ message, hint, diff }` per `docs/wire-validation-error-format.md`.
 *
 * These tests are mechanism-only — no production op is wired through
 * yet (that's Z-4 / #288). They drive the helper directly with
 * hand-built ZodErrors.
 */

function getError<T>(schema: z.ZodType<T>, input: unknown): { error: z.ZodError; input: unknown } {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    throw new Error("test schema unexpectedly accepted input");
  }
  return { error: parsed.error, input };
}

describe("buildWireShapeMessage", () => {
  it("renders singular `1 field issue` (plural-aware)", () => {
    expect(buildWireShapeMessage("BillingCycle", 1)).toBe(
      "Wire shape doesn't match expected schema for operation `BillingCycle` (1 field issue).",
    );
  });

  it("renders plural `<N> field issues`", () => {
    expect(buildWireShapeMessage("BillingCycle", 2)).toBe(
      "Wire shape doesn't match expected schema for operation `BillingCycle` (2 field issues).",
    );
    expect(buildWireShapeMessage("Op", 0)).toBe(
      "Wire shape doesn't match expected schema for operation `Op` (0 field issues).",
    );
  });

  it("escapes nothing — operationName lands verbatim in backticks", () => {
    expect(buildWireShapeMessage("ProfileShow", 3)).toContain("`ProfileShow`");
  });
});

describe("projectZodErrorToDiff", () => {
  it("projects an `invalid_type` issue with concrete input to `~` with raw value", () => {
    const schema = z.object({ duration: z.number() });
    const { error, input } = getError(schema, { duration: "480" });
    const diff = projectZodErrorToDiff(error, input);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({
      op: "~",
      path: "duration",
      expected: "number",
      actual: "string",
      value: "480",
    });
  });

  it("projects an `invalid_type` issue with `undefined` input to `-` (missing-required)", () => {
    const schema = z.object({ duration: z.number() });
    const { error, input } = getError(schema, {});
    const diff = projectZodErrorToDiff(error, input);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({
      op: "-",
      path: "duration",
    });
    expect(diff[0]?.value).toBeUndefined();
  });

  it("projects an `unrecognized_keys` issue (strict object) to one `+` per key", () => {
    const schema = z.strictObject({ a: z.string() });
    const { error, input } = getError(schema, { a: "ok", surprise1: 1, surprise2: 2 });
    const diff = projectZodErrorToDiff(error, input);
    // Two `+` entries — one per unknown key. Sorting puts `surprise1`
    // before `surprise2` (lex on path).
    expect(diff).toHaveLength(2);
    expect(diff.map((e) => e.op)).toEqual(["+", "+"]);
    expect(diff.map((e) => e.path).sort()).toEqual(["surprise1", "surprise2"]);
  });

  it("renders array indices with bracket notation (matches jq path semantics)", () => {
    const schema = z.object({ records: z.array(z.object({ duration: z.number() })) });
    const { error, input } = getError(schema, { records: [{ duration: "480" }, { duration: 60 }] });
    const diff = projectZodErrorToDiff(error, input);
    expect(diff[0]?.path).toBe("records[0].duration");
  });

  it("sorts entries by path with NUMERIC index comparison (`[2]` before `[10]`)", () => {
    const schema = z.object({ items: z.array(z.number()) });
    // Build a hand-crafted error scenario by constructing entries in
    // non-deterministic order, then assert sorted output.
    const { error, input } = getError(schema, { items: Array.from({ length: 11 }, () => "wrong-type") });
    const diff = projectZodErrorToDiff(error, input);
    // First entry should be `items[0]`, last `items[10]`.
    expect(diff[0]?.path).toBe("items[0]");
    expect(diff[diff.length - 1]?.path).toBe("items[10]");
    // Critically: `items[2]` precedes `items[10]` (numeric compare,
    // not lexicographic — `"[10]" < "[2]"` lexicographically).
    const idx2 = diff.findIndex((e) => e.path === "items[2]");
    const idx10 = diff.findIndex((e) => e.path === "items[10]");
    expect(idx2).toBeLessThan(idx10);
  });

  it("truncates rendered values to MAX_VALUE_LENGTH chars with `…`", () => {
    const schema = z.object({ x: z.number() });
    const longString = "x".repeat(100);
    const { error, input } = getError(schema, { x: longString });
    const diff = projectZodErrorToDiff(error, input);
    expect(diff[0]?.value).toBeDefined();
    expect(diff[0]?.value?.length).toBeLessThanOrEqual(MAX_VALUE_LENGTH);
    expect(diff[0]?.value?.endsWith("…")).toBe(true);
  });

  it("falls back to path-only render when wireData is omitted (Zod v4 strips input)", () => {
    const schema = z.object({ duration: z.number() });
    const { error } = getError(schema, { duration: "480" });
    const diff = projectZodErrorToDiff(error); // no wireData
    // Without snapshot, can't extract actual value — but the test should
    // still produce a diff entry (degraded mode).
    expect(diff).toHaveLength(1);
    expect(diff[0]?.path).toBe("duration");
    // Resolved=MISSING; behaves as missing-required → `-` op.
    expect(diff[0]?.op).toBe("-");
  });

  it("renders empty diff for an empty issue list", () => {
    const schema = z.string();
    const customError = new z.ZodError([]);
    const diff = projectZodErrorToDiff(customError);
    expect(diff).toEqual([]);
    // Sanity check that schema is unused — getError isn't called here.
    expect(schema.safeParse("ok").success).toBe(true);
  });
});

describe("buildWireShapeError", () => {
  it("returns { message, hint, diff } payload composing the parts", () => {
    const schema = z.object({ duration: z.number() });
    const { error, input } = getError(schema, { duration: "480" });
    const payload = buildWireShapeError("BillingCycle", error, input);
    expect(payload.message).toBe(
      "Wire shape doesn't match expected schema for operation `BillingCycle` (1 field issue).",
    );
    expect(payload.hint).toBe(WIRE_SHAPE_HINT);
    expect(payload.diff).toHaveLength(1);
  });

  it("counts the DIFF-ENTRY count, not the issue count (for unrecognized_keys expansion)", () => {
    const schema = z.strictObject({ a: z.string() });
    const { error, input } = getError(schema, { a: "ok", k1: 1, k2: 2, k3: 3 });
    const payload = buildWireShapeError("Op", error, input);
    // Three unknown keys → three `+` diff entries. The Zod error has a
    // single `unrecognized_keys` issue, but the diff (which is what
    // the operator sees) carries three entries.
    expect(payload.diff).toHaveLength(3);
    expect(payload.message).toContain("(3 field issues)");
  });

  it("uses the WIRE_SHAPE_HINT constant verbatim (no interpolation)", () => {
    const schema = z.object({ x: z.number() });
    const { error, input } = getError(schema, { x: "s" });
    const payload = buildWireShapeError("Op", error, input);
    expect(payload.hint).toContain("https://github.com/alexey-pelykh/ttctl/issues");
    expect(payload.hint).toContain("Toptal changed the API");
  });
});

describe("WIRE_SHAPE_HINT constant", () => {
  it("matches the verbatim spec text from `docs/wire-validation-error-format.md`", () => {
    expect(WIRE_SHAPE_HINT).toBe(
      "wire shape doesn't match expected — this typically means Toptal changed the API; please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the operation name and timestamp.",
    );
  });
});
