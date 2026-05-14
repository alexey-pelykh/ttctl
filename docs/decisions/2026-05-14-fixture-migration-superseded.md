# Deferred TS-Fixture Migration — Cancelled (Superseded by Wire Snapshots)

> Issued under #278 (I1, Wave 0 of the hybrid runtime field-level wire-validation
> scope). Superseded by the Track 1 wire-snapshot work: #276 (WS-1, utility),
> #283 (WS-2, helper + update gate), #285 (WS-3, timesheet domain application).

## Status

**Accepted — Cancellation**. 2026-05-14.

The deferred TS-fixture migration (originally surfaced as "Scope B" in an
earlier fixture-migration council, deferred pending the runtime-validation
council's outcome) is cancelled. No alternative implementation is owed.

## Context

A prior council had identified a TS-fixture migration as a candidate for
shoring up the `as`-cast at the `callGateway` boundary in
`packages/core/src/transport.ts`. The proposed mechanism was:

- Capture live wire payloads, redact, and transcribe into TypeScript literal
  fixtures (e.g. `TimesheetDetailWireItem`-shaped objects).
- Apply a `satisfies T` assertion at the fixture source site so structural
  drift would surface as a TypeScript compile error.

The migration was deferred while the runtime-validation council deliberated
on field-level validation options (typescript-architect, software-engineer,
technical-architect; verdict DIVERGENT-DEEP, user-arbitrated). That council
chose the **Hybrid** path: wire-shape snapshots for ops where the synthesized
schema is gappy (Track 1), and codegen-Zod for ops where the synthesized
schema is complete (Track 2).

Council record (local artifact, not committed):
`.tmp/council-runtime-validation-20260514/COUNCIL.md`.
Scope brief (forthcoming, separate PR):
`docs/briefs/2026-05-14-scope-runtime-validation-hybrid.md`.

## Decision

Cancel the deferred TS-fixture migration. The Track 1 wire-snapshot pattern
(#276 → #283 → #285) supersedes it. The fixture-migration backlog item is
removed from consideration; this document is the authoritative cancellation
record alongside issue #278.

## Rationale

Wire snapshots strictly subsume the fixture migration on every dimension that
motivated the original proposal:

| Aspect            | TS fixtures (deferred Scope B)                                                  | Wire snapshots (Track 1)                                                        |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Source of truth   | Captured-and-redacted JSON, transcribed into TS literals (lossy, human-curated) | Captured wire shape, structure-only (mechanical, replay-driven)                 |
| Validation seam   | `satisfies T` at one TS source site                                             | Structural diff in every E2E run (`assertWireShapeStable`)                      |
| Coverage          | One assertion at one type seam                                                  | Continuous: every field, every nullability transition                           |
| Update mechanism  | Manual TS edit (developer-driven)                                               | `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` env-gated regeneration (deliberate, reviewable) |
| Maintenance cost  | TS literals drift silently from wire reality                                    | Snapshot files diff against live wire on every E2E run                          |
| Detection latency | Compile-time once, then static until next manual edit                           | Per-E2E-run; structural drift surfaces immediately                              |

On no dimension does the TS-fixture approach lead. Continuing to pursue both
would duplicate engineering effort and create two competing sources of truth
for the same wire-boundary contract.

## Consequences

**Code**: No changes in this PR. The existing TS interfaces in
`packages/core/src/services/timesheet/index.ts` (notably `TimesheetDetailWireItem`)
remain as the in-process domain types. They are no longer slated for
fixture-backed verification; their structural correctness is delegated to the
upcoming wire-snapshot work (#285 applies Track 1 to the timesheet domain
specifically).

**Process**: The CLAUDE.md schema/contract validation rule (live E2E coverage
for any operation consuming an INFERRED / UNVERIFIED research note) remains
load-bearing and unchanged. Wire snapshots extend that rule by adding
structural drift detection for **existing-op** payloads; the fixture migration
would have addressed the same drift surface less effectively.

**Failure modes not addressed by this cancellation**: The honesty section of
the runtime-validation council record enumerates four classes of bug that
neither Track 1 nor Track 2 catches (semantic-unit drift, server-side
persistence drops, field renames to unqueried names, new sibling fields
shifting interpretation). The cancelled fixture migration would not have
caught any of these either, so this cancellation does not regress coverage.

**Reversibility**: This decision is reversible. If the wire-snapshot work
stalls or proves unworkable, a future PR can either resurrect the fixture
migration or annotate this document with a retraction. No code is being
deleted; nothing has to be undone.

## References

- Issue #278 — authoritative cancellation record (this document's tracker
  counterpart).
- Issue #276 — WS-1: `captureWireShape` utility + snapshot format (walking
  skeleton).
- Issue #283 — WS-2: `assertWireShapeStable` helper + update gate.
- Issue #285 — WS-3: Track 1 application to the timesheet domain (bundles the
  PR #275 regression test).
- PR #275 — originating bug (`TimesheetRecord.duration` wire-shape mismatch
  rendered 8h as 0.13h); the second wire-shape bug to bypass the type system
  after #146.
- Scope brief (forthcoming, separate PR):
  `docs/briefs/2026-05-14-scope-runtime-validation-hybrid.md` (full scope of
  the hybrid runtime field-level wire-validation effort).
- Council record (local artifact, not committed):
  `.tmp/council-runtime-validation-20260514/COUNCIL.md`.
