# ADR-006 — Hybrid wire validation (wire snapshots + codegen-Zod)

- **Status**: ACCEPTED
- **Date**: 2026-05-14
- **Deciders**: User (arbitrating); council: `typescript-architect`, `software-engineer`, `technical-architect`

## Context

Two wire-shape bugs reached `main` by bypassing TypeScript's type system at
the `callGateway` boundary, where wire responses are coerced with `as T` and
never runtime-checked:

- **#146** — caught at PR time by the `TTCTL_E2E=1` schema/contract rule,
  which fires on _new_ ops with `INFERRED`/`UNVERIFIED` shapes.
- **PR #275** — `TimesheetRecord.duration` declared `number` (seconds);
  wire returns `string` (minutes). An 8-hour day rendered as `0.13h` in
  `ttctl timesheet show`. Pre-existing op, post-merge drift — outside the
  schema/contract rule's coverage class.

A 3-agent council (`typescript-architect`, `software-engineer`,
`technical-architect`) deliberated. Verdict: **DIVERGENT-DEEP**. User
arbitrated.

**Empirical pivot mid-deliberation**: the synthesized schema at
`research/graphql/gateway/schema.graphql` is materially incomplete for the
timesheet domain — `type BillingCycle` has 9 fields, the wire has 13+;
`type TimesheetRecord` does not exist; `BigDecimal` codegens to `unknown`.
**A codegen-Zod path alone would not have caught the duration bug**, because
the offending field is absent from the schema. This priced in schema-repair
work for any codegen-only path and validated the need for a complementary
mechanism that does not depend on schema completeness.

## Decision

Adopt a **hybrid** runtime wire-validation strategy with **per-op routing**:

- **Track 1 — Wire-shape snapshots** for ops whose synthesized schema is
  gappy. Capture structure-only manifests (types + nullability, no values)
  at E2E time; commit per-op snapshot files; assert structural stability on
  every `TTCTL_E2E=1` run. Updates gated by `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`
  (deliberate human-reviewed change, never automatic).
- **Track 2 — Codegen-Zod** for ops whose synthesized schema is complete.
  Generate Zod schemas from `research/graphql/**/schema.graphql`; validate
  at the `callGateway` / `callTalentProfile` boundary; map `ZodError` to a
  domain `WIRE_SHAPE_ERROR` code on the per-service error taxonomy.
- **Routing manifest** (#289 / X-1) records each active op's track
  disposition. New ops pick a track at PR time per the CLAUDE.md
  schema/contract rule corollary (#290 / X-2).
- **Promotion path** — see § Promotion Path below.

The existing `TTCTL_E2E=1` schema/contract rule remains load-bearing and
unchanged; the hybrid extends it for existing-op drift detection.

## Alternatives Considered

| #     | Position                                          | Owner                  | Conf  | Why not                                                                                                                                                                |
| ----- | ------------------------------------------------- | ---------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Status quo (`as T` cast)                          | —                      | —     | Two bugs already past it; structural root cause.                                                                                                                       |
| B     | Codegen-Zod only on hand-rolled ops               | `typescript-architect` | 0.8   | Cannot catch ops absent from the synthesized schema — the very class of bug that prompted this work.                                                                   |
| C     | Codegen-Zod phased, with stronger E2E assertions  | `software-engineer`    | 0.7   | Same schema-completeness gap as B; proposed E2E assertions sketch what Track 1 makes systematic.                                                                       |
| D     | Reject Zod; build `wireDriftDetector` alternative | `technical-architect`  | 0.85  | Position's _spirit_ (drift detection without schema dependency) is absorbed as Track 1; the rejection-of-Zod plank is not — Track 2 keeps Zod for schema-complete ops. |
| **E** | **Hybrid (T1 + T2, per-op routing)**              | **user arbitration**   | **—** | **Chosen — see § Decision.**                                                                                                                                           |

All three council positions converged on: (1) the `as`-cast at
`callGateway` is the structural root cause; (2) `TTCTL_E2E=1`
schema/contract rule remains load-bearing; (3) Zod-at-boundary by design
cannot catch semantic-unit drift, field renames, or business-logic drift
— see § What We're NOT Solving.

Full deliberation: `.tmp/council-runtime-validation-20260514/COUNCIL.md`
(local artifact at scope time; preserved by citation here).

## Consequences

**Positive** — both wire-shape bug classes (#146-class at PR time,
#275-class post-merge) are structurally prevented; schema gaps stop being
load-bearing for safety on gappy domains; snapshot diffs surface in PR
review, making intentional shape changes a deliberate, reviewable act.

**Negative / cost** — two mechanisms instead of one (per-op routing #289
is now a mandatory governance artifact); Track 2 requires up-front
schema-repair work for any op whose synthesized schema is incomplete
(independently valuable, but absorbs time before Track 2 expansion);
snapshot updates require human review, with false-positive churn on
legitimate Toptal-side additions as the steady-state operational cost.

**Neutral** — the deferred TS-fixture migration is superseded by Track 1
(cancellation recorded in #278).

## What We're NOT Solving

Honesty section. The hybrid does **not** detect, by design:

- **Semantic-unit drift** — `duration: 8` meaning seconds vs minutes both
  pass `z.number()` and leave a numeric snapshot unchanged. PR #275's
  actual root cause is _half_ in this class (the other half — `string` vs
  `number` — Track 1 _does_ catch).
- **Server-side persistence drops** — mutation returns `success: true` but
  the field never persisted. Requires round-trip persistence assertions
  (deferred as #M6 in scope brief; not filed).
- **Field renames to unqueried names** — Toptal renames `cycleStatus` →
  `billingCycleStatus`; our query asks for the old name; we silently miss
  the data. Neither snapshots nor Zod see the new name.
- **New sibling fields shifting interpretation** — Toptal adds
  `durationUnit: "seconds"` next to a `duration` already minutes-encoded;
  schema doesn't know, snapshots ignore in non-strict mode.

Mitigation is process-level (manual transcripts per feature PR, deferred as
#M7) or out-of-band wire monitoring (out of scope).

## Promotion Path

An op's disposition is not permanent. Track 1 → Track 2 promotion requires:
(1) the op's synthesized schema in `research/graphql/**/schema.graphql`
repaired to wire-completeness — all fields, correct types, scalars mapped
(`BigDecimal` → `string` per wire empirics, per #279 / Z-1); (2) the
routing entry (#289) updated T1 → T2; (3) the generated Zod schema landed
in `packages/core/src/__generated__/zod-schemas.ts` and wired at the call
site; (4) the wire-snapshot file retired (deletion committed in the same
PR as the Zod wiring). Schema-repair work is tracked as discrete items,
not bundled into the hybrid foundation work.

## Related Work

Walking-skeleton items (run in parallel): **#276** (WS-1 `captureWireShape`
utility), **#277** (Z-0 zod-plugin selection spike), **#278** (I1
fixture-migration cancellation).

Track 1 follow-ons: #283 (WS-2 helper + update gate), #285 (WS-3 apply to
timesheet, bundles #275 regression test #I3 + perf sanity #M5), #287 (WS-4
workflow doc + CLAUDE.md cross-link).

Track 2 follow-ons: #279 (Z-1 `BigDecimal` scalar mapping), #284 (Z-2 plugin
and generated schemas), #286 (Z-3 `callGateway` integration), #288 (Z-4
beachhead op).

Cross-cutting siblings: #289 (X-1 per-op routing manifest), #290 (X-2
CLAUDE.md schema/contract rule corollary), this ADR (#280 X-3).

## References

- Originating fix: [PR #275](https://github.com/alexey-pelykh/ttctl/pull/275)
- Prior bug caught at PR time: [#146](https://github.com/alexey-pelykh/ttctl/issues/146)
- Council deliberation: `.tmp/council-runtime-validation-20260514/COUNCIL.md` (local artifact at scope time)
- Scope brief: `docs/briefs/2026-05-14-scope-runtime-validation-hybrid.md` (local artifact at scope time)
- CLAUDE.md § Schema/contract validation rule — load-bearing at PR time; this ADR adds the existing-op-drift corollary.
