# ADR-008 — Application Funnel Write-Side (relax read-only non-goal; lock answers-file grammar)

- **Status**: ACCEPTED
- **Date**: 2026-05-20
- **Deciders**: User (arbitrating); `/scope` orchestrator (Stage 2 — `/design-solution`); Claude Opus 4.7

> **Namespace note**: This is the ttctl-local ADR-008, filed at `hq/engineering/adr/` in this repo. Per the convention established by ADR-007 (ttctl), citing this ADR uses `ADR-008 (ttctl)`. HQ ADRs live in a separate namespace.

## Context

### The non-goal under review

Two source-file headers in TTCtl currently declare a read-only stance on the application funnel:

- `packages/cli/src/commands/applications/index.ts:47-48` — "Per project non-goals (#15): no apply / withdraw / edit operations are exposed. The CLI is read-only by design."
- `packages/core/src/services/jobs/index.ts:89-94` — "Out of scope for v1: Application funnel (`jobs apply` etc.) — lives in `applications` group (#15) as the funnel-crossing verb."

This stance was authoritative at the time of #15 (the read-only `applications` group), but has been progressively undermined:

1. **PR #411** (commit `704bb4b`, merged 2026-05-19) added IR write surface: `applications confirm` and `applications reject` mutations on `AvailabilityRequest`. These ARE write operations on the application funnel.
2. The captured wire surface includes `JobApply($id, $comment, $matcherQuestionsAnswers, $expertiseQuestionsAnswers, $consentIssued, $requestedHourlyRate, $talentCard)` — the canonical direct-apply mutation — with no TTCtl surface.
3. The core service for `applications.confirm()` already accepts opaque `matcherQuestionsAnswers: unknown[]`, `expertiseQuestionsAnswers: unknown[]`, `pitchInput: Record<string, unknown>` pass-throughs at `packages/core/src/services/applications/index.ts:375-388`, but no CLI/MCP exposure exists — confirmation of IRs with attached questions is currently unreachable through TTCtl.

The read-only stance, as written, is now internally inconsistent.

### The opportunity

Closing the write-side gap completes the funnel parity TTCtl already achieves on the read side (`jobs list/show`, `applications list/show/stats`). Users authenticating with TTCtl can browse, save, and view — but cannot ACT on the opportunities they discover. This is a real workflow blocker for active talent.

### The constraint

`research/notes/04-schema-gaps.md` flags `JobPositionAnswerInput`, `JobExpertiseAnswerInput`, and `PitchInput` as unrecovered schema-gap input types. Without recovery, CLI/MCP must accept opaque JSON payloads; with recovery, they ship typed Zod schemas.

## Decision

### Part 1 — Relax the read-only non-goal

Replace the read-only-by-design stance with a deliberate, ADR-tracked write-side scope:

> TTCtl supports user-initiated write operations on the application funnel:
> Interest Request confirmation (with optional custom-question + pitch
> payloads), Interest Request rejection (with reason from the platform
> catalog), and direct job application via the `JobApply` mutation and
> its pre-apply query suite. Write operations preserve the existing
> safety conventions: DESTRUCTIVE warnings, `--dry-run` support, and
> explicit consent gating for legally-bound actions.

The two source-file comments at `packages/cli/src/commands/applications/index.ts:47-48` and `packages/core/src/services/jobs/index.ts:89-94` are removed and replaced with cross-references to this ADR.

The relaxation is **bounded** — these operations remain explicitly out of scope:

- `JobApplication.withdraw` / `JobApplication.edit` — Toptal may or may not support; deferred to a separate scope.
- **Bulk apply** — single-id verb only (matches the safety boundary established by #411 for IR ops).
- **Interview accept/reject** — separate scope, separate catalog (`InterviewRejectReason`).
- **Cross-account / multi-profile** — TTCtl remains single-account.

### Part 2 — Lock the answers-file grammar

Custom-question answer payloads (matcher and expertise) are supplied via a **JSON file referenced by `--answers-file <path>`**, mirrored at MCP as `matcherAnswers: z.array(z.unknown())` and `expertiseAnswers: z.array(z.unknown())` opaque arrays (Stage 1) → tightened to recovered Zod schemas (Stage 2 after schema recovery completes).

#### Grammar

| Wire idiom          | Wire shape (when recovered)  | CLI flag                                          | MCP key                          | Stage-1 type           | Stage-2 type                       |
| ------------------- | ---------------------------- | ------------------------------------------------- | -------------------------------- | ---------------------- | ---------------------------------- |
| Matcher questions   | `[JobPositionAnswerInput!]`  | `--answers-file <path>` (key: `matcherAnswers`)   | `matcherAnswers`                 | `z.array(z.unknown())` | `z.array(JobPositionAnswerInput)`  |
| Expertise questions | `[JobExpertiseAnswerInput!]` | `--answers-file <path>` (key: `expertiseAnswers`) | `expertiseAnswers`               | `z.array(z.unknown())` | `z.array(JobExpertiseAnswerInput)` |
| Pitch card          | `PitchInput`                 | `--pitch-file <path>`                             | `pitchData`                      | `z.unknown()`          | `PitchInput`                       |
| Consent             | `Boolean!`                   | `--consent` (no value; boolean flag)              | `consentIssued: z.literal(true)` | (final)                | (final)                            |
| Hourly rate         | `BigDecimal!`                | `--rate <decimal>`                                | `requestedHourlyRate: string`    | (final)                | (final)                            |
| Talent message      | `String` (optional)          | `--message <text>`                                | `message: z.string().optional()` | (final)                | (final)                            |

#### JSON file shape

```jsonc
{
  "matcherAnswers": [
    { "questionId": "<id from JobApplicationQuestions>", "answer": "<value>", ... }
  ],
  "expertiseAnswers": [
    { "questionId": "<id>", "answer": "<value>", ... }
  ]
}
```

The pitch file (separately referenced via `--pitch-file`) is a single JSON object matching the `PitchInput` shape (recovered in Stage 2).

#### Stdin escape

`--answers-file -` reads JSON from stdin per commander's standard convention. This is the pipeable path for agent-authored answers.

#### Rationale for JSON file vs repeatable key=value flag

| Option                                  | Pro                                                                      | Con                                                                           | Verdict    |
| --------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------- |
| `--matcher-answer key=value` repeatable | Inline, no file needed                                                   | Unwieldy past ~3 questions; matcher+expertise typically 5-15 per job          | NOT CHOSEN |
| **`--answers-file <path>` JSON-only**   | **Git-trackable, agent-authorable, 1:1 with wire shape, stdin pipeable** | **Requires user (or agent) to author JSON; offset by stdin pipe**             | **CHOSEN** |
| Both                                    | Most flexible                                                            | Higher implementation + test cost; ambiguity over which wins if both supplied | NOT CHOSEN |

The JSON file path also matches the wire shape directly, so post-recovery (Stage 2) the file can be validated against the recovered Zod schemas without translation.

### Part 3 — Schema recovery: spike-first with locked fallback

Allocate a **2-week schema-recovery spike** (Stage-1 first work item) to recover `JobPositionAnswerInput`, `JobExpertiseAnswerInput`, `PitchInput` field shapes via APK decompile per the existing recovery path described in `research/notes/04-schema-gaps.md` § Newly recovered (`PitchInput` is already partially decoded, suggesting feasibility for the other two).

If the 2-week budget is exceeded → fall back to opaque `z.array(z.unknown())` and ship Stage 1. Upgrade to Stage 2 (typed Zod) as a follow-up after recovery completes.

The opaque-pass-through path is NOT a compromise that ships permanently — it is a **bounded fallback** that preserves shipping velocity. Schema recovery becomes a tracked follow-up issue tied to this ADR.

#### Spike outcome (2026-05-21, [#425](https://github.com/alexey-pelykh/ttctl/issues/425))

Spike completed under budget. Recovery summary:

| Input                     | Field-name coverage | Field-type coverage                     | Confidence                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobPositionAnswerInput`  | 2 / 2               | 2 / 2                                   | 🟢 fully recovered (no Optional<T> erasure; explicit constructor validators)                                                                                                                                                                                                     |
| `JobExpertiseAnswerInput` | 3 / 3               | 3 / 3 (2 fields via semantic inference) | 🟡 field names exact; `other` + `subjectId` inner types inferred as nullable `String` from operation-side corroboration (response-side `JobExpertiseQuestionSubject` union shape). Live wire confirmation deferred to [#445](https://github.com/alexey-pelykh/ttctl/issues/445). |
| `PitchInput`              | 8 / 8               | 7 / 8 (`mentorship` deferred)           | 🟢 / 🔴 7 ArrayList fields typed via `[PitchItem*Input!]` element linking; `mentorship` Optional<T> has no constructor binding (mobile client never sets it) — recovery requires web-API capture or live introspection.                                                          |

**Stage-1 → Stage-2 readiness signal**: The recovered Zod schemas now produce concrete `PitchInputSchema()`, `JobExpertiseAnswerInputSchema()`, and `JobPositionAnswerInputSchema()` in `packages/core/src/__generated__/zod-schemas.ts`. The surface-tightening work tracked at [#438](https://github.com/alexey-pelykh/ttctl/issues/438) (W1-2) can now consume those schemas to replace `z.array(z.unknown())` at the CLI / MCP boundary with typed Zod. **Stage 2 is unblocked for the matcher / expertise answer arrays** (`JobPositionAnswerInput`, `JobExpertiseAnswerInput`) and **for `PitchInput` excluding the `mentorship` field**, which remains opaque (`z.unknown().nullable()` at the wire-shape level) until further recovery evidence appears.

**Codegen exclusion list**: The five operations consuming these inputs (`JobApply`, `JobApplyData`, `ConfirmAvailabilityRequest`, `ApplyForJob`, `SetAvailabilityRequests`) remain in `codegen.config.ts` `KNOWN_UNTRUSTED_OPS` even after this recovery. Reason: their selection sets reference unrelated `Unknown` placeholders (`NotificationContext` variants, the missing `Pitch` response type, multiple `JobPositionQuestion` fields) that this spike's scope did not address. The recovery pays down ONE of several preconditions; the exclusion list shrinks monotonically as the broader gaps close. See `research/notes/04-schema-gaps.md` § "Wave-1 spike #425 — application-funnel input recovery" § "Codegen exclusion-list status" for the empirical-probe details (46 unrelated GraphQL validation errors observed when the operations were temporarily removed from the exclusion list).

**Tooling lineage**: The recovery is encoded as a `FIELD_TYPE_REFINEMENTS` table in `research/tools/extract/inputs.py`, with one entry per refined `(type_name, field_name)` pair. Each entry cites its decompile-site evidence plus the operation document that corroborates the wire-level position; the table is the durable home for any future refinements of the same flavor.

### Part 4 — Consent gating: explicit user action, NEVER auto-filled

The wire's `consentIssued: Boolean!` represents the talent's acceptance of Toptal's apply terms (a legal-compliance act issued via the portal's apply screen). Auto-filling this field would expose the user to legal exposure they did not authorize.

Therefore:

- **CLI**: `--consent` is a commander boolean option with NO default. Absence raises `ApplicationsError("CONSENT_REQUIRED", ...)` BEFORE any wire call. Documentation must explain what the flag represents.
- **MCP**: `consentIssued: z.literal(true)` — the tightest type-system constraint Zod supports. The tool description must explain what `consentIssued: true` represents and that auto-filling is forbidden in the agent's behavior model.

This is the same posture #411 took on the `DESTRUCTIVE` IR mutations; the consent gate adds a legal dimension on top of the destructiveness warning.

### Part 5 — Service-module placement: `applications.apply()` (not `jobs.apply()`)

Per the existing pattern where the application funnel's write verbs live on the `applications` domain (`applications.confirm()`, `applications.reject()` from #411), the new `apply` verb belongs alongside them:

- **Core fn**: `applications.apply(token, jobId, input, options)` — symmetric with `applications.confirm()` and `applications.reject()`.
- **CLI verb**: `ttctl jobs apply <job-id>` — keeps the user-facing verb readable ("apply to a job") while the implementation lives on `applications`. CLI handler delegates: `runJobsApply` in `packages/cli/src/commands/jobs/apply.ts` calls into `applications.apply(...)`.
- **MCP tool**: `ttctl_jobs_apply` — same delegation; the tool name carries the user-facing verb.
- **Error class**: `ApplicationsError` (extended with `CONSENT_REQUIRED`, `ALREADY_APPLIED`); NO separate `JobsErrorCode`.

The `JobApply` wire mutation operates on a `Job` id but produces a `JobApplication` entity — its semantic home is the application lifecycle, not the job-discovery surface.

## Alternatives Considered

| #     | Position                                                                      | Why not                                                                                                                                                                |
| ----- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Keep the read-only non-goal                                                   | Internally inconsistent with #411 already shipped; users blocked from completing flows TTCtl half-supports                                                             |
| **B** | **Relax the non-goal with bounded scope + ADR-tracking** (this ADR)           | **Chosen — see § Decision**                                                                                                                                            |
| C     | Relax the non-goal but defer apply-flow to a separate ADR                     | Adds ADR churn without buying clarity; the relaxation and the apply flow are intrinsically linked                                                                      |
| D     | Use `--matcher-answer key=value` repeatable flags instead of `--answers-file` | Unwieldy past ~3 questions; matcher+expertise typically 5-15 per job per research note 03                                                                              |
| E     | Use both `--matcher-answer` AND `--answers-file`                              | Ambiguity if both supplied; higher implementation + test cost; no concrete user demand                                                                                 |
| F     | Ship with opaque pass-through; defer schema recovery indefinitely             | Loses long-term DX value; "temporary" workarounds tend to ossify; the spike-first w/ fallback approach preserves both options                                          |
| G     | Place new apply on `jobs.apply()` service module                              | Splits the funnel's write surface across two modules (`applications.confirm/reject` + `jobs.apply`); confusing for callers and breaks the symmetry established by #411 |
| H     | Auto-fill `consentIssued: true` (assume the user knows what they're doing)    | Legal exposure — same posture #411 explicitly avoided with DESTRUCTIVE warnings                                                                                        |

## Consequences

**Positive**:

- TTCtl completes the application-funnel parity with the portal — users can act on every state transition (browse → save → respond-to-IR OR direct-apply → engage) from the terminal.
- The non-goal text in two source-file headers is replaced with an ADR cross-reference (consistent precedent: #411 references in code comments).
- The `--answers-file` grammar is locked, preventing future bikeshedding when other custom-question-bearing surfaces appear (rate change requests, follow-up forms, etc.) — the same JSON-file pattern extends naturally.
- Spike-first schema recovery preserves both options: ship Stage 1 fast with opaque types, then tighten to typed Zod in Stage 2 without changing the surface contract.
- ADR-tracked relaxation lets future contributors see WHY the non-goal changed (not just THAT it changed) — preserves institutional memory.

**Negative / cost**:

- Two source-file headers must be modified (mechanical; covered by PR series).
- ADR maintenance: one more ADR to keep current as the apply flow evolves. Mitigated by the bounded-scope statement that limits future amendments.
- The Stage-1 → Stage-2 schema-recovery transition introduces a minor breaking change pre-1.0 (the MCP tool's input schema tightens from `z.array(z.unknown())` to typed). Pre-1.0 acceptable per project versioning posture; documented in changelog.
- `--consent` flag adds one keystroke per apply. Documented as a feature (legal-compliance gate), not a friction point.

**Neutral**:

- ADR-006 (hybrid wire validation T1/T2) is unchanged. The 5 new wire ops ship on T1 (snapshots) and promote to T2 (codegen-Zod) after schema recovery + codegen-exclusion-list update.
- ADR-007 (pagination flag grammar) is unchanged. The new flags here are answer-payload flags, not pagination — orthogonal concerns.

## What We're NOT Solving

Honesty section. This ADR does **not**:

- **Implement `JobApplication.withdraw` / `JobApplication.edit`** — separate scope, separate ADR if needed.
- **Implement bulk-apply** — single-id verb only; matches #411's safety boundary.
- **Implement interview accept/reject** — separate scope, separate catalog (`InterviewRejectReason`).
- **Define the apply-flow's CLI envelope shape** — that's governed by HQ ADR-009 (CLI / MCP surface envelope), referenced for consistency.
- **Define rate-limit behavior on `JobApply`** — empirical observation pending; potential `--retry-after` addendum if rate-limiting is observed in production usage.
- **Recover the schema gaps for the three input types** — that's the Stage-1 spike work item, tracked separately. This ADR locks the fallback path, not the recovery method.
- **Re-litigate the surface-honest pagination grammar from ADR-007** — the answer-payload flags here use JSON-file shape (not page/perPage); the two ADRs cover orthogonal concerns.

## References

- Research: `research/notes/03-applications.md` (apply flow + question variable types), `research/notes/04-schema-gaps.md` (input-type recovery work)
- Precedent: ADR-006 (T1/T2 wire validation), ADR-007 (pagination grammar)
- PR #411: IR confirm/reject (commit `704bb4b`)
- Schema/contract validation rule: `CLAUDE.md` § Schema/contract validation rule
- Work items implementing this ADR: the application-funnel-write-side issues on GitHub (labels `wave-0` / `wave-1` / `wave-2`). Per-item requirements, acceptance criteria, and behavioral scenarios live in those issue bodies — this ADR is the durable decision record; the issues are the durable work record.
