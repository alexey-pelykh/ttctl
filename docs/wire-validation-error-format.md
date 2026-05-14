# WIRE_SHAPE_ERROR user-visible format

Spec for the user-visible error emitted when a wire response from a Toptal
GraphQL endpoint fails its generated Zod schema. This is the contract that
issue #286 (Z-3, `callGateway` integration) will implement. Track 1
(wire-shape snapshots, #276) emits a different `WIRE_SNAPSHOT_DRIFT` shape at
E2E time and is out of scope here. Background: scope brief at
[`docs/briefs/2026-05-14-scope-runtime-validation-hybrid.md`][brief].

[brief]: ./briefs/2026-05-14-scope-runtime-validation-hybrid.md

## Code + base fields

| Field     | Value                                                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`    | `"WIRE_SHAPE_ERROR"` (stable; part of the public-API contract per `ENVELOPE_VERSION`)                                                                                                                                                                          |
| `message` | ``"Wire shape doesn't match expected schema for operation `<OpName>` (<N> field issue(s))."`` — `<OpName>` is the GraphQL `operationName`; `<N>` is the diff-entry count.                                                                                      |
| `hint`    | (verbatim) `"wire shape doesn't match expected — this typically means Toptal changed the API; please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the operation name and timestamp."`                                                   |
| `diff`    | Field-level diff array. NEW optional `diff?: WireShapeDiffEntry[]` slot on the existing `EnvelopeError` shape — populated for `WIRE_SHAPE_ERROR`, absent for other codes. The single-valued `field?: string` slot keeps its meaning for non-wire-shape errors. |

Operationally a `WIRE_SHAPE_ERROR` means **Toptal changed the wire shape** —
not a bug TTCtl can fix in code; the user files an issue so the schema is
re-synthesized.

## Diff entries

Each entry is `{op, path, expected, actual, value?}`:

- `op`: `"+"` added (wire field absent from schema; strict mode only) /
  `"-"` removed (schema field missing on wire, or `null` where non-null
  required) / `"~"` type-changed (wire value type differs from schema).
- `path`: JSON path from the operation root, zero-indexed arrays
  (`billingCycle.timesheetRecords[0].duration`) so it matches `jq` semantics.
- `expected`: schema type as a short string (`"number"`, `"string | null"`,
  `"array<string>"`). Generated from the Zod schema; exact formatter is
  implementation detail of #286.
- `actual`: wire value type as a short string.
- `value?`: raw wire value for `~` entries, truncated to 32 chars with `…` on
  overflow. Omitted for `+` / `-`. `body.data` never contains the bearer, so
  no redaction is needed here.

**Deterministic ordering**: entries are sorted by `path` with array indices
compared numerically (`[2]` before `[10]`). Byte-identical output across runs
is essential for snapshot tests and human pattern-matching.

The Zod-to-diff projection of `ZodIssue.code`: `invalid_type` → `~`,
`unrecognized_keys` (strict mode) → `+`, `invalid_union` / `invalid_literal`
→ `~`, and an undefined-where-required case → `-`. #286 nails the exact
mapping table.

## `-o pretty` (STDERR; STDOUT stays clean; exit `1`)

One-line summary header, structured diff block (capped at 10 entries; tail
note when more), hint footer.

```
Error: Wire shape mismatch for operation `BillingCycle` (2 field issues).
  (Code: WIRE_SHAPE_ERROR)
  Diff (schema vs wire):
    ~ billingCycle.duration: expected number, got string ("480")
    ~ billingCycle.timesheetRecords[0].duration: expected number, got string ("480")
  Hint: wire shape doesn't match expected — this typically means Toptal changed the API; please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the operation name and timestamp.
```

On >10 entries, block ends with `… and <K> more (see -o json for the full diff).`

## `-o json` (STDOUT; single-line; exit `1`)

The runtime emits a single line of compact JSON via `JSON.stringify(envelope)`
(matching the existing `formatErrorJson` contract in
`packages/cli/src/lib/envelopes.ts`). The example below is wrapped only for
readability in this doc; the wire bytes carry no newlines or extra whitespace.

<!-- prettier-ignore -->
```json
{"ok":false,"version":"1.0","operation":"BillingCycle","errors":[{"code":"WIRE_SHAPE_ERROR","message":"Wire shape doesn't match expected schema for operation `BillingCycle` (2 field issues).","hint":"wire shape doesn't match expected — this typically means Toptal changed the API; please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the operation name and timestamp.","diff":[{"op":"~","path":"billingCycle.duration","expected":"number","actual":"string","value":"480"},{"op":"~","path":"billingCycle.timesheetRecords[0].duration","expected":"number","actual":"string","value":"480"}]}]}
```

JSON is **never** truncated — the full diff ships. Routed to STDOUT so `jq`
consumers see the structured payload regardless of exit code.

## `-o yaml` (STDOUT; block-style; exit `1`)

Same envelope as `-o json`, rendered via the shared `formatYaml` helper
(`customTags: []`, `aliasDuplicateObjects: false`, `lineWidth: 0`).

```yaml
ok: false
version: "1.0"
operation: BillingCycle
errors:
  - code: WIRE_SHAPE_ERROR
    message: "Wire shape doesn't match expected schema for operation `BillingCycle` (2 field issues)."
    hint: "wire shape doesn't match expected — this typically means Toptal changed the API; please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the operation name and timestamp."
    diff:
      - op: "~"
        path: billingCycle.duration
        expected: number
        actual: string
        value: "480"
      - op: "~"
        path: billingCycle.timesheetRecords[0].duration
        expected: number
        actual: string
        value: "480"
```

## MCP error-text surface

`isError: true`, `content: [{type: "text", text: …}]`. Extends the existing
`domainErrorResponse` helper (`packages/mcp/src/tools/_shared.ts`) with a
`Diff:` block matching the CLI pretty form so an LLM client sees identical
information across surfaces. The 10-entry cap from pretty applies; a client
that needs the full diff can re-invoke the tool (wire shape is deterministic
per operation).

```
Error: ttctl_timesheet_show failed (WIRE_SHAPE_ERROR): Wire shape doesn't match expected schema for operation `BillingCycle` (2 field issues).

Diff (schema vs wire):
  ~ billingCycle.duration: expected number, got string ("480")
  ~ billingCycle.timesheetRecords[0].duration: expected number, got string ("480")

Hint: wire shape doesn't match expected — this typically means Toptal changed the API; please file an issue at https://github.com/alexey-pelykh/ttctl/issues with the operation name and timestamp.

(Code: WIRE_SHAPE_ERROR)
```

## Implementation hooks (for #286)

- `WIRE_SHAPE_ERROR` is a NEW code on each per-service domain-error union
  (`PaymentsError`, `EngagementsError`, `ProfileError`, …), NOT a
  `TtctlError` subclass. The `TtctlError` hierarchy is reserved for
  cross-service transport/auth concerns with surface-uniform recovery;
  wire-shape mismatches are per-operation and fit the per-service pattern.
- A shared `buildWireShapeError(operationName, zodError)` helper in
  `@ttctl/core` keeps diff construction uniform.
- `ENVELOPE_VERSION` stays at `"1.0"` — `diff?` is an additive optional field
  on `EnvelopeError` (sibling slots like `documentationUrl?` already exist),
  so no breaking change.
- Per the CLAUDE.md schema/contract rule, #286 ships with a unit test against
  a hand-built `ZodError` asserting all four surface renderings AND a live
  E2E (`TTCTL_E2E=1`) that hand-crafts a deliberately-mismatched Zod schema
  and asserts the live wire response triggers `WIRE_SHAPE_ERROR` — closing
  the loop that the gate fires on real wire data.
