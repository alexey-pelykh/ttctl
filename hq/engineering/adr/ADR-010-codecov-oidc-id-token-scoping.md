# ADR-010 — Codecov OIDC: id-token grant scoped to a dedicated coverage job

- **Status**: ACCEPTED
- **Date**: 2026-06-12
- **Deciders**: Claude (orchestrating); consulted: `cicd-architect`, `security-architect` (parallel, convergent)
- **Related**: #761 (part b), #760, #759, PR #766 (the #760 fix)

> **Namespace note**: This is the ttctl-local ADR-010, filed at `hq/engineering/adr/` in this repo. Per the convention established by ADR-007 (ttctl), citing this ADR uses `ADR-010 (ttctl)`. HQ ADRs live in a separate namespace.

## Context

#761 part (b) replaces the long-lived `CODECOV_TOKEN` upload secret with
GitHub OIDC (`use_oidc: true` on the SHA-pinned codecov-action, CLI pinned
`v11.2.8`). OIDC requires `id-token: write`, which GitHub grants only at
workflow or job level — every step in a granted job can mint tokens
asserting this repo's CI identity (the #759 step-scoping trick cannot be
replicated for OIDC). Fork-context and Dependabot runs are hard-capped to
`id-token: read` regardless of YAML, so the upload must be skipped there
(falsifying #761's "Dependabot would upload via OIDC" premise).

Three scoping shapes were evaluated:

- **A — grant on the 6-leg test matrix job**: simplest diff; hands
  token-minting capability to the full npm supply chain on all 6 legs
  (5 of which never upload) and forces the fork/Dependabot guard into the
  matrix step condition.
- **B — artifact handoff to a minimal upload job**: tightest (privileged
  job runs no npm lifecycle code); costs artifact plumbing, waits on all
  6 legs (latency regression, and any flaky leg kills the coverage signal
  exactly on red PRs), and protects marginal value ≈ nil today — forged
  coverage does not need the token, since in-job code can tamper with the
  coverage files before upload under every option.
- **C — dedicated `coverage` job**: grant confined to one job
  (checkout → setup → build → `test:coverage` → upload) running in
  parallel with the matrix; all 6 matrix legs become byte-identical
  again; Codecov outages surface as a red job named `Coverage` instead
  of a red test leg (post-#760 loud-failure posture preserved via
  `fail_ci_if_error: true` + `ci-gate` wiring with a skipped-tolerant
  check).

## Decision

**Option C.** `id-token: write` lives ONLY on the `coverage` job in
`.github/workflows/ci.yml`, paired with an explicit `contents: read`
(job-level permission blocks replace the inherited set). Workflow-level
permissions stay `contents: read`. The job-level `if:` gate
(`(push && actor != 'dependabot[bot]') || (same-repo PR &&
pull_request.user.login != 'dependabot[bot]')`) exists for clean skips —
GitHub's id-token hard cap is the security boundary, not the gate. On the
PR leg, `pull_request.user.login` is used instead of `github.actor` so a
maintainer re-running a Dependabot PR workflow does not flip the guard
while the run still carries the original context's cap. On the push leg,
the actor guard covers merges performed by Dependabot itself (the
`@dependabot merge` comment command pushes to main as `dependabot[bot]`,
id-token-capped); the coverage canary simply defers to the next
human-attributed push.

## Escalation trigger (pre-committed)

Today the only relying party trusting this repo's CI OIDC identity is
Codecov, so a minted token's value is bounded by "upload coverage as this
repo" — a capability in-job code already has via workspace tampering.
**The day any second system is configured to trust this repo's GitHub
OIDC issuer** (cloud deployment role, npm trusted publishing on this
workflow, anything), this calculus breaks: restructure to shape B
(artifact-handoff upload job with no npm execution under the grant) or
move that trust to a dedicated workflow with `sub`/`job_workflow_ref`
claim constraints. Audience restriction is NOT an in-job control — code
holding the request token mints with any audience it likes.

## Token retirement sequencing

After the first verified green OIDC upload on a `main` push (canary):

1. **Revoke the upload token on the Codecov side first** — deleting the
   GitHub secret does not invalidate the token server-side.
2. Then delete `CODECOV_TOKEN` from repo secrets.

Both steps require explicit maintainer confirmation; neither is performed
autonomously.

## Consequences

- No long-lived upload credential exists anywhere once retirement
  completes (#759's step-scoping → full elimination).
- The ubuntu/node24 build+test work runs twice per CI run (~2 min of
  free public-repo runner time); wall-time neutral or better — the
  coverage job starts at t=0 without the matrix legs' format/lint chain.
- Dependabot/fork PRs lose the (previously token-gated, so already
  absent) coverage upload AND now skip coverage generation entirely;
  their `CI` required check stays green via the skipped-tolerant
  `ci-gate` rule.
