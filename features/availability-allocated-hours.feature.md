# Feature: Availability — Allocated Hours

> Locks behavioural semantics for `availability.allocatedHours.{show,set}`
> against `UpdateAllocatedHours` and `GetAvailability` on the
> `mobile-gateway` surface. Specification-by-example coverage of the
> existing implementation in
> [`packages/core/src/services/availability/index.ts`](../packages/core/src/services/availability/index.ts);
> wire format is validated continuously by
> [`packages/e2e/src/23-availability-write.e2e.test.ts`](../packages/e2e/src/23-availability-write.e2e.test.ts)
> against the live mobile-gateway (`TTCTL_E2E=1` gated, per the
> schema/contract validation rule in
> [`CLAUDE.md`](../CLAUDE.md)).

## Scope and vocabulary

**Allocated hours** is a **viewer-scoped** quantity — a single integer
in `[0, 80]` representing how many hours per week the signed-in Toptal
talent is willing to commit across **all** of their active engagements.
The Toptal portal exposes this in the "Availability" tab; the talent
sets one number that the platform uses to bound recruiter matchmaking.

**The `UpdateAllocatedHours` mutation operates on `viewerRole`, NOT on a
specific engagement.** The mutation has no `engagementId` argument and
no per-engagement override exists on the API. The issue's premise that
the op "straddles two domains: engagement-level vs profile-level" is
empirically incorrect — only the viewer-scoped path exists. Per-
engagement availability is expressed instead through engagement
**breaks** (`engagement.createBreak` / `engagements.breaks.*` in
`@ttctl/core`); see the related vocabulary note in
[`services/availability/index.ts`](../packages/core/src/services/availability/index.ts)
module doc.

## Background

```gherkin
Background:
  Given the user is signed in as a Toptal talent
    And the user has a Toptal viewer role on the platform
    And the user's availability snapshot exposes a numeric
        `allocatedHours` field in the range `[0, 80]`
```

## Scenarios

### Scenario: Read the current allocated-hours value

```gherkin
Scenario: View current allocated hours
  When the user runs `ttctl availability allocated-hours show -o json`
  Then the exit code is `0`
   And the JSON payload contains the field `allocatedHours`
   And the value of `allocatedHours` is a non-negative integer
   And the value of `allocatedHours` is less than or equal to `80`
```

Backing implementation: `availability.allocatedHours.show()` —
projection over the `GetAvailability` query's
`viewer.viewerRole.allocatedHours` selection.

### Scenario: Update allocated hours to a new value (round-trip)

```gherkin
Scenario: Update allocated hours and verify persistence
  Given the current allocated-hours value is `H`
  When the user runs `ttctl availability allocated-hours set --hours H -o json`
  Then the exit code is `0`
   And the JSON payload contains `ok: true`
   And the JSON payload contains `operation: "availability.allocated-hours.set"`
   And the JSON payload's `updated.allocatedHours` equals `H`
   And a subsequent `ttctl availability allocated-hours show` reports `allocatedHours == H`
```

Backing implementation: `availability.allocatedHours.set(token, hours)`
calls `UpdateAllocatedHours` with `variables.hours = H`. The mutation
returns `viewerRole.update.viewer.viewerRole.allocatedHours` — the
post-update value — and the service projects it onto
`AllocatedHoursAppliedOutcome.result.allocatedHours`. The write-read
**symmetry property** (i.e., a subsequent `show` reads back the same
value the `set` returned) holds at the wire level: both the mutation's
response payload and the `GetAvailability` query select
`viewer.viewerRole.allocatedHours` from the same canonical source.

### Scenario: Non-integer rejected at the client boundary

```gherkin
Scenario: Reject non-integer allocated hours
  When the user calls `availability.allocatedHours.set(token, 3.5)` in code
  Then the call throws `AvailabilityError`
   And the error `code` equals `"MUTATION_ERROR"`
   And the error message references "hours must be a non-negative integer"
   And no wire request is issued to the mobile-gateway
```

Backing implementation: the client-side validation in
[`allocatedHours.set`](../packages/core/src/services/availability/index.ts)
short-circuits `!Number.isInteger(hours)` and throws BEFORE the
`callGateway` transport invocation. The CLI surface (`--hours <int>`)
parses the value via `Number(...)` and inherits the same validation —
floats are not enabled at the CLI parser layer either.

### Scenario: Negative value rejected at the client boundary

```gherkin
Scenario: Reject negative allocated hours
  When the user calls `availability.allocatedHours.set(token, -5)` in code
  Then the call throws `AvailabilityError`
   And the error `code` equals `"MUTATION_ERROR"`
   And the error message references "non-negative integer"
   And no wire request is issued to the mobile-gateway
```

Backing implementation: the same client-side guard
(`hours < 0`) rejects negative values, short-circuiting before the
`callGateway` invocation.

### Scenario: Dry-run preview emits no wire mutation

```gherkin
Scenario: Dry-run set with a different value leaves the wire untouched
  Given the current allocated-hours value is `B`
   And a chosen dry-run value `V` such that `V != B`
  When the user runs `ttctl --dry-run availability allocated-hours set --hours V -o json`
  Then the exit code is `0`
   And the JSON payload contains `ok: true`
   And the JSON payload contains `dryRun: true`
   And the JSON payload's `preview.operationName` equals `"UpdateAllocatedHours"`
   And the JSON payload's `preview.surface` equals `"mobile-gateway"`
   And the JSON payload's `preview.variables.hours` equals `V`
   And the JSON payload does NOT contain `updated`
   And a subsequent `ttctl availability allocated-hours show` reports `allocatedHours == B`
```

Backing implementation: the `dryRun: true` branch in
[`allocatedHours.set`](../packages/core/src/services/availability/index.ts)
short-circuits BEFORE the transport call, returning a
`{ kind: "preview", preview: ... }` outcome whose `variables.hours`
mirrors the would-be wire payload. The integer-range validation runs
BEFORE the dry-run short-circuit (so invalid input still throws
`AvailabilityError("MUTATION_ERROR")` rather than emitting a preview
that would be rejected at apply time).

### Scenario: Write-read symmetry — `allocatedHours` echoes on `GetAvailability`

```gherkin
Scenario: allocatedHours is selected by GetAvailability and returned by UpdateAllocatedHours
  Given the `GetAvailability` query selects `viewer.viewerRole.allocatedHours`
   And the `UpdateAllocatedHours` mutation's `availabilityData` fragment selects
       `viewer.viewerRole.allocatedHours`
  Then for any successful `UpdateAllocatedHours(hours=H)`:
       a subsequent `GetAvailability` returns `viewer.viewerRole.allocatedHours == H`
   And the structural shape of `GetAvailability` is stable
       (per `assertWireShapeStable("GetAvailability", ...)` snapshot)
   And the structural shape of `UpdateAllocatedHours`'s post-projection result is stable
       (per `assertWireShapeStable("UpdateAllocatedHours", ...)` snapshot)
```

Backing implementation:

- `GET_AVAILABILITY_QUERY` and `UPDATE_ALLOCATED_HOURS_MUTATION` (the
  latter via its `availabilityData` fragment) both select
  `viewer.viewerRole.allocatedHours` from the wire — the same canonical
  source.
- Wire-shape snapshots at
  `packages/e2e/src/wire-snapshots/GetAvailability.snapshot.json` and
  `packages/e2e/src/wire-snapshots/UpdateAllocatedHours.snapshot.json`
  lock the structural shape; drift surfaces as a structured diff per
  the [snapshot README](../packages/e2e/src/wire-snapshots/README.md).
- `scripts/check-write-read-symmetry.ts` (extended in this PR to scan
  `services/availability/`) does NOT produce an automatic pairing
  because the write fn's first non-token parameter is a scalar
  (`hours: number`) rather than a named interface. The script's scope
  is type-level write-input vs read-output field-name comparison;
  scalar-input ops fall outside that scope by design. The wire-level
  symmetry property is asserted via the round-trip E2E in
  `23-availability-write.e2e.test.ts` and the snapshot files above.
