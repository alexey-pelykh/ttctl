# ADR-012 — Engagements surfaced via JobActivityItems (no top-level `viewer.engagements`)

- **Status**: ACCEPTED
- **Date**: 2026-06-14
- **Deciders**: User (arbitrating); #147 engagements-group implementation; Claude Opus 4.8. Documented retroactively per #158.

> **Namespace note**: This is the ttctl-local ADR-012, filed at `hq/engineering/adr/` in this repo. Per the convention established by ADR-007 (ttctl), citing this ADR uses `ADR-012 (ttctl)`. HQ ADRs live in a separate namespace.

## Context

The synthesized SDL (`research/graphql/gateway/schema.graphql`) exposes
`type Viewer implements Node` with `jobActivityItem: TalentJobActivityItem!`
and `jobActivityList: JobActivityList!` — but **no `engagements` field**.
There is no top-level engagement collection on the mobile-gateway surface.

Engagements are not absent from the wire — they are reachable as a
PROJECTION of job-activity rows. In Toptal vocabulary an "Engagement" is an
active (or closed) assignment between a talent and a client (what users
colloquially call their "current job"). Each engagement-bearing
`TalentJobActivityItem` carries an `engagement` sub-object holding the
engagement-specific fields.

This sits in the schema-coverage gap region
(`research/notes/11-uncovered-gaps.md`): the synthesized SDL is best-effort
over the ~370 ops without live captures. The absence of `viewer.engagements`
is the wire truth, not a synthesis artifact — verified live while building
#147.

The #147 engagements command group (`list` / `show` / `stats` / `breaks`)
needed a surfacing strategy. The decision was made inline in the
`engagements/index.ts` module comments; #158 promotes it to a discoverable
ADR so future contributors — and any future re-evaluation if the schema
changes — find it at the catalog level rather than buried in a docstring.

## Decision

Engagement `list` / `show` / `stats` surface through `viewer.jobActivityList`,
filtered by `statusGroupV2.only` to the engagement-bearing status groups:

```ts
// packages/core/src/services/engagements/index.ts
export const ENGAGEMENT_STATUS_GROUPS = ["ACTIVE_ENGAGEMENT", "CLOSED_ENGAGEMENT"] as const;
```

- **`list`** → `JobActivityItems(statusGroupV2: { only: <groups> })`, where
  `<groups>` derives from the `status` flag: `active` → `[ACTIVE_ENGAGEMENT]`,
  `past` → `[CLOSED_ENGAGEMENT]`, `all` → both.
- **`show`** → `JobActivityItem(id)` with an extended engagement projection.
- The activity item's **`engagement` sub-object** carries the
  engagement-specific fields — the projection a hypothetical
  `viewer.engagements` would have returned.

Same surface and transport as the `applications` service: both ride the
`TalentJobActivityItem` join on the plain-HTTPS mobile-gateway
(`https://www.toptal.com/gateway/graphql/talent/graphql` via `stockTransport`
— no Cloudflare, no TLS impersonation). Engagements is the
`ACTIVE/CLOSED_ENGAGEMENT`-filtered READ view of the same activity stream
whose WRITE side ADR-008 (ttctl) governs.

## Alternatives Considered

1. **Synthesize a client-side `viewer.engagements` field** — map job-activity
   rows into a fabricated engagements collection at the TTCtl layer.
   **Rejected**: hides the wire-format truth, adds a translation layer that
   drifts from the API, and misleads contributors into believing a native
   field exists.
2. **Wait for the API to expose `viewer.engagements` natively** —
   **Rejected**: blocks delivery indefinitely on a vendor change TTCtl does
   not control. The job-activity surface is available today and already
   carries the full engagement projection.

## Consequences

- **The public engagement-id is `jobActivityItem.id`, not `engagement.id`.**
  The CLI/MCP surface uses the activity-row id (consistent with the
  `engagements list` output) as the public engagement id. Two ids coexist in
  this domain: `jobActivityItem.id` (the row id) and `engagement.id` (the
  underlying `TalentEngagement`, mutation root for `engagement(id).createBreak`).
- **`breaks.add` pays one extra round-trip.** Because the public id is the
  row id, `breaks.add` first issues a one-shot `EngagementBreaks` query to
  resolve `engagement.id` from `jobActivityItem.id`, then issues
  `CreateEngagementBreak`. `breaks.remove` / `breaks.reschedule` take the
  `engagementBreak.id` directly (no translation needed).
- **`stats` issues 2 parallel `JobActivityItems` calls** — one per
  `ENGAGEMENT_STATUS_GROUPS` entry — because the counts are per status group.
- **The surfacing concern is local to the engagements service.** If a native
  field later appears, only `engagements/index.ts` migrates; the CLI/MCP leaf
  grammar (`list` / `show` / `stats` / `breaks`) is unaffected.

## Revisit Trigger

If a future mobile-gateway version exposes `viewer.engagements` natively (a
typed engagement collection on `Viewer`), this ADR is **superseded**:
migrate the engagements service to the native field, drop the `statusGroupV2`
filtering indirection, and re-evaluate whether the public engagement id should
become `engagement.id`. Until then, the JobActivityItems surfacing is the only
available path.

## References

- #147 — engagements command group (`list` / `show` / `stats` / `breaks`) — the implementing PR.
- #158 — this ADR.
- ADR-008 (ttctl) — Application Funnel Write-Side — the write side of the same `TalentJobActivityItem` surface.
- `packages/core/src/services/engagements/index.ts` — implementation + `ENGAGEMENT_STATUS_GROUPS`.
- `research/notes/11-uncovered-gaps.md` — schema-coverage gap region.
