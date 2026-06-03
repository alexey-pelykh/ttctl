# Wire snapshots — redaction policy

> Structure-only wire-shape snapshots for Track 1 of the hybrid runtime
> validation scope. This README is the **redaction policy** binding the
> `captureWireShape` producer ([#276]) and every snapshot PR that lands
> a `*.snapshot.json` file in this directory.

## Directory contents

This directory holds, once the full Track 1 lands:

```
README.md                  # this file — redaction policy
captureWireShape.ts        # producer utility (#276 / WS-1)
captureWireShape.test.ts   # unit tests (#276 / WS-1)
assertWireShapeStable.ts   # E2E diff helper (#283 / WS-2)
<OpName>.snapshot.json     # committed wire-shape snapshots (#285 / WS-3 onwards)
```

## Why this policy exists

Wire snapshots are **structure-only by construction** — `captureWireShape`
emits type tags (`"string"`, `"number"`, `"boolean"`, `"null"`) and
field-name keys, never response **values**. PII / secret-leak risk is
therefore bounded at the producer level by the `WireShape` type
contract.

This document covers the **edge cases** where the structure-only
invariant could degrade, and the **manual review checklist** that
catches degradations before they merge. The policy applies to:

- Every `*.snapshot.json` file in this directory
- The `captureWireShape` producer
- Every PR that adds or updates either

## What goes in a snapshot

### Header (public information, retained verbatim)

| Field           | Source                                                   | Why it's safe                                                  |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `version`       | hard-coded `"1"`                                         | Constant                                                       |
| `capturedAt`    | ISO 8601 timestamp                                       | Generated; no payload data                                     |
| `operationName` | GraphQL op name (e.g. `GetTimesheets`)                   | Public — same name lives in `.graphql` source / generated TS   |
| `surface`       | one of `mobile-gateway` / `talent-profile` / `scheduler` | Public — documented in `research/notes/02-auth-and-clients.md` |
| `transport`     | one of `stock` / `impersonated`                          | Public — TLS impersonation policy is public                    |

### Body (structure-only `WireShape`)

The body is the `WireShape` discriminated union from `captureWireShape`:

- **Primitives** — bare type tags: `"string"`, `"number"`, `"boolean"`, `"null"`
- **Objects** — `{ kind: "object", fields: { <name>: <WireShape> } }` with field names sorted alphabetically (deterministic diffs)
- **Arrays** — `{ kind: "array", item: <WireShape> }` where `item` is the **unified** shape across elements
- **Nullable** — `{ kind: "nullable", inner: <WireShape> }` when a field is `null` in some samples but typed in others
- **Optional** — `{ kind: "optional", inner: <WireShape> }` when a field is present in some array elements but absent in others
- **Unknown** — `{ kind: "unknown" }` for empty arrays only

The comparator treats `nullable` / `optional` as a **directional contract**:
the snapshot is the richer shape the live run must _inhabit_. A live run
whose data is degenerate for a wrapped field — e.g. a `nullable<string>`
column that is `null` in every record this cycle (captured as `null`), or
typed in every record (captured as a bare `string`) — does NOT drift. A live
shape _broader_ than the snapshot (snapshot `string`, live `nullable<string>`)
still drifts: that is a genuine wire change. Corollary: a genuinely nullable
field MUST be declared `nullable<T>` in the snapshot — a bare-`T` snapshot
still (correctly) drifts on a live `null`.

## What does NOT go in a snapshot

### Values — never

A snapshot must never contain:

- Response value strings (a profile name, a description, a URL)
- Numeric values (only the tag `"number"`)
- Boolean values (only the tag `"boolean"`)
- Bearer token strings (matching `user_[0-9a-f]{24}_[A-Za-z0-9]{20}`)
- Email addresses, UUIDs, base64 chunks
- Anything resembling PII

If any of the above appears in a snapshot diff, the snapshot is wrong.
Either `captureWireShape` was called on a value-bearing transform, or
the file was hand-edited. **Stop and fix the producer** — do not
"clean up" the snapshot after the fact.

### Enum members — collapsed to `"string"`

GraphQL enums — closed sets of allowed string values like
`SUBMITTED | DRAFT | APPROVED` — have member names that may reveal
product taxonomy or internal workflow vocabulary. `captureWireShape`
treats any primitive `typeof === "string"` runtime value as the type
tag `"string"`, regardless of whether the value happens to be a known
enum member.

A snapshot for an enum-typed field therefore looks like:

```json
{ "status": "string" }
```

NOT:

```json
{ "status": { "kind": "enum", "members": ["SUBMITTED", "DRAFT", "APPROVED"] } }
```

This is intentional. The structure-only contract means **the snapshot
must be deterministically computable from the response shape alone**,
without consulting the schema. Enumerating member names would cross
from "structure" into "values" and would also require schema input the
producer does not have.

**Trade-off**: enum-member drift (Toptal adds a new member or renames
an existing one) is invisible to Track 1. That gap is accepted —
enum-member drift surfaces as a behavioral bug in consuming code, not
as a wire-shape bug. For ops where enum strictness matters, route to
Track 2 (codegen-Zod) per the per-op disposition ([#289]).

## Edge cases

### `__typename`

GraphQL's `__typename` introspection field is treated as a regular
field. If the query selects `{ __typename id duration }`, the snapshot
retains the field name `__typename` and types its value as `"string"`
under the same enum-as-string collapse.

Type **names** (e.g., `BillingCycle`, `Recruiter`) therefore never
appear in the snapshot body — only the field name `__typename` and
its tag. Type names are already public via
`research/graphql/gateway/schema.graphql` and the generated
`packages/core/src/__generated__/graphql.ts`, so excluding them is not
load-bearing for confidentiality; it falls out of the uniform
enum-as-string rule.

### Field names that look sensitive

Two classes of "looks sensitive" exist:

**Class A — names suggesting internal vocabulary.** E.g.,
`recruiterSlackId`, `talentHourlyRate`, or anything resembling
`talentInternalScore` / `revenueBucket`. The names may reveal Toptal's
product taxonomy even when their values are absent.

**Class B — names suggesting PII-bucket content.** E.g., `email`,
`token`, `phoneNumber`, `firstName`. The names are common-knowledge
PII labels.

Both classes are **retained verbatim** in snapshots. Reasoning:

1. The field name already lives in the project's `.graphql` source
   documents and generated TypeScript types — and, for Class B names,
   in the schema's standard scalar / field vocabulary that anyone with
   a Toptal account can observe. The snapshot is **not new
   disclosure** — same information, different file.
2. Wire-shape stability **requires** field names. Without them, the
   structure is opaque and drift detection becomes impossible.
3. Field-name-level redaction (hashing, aliasing) would defeat the
   diff in `assertWireShapeStable` ([#283]) and the manual review check
   ("did the wire just change?").

Note the asymmetry: an `email` **field name** is retained as a key,
but its **value** is forbidden (the manual review checklist's
PII-resembling-content grep catches an actual `@`-bearing string). A
snapshot of a user profile op therefore looks like
`{ "email": "string" }` — the structure of "this op returns a string
in the `email` slot" without the email itself.

If a field name is so sensitive that it cannot be captured at all,
the solution is to **not query that field** — not to redact it from
the snapshot. The audit point is op-authoring time (`.graphql`
document review), not snapshot review.

### Sensitive scalar TYPES

Custom scalar types in the Toptal schema today — `BigDecimal`,
`DateTime`, `JSON`, `Upload`, etc. — collapse to whatever their
runtime JSON type is. `BigDecimal` arrives as a string on the wire and
renders as `"string"`; `DateTime` arrives as an ISO 8601 string and
renders as `"string"`; `JSON` could render as any shape depending on
what the server returns.

Hypothetical future scalars whose **names** suggest sensitivity (e.g.,
`Email`, `Token`, `BearerToken`, `Cuid` — none currently in the
schema beyond the standard scalars) would collapse under the same
rule: the wire-shape layer cannot distinguish `Email!` from `String!` —
both render as `"string"`.

For ops needing format-level validation (RFC 5322 email, bearer
pattern, decimal precision), route to Track 2 (codegen-Zod) where
scalar mappings carry format constraints. See the per-op routing
manifest ([#289]) for disposition.

The wire-shape layer is **not** the place to enforce "this string
must match a regex". It detects **structural** drift (field added,
type changed, nullability flipped) only.

### Mutation inputs

`captureWireShape` is for **response** shapes. It is not used on
inputs — inputs are constructed by our code, not received from the
wire. There is no mutation-input snapshot suite, and this policy does
not extend to inputs. If we ever add input snapshots, they need their
own policy because inputs may legitimately contain bearer tokens, file
contents, or other values that must **not** be captured.

## Workflows

### Add a snapshot for a new operation

Author an E2E test calling
`assertWireShapeStable({ operationName, surface, transport, response })`
on the response path (existing usage:
`packages/e2e/src/25-timesheet-list.e2e.test.ts`), then run:

```sh
TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1 pnpm test:e2e -- -t <OpName>
```

The first run writes `<OpName>.snapshot.json` here; review against the
[Manual review checklist](#manual-review-checklist-for-snapshot-prs)
and commit it alongside the test.

### Update an existing snapshot when the wire genuinely changed

Re-run the same command — the helper overwrites the snapshot and emits
`[wire-snapshot] updated <path>` to stderr. The PR description **must**
justify the wire change (Toptal incident, `research/notes/` update, or
schema-drift evidence).

### Triage a failing snapshot test

Without the update env var, drift surfaces as a structured diff —
`+` added, `-` removed, `~` type changed (or a nullability/optionality
_broadening_ — see the directional contract above; a degenerate live
subject does not drift):

```sh
TTCTL_E2E=1 pnpm test:e2e -- -t <OpName>
```

- **Expected change** (you altered consuming code or query selection)
  → follow the update workflow above.
- **Unexpected change** (silent server-side drift) → open an issue
  against the sibling `../research/` schema with the diff and decide
  whether to fix the typed client, update the snapshot, or both.

## Manual review checklist (for snapshot PRs)

When reviewing a PR that adds or updates a `*.snapshot.json` file in
this directory:

- [ ] **No value strings.** The only string literals in the body are
      type tags (`"string"`, `"number"`, `"boolean"`, `"null"`,
      `"unknown"`), discriminant keys (`"kind"`, `"fields"`, `"item"`,
      `"inner"`), and field-name object keys inside `fields`. Any
      other string is a value leak.
- [ ] **No PII-resembling content.** Grep the diff for: the bearer
      pattern `user_[0-9a-f]{24}_[A-Za-z0-9]{20}`, any `@` inside a
      string literal (email), `https?://` (URL), long numeric runs
      (timestamps, ID-like sequences), and base64 chunks
      (`[A-Za-z0-9+/]{20,}={0,2}`). Any match means the producer leaked
      values — investigate before approving.
- [ ] **Field names match query intent.** Cross-reference the
      snapshot's `fields` against the corresponding `.graphql`
      document selection set. Names that don't appear in the query
      are a smell — `captureWireShape` was probably called on a
      merged / transformed shape instead of the raw response.
- [ ] **Enum-shaped fields collapse to `"string"`.** Any field typed
      as `XxxStatus!` / `XxxCategory!` / any enum in the schema must
      be `"string"` in the snapshot — not a list of member names, not
      a `kind: "enum"` variant.
- [ ] **Header values match runtime.** `operationName` matches the
      `.graphql` op; `surface` matches the actual call site (a
      `talent-profile` op must not be tagged `mobile-gateway`);
      `transport` matches the surface convention (`mobile-gateway` →
      `stock`, `talent-profile` / `scheduler` → `impersonated`).
- [ ] **`capturedAt` is plausible.** ISO 8601, within roughly a day of
      the PR draft time. Stale timestamps (>1 week pre-PR) suggest
      the snapshot was generated against an old session and may not
      reflect current wire state.
- [ ] **Field names sorted alphabetically.** Enforced by
      `captureWireShape`; verify in the diff. Manual ordering breaks
      the determinism contract and causes spurious diffs on
      regeneration.

## Producer-side defaults

The structure-only contract is **enforced by the producer's type
system**, not by post-hoc redaction:

- The `WireShape` discriminated union has **no variant carrying a
  value**. There is no `value: string` field anywhere in the type.
  Leaking values requires either (a) a deliberate type-cast bypass,
  or (b) hand-editing the JSON output.
- Enums collapse to `"string"` because the primitive branch returns
  the tag `"string"` for any `typeof === "string"` input — not because
  of an affirmative redaction step.
- Field names flow through as object keys without filtering or
  hashing.
- Empty arrays produce `{ kind: "unknown" }` rather than guessing
  member shape from external context.

This producer-by-construction approach is the **first line of
defense**. The manual review checklist above is the **second**.

## Cross-references

- [`captureWireShape.ts`](./captureWireShape.ts) — producer ([#276] / WS-1)
- [`assertWireShapeStable.ts`](./assertWireShapeStable.ts) — E2E diff helper ([#283] / WS-2)
- [`docs/snapshot-tests.md`](../../../../docs/snapshot-tests.md) —
  sibling JSON-shape snapshot suite for CLI / MCP envelopes ([#152]);
  different layer, same review-via-diff pattern
- [`packages/e2e/README.md`](../../README.md) — `@ttctl/e2e` overview
  including log-time failure-output redaction (sibling concern)
- [`packages/e2e/src/harness/redaction.ts`](../harness/redaction.ts) —
  log-time redaction for E2E failure output; complements this policy,
  does not replace it
- [`CLAUDE.md` § Schema/contract validation rule](../../../../CLAUDE.md) —
  PR-introduction-time live-E2E gate for inferred wire shapes
- `research/notes/02-auth-and-clients.md` (sibling research repo,
  private, local checkout only) — surface taxonomy
  (`mobile-gateway`, `talent-profile`, `scheduler`); source for the
  `surface` field in the snapshot header
- Per-op routing manifest (lands in [#289]) — declares Track 1 (this
  policy) vs Track 2 (codegen-Zod) disposition per op
- Hybrid runtime-validation ADR (lands in [#280]) — overall design

[#152]: https://github.com/alexey-pelykh/ttctl/issues/152
[#276]: https://github.com/alexey-pelykh/ttctl/issues/276
[#280]: https://github.com/alexey-pelykh/ttctl/issues/280
[#283]: https://github.com/alexey-pelykh/ttctl/issues/283
[#285]: https://github.com/alexey-pelykh/ttctl/issues/285
[#289]: https://github.com/alexey-pelykh/ttctl/issues/289
