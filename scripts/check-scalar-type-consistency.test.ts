// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import {
  analyzeScalarConsistency,
  type Disposition,
  formatReport,
  type ScalarAnalysis,
} from "./check-scalar-type-consistency.js";

// Drives the gate's pure core against in-memory fixtures. Runs under root vitest
// (`pnpm test:coverage`), NOT `turbo run test` (per-package, never sees scripts/).

type Fixtures = Record<string, string>;

function readerFor(files: Fixtures): (relPath: string) => string[] | null {
  return (relPath) => (relPath in files ? (files[relPath] as string).split("\n") : null);
}

function analysisOf(files: Fixtures): ScalarAnalysis {
  return analyzeScalarConsistency(Object.keys(files), readerFor(files));
}

function dispositionOf(files: Fixtures, iface: string, field: string): Disposition | undefined {
  return analysisOf(files).fields.find((f) => f.hand.iface === iface && f.hand.field === field)?.disposition;
}

const GEN_PATH = "packages/core/src/__generated__/gateway.ts";
const SVC_PATH = "packages/core/src/services/payments/index.ts";

// A generated fixture mirroring the real shape: a Scalars block, codegen TS
// named-type fields, and codegen-Zod schemas (output + input). `value` is Int in
// one type and String in another → ambiguous on purpose; `meta` is JSON
// (non-primitive); `inputOnly`/`zodInputOnly` are input-side and must be ignored.
const GEN = [
  `export type Scalars = {`,
  `  ID: { input: string; output: string; }`,
  `  String: { input: string; output: string; }`,
  `  Boolean: { input: boolean; output: boolean; }`,
  `  Int: { input: number; output: number; }`,
  `  BigDecimal: { input: string; output: string; }`,
  `  JSON: { input: Record<string, unknown>; output: Record<string, unknown>; }`,
  `};`,
  ``,
  `export type TalentPayment = {`,
  `  __typename?: 'TalentPayment';`,
  `  paymentGroupId: Maybe<Scalars['Int']['output']>;`,
  `  amount: Scalars['BigDecimal']['output'];`,
  `  meta: Scalars['JSON']['output'];`,
  `  job: TalentJob;`,
  `};`,
  ``,
  `export type TimeZone = {`,
  `  utcOffset: Scalars['Int']['output'];`,
  `  active: Scalars['Boolean']['output'];`,
  `  value: Scalars['String']['output'];`,
  `};`,
  ``,
  `export type WeirdThing = {`,
  `  value: Scalars['Int']['output'];`,
  `};`,
  ``,
  `export type SomeInput = {`,
  `  inputOnly: InputMaybe<Scalars['Int']['input']>;`,
  `};`,
  ``,
  `export function TalentPaymentSchema(): z.ZodObject<Properties<TalentPayment>> {`,
  `  return z.object({`,
  `    paymentGroupId: z.number().nullable(),`,
  `    amount: z.string(),`,
  `  })`,
  `}`,
  ``,
  `export function SomeInputSchema(): z.ZodObject<Properties<SomeInput>> {`,
  `  return z.object({`,
  `    zodInputOnly: z.string(),`,
  `  })`,
  `}`,
].join("\n");

describe("analyzeScalarConsistency — mismatch detection (the #275 class)", () => {
  it("flags string-vs-number (the #779 paymentGroupId shape)", () => {
    const files = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [`export interface Payout {`, `  paymentGroupId: string | null;`, `}`].join("\n"),
    };
    const { findings } = analysisOf(files);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      iface: "Payout",
      field: "paymentGroupId",
      handPrimitive: "string",
      generatedPrimitive: "number",
    });
    expect(dispositionOf(files, "Payout", "paymentGroupId")).toBe("MISMATCH");
  });

  it("passes when the hand-authored type matches the generated scalar (post-#779 state)", () => {
    const files = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [`export interface Payout {`, `  paymentGroupId: number | null;`, `  amount: string;`, `}`].join(
        "\n",
      ),
    };
    expect(analysisOf(files).findings).toHaveLength(0);
    expect(dispositionOf(files, "Payout", "paymentGroupId")).toBe("OK");
    expect(dispositionOf(files, "Payout", "amount")).toBe("OK");
  });

  it("resolves BigDecimal→string, so a string-typed numeric (the duration class) is NOT a false positive", () => {
    // `amount` is BigDecimal (→ string) on the wire; hand-authored `string` is correct.
    const ok = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [`export interface Payout {`, `  amount: string;`, `}`].join("\n"),
    };
    expect(analysisOf(ok).findings).toHaveLength(0);
    expect(dispositionOf(ok, "Payout", "amount")).toBe("OK");

    // The inverse IS caught: declaring a BigDecimal field as `number` contradicts string.
    const bad = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [`export interface Payout {`, `  amount: number;`, `}`].join("\n"),
    };
    expect(analysisOf(bad).findings).toMatchObject([
      { field: "amount", handPrimitive: "number", generatedPrimitive: "string" },
    ]);
  });

  it("resolves Boolean and reports a boolean-vs-number contradiction", () => {
    const files = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [`export interface Zone {`, `  active: number;`, `}`].join("\n"),
    };
    expect(analysisOf(files).findings).toMatchObject([
      { field: "active", handPrimitive: "number", generatedPrimitive: "boolean" },
    ]);
  });
});

describe("analyzeScalarConsistency — disambiguation + scoping guards", () => {
  it("skips a field name the generated authority holds with two primitives (ambiguous)", () => {
    const files = {
      [GEN_PATH]: GEN, // `value` is String in TimeZone and Int in WeirdThing
      [SVC_PATH]: [`export interface Zone {`, `  value: number;`, `}`].join("\n"),
    };
    expect(analysisOf(files).findings).toHaveLength(0);
    expect(dispositionOf(files, "Zone", "value")).toBe("AMBIGUOUS");
  });

  it("skips a field with no generated authority", () => {
    const files = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [`export interface Zone {`, `  homegrownField: number;`, `}`].join("\n"),
    };
    expect(analysisOf(files).findings).toHaveLength(0);
    expect(dispositionOf(files, "Zone", "homegrownField")).toBe("NO-AUTHORITY");
  });

  it("does not form authority from input-side TS fields or *InputSchema Zod fields", () => {
    const files = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [
        `export interface Zone {`,
        `  inputOnly: string;`, // generated only as InputMaybe<Int> → no output authority
        `  zodInputOnly: number;`, // generated only inside SomeInputSchema → no output authority
        `}`,
      ].join("\n"),
    };
    expect(analysisOf(files).findings).toHaveLength(0);
    expect(dispositionOf(files, "Zone", "inputOnly")).toBe("NO-AUTHORITY");
    expect(dispositionOf(files, "Zone", "zodInputOnly")).toBe("NO-AUTHORITY");
  });

  it("does not treat non-scalar hand-authored fields as checkable", () => {
    const files = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [
        `export interface Payout {`,
        `  tags: string[];`,
        `  child: TimeZone | null;`,
        `  kind: "a" | "b";`,
        `  mixed: string | number;`,
        `  paymentGroupId: number | null;`,
        `}`,
      ].join("\n"),
    };
    const fields = analysisOf(files).fields.map((f) => f.hand.field);
    expect(fields).toEqual(["paymentGroupId"]); // the only plain scalar
  });

  it("ignores interfaces under __tests__ and *.test.ts", () => {
    const files = {
      [GEN_PATH]: GEN,
      "packages/core/src/services/payments/__tests__/fixtures.ts": [
        `export interface FakePayout {`,
        `  paymentGroupId: string;`,
        `}`,
      ].join("\n"),
    };
    expect(analysisOf(files).findings).toHaveLength(0);
  });
});

describe("analyzeScalarConsistency — exemptions", () => {
  it("honors a per-field exemption marker", () => {
    const files = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [
        `export interface Payout {`,
        `  // scalar-consistency-exempt: deliberately surfaced as a string`,
        `  paymentGroupId: string | null;`,
        `}`,
      ].join("\n"),
    };
    expect(analysisOf(files).findings).toHaveLength(0);
    expect(dispositionOf(files, "Payout", "paymentGroupId")).toBe("EXEMPT");
  });

  it("honors an interface-level marker for every field in the interface", () => {
    const files = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [
        `// scalar-consistency-exempt: whole-interface divergence`,
        `export interface Payout {`,
        `  paymentGroupId: string | null;`,
        `  amount: number;`,
        `}`,
      ].join("\n"),
    };
    expect(analysisOf(files).findings).toHaveLength(0);
    expect(dispositionOf(files, "Payout", "paymentGroupId")).toBe("EXEMPT");
    expect(dispositionOf(files, "Payout", "amount")).toBe("EXEMPT");
  });
});

describe("formatReport — warn vs strict exit codes", () => {
  const mismatch = {
    [GEN_PATH]: GEN,
    [SVC_PATH]: [`export interface Payout {`, `  paymentGroupId: string | null;`, `}`].join("\n"),
  };

  it("a mismatch fails strict, passes warn", () => {
    const analysis = analysisOf(mismatch);
    expect(formatReport(analysis, true).exitCode).toBe(1);
    expect(formatReport(analysis, false).exitCode).toBe(0);
    // The mismatch surfaces on stderr in both modes (visibility).
    expect(formatReport(analysis, false).stderrLines.join("\n")).toContain("Payout.paymentGroupId");
  });

  it("a clean corpus exits 0 in both modes", () => {
    const clean = {
      [GEN_PATH]: GEN,
      [SVC_PATH]: [`export interface Payout {`, `  paymentGroupId: number | null;`, `}`].join("\n"),
    };
    const analysis = analysisOf(clean);
    expect(formatReport(analysis, true).exitCode).toBe(0);
    expect(formatReport(analysis, false).exitCode).toBe(0);
    expect(formatReport(analysis, false).stderrLines).toEqual([]);
  });
});
