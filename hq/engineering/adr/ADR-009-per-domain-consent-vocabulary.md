# ADR-009 — Per-Domain Consent Vocabulary for INFERRED-Destructive Mutations

- **Status**: ACCEPTED
- **Date**: 2026-05-22
- **Deciders**: User (arbitrating); `/council` orchestrator (5-agent panel: product-strategist, project-manager, technical-architect, security-architect, entrepreneur); Claude Opus 4.7

> **Namespace note**: This is the ttctl-local ADR-009, filed at `hq/engineering/adr/` in this repo. Per the convention established by ADR-007 (ttctl), citing this ADR uses `ADR-009 (ttctl)`. HQ ADRs live in a separate namespace.

## Context

### What #258 was originally

Issue [#258](https://github.com/alexey-pelykh/ttctl/issues/258) ("defensive consent gate for INFERRED-destructive mutations") proposed a single runtime gate `ensureDestructiveConsent(opName)` plus a uniform CLI flag (`--i-know-this-is-destructive`), MCP `destructive: true` metadata, and env-var `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1`. The motivating concern was `submitForReview` — one INFERRED-destructive mutation whose first invocation is also the validation event.

### Why a single uniform gate is now insufficient

The `/scope` pass on 2026-05-20 (see closed work: [#427-#480](https://github.com/alexey-pelykh/ttctl) range; full record in 45 GitHub issues + ADRs) identified **17 mutations** that the council convened to ship, all currently `blocked-by #258`. Those 17 span four operational domains with distinct threat models:

| Domain                    | Mutations (issue numbers)    | Threat model (single sentence)                                                                           |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Interview action          | #432, #433, #434, #435, #441 | Scheduling commitment + reputational exposure — talent confirms/declines an interview slot or invitation |
| Payment routing           | #449, #450, #451, #453, #454 | Financial-routing change + wire-irreversible external-account binding (Payoneer / Toptal account)        |
| Profile public-disclosure | #462, #463, #465, #467       | Recruiter-visible profile claims + permanent capability record (skill / industry / specialization)       |
| Timesheet billing         | #458, #459                   | Weekly billing-record write + engagement-compliance impact                                               |
| Light-destructive bits    | #444, #475, #476             | Audit-trail acknowledgement bits + preference resets — blast radius approaches zero                      |

Two `/council` panelists (technical-architect, security-architect) independently flagged that reusing ADR-008's `consentIssued: z.literal(true)` rationale across all four domains is a **category error**: ADR-008's rationale is specific to the apply-funnel's legal-compliance signal (Toptal's apply-terms acceptance), not a universal consent semantic. Conflation now creates two future risks:

1. **Wire divergence**: When Toptal's API introduces per-domain consent flags (e.g., a payment-method disclosure boolean distinct from apply-terms acceptance), our uniform `consentIssued` field name can't carry both — the field name re-allocates and breaks every previously-shipped consumer.
2. **Insufficient gate for high-blast domains**: External payment-account creation (#453 Payoneer, #454 Toptal account) is **wire-irreversible** from TTCtl's side. A `z.literal(true)` alone gives no defense against AI-agent misbinding to the wrong account. The gate needs additional factors: an idempotency key (defends against duplicate creation) plus an account-identifier echo (forces the agent to re-state the account identity the user intends).
3. **Ceremony fatigue on light-destructive ops**: Forcing a literal-true ceremony on audit-trail bit-flips (#444, #475, #476) erodes the gate's meaningfulness when it actually matters.

### What this ADR is

A vocabulary lock. It defines per-domain consent field names + supplementary factors at the Zod boundary, BEFORE the first cluster PR consumes #258's gate. It is the prerequisite the council asked for.

### What this ADR is NOT

It is not the implementation of #258. The implementation lives in #258's PR (issue body to be amended post-ADR). This ADR defines the vocabulary; #258 implements it.

## Decision

### Part 1 — Per-domain consent field names (Zod boundary)

The TTCtl-layer consent gate at the Zod boundary uses **per-domain field names** so each domain's consent ceremony is forensically distinct in agent behavior models, tool descriptions, and audit logs:

| Domain                    | TTCtl-layer Zod field                             | TTCtl CLI flag                 | Semantic                                                                                    |
| ------------------------- | ------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| Interview action          | `interviewActionConsentIssued: z.literal(true)`   | `--consent-interview-action`   | "I confirm this scheduling/legal commitment now"                                            |
| Payment routing           | `paymentRoutingConsentIssued: z.literal(true)`    | `--consent-payment-routing`    | "I confirm this financial-routing change" — paired with idempotency + account-echo (Part 2) |
| Profile public-disclosure | `profileCapabilityConsentIssued: z.literal(true)` | `--consent-profile-capability` | "I confirm this recruiter-visible profile change"                                           |
| Timesheet billing         | `timesheetBillingConsentIssued: z.literal(true)`  | `--consent-timesheet-billing`  | "I confirm this billing-record edit"                                                        |
| Light-destructive bits    | (none — DESTRUCTIVE marker + `--dry-run` only)    | (none)                         | Proportional: audit-trail bits and preference resets need no literal-true ceremony          |

The Zod primitive remains `z.literal(true)` across all domains — that part of ADR-008's precedent is preserved. What varies is the **field name**, which is what the agent's behavior model and the audit log key off.

#### Relation to ADR-008's `consentIssued`

ADR-008's `consentIssued: z.literal(true)` is a **wire-level** field (passed through to Toptal's `JobApply` mutation as the legal-compliance signal). It is a passthrough constant, not a TTCtl-layer gate field. ADR-009's tokens are TTCtl-layer gates at the Zod input boundary. The two are orthogonal:

- `consentIssued` (ADR-008): the wire's `Boolean!` field on `JobApply`. Stays as-is.
- `interviewActionConsentIssued` / `paymentRoutingConsentIssued` / etc. (ADR-009): TTCtl-layer Zod gates that the operator opts into. Do not appear on the wire.

If Toptal's API later introduces a wire-level `paymentRoutingConsentIssued: Boolean!` field, that wire field passes through with its own name and is documented per-op in the implementing PR — distinct from the TTCtl-layer gate of the same name (which can be renamed at that time to disambiguate).

### Part 2 — Supplementary factors for wire-irreversible domains

The payment routing domain (specifically #453 CREATE_PAYONEER_PAYMENT_OPTION and #454 CREATE_TOPTAL_PAYMENT_ACCOUNT) creates external account bindings that TTCtl cannot rescind from its side once committed. `z.literal(true)` alone is insufficient. Required additional factors:

```typescript
// Sketch — implementation lives in #258's PR
{
  paymentRoutingConsentIssued: z.literal(true),
  idempotencyKey: z.string().min(16),           // operator-supplied UUID or similar
  accountIdentifierEcho: z.string().min(4),     // operator re-states the account ID/email/handle
}
```

The agent (or operator) must:

1. Set `paymentRoutingConsentIssued: true` (literal gate).
2. Generate an idempotency key for this specific call (collision = the same operation, idempotent).
3. **Echo back** the account identifier the user intends to bind. The implementing service compares the echo to the input account identifier; mismatch raises `ApplicationsError("ACCOUNT_ECHO_MISMATCH", ...)` before any wire call.

CLI surface (per-op):

```sh
ttctl payments options create-payoneer \
  --consent-payment-routing \
  --idempotency-key <uuid> \
  --echo-account <account-id>
```

Other payment-routing mutations (#449, #450, #451) get only `--consent-payment-routing` (no idempotency + echo) because they modify pre-existing routing rather than create new bindings.

### Part 3 — Light-destructive proportionality

The following ops ship with the DESTRUCTIVE marker on their MCP tool description + `--dry-run` support but **no consent-literal field**:

| Op                                  | Why proportional                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #444 MarkJobOfferDisclaimerAsViewed | Audit-trail acknowledgement bit; semantically reversible (next disclaimer view re-flips state)                                                              |
| #475 MarkJobsAsViewed (batch ≤20)   | Talent-visible state only; not recruiter-visible. Anti-automation discipline (≤20 bound) handled separately at the MCP layer (see § What We're NOT Solving) |
| #476 ResetSearchFilters             | User-side preference reset; restored by re-applying filters                                                                                                 |

The DESTRUCTIVE marker remains. The literal-true ceremony does not. Rationale: ceremony fatigue. If every op carries the same literal-true gate, agents and operators learn to mechanically supply it; reserving the ceremony for high-blast domains preserves its meaning.

### Part 4 — Gate utility signature

#258's `ensureDestructiveConsent` utility expands to:

```typescript
// Sketch — actual implementation in #258's PR
type ConsentDomain = "interview-action" | "payment-routing" | "profile-capability" | "timesheet-billing";

function ensureDestructiveConsent(opName: string, domain: ConsentDomain, input: { [key: string]: unknown }): void {
  // Verify the right consent field is set to `true` per domain
  // For "payment-routing", additionally verify idempotencyKey + accountIdentifierEcho if op is a CREATE_*
  // Throw ConsentRequiredError(opName, domain) on mismatch
}
```

One utility; four valid domain values; per-domain conditional checks. Env-var bypass `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` from #258's original proposal is retained for non-interactive CI/test contexts but does NOT bypass the idempotency-key / account-echo requirements for payment-routing CREATEs (those gates protect against bugs in any caller, agent or human).

## Alternatives Considered

| #     | Position                                                                                             | Why not                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Single uniform `consentIssued: z.literal(true)` across all 17 mutations                              | Category error per council (tech + security): conflates four distinct threat models; provides no defense for wire-irreversible payment-account creation |
| B     | Per-op consent tokens (17 distinct field names)                                                      | Too much ceremony; loses the domain-grouping signal; doesn't scale as new ops land                                                                      |
| **C** | **Per-domain tokens (4) + supplementary factors for high-blast + light-destructive proportionality** | **Chosen — see § Decision**                                                                                                                             |
| D     | Defer consent entirely to MCP-layer middleware                                                       | Bypasses CLI surface; breaks composition with ADR-008's Zod-at-boundary discipline; agents see no consent semantic in tool descriptions                 |
| E     | Use ADR-008's `consentIssued` field name for all four domains                                        | Field-name re-allocation risk when Toptal API later introduces a wire-level `consentIssued: Boolean!` outside the apply-funnel; ambiguity in audit logs |

## Consequences

**Positive**:

- Each domain's consent ceremony is forensically distinct in agent behavior models, MCP tool descriptions, CLI `--help` text, and audit logs.
- Payment-routing's wire-irreversibility gets the additional defense it needs (idempotency + account-echo).
- Light-destructive ops avoid ceremony fatigue — the literal-true gate keeps its meaning.
- ADR-008's `consentIssued` (wire-level, apply-funnel-specific) stays orthogonal to ADR-009 tokens (TTCtl-layer, per-domain).
- Future Toptal API additions to wire-level consent flags don't clash with our TTCtl-layer naming.
- The 17 mutations land under a vocabulary that's documented BEFORE the first cluster PR consumes it, avoiding the "undocumented decision that's expensive to reverse" debt the council flagged.

**Negative / cost**:

- More CLI flags + MCP tool fields per mutation vs single uniform `--consent` (offset by per-domain `--help` text that explains the semantic).
- Documentation surface grows; per-domain README sections needed alongside #258's implementation.
- #258's existing issue body amends from "single utility" to "parametrized utility"; one issue-body update.
- Payment-routing CREATE flow has three flags (`--consent-payment-routing`, `--idempotency-key`, `--echo-account`) — three keystrokes vs one. Documented as a feature (wire-irreversibility gate), not friction.

**Neutral**:

- ADR-006 (T1/T2 wire validation) unchanged.
- ADR-007 (pagination flag grammar) unchanged.
- ADR-008 unchanged — its `consentIssued` field is the apply-funnel wire-level passthrough, not a TTCtl-layer gate field.
- DESTRUCTIVE marker on MCP tools unchanged.

## What We're NOT Solving

Honesty section. This ADR does **not**:

- **Implement #258** — that's the implementing PR. This ADR locks the vocabulary; #258 wires the utility, flags, and per-domain Zod schemas.
- **Define per-op consent wording** — that's per-issue in each implementing PR's MCP tool description.
- **Anti-automation enforcement for #475** — the ≤20-id batch bound is README-discipline; the council's security panelist flagged that an agent can loop 50×20 (1000-id mass-view, schema-compliant). This needs an MCP-layer sliding-window rate limit, tracked as a **separate work item** when #475 is picked up. Not in scope here.
- **Reclassify any of the 17 mutations** — domain assignments above match the scope-pass classification. If an op's domain proves wrong at implementation time, that's an amendment, not a re-litigation.
- **Cover #258's original `submitForReview` motivation** — `submitForReview` is the existing INFERRED-destructive mutation and is closest to the **profile-capability** domain (it commits the talent's profile to review queue). It adopts `profileCapabilityConsentIssued: z.literal(true)` per Part 1.
- **Govern wire-level consent flags** — Toptal's own wire-level booleans (e.g., `JobApply.consentIssued: Boolean!`) pass through with their own names and semantics per the implementing op's PR.

## References

- ADR-006 (ttctl): hybrid wire validation (T1 / T2 / NEITHER disposition framework)
- ADR-007 (ttctl): pagination flag grammar
- ADR-008 (ttctl): application funnel write-side — precedent for `z.literal(true)` Zod-boundary gate
- Issue #258: defensive consent gate (this ADR refines #258's design; #258's body amends post-acceptance)
- Schema/contract validation rule: `CLAUDE.md` § Schema/contract validation rule
- Council convened 2026-05-22 (this ADR's authoring trigger): 5-agent panel — product-strategist, project-manager, technical-architect, security-architect, entrepreneur. Tech + security independently flagged ADR-009 as a prerequisite to unblocking 17 mutations under #258.
- Work items implementing this ADR: the 17 mutation issues in the scope-pass — per-domain breakdown in § Context. Per-item AC, T1/T2 disposition, and behavioral scenarios live in those issue bodies; this ADR is the durable vocabulary record.
