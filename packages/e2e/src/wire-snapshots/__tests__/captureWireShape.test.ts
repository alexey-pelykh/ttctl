// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { captureWireShape, createWireSnapshot } from "../captureWireShape.js";
import type { WireShape } from "../captureWireShape.js";

describe("captureWireShape — primitives", () => {
  it("captures string", () => {
    expect(captureWireShape("foo")).toEqual({ kind: "string" });
  });

  it("captures number (including the literal-0 edge case)", () => {
    expect(captureWireShape(42)).toEqual({ kind: "number" });
    expect(captureWireShape(0)).toEqual({ kind: "number" });
    expect(captureWireShape(-1.5)).toEqual({ kind: "number" });
  });

  it("captures boolean (both truth values)", () => {
    expect(captureWireShape(true)).toEqual({ kind: "boolean" });
    expect(captureWireShape(false)).toEqual({ kind: "boolean" });
  });

  it("captures null distinctly from undefined and unknown", () => {
    expect(captureWireShape(null)).toEqual({ kind: "null" });
  });

  it("treats undefined as `unknown` (not valid JSON, but maps cleanly)", () => {
    expect(captureWireShape(undefined)).toEqual({ kind: "unknown" });
  });
});

describe("captureWireShape — objects", () => {
  it("captures a flat object with sorted field keys", () => {
    const shape = captureWireShape({ z: 1, a: "x", m: true });
    expect(shape).toEqual({
      kind: "object",
      fields: {
        a: { kind: "string" },
        m: { kind: "boolean" },
        z: { kind: "number" },
      },
    });
    // Serializer determinism: insertion-order is sort-order, so JSON is byte-stable.
    expect(JSON.stringify(shape)).toBe(
      '{"kind":"object","fields":{"a":{"kind":"string"},"m":{"kind":"boolean"},"z":{"kind":"number"}}}',
    );
  });

  it("captures nested objects (single sample preserves null as `null`, not `nullable`)", () => {
    expect(
      captureWireShape({
        outer: { inner: { leaf: "x" }, marker: null },
      }),
    ).toEqual({
      kind: "object",
      fields: {
        outer: {
          kind: "object",
          fields: {
            inner: {
              kind: "object",
              fields: { leaf: { kind: "string" } },
            },
            marker: { kind: "null" },
          },
        },
      },
    });
  });

  it("captures deeply nested (3+ levels)", () => {
    const shape = captureWireShape({ a: { b: { c: { d: 42 } } } });
    expect(shape).toEqual({
      kind: "object",
      fields: {
        a: {
          kind: "object",
          fields: {
            b: {
              kind: "object",
              fields: {
                c: {
                  kind: "object",
                  fields: { d: { kind: "number" } },
                },
              },
            },
          },
        },
      },
    });
  });

  it("captures empty object", () => {
    expect(captureWireShape({})).toEqual({ kind: "object", fields: {} });
  });
});

describe("captureWireShape — arrays", () => {
  it("empty array → item is `unknown`", () => {
    expect(captureWireShape([])).toEqual({
      kind: "array",
      item: { kind: "unknown" },
    });
  });

  it("array of primitives → item is that primitive", () => {
    expect(captureWireShape(["a", "b", "c"])).toEqual({
      kind: "array",
      item: { kind: "string" },
    });
  });

  it("array with null + non-null → item is nullable", () => {
    expect(captureWireShape([null, "x", null, "y"])).toEqual({
      kind: "array",
      item: { kind: "nullable", inner: { kind: "string" } },
    });
  });

  it("array of all nulls → item is `null` (no useful inner inferable)", () => {
    expect(captureWireShape([null, null])).toEqual({
      kind: "array",
      item: { kind: "null" },
    });
  });

  it("array of objects with divergent field sets → missing fields wrapped in `optional`", () => {
    expect(
      captureWireShape([
        { a: 1, b: "x" },
        { a: 2, c: true },
      ]),
    ).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: {
          a: { kind: "number" },
          b: { kind: "optional", inner: { kind: "string" } },
          c: { kind: "optional", inner: { kind: "boolean" } },
        },
      },
    });
  });

  it("array of objects where a field is null in some samples and typed in others → nullable inner", () => {
    expect(
      captureWireShape([
        { note: "first" },
        { note: null },
        { note: "third" },
      ]),
    ).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: {
          note: { kind: "nullable", inner: { kind: "string" } },
        },
      },
    });
  });

  it("mismatched primitive kinds collapse to `unknown` (documented behavior)", () => {
    expect(captureWireShape(["a", 1, true])).toEqual({
      kind: "array",
      item: { kind: "unknown" },
    });
  });

  it("array of arrays unifies items recursively", () => {
    expect(
      captureWireShape([
        ["a", "b"],
        ["c"],
      ]),
    ).toEqual({
      kind: "array",
      item: { kind: "array", item: { kind: "string" } },
    });
  });
});

describe("captureWireShape — composite wrappers", () => {
  it("a field both optional and nullable lands as optional<nullable<T>> (canonical layering)", () => {
    expect(
      captureWireShape([
        { note: "first" },
        { note: null },
        { other: 1 }, // 'note' absent
      ]),
    ).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: {
          note: {
            kind: "optional",
            inner: { kind: "nullable", inner: { kind: "string" } },
          },
          other: { kind: "optional", inner: { kind: "number" } },
        },
      },
    });
  });

  it("optional propagates through subsequent same-typed samples (once optional, always optional)", () => {
    expect(
      captureWireShape([
        { name: "a" },
        {}, // 'name' absent → optional
        { name: "b" }, // present again, stays optional
      ]),
    ).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: {
          name: { kind: "optional", inner: { kind: "string" } },
        },
      },
    });
  });
});

describe("captureWireShape — wire-fixture shape (BillingCycle, structurally equivalent to .tmp/01-before-show.json)", () => {
  /**
   * Structural-only stand-in for the captured fixture. The real fixture
   * lives in `.tmp/` (gitignored) and carries live-account PII; this
   * literal mirrors the SHAPE — nested object hierarchy, an array of
   * records with one nullable field, and the wire-shape quirk that
   * motivated the council: `duration` and `hours` as strings, not
   * numbers (per PR #275's lesson — see CLAUDE.md § Schema/contract
   * validation rule).
   */
  const billingCycleFixture = {
    id: "VjEtQmlsbGluZ0N5Y2xlLTEzMTA1MjA",
    startDate: "2026-05-01",
    endDate: "2026-05-13",
    hours: "72.0",
    minimumCommitment: null,
    timesheetOverdue: true,
    timesheetSubmissionOpenDatetime: "2026-05-11T00:00:00+00:00",
    timesheetSubmissionDeadlineDatetime: "2026-05-28T00:00:00+00:00",
    timesheetSubmitted: false,
    engagement: {
      __typename: "TalentEngagement",
      id: "VjEtVGFsZW50RW5nYWdlbWVudC01MTM2ODU",
      expectedHours: 40,
      job: {
        __typename: "TalentJob",
        id: "VjEtSm9iLTQ1OTkyMQ",
        title: "[redacted]",
      },
    },
    timesheetUrl: "https://example.test/timesheet",
    timesheetComment: "",
    timesheetRecords: [
      {
        __typename: "TimesheetRecord",
        date: "2026-05-01",
        duration: "480.0",
        isDayOff: false,
        note: "AOP-1; AOP-2",
      },
      {
        __typename: "TimesheetRecord",
        date: "2026-05-02",
        duration: "0.0",
        isDayOff: false,
        note: null,
      },
    ],
    actualAgreement: {
      __typename: "EngagementAgreement",
      applicationRate: "102.0",
      talentHourlyRate: "102.0",
      marketplaceMargin: null,
    },
  };

  it("captures the BillingCycle shape deterministically", () => {
    const shape = captureWireShape(billingCycleFixture);
    expect(shape).toMatchObject({
      kind: "object",
      fields: {
        // Wire-shape regression: PR #275 — duration/hours land as strings,
        // not numbers. The shape must reflect that or the diff has no
        // chance of catching the regression on the next drift.
        hours: { kind: "string" },
        minimumCommitment: { kind: "null" },
        timesheetOverdue: { kind: "boolean" },
        timesheetSubmitted: { kind: "boolean" },
        engagement: {
          kind: "object",
          fields: {
            expectedHours: { kind: "number" },
            job: { kind: "object" },
          },
        },
        timesheetRecords: {
          kind: "array",
          item: {
            kind: "object",
            fields: {
              date: { kind: "string" },
              duration: { kind: "string" },
              isDayOff: { kind: "boolean" },
              // Note is null in one record, string in another.
              note: { kind: "nullable", inner: { kind: "string" } },
            },
          },
        },
      },
    });
  });

  it("produces byte-stable JSON regardless of source field order", () => {
    // Same fixture, fields scrambled — JSON output must be identical.
    const scrambled = {
      timesheetRecords: billingCycleFixture.timesheetRecords,
      id: billingCycleFixture.id,
      hours: billingCycleFixture.hours,
      engagement: billingCycleFixture.engagement,
      actualAgreement: billingCycleFixture.actualAgreement,
      timesheetSubmitted: billingCycleFixture.timesheetSubmitted,
      timesheetOverdue: billingCycleFixture.timesheetOverdue,
      startDate: billingCycleFixture.startDate,
      endDate: billingCycleFixture.endDate,
      minimumCommitment: billingCycleFixture.minimumCommitment,
      timesheetSubmissionOpenDatetime: billingCycleFixture.timesheetSubmissionOpenDatetime,
      timesheetSubmissionDeadlineDatetime: billingCycleFixture.timesheetSubmissionDeadlineDatetime,
      timesheetUrl: billingCycleFixture.timesheetUrl,
      timesheetComment: billingCycleFixture.timesheetComment,
    };
    expect(JSON.stringify(captureWireShape(billingCycleFixture))).toBe(
      JSON.stringify(captureWireShape(scrambled)),
    );
  });
});

describe("captureWireShape — discriminated-union type narrowing", () => {
  it("the WireShape union narrows on `kind` at the type level", () => {
    const shape: WireShape = captureWireShape({ a: 1 });
    // Exhaustive switch — the compiler enforces every variant is handled.
    switch (shape.kind) {
      case "string":
      case "number":
      case "boolean":
      case "null":
      case "unknown":
        break;
      case "object": {
        expect(shape.fields).toBeDefined();
        break;
      }
      case "array": {
        expect(shape.item).toBeDefined();
        break;
      }
      case "nullable":
      case "optional": {
        expect(shape.inner).toBeDefined();
        break;
      }
    }
  });
});

describe("createWireSnapshot", () => {
  it("populates the file format with the provided fields and captures the shape", () => {
    const snapshot = createWireSnapshot({
      operationName: "GetBillingCycle",
      surface: "mobile-gateway",
      transport: "stock",
      response: { id: "x", hours: "72.0" },
      capturedAt: "2026-05-14T00:00:00.000Z",
    });
    expect(snapshot).toEqual({
      version: "1",
      capturedAt: "2026-05-14T00:00:00.000Z",
      operationName: "GetBillingCycle",
      surface: "mobile-gateway",
      transport: "stock",
      shape: {
        kind: "object",
        fields: {
          hours: { kind: "string" },
          id: { kind: "string" },
        },
      },
    });
  });

  it("defaults capturedAt to a valid ISO 8601 wall-clock timestamp", () => {
    const snapshot = createWireSnapshot({
      operationName: "X",
      surface: "talent-profile",
      transport: "impersonated",
      response: 1,
    });
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("pins format version to '1'", () => {
    const snapshot = createWireSnapshot({
      operationName: "X",
      surface: "scheduler",
      transport: "impersonated",
      response: null,
    });
    expect(snapshot.version).toBe("1");
  });
});
