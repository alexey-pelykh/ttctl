# ADR-007 — Pagination flag grammar (surface-honest per-wire-idiom)

- **Status**: ACCEPTED
- **Date**: 2026-05-19
- **Deciders**: User (arbitrating); 5-agent council: `technical-architect`, `product-strategist`, `testing-architect`, `brand-strategist`, `ux-architect`

> **Namespace note**: This is the ttctl-local ADR-007, filed at `hq/engineering/adr/` in this repo. The operational HQ repo carries a separate ADR-007 (`safe-mode-interceptor`) in its own namespace. Numbering collision across the two repos is per-namespace accepted convention — each numbering scheme is local, not global. Cite ttctl ADRs as `ADR-NNN (ttctl)`; HQ ADRs as `HQ ADR-NNN`.

## Context

The Toptal wire exposes multiple coexisting pagination idioms across surfaces — there is no single uniform shape. Three findings drove the decision:

1. **Empirical wire enforcement** — PR [#383](https://github.com/alexey-pelykh/ttctl/pull/383) attempted to add `offset` to `Viewer.billingCycles.pagination` (a limit-only field). The wire rejected the request with HTTP 400 across 8 E2E test failures. The wire is not tolerant of additive flags; the per-idiom shape is enforced server-side.
2. **Multiple idioms in active use** — `eligibleJobs` / `jobActivityList` ship offset-list `(page, pageSize)`; `Payments` ships an offset-pagination wrapper `(offsetPagination: {offset, limit})`; `PendingTimesheets` (post-[#374](https://github.com/alexey-pelykh/ttctl/issues/374) re-spike) ships a limit-only wrapper `(pagination: {limit})`; future engagements-payments will ship limit+forward-cursor; future performed-actions will ship bare bidirectional cursor.
3. **Surface-honesty positioning** — ttctl's value proposition is faithful third-client behavior (Sage archetype per `brand-strategist`). A uniform flag layer that translates to/from the wire would (a) silently lie about which arguments the wire accepts, (b) forfeit AI/script callers' ability to map flag names back to wire arguments, (c) introduce a coupling that drifts silently on Toptal wire changes.

A 5-agent council (`technical-architect`, `product-strategist`, `testing-architect`, `brand-strategist`, `ux-architect`) deliberated. Verdict: **CONVERGENT-HIGH-CONFIDENCE 5/5** on surface-honest per-wire-idiom flags.

## Decision

Adopt **surface-honest per-wire-idiom pagination flag grammar**: CLI / MCP flags name what the wire arg names; their types match what the wire arg accepts. The 5-row grammar locked below covers every paginated surface ttctl currently ships and the two known-deferred shapes.

### Grammar

| Wire idiom                   | Wire shape                                        | CLI flags                            | MCP keys                       | Used today by                                  | Reference op                       |
| ---------------------------- | ------------------------------------------------- | ------------------------------------ | ------------------------------ | ---------------------------------------------- | ---------------------------------- |
| Offset-list                  | `(page: Int, pageSize: PageSize)`                 | `--page` / `--per-page`              | `{page, perPage}`              | jobs / applications / engagements              | `eligibleJobs` / `jobActivityList` |
| Offset-pagination wrapper    | `(offsetPagination: {offset: Int!, limit: Int!})` | `--page` / `--per-page` (translated) | `{page, perPage}` (translated) | payments payouts                               | `Payments`                         |
| Limit-only wrapper           | `(pagination: {limit: Int})`                      | `--limit`                            | `{limit}`                      | timesheet pending (post-#374 re-spike)         | `PendingTimesheets`                |
| Limit+forward-cursor wrapper | `(pagination: {limit, after: ID})`                | `--limit` + `--after <id>`           | `{limit, after}`               | _(deferred — see future engagements-payments)_ | `GetEngagementPayments`            |
| Bare bidirectional cursor    | `(before: String, after: String, limit: Int)`     | `--before` / `--after` / `--limit`   | `{before, after, limit}`       | _(deferred — see future performed-actions)_    | `GetPerformedActions`              |

### Translation rule for row 2

The offset-pagination wrapper accepts wire `(offset, limit)` but exposes user-facing `(--page, --per-page)` because:

1. Row 1 already familiarizes users with `(page, perPage)` shape across the most common services.
2. `offset = (page - 1) * perPage` is a deterministic, lossless translation; row 2 services pre-compute it before dispatch.
3. Hand-computing `offset = 60` for "page 3 with 20 per page" is hostile UX for the same domain ergonomics row 1 already established.

Row 2 is the **only** translation; all other rows expose wire arg names verbatim. The per-service CLI / MCP docstring documents the mapping so callers can recover the wire intent.

### Convention scope

This grammar locks **request flag names** and **MCP key names** — not response envelope shapes. Response envelopes (`{items, pageInfo?}` and friends) are governed by HQ ADR-009 (CLI / MCP surface envelope). Request shape and response shape are orthogonal concerns.

## Alternatives Considered

| #     | Position                                                        | Why not                                                                                                                                                                                           |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Status quo + documented exceptions                              | Uniform-as-fiction lies to AI / script callers; per-service docstrings would still need to surface the actual wire arg names to be honest, defeating the uniformity claim.                        |
| **B** | **Surface-honest per-wire-idiom flags**                         | **Chosen — see § Decision.** Council 5/5 CONVERGENT-HIGH-CONFIDENCE.                                                                                                                              |
| C     | Opaque cursor `--cursor <token>` (uniform across all services)  | Forfeits scriptability and wire affordance: callers can no longer compose pages from script-known integers; the cursor is an opaque blob owned by Toptal. Wrong shape for offset-native services. |
| D     | Verb decomposition (`show-all` vs `list`, `dump` vs `paginate`) | Over-vocabularization: each pagination axis would need its own verb, doubling the command tree without buying disambiguation the flag types already provide.                                      |

## Consequences

**Positive**:

- AI / script callers can map flag names back to wire arguments with a 1:1 trace (per-service docstring documents the mapping; row 2 documents the one translation).
- Wire-shape changes show up as flag-shape changes in CLI / MCP, surfacing drift instead of hiding it under a translation layer.
- Future paginated services adopt one of the five rows without re-deriving the grammar.
- The Schema/Contract Rule (CLAUDE.md) coverage class is preserved: a new GraphQL op declares its T1 / T2 disposition per ADR-006 (ttctl); its CLI / MCP surface inherits flag grammar from one of the five rows locked here — two complementary contracts, no overlap.

**Negative / cost**:

- CLI users see flag heterogeneity across services (`--per-page` for offset, `--limit` for limit-only, `--after` for cursor). Per-service `--help` is the canonical recovery surface.
- Adding a new paginated service requires picking a row; the choice is mechanical when the wire shape is known, but new wire shapes outside the five rows require a new ADR (or an extension to this one).
- Row 2's translation is a hidden complexity: the wire takes `offset` but the user types `--page`. Documented at the per-service docstring level and called out here so future maintainers do not re-litigate.

**Neutral**:

- HQ ADR-009 (CLI / MCP surface envelope) is unchanged. That ADR governs response shape (`{items, pageInfo?}`); this one governs request flag grammar. The two are orthogonal.

## What We're NOT Solving

Honesty section. This ADR does **not**:

- **Define auto-paging helpers** — a `--all` flag that auto-fans through pages. Deferred. When added, it lives at the CLI / MCP layer per-service and consumes the row 2 / 3 / 4 / 5 paging args internally; row 1 services continue to expose `--page` / `--per-page` raw.
- **Redefine response envelope shape** — `{items, pageInfo?}` and friends are HQ ADR-009's territory.
- **Modify the Schema/Contract Rule** — CLAUDE.md § _Schema/contract validation rule_ remains load-bearing for any future PR that adds paginated wire ops. The rule + its T1 snapshot sibling (per ADR-006) have together caught three wire-shape bugs: [#146](https://github.com/alexey-pelykh/ttctl/issues/146) at PR time by the rule; [#275](https://github.com/alexey-pelykh/ttctl/pull/275) post-merge as drift (motivating the T1 snapshot path in ADR-006, outside the rule's PR-time coverage class); [#383](https://github.com/alexey-pelykh/ttctl/pull/383) empirically rejected at E2E during a new-op landing. This ADR specifies the flag grammar each new op's CLI / MCP surface must adopt; the Schema/Contract Rule specifies the wire-validation regime each new op must declare. Both contracts apply.

## Related Work

- [#383](https://github.com/alexey-pelykh/ttctl/pull/383) — the broken PR that motivated this ADR (closed as superseded). Empirical proof the wire enforces per-idiom shapes.
- [#374](https://github.com/alexey-pelykh/ttctl/issues/374) — original timesheet pagination issue. To be closed by the re-spike PR using row 3 (limit-only).
- [#369](https://github.com/alexey-pelykh/ttctl/issues/369) — applications pagination. Resolved via [#377](https://github.com/alexey-pelykh/ttctl/pull/377) / [#384](https://github.com/alexey-pelykh/ttctl/pull/384) / [#385](https://github.com/alexey-pelykh/ttctl/pull/385) using row 1.
- [#373](https://github.com/alexey-pelykh/ttctl/issues/373) — payments payouts pagination. The only row-2 service ttctl currently ships.
- [#375](https://github.com/alexey-pelykh/ttctl/issues/375) — engagements pagination. Resolved using row 1.
- [#138](https://github.com/alexey-pelykh/ttctl/issues/138) / [#183](https://github.com/alexey-pelykh/ttctl/issues/183) — original `--page` / `--per-page` convention (row 1 establishment).

## References

- ADR-005 (ttctl) — convention-locking precedent (single bearer-token auth model). Same lock-once-cite-everywhere pattern as this ADR.
- [ADR-006 (ttctl)](ADR-006-hybrid-wire-validation.md) — hybrid wire validation (T1 snapshots + T2 codegen-Zod). Governs the wire-validation regime each new paginated op must declare; this ADR governs the CLI / MCP flag grammar each new op exposes. Orthogonal concerns.
- HQ ADR-009 — CLI / MCP surface envelope (`{items, pageInfo?}` response shape). Orthogonal: response shape is HQ ADR-009; request flag grammar is this ADR.
- HQ ADR-007 — `safe-mode-interceptor`. Separate namespace; numbering collision is per-namespace accepted convention (see preamble § Namespace note).
- CLAUDE.md § _Schema/contract validation rule_ — wire-shape bug lineage informing the rule + T1 snapshot regime: [#146](https://github.com/alexey-pelykh/ttctl/issues/146) caught at PR time by the rule; [#275](https://github.com/alexey-pelykh/ttctl/pull/275) post-merge drift (T1 motivator); [#383](https://github.com/alexey-pelykh/ttctl/pull/383) E2E rejection on new-op landing. This ADR does not modify the rule; it complements it by specifying the flag-grammar contract for the CLI / MCP surfaces the rule covers.
- Originating issue: [#387](https://github.com/alexey-pelykh/ttctl/issues/387).
