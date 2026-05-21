# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`applications confirm`: expose matcher / expertise question
  answers and pitch payloads via `--answers-file` / `--pitch-file`
  flags (#428).** Closes the half of the IR-confirm gap that #423
  shipped service-side. The core's `applications.confirm()` already
  accepted opaque `matcherQuestionsAnswers`, `expertiseQuestionsAnswers`,
  `pitchInput` pass-throughs (verified by the #423 wire-forwarding
  tests); the CLI now reaches them.
  - **CLI surface**: `ttctl applications confirm` gains two new
    optional flags per ADR-008 § Decision Part 2 (locked JSON-only
    grammar): - `--answers-file <path>` — JSON file containing
    `{ matcherAnswers: [...], expertiseAnswers: [...] }`. Question
    identifiers come from `applications show <activityId>` output. - `--pitch-file <path>` — JSON file containing a `PitchInput`
    payload (single JSON object). - Both flags accept `-` to read JSON from stdin per commander
    convention (`cat answers.json | ttctl applications confirm
... --answers-file -`). Only one flag may claim stdin per
    invocation; the second `-` claim surfaces a typed
    `STDIN_DOUBLE_CLAIM` validation error.
  - **Pre-wire validation**: malformed JSON, missing files, wrong
    top-level shapes (e.g. a JSON array where an object is required),
    and `matcherAnswers` / `expertiseAnswers` keys that are not
    arrays all refuse with the `VALIDATION_ERROR` envelope BEFORE
    any wire call is made. The recovery hint cites the parse failure
    line/column; file-not-found errors carry the absolute path so
    shell aliases and `cd` mistakes are obvious.
  - **Backward compat**: existing `--message`, `--rate`, `--kind`
    flags work unchanged when the new flags are absent (#411
    regression guard pinned by new unit tests).
  - **Shared loader**: `packages/cli/src/lib/json-input.ts` factors
    the JSON-file read + parse logic so #430 (`jobs apply`) can
    reuse it without churn. Sibling to `lib/freetext.ts` (same
    diagnostic posture; different grammar: bare path here, `@path`
    prefix there).
  - **Schema/contract rule**: TRIGGERED — extends the active wire
    call. Live E2E coverage is built by #445; this PR ships the
    CLI wiring and unit tests against `applications.confirm` mock
    only.

- **MCP `ttctl_interest_requests_accept`: expose
  `matcherAnswers` / `expertiseAnswers` / `pitchData` answer-payload
  fields (#429)**. Mirrors the CLI half of the application-funnel
  write-side shipped service-side by #423. The opaque
  `applications.ConfirmInput` pass-throughs
  (`matcherQuestionsAnswers` / `expertiseQuestionsAnswers` /
  `pitchInput`) now reach the MCP surface so LLM agents can confirm
  Interest Requests with attached question answers and a pitch.
  - `matcherAnswers: z.array(z.unknown()).optional()` — opaque
    `{ questionId, answer }` array (`JobPositionAnswerInput[]`);
    forwarded as the wire's `matcherQuestionsAnswers` variable.
    Question identifiers discovered via
    `ttctl_applications_show <activityId>`.
  - `expertiseAnswers: z.array(z.unknown()).optional()` — same opaque
    shape (`JobExpertiseAnswerInput[]`); forwarded as the wire's
    `expertiseQuestionsAnswers` variable.
  - `pitchData: z.unknown().optional()` — opaque `PitchInput` object
    (typically `{ message: "..." }`); forwarded as the wire's
    `pitchInput` variable.
  - **Tool description**: extended with an example call showing the
    answers payload structure and a pointer to
    `ttctl_applications_show` for `questionId` discovery.
  - **Backward compat**: existing `id` / `message` / `rate` / `kind`
    fields work unchanged when the new fields are absent (#411
    regression guard pinned by new unit tests).
  - **Schema/contract rule**: TRIGGERED indirectly — extends the active
    `ConfirmAvailabilityRequest` wire call (covered by #445 E2E).
  - **Diagnostic redaction**: the three new field names are owned by
    cross-cutting issue #446 (extends `redactBody` allowlist).

## [v0.1.0-rc.7] - 2026-05-20

### Fixed

- **`profile.employment.add --no-employer`: settle the CREATE-side
  anchor contract; expose `--no-website` / `noWebsite` parameter
  (#484).** Reporter (rc.6 MCP) observed `USER_ERROR: employment add
rejected (employerId): You can't leave this empty` when calling
  `ttctl_profile_employment_add { noEmployer: true, ... }` WITHOUT a
  `website` argument. The error message is misleading — the server's
  Rails `.blank?` validator on `employer_id` fires only because the row
  carries no other anchor signal. Empirical settlement (new E2E
  `45-profile-employment-add.e2e.test.ts` #484 describe, live-passed
  2026-05-20):
  - `noEmployer:true + companyWebsite:"<url>" + noWebsite:false`
    → SUCCESS (the existing #401 path).
  - `noEmployer:true + noWebsite:true + companyWebsite:undefined`
    → SUCCESS (newly settled — `noWebsite:true` alone is sufficient
    anchor; no URL needed).
  - `noEmployer:true + neither anchor` → server rejects with
    `employerId: You can't leave this empty` (the reporter's case;
    now refused client-side before the wire).
  - **CLI surface**: `ttctl profile employment add` gains `--no-website`
    (the explicit no-website signal). Commander's `--website <url>` and
    `--no-website` are mutually exclusive — `options.website` becomes a
    `string | false | undefined` union and `runAdd` discriminates.
    Additionally exposes `--skill-id <id>` (repeatable, optional) so the
    `--no-employer` path can satisfy the live wire's `skills: [≥1
SkillRefInput]` requirement (cascade-of-required-fields per #395).
    Discover skill ids via `ttctl profile skills list`.
  - **MCP surface**: `ttctl_profile_employment_add` gains
    `noWebsite: z.boolean().optional()` and a mutual-exclusion guard
    with `website` (returns `VALIDATION_ERROR` when both are supplied).
    Additionally exposes `skills: z.array(z.object({ id, name? }))` so
    callers can satisfy the live wire's `skills: [≥1 SkillRefInput]`
    requirement on the `noEmployer:true` path (previously the field was
    declared on `@ttctl/core`'s `EmploymentFields` but not surfaced
    through MCP). Discover via `ttctl_profile_skills_list`.
  - **Core validation**: `add()` in
    `packages/core/src/services/profile/employment/index.ts` now
    refuses `noEmployer:true` without a `companyWebsite` URL OR
    `noWebsite:true`, surfacing an actionable `VALIDATION_ERROR` that
    names the missing flag and references the WORM note. Empty-string
    and explicit-null `companyWebsite` are NOT anchors (covered by
    dedicated unit tests).
  - **Schema/contract rule**: TRIGGERED. The new
    `noWebsite:true + companyWebsite:undefined` wire-shape permutation
    was previously untested; settled by the new `#484` E2E describe in
    `45-profile-employment-add.e2e.test.ts` (T1 — `CreateEmployment` is
    in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`; shares the committed
    `CreateEmployment.snapshot.json`). Live transcript:
    `.tmp/484-e2e-noWebsite.log`.
  - **Track 1 vs Track 2**: T1 (unchanged) —
    `CreateEmployment` has no generated operation type. Wire-shape
    snapshot shared across #395 / #401 / #484 (response shape
    invariant; only the request permutations differ).
  - **Documentation**: research note
    `research/notes/15-employment-custom-workplace-worm.md` is a
    sibling-repo artifact and remains accurate for the UPDATE-side
    WORM. The CREATE-side anchor contract documented here will be
    folded into that note in a follow-up research-repo update.

## [v0.1.0-rc.6] - 2026-05-20

### Added

- **`profile.employment.update`: expose `publicationPermit` /
  `showViaToptal` / `toptalRelated` params (Rails `.blank?` gate
  fields) (#402)**. Extends #394's employment.update by exposing 3
  optional boolean params on the MCP tool
  `ttctl_profile_employment_update`. Unblocks updates on rows where
  `publicationPermit` is currently `false` — the server's Rails
  `.blank?` check rejects `false` as "blank", so the read-current+merge
  path would re-send the rejected value without an explicit override.
  Pattern mirrors the `industryIds` exposure from #403 (surface-only;
  the core service's `EmploymentFields` already declared all 3 fields
  and `buildUpdateEmploymentInput`'s `{ ...merged, ...fields }`
  provides override semantics).
  - **New surface — update (override-on-supply)**: MCP
    `ttctl_profile_employment_update` gains `publicationPermit`,
    `showViaToptal`, `toptalRelated` (all `z.boolean().optional()`).
    When supplied, the user value overrides the merged current state;
    when omitted, the rc.4 read-current+merge behavior is preserved
    via the `undefined` guard.
  - **Per-field server semantics** (empirical, captured 2026-05-20):
    - `publicationPermit` — Rails `.blank?`-gated (the originating bug;
      `false` rejected on update).
    - `showViaToptal` — wire-required non-null (freely settable; already
      in `buildUpdateEmploymentInput`'s `merged`).
    - `toptalRelated` — server-determined (live API accepts any input
      without error but returns its own determination — likely keyed on
      whether `employerId` resolves to a Toptal-affiliated engagement).
  - **Tool description**: documents the Rails `.blank?` gate behavior
    and recommends explicit override on rows where the current value is
    `false`. Per-field describe text differentiates the three server
    semantics above.
  - **Schema/contract rule**: NOT triggered — no file under
    `packages/core/src/services/profile/**` changed; only the MCP tool
    surface is modified. The core service's `EmploymentFields`
    interface already declared all 3 fields and the merge/override path
    already existed.
  - **Track 1 vs Track 2**: T1 — `UpdateEmployment` is in
    `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` per
    `docs/wire-validation-routing.md`. The existing T1 snapshot at
    `packages/e2e/src/wire-snapshots/UpdateEmployment.snapshot.json`
    (captured 2026-05-19 in #394) remains valid — this PR alters input
    shape only, not response shape. Live `TTCTL_E2E=1` coverage at
    `packages/e2e/src/52-profile-employment-update-blank-gate-overrides.e2e.test.ts`
    exercises all 3 AC scenarios (publicationPermit:true sentinel + minimal update merge succeeds; explicit `publicationPermit: false`
    on update rejected with `USER_ERROR`; explicit `publicationPermit:
true` override succeeds) plus sibling override-throughput proof for
    `showViaToptal` and `toptalRelated`.

## [v0.1.0-rc.5] - 2026-05-20

### Added

- **`interest_requests` accept/reject MCP+CLI tools wrapping
  `ConfirmAvailabilityRequest` / `RejectAvailabilityRequest` (#411)**.
  Adds the write-side IR triage surface that completes the loop
  opened by #410's read-side `fixedRate` visibility — an MCP host
  can now accept/reject Interest Requests without leaving the host
  UI.
  - **New surfaces** (3 tools each per MCP + CLI): - `ttctl_interest_requests_accept` / `ttctl applications
confirm` → `ConfirmAvailabilityRequest`. Auto-detects
    `AvailabilityRequestKindEnum` from AR metadata `__typename`;
    auto-fills the requested rate from Fixed-kind
    `offeredHourlyRate`. **Destructive on the wire** — confirms
    the AR and creates a `JobApplication`; no undo. - `ttctl_interest_requests_reject` / `ttctl applications reject`
    → `RejectAvailabilityRequest`. `--reason` key drawn from the
    decline-reason inventory. **Destructive — terminal
    `AVAILABILITY_REQUEST_REJECTED` state.** - `ttctl_interest_requests_reject_reasons` / `ttctl applications
reject-reasons` → `AvailabilityRequestRejectReasons` (new
    hand-authored query). Returns the `{fixed, flexible}` decline-
    reason inventory the portal's Decline form uses. Read-only.
  - **Surface naming**: MCP renames `confirm` → `accept` for
    ergonomic alignment with the portal's Respond/Decline buttons;
    the wire-side spelling persists in the service. CLI keeps
    `confirm` (mirrors the wire name).
  - **IR list projection extended**: `ttctl_interest_requests_list`
    now surfaces `availabilityRequestId` so callers chain
    accept/reject without a separate `_show` round-trip.
  - **Schema/contract rule**: TRIGGERED. `ConfirmAvailabilityRequest`
    and `RejectAvailabilityRequest` were already in
    `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`;
    `AvailabilityRequestRejectReasons` and
    `GetAvailabilityRequestKind` are NEW hand-authored ops;
    `AvailabilityRequestKindEnum` values
    (`FIXED` / `FLEXIBLE` / `MARKETPLACE_FLEXIBLE`) are INFERRED
    from synthesized-schema metadata-union variants. E2E coverage at
    `packages/e2e/src/{48-applications-confirm,49-applications-reject,51-applications-reject-reasons}.e2e.test.ts`
    — `48` / `49` ship always-on dry-run + negative paths plus
    gated positive paths via `TTCTL_E2E_ACCEPT_INTEREST_REQUEST` /
    `TTCTL_E2E_REJECT_INTEREST_REQUEST` (positive paths require an
    operator-supplied real pending AR id; destructive on the
    wire); `51` is always-on, read-only.
  - **Track 1 vs Track 2**: T1 for all four ops — none are in the
    codegen-trusted catalog. Wire-shape snapshots commit on first
    live run via `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`.

- **Projections expose recruiter Fixed rate on jobs/applications/IR
  surfaces (#410)**. Surfaces the recruiter-set Fixed rate (e.g.
  `$77/hr Fixed` in the portal UI) on four projections so callers
  can disambiguate it from the existing Marketplace `maxRate`
  ceiling.
  - **Affected projections**: `ttctl_jobs_list` per-row on
    `JobListItem.fixedRate`; `ttctl_jobs_show` on
    `JobDetail.fixedRate`; `ttctl_applications_show` on
    `JobActivityItemDetail.fixedRate`;
    `ttctl_interest_requests_list` on `InterestRequestRow.fixedRate`.
  - **Field shape**: `{ decimal: string, verbose: string } | null`
    (Money type, identical to the existing `requestedHourlyRate`
    pattern). Sourced from
    `viewer.job(id).activityItem.availabilityRequest.metadata.offeredHourlyRate`
    on `AvailabilityRequestFixedMetadata`.
  - **Disambiguation preserved**: `maxRate` (Marketplace ceiling)
    and `fixedRate` (recruiter-pinned) coexist as separate fields.
    CLI tables widen by one column (`max rate` + `fixed rate`);
    pretty renderers emit a separate "Fixed rate" line/section.
  - **Nullability cascade**: every projection short-circuits at
    `activityItem` / `availabilityRequest` / (missing metadata) and
    returns `fixedRate: null`.
  - **Schema/contract rule**: TRIGGERED — modifies four
    hand-authored T1 op selection sets (`JobShow`, `JobsList`,
    `JobActivityItem`, `JobActivityItems`). Live `TTCTL_E2E=1`
    shape assertions added across
    `packages/e2e/src/{24-jobs,15-applications-list,16-applications-show}.e2e.test.ts`.
  - **Track 1 vs Track 2**: T1 for all four ops — no generated
    operation types (codegen-exclusion list). No committed wire
    snapshots existed for any of these ops; live E2E shape
    assertions are the wire-validation surface.

- **`profile.employment.add` + `profile.employment.update`: expose
  the `industryIds` parameter the server already supports (#403)**.
  The core service already accepted `EmploymentFields.industryIds`
  (since #344) and threaded it through `add()` and
  `buildUpdateEmploymentInput`, but neither user-facing surface
  exposed it — so `ttctl profile employment add` produced a confusing
  late wire `USER_ERROR` (`industries: can't be blank`, per the #395
  cascade) and `update` could not attach/replace industries at all.
  - **New surface — add (required)**: CLI `ttctl profile employment
add` gains a repeatable `--industry-id <id>` flag and the MCP
    `ttctl_profile_employment_add` tool gains `industryIds:
string[]`, both **required (≥1)** — mirroring `portfolio add` /
    `ttctl_profile_portfolio_add`. A missing/empty value is now an
    upfront `VALIDATION_ERROR` instead of a confusing server-side
    rejection after the request is sent. Discover catalog ids via
    `ttctl profile industries autocomplete` /
    `ttctl_profile_industries_autocomplete`.
  - **New surface — update (replace-on-supply)**: CLI `ttctl profile
employment update` and the MCP `ttctl_profile_employment_update`
    tool gain the same `--industry-id` / `industryIds` input,
    **optional**; when supplied it **replaces** the entry's entire
    industry set, when omitted the existing set is **preserved** —
    identical semantics to `portfolio update` (replace-on-supply,
    preserve-on-omit). Clearing to an empty set is intentionally not
    offered (the live API's #394 Rails-blank gate rejects empty
    `industryIds` on employment).
  - **No core change**: surface-only — `EmploymentFields.industryIds`,
    the `add()` field spread, and the `buildUpdateEmploymentInput`
    merge/override already existed; this issue only wires the two
    user-facing surfaces to the existing capability.
  - **Schema/contract rule**: NOT triggered — no file under
    `packages/core/src/services/profile/**` changed (the wire shape
    is unchanged; `industryIds` was already sent by core). The
    pre-existing `CreateEmployment` / `UpdateEmployment` T1 wire-shape
    snapshots (per ADR-006) remain authoritative and unchanged. E2E
    coverage extended in
    `packages/e2e/src/45-profile-employment-add.e2e.test.ts` (AC#4a:
    seeded industry round-trips through `show()`) and
    `packages/e2e/src/46-profile-employment-update-merge.e2e.test.ts`
    (AC#4b: supplying `industryIds` replaces the set; AC#4c: omitting
    it preserves the seeded set).

- **`profile.employment.add` — custom (non-catalog) workplace via
  `employerId: null` (#401)**. Adds the Toptal "Add as new: <name>"
  behaviour to `employment.add`. When the new `noEmployer` signal is
  set, `add()` skips employer-autocomplete resolution and sends
  `CreateEmployment` with `employerId: null` + the free-text
  `company` verbatim. There is no `CreateEmployer` mutation in the
  API; this surfaces the existing nullable-`employerId` path.
  - **New surface**: CLI `--no-employer` flag; MCP `noEmployer`
    boolean arg on `ttctl_profile_employment_add`. Mutual-exclusion
    guard rejects `--no-employer` + `--employer-id` as
    `VALIDATION_ERROR`. `noEmployer` is orthogonal to `noWebsite` —
    a custom workplace may still carry a website.
  - **Core**: `EmploymentFields.noEmployer?: boolean` (write-only
    signal, Class B exempt — stripped from the wire payload);
    conditional `resolveEmployerId()` skip (NO autocomplete on the
    custom path, in apply or dry-run); `employerId: null` on the
    wire.
  - **Toptal-side WORM (write-once-read-many) limitation**: rows
    with `employerId: null` CANNOT be updated via
    `UpdateEmployment` — Toptal's Rails apply path treats BOTH
    absence AND explicit `null` as `.blank?` and rejects with
    `USER_ERROR "employmentId update rejected (employerId): You
can't leave this empty"`. No client-side payload can satisfy the
    wire on a null-employerId row. This is a Toptal-side product
    limitation, not a TTCtl bug; documented in the E2E file header,
    `buildUpdateEmploymentInput`'s docblock, and
    `research/notes/15-employment-custom-workplace-worm.md`. E2E
    `#3` scope is `add → show → remove` only.
  - **Sibling fix — `publicationPermit` default `:false → :true`**:
    `CreateEmployment`'s Rails apply path treats Boolean `false` as
    `.blank?` and rejects with `USER_ERROR "publicationPermit: You
can't leave this empty"`. The `add()` static default was carried
    from pre-#395 inference; flipping to `:true` aligns `add()`
    with `buildUpdateEmploymentInput`'s
    `current.publicationPermit ?? true` fallback so add/update
    agree on the no-caller-input semantics.
  - **Schema/contract rule**: TRIGGERED (file path
    `packages/core/src/services/profile/employment/index.ts`).
    `CreateEmployment` was in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`
    and the change relies on an INFERRED contract:
    `employerId: null` accepted on CREATE (documented for Update,
    inferred for Create per maintainer-clarified #401 wire note).
    Live `TTCTL_E2E=1` `45-profile-employment-add.e2e.test.ts`
    `#401` block exercises the `add → show → remove` lifecycle.
    T1 `CreateEmployment.snapshot.json` refreshed to surface
    `employerId: string` + `skills: array<unknown>` — newly-selected
    fields from the #344/#394 `EMPLOYMENT_FRAGMENT` widening
    (incomplete original capture, NOT Toptal-side drift).
  - **Live-wire investigation note**: a 3-run controlled URL-host
    probe established that Toptal may auto-create a new Employer
    (real distinct host like `https://anthropic.com`), link to an
    existing Employer (host matches existing test-account catalog
    entry), or do no catalog interaction (RFC-2606 `.invalid`
    host). The E2E uses `.invalid` for deterministic contract
    assertion.

### Fixed

- **`profile.employment.update` — thread `current.position` through
  the merge enum to satisfy wire-required non-null (#407)**.
  `buildUpdateEmploymentInput` merge enum (sibling to the
  wire-broke meta-class #394 / #392) dropped `position`. Any
  partial update that omitted `position` (e.g. the
  `{industryIds: [X]}`-only replace path from #403 AC#4(b))
  crashed at the wire with `Variable $input ... was provided
invalid value for employment.position (Expected value to not be
null)`.
  - **Fix**: threads `current.position` through the merge.
    `EMPLOYMENT_FRAGMENT` already selected `position` read-side, so
    the value was always available — only the merge enum was the
    gap. JSDoc cardinality of GraphQL-required-non-null fields
    refreshed from "(4)" → "(5)" across
    `DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER`,
    `buildUpdateEmploymentInput`, and `update`. MCP `dryRun: true`
    preview synced to include a `position` placeholder.
  - **Schema/contract rule**: TRIGGERED (file path
    `packages/core/src/services/profile/employment/index.ts`). E2E
    coverage at
    `packages/e2e/src/46-profile-employment-update-merge.e2e.test.ts:250`
    — the partial-update-without-position call site from #403
    AC#4(b).
  - **Track 1 vs Track 2**: T1 — `UpdateEmployment` snapshot
    unchanged (the fix changes wire INPUT values, not the wire
    RESPONSE shape).

- **Wire-broke meta-class #392 (4th sibling) — `profile.skills.add`
  rejected by the live API; input shape was pure invention (#396)**.
  `ttctl_profile_skills_add` / `ttctl profile skills add` sent the
  invented variables `{ input: { name } }`. The live
  `talent_profile/graphql` server rejected every call with
  `name (Field is not defined on AddProfileSkillSetInput),
profileId (Expected value to not be null),
skillSet (Expected value to not be null)`. Unlike the three rc.4
  siblings (#393 / #394 / #395), `skills.add` had **no live capture**
  to guide the shape and the schema was a gap
  (`AddProfileSkillSetInput { _placeholder: String }`), so it was held
  back from rc.4 until the wire shape could be captured (capture-first
  is non-negotiable — re-inventing a second shape is the same
  anti-pattern that produced the bug).
  - **Fix**: live capture committed (both catalog and custom-skill
    variants). The service now sends the real Pattern-2 shape
    `{ input: { profileId, skillSet: { name, rating, experience,
public, [id] } } }` — `profileId` resolved via
    `extractProfileId(token)`, the inner `skillSet.id` an OPTIONAL
    catalog `Skill` id (omit → server creates a custom skill).
  - **API change**: `profile.skills.add(token, name)` →
    `add(token, fields, options?)` returning the discriminated
    `AddSkillOutcome` (`{ kind: "created" } | { kind: "preview" }`),
    mirroring `basic.set` (#393) / `employment.add` (#395). Required
    field `name`; optional `rating` / `experience` / `public` /
    `skillId` with defaults `COMPETENT` / `1` / `false` / (unset) so
    the bare `{ name }` call still succeeds.
  - **New surface**: CLI `add` gains `--rating` / `--experience` /
    `--public` / `--private` / `--skill-id` (and routes the global
    `--dry-run`); the MCP tool gains `rating` / `experience` /
    `public` / `skillId` (optional) and delegates dry-run to the core
    service so the preview is byte-identical to the live wire.
  - **Out of scope**: transparent `name` → catalog `skillId`
    resolution (analogous to `employment.add`'s `--company` →
    `employerId`) is a follow-up; for now callers pass `skillId`
    explicitly (discover via `ttctl profile skills autocomplete`).
  - **Schema/contract rule**: TRIGGERED (file-path:
    `packages/core/src/services/profile/skills/index.ts`). E2E
    coverage at `packages/e2e/src/47-profile-skills-add.e2e.test.ts`
    (`e2e-covers: ADD_PROFILE_SKILL_SET`). T1 wire-shape snapshot
    committed at
    `packages/e2e/src/wire-snapshots/ADD_PROFILE_SKILL_SET.snapshot.json`
    per ADR-006.

### Dependencies

- Bump `undici` 8.2.0 → 8.3.0 (#420), `tsx` 4.21.0 → 4.22.3 (#419),
  `typescript-eslint` 8.59.3 → 8.59.4 (#417), `yaml` 2.8.4 → 2.9.0
  (#416), `eslint` 10.3.0 → 10.4.0 (#415),
  `codecov/codecov-action` 6.0.0 → 6.0.1 (#414),
  `actions/github-script` 8.0.0 → 9.0.0 (#413).

## [v0.1.0-rc.4] - 2026-05-19

### Fixed

- **Wire-broke meta-class #392 — `profile.basic.set` / `profile.employment.add` /
  `profile.employment.update` all rejected by the live API in rc.3**. Three
  MCP write tools that shipped in v0.1.0-rc.3 sent partial input variables
  that the live `talent_profile/graphql` server rejected (GraphQL-required
  non-null fields and Rails `.blank?` USER_ERROR gates). Unit tests with
  mocks could not detect the contract mismatches because mocks accept
  whatever shape the code sends — the cause the project's
  **schema/contract validation rule** is designed to catch. rc.4 ships
  three independent fixes from the #392 decomposition:

- **`profile.basic.set` — read-current+merge to satisfy full-replacement
  contract (#393)**. Live `talent_profile/graphql` treats
  `UpdateBasicInfoInput!` as a full-replacement contract: any required
  non-null field omitted from the input fails with `"Expected value to not
  be null"`, regardless of its current value on the server. Pre-fix,
  `set({bio, headline})` sent only `{profileId, profile: {about?, quote?}}`
  and the live API rejected on **9 required fields** (`fullName`, `legalName`,
  `countryId`, `city`, `placeIdentity`, `citizenshipId`, `languageIds`,
  `phoneNumber`, `softwareSkills`).
  - **Fix**: read current state via `getBasicInfo()` pre-submit, merge
    user-supplied fields over the snapshot, send the full input. The
    extended `getBasicInfo()` projects every server-required scalar /
    collection so the merge has full coverage. `UpdateBasicInfoProfileInput`
    now mirrors the full input contract documented in
    `research/notes/10-mutation-input-patterns.md`.
  - **Dry-run preview** (#52 zero-transport invariant preserved): now shows
    the full merged input — user-supplied fields verbatim, unset scalars
    carry an explicit `<preserved from current profile state>` placeholder,
    collection fields surface as empty arrays. Consumers see exactly which
    keys the live mutation will transmit without firing any transport.
  - **Schema/contract rule**: TRIGGERED (file-path:
    `packages/core/src/services/profile/basic/index.ts`). E2E coverage at
    `packages/e2e/src/44-profile-basic.e2e.test.ts` (`e2e-covers:
UPDATE_BASIC_INFO, GET_BASIC_INFO`). T1 wire-shape snapshot committed at
    `packages/e2e/src/wire-snapshots/UPDATE_BASIC_INFO.snapshot.json` per
    ADR-006.

- **`profile.employment.add` — auto-resolve `employerId` via autocomplete
  (#395)**. Pre-fix, `add({company, role, ...})` passed the free-text
  `company` string to the server's `CreateEmployment` mutation. The server
  requires `employment.employerId` (catalog id, not the company string) and
  rejected the call with `USER_ERROR: employment add rejected (employerId):
You can't leave this empty`.
  - **Fix**: wires the existing `employerAutocomplete()` into `add()` with
    an exact-name (case-insensitive, trimmed) resolution heuristic — 1 match
    → transparent use, 0 matches → nudge to autocomplete discovery, 2+
    exact-name duplicates → disambiguation listing. New `--employer-id` CLI
    flag and `employerId` MCP field bypass autocomplete entirely.
  - **`AddOutcome` discriminated union** (`{kind:"created"}` |
    `{kind:"preview"}`) for cross-service consistency with #393's `SetOutcome`.
  - **Dry-run** fires autocomplete so the preview shows the **resolved**
    `employerId` rather than the raw company string — diverges from
    `basic.set`'s zero-network dry-run by design (documented at the call
    site). The mutation transport is still NEVER fired in `dryRun` mode.
  - **`publicationPermit: true` default** — empirically discovered via live
    capture that the server's Rails `.blank?` semantics treat Boolean `false`
    as blank for the non-null `publicationPermit` field. Other server-
    required fields (`experienceItems`, `skills`, `industryIds`) remain
    caller-supplied; full auto-defaulting is tracked as a follow-up.
  - **Schema/contract rule**: TRIGGERED. T1 wire-shape snapshot committed
    at `packages/e2e/src/wire-snapshots/CreateEmployment.snapshot.json`. New
    E2E at `packages/e2e/src/45-profile-employment-add.e2e.test.ts`
    (`e2e-covers: CreateEmployment, GET_EMPLOYERS_AUTOCOMPLETE`) includes a
    regression guard that hard-fails if the original `employerId`-empty
    `USER_ERROR` ever returns.

- **`profile.employment.update` — full read-current+merge on wire & Rails-
  blank gates (#394)**. Pre-fix, the apply path sent only the user-supplied
  subset (e.g. `{position: "Odoo Expert"}`). The live API rejected the
  variables across **two tiers**: first the GraphQL layer with
  `"Expected value to not be null"` for four required-non-null fields
  (`experienceItems`, `showViaToptal`, `startDate`, `skills`), then a second
  tier of Rails `.blank?` `USER_ERROR` gates that fire **below** the GraphQL
  layer (`company`, `employerId`, `publicationPermit`, `industryIds`, plus
  `skills`-non-empty).
  - **Fix**: read the current row via `show()` and merge **all** wire-required
    fields onto the input. GraphQL non-null (4) + Rails `.blank?` gates
    (`company`, `publicationPermit` — defaults to `true` when current is null)
    - catalog refs (`industryIds` always; `employerId` /
      `primaryGeographyId` / `reportingTo` conditionally on current row).
      User-supplied `fields` override the current-derived defaults.
  - **Fragment + interface extensions**: `EMPLOYMENT_FRAGMENT` now selects
    `employer { id }` and `skills { nodes { id name } }`; `Employment`
    interface gains `employerId: string | null` and `skills: { id; name }[]`;
    `EmploymentFields.skills` type corrected from `string[]` to
    `{ id; name }[]` (matches the wire's `SkillRefInput` shape).
  - **MCP dry-run**: surfaces the new placeholders (`company`,
    `publicationPermit`, `employerId`, `industryIds`) so the preview reflects
    the merged shape. Zero-transport-in-dry-run invariant (#165 / #379)
    preserved.
  - **Schema/contract rule**: TRIGGERED. T1 wire-shape snapshot committed at
    `packages/e2e/src/wire-snapshots/UpdateEmployment.snapshot.json`. New
    E2E at `packages/e2e/src/46-profile-employment-update-merge.e2e.test.ts`
    (`e2e-covers: UpdateEmployment`); does NOT propagate the silent-skip-on-
    USER_ERROR anti-pattern from sibling `43-profile-employment.e2e.test.ts`.

  **Sibling out-of-scope**: `profile.skills.add` (#396) was identified in the
  #392 decomposition as a fourth wire-broke tool but is blocked on live
  capture per the operator's scope clause; it is **not** addressed in rc.4
  and remains tracked under the open #392 meta-issue.

## [v0.1.0-rc.3] - 2026-05-19

### Added

- **`ttctl timesheet pending list [--limit N]` (CLI) and
  `ttctl_timesheet_pending_list` (MCP) — surface-honest viewer-wide
  pending pagination (#374, re-spike of #383)**. Closes the original
  pagination gap on the timesheet domain: pre-#374, the viewer-wide
  `PendingTimesheets` wire op hardcoded `pagination: { limit: 50 }` in
  its captured document, so callers with more than 50 pending cycles
  could not enumerate them all.
  - **Wire**: `PENDING_TIMESHEETS_QUERY` is now parameterised with
    `$limit: Int` and threads through the wire's
    `pagination: { limit: $limit }` input. The wire field is
    `LimitPagination` (no `offset`, no cursor) — empirically confirmed
    by PR #383's HTTP 400 transcript when an offset was supplied.
  - **Core**: `timesheet.ListOptions` gains `limit?: number`; the new
    `DEFAULT_PENDING_LIMIT = 50` export preserves the pre-#374
    hardcoded value when callers omit the option. The `engagement`
    path is untouched — the per-engagement `TIMESHEETS_QUERY` carries
    no pagination input (OUT-OF-SCOPE per #374; tracked separately if
    user demand surfaces).
  - **CLI**: new sub-command tree `ttctl timesheet pending list
[--limit N]`. The pre-existing `ttctl timesheet list
[--engagement <id>]` is unchanged and continues to work in both
    viewer-wide and per-engagement modes (the no-engagement path now
    threads `DEFAULT_PENDING_LIMIT` through the parameterised wire op
    — flag-less callers see no behaviour change).
  - **MCP**: new `ttctl_timesheet_pending_list` tool with the schema
    `{ limit?: number (int, positive), dryRun? }`. The pre-existing
    `ttctl_timesheet_list` tool keeps its pre-#374 shape (no
    pagination args) for backward compatibility; its description
    points agents at `ttctl_timesheet_pending_list` when pagination
    is needed.
  - **Surface-honest divergence from the other four paginated
    services** (jobs / applications / engagements / payments
    payouts): those wires expose offset-style pagination and ttctl
    surfaces `--page` / `--per-page` flags; the
    `PendingTimesheets` wire op accepts only `limit` so this surface
    diverges to `--limit N` (CLI) / `{ limit }` (MCP). Surface-honest
    per ADR-007 (see `hq/engineering/adr/ADR-007-pagination-flag-grammar.md`,
    filed in #387 — companion PR in this batch). CLI flag names
    mirror wire arg names; MCP keys mirror wire arg keys; no
    translation layer.
  - **Supersedes PR #383** (closed as broken). The original
    re-spike attempt added `--page` / `--per-page` and tried to
    translate them into `pagination: { limit, offset }`. The wire
    rejected this with HTTP 400 across 8 E2E tests — the field is
    `LimitPagination`, not `OffsetPagination`. This re-spike adopts
    the surface-honest grammar from ADR-007 row 3 ("limit-only
    wrapper") instead.
  - **Schema/contract rule**: TRIGGERED. The hand-authored
    `PendingTimesheets($limit: Int)` document threads a variable
    through the inferred wire-input shape. E2E coverage in
    `packages/e2e/src/25-timesheet-list.e2e.test.ts` (gated by
    `TTCTL_E2E=1`) asserts the live API accepts the variable with an
    explicit value (`limit: 1`) and with the default
    (`DEFAULT_PENDING_LIMIT = 50`); manual run + transcript REQUIRED
    on the PR thread per the rule. Track 1 (wire-shape snapshot) per
    ADR-006 — the existing
    `packages/e2e/src/wire-snapshots/PendingTimesheets.snapshot.json`
    continues to assert structural drift; the input variable change
    does not perturb the response shape.

- **`employment` / `education` / `certifications` `list` operation surfaced
  on CLI + MCP (#341)**. Closes the Class A surface-coverage gap caught
  by `scripts/check-surface-coverage.ts`: the three sub-domains exported
  `list(token)` from `@ttctl/core` but had registered NEITHER a CLI
  command NOR an MCP tool, so an agent could not enumerate employment /
  education / certification IDs at all from within ttctl. The underlying
  GraphQL queries (`GET_WORK_EXPERIENCE` / `GET_EDUCATION` /
  `GET_CERTIFICATION`) were already firing client-side from the existing
  `_show` paths (which internally list-then-filter); this change exposes
  the unfiltered list at the MCP / CLI boundary without touching any
  wire format.
  - **CLI**: `ttctl profile employment list [-o text|json|table]` (alias
    `experience list`), `ttctl profile education list`, `ttctl profile
certifications list` (alias `certs list`). Empty-list output goes
    through the `emptyStateProse` CTA wrapper (#122). New
    `format{Employment,Education,Certification}List{Text,Table}`
    formatters render one-line-per-row (`text`) or a `cli-table3` table
    with `Highlight` column (`table`).
  - **MCP**: `ttctl_profile_employment_list` / `_education_list` /
    `_certifications_list` registered on the talent-profile surface.
    Each returns the same per-item shape as the corresponding `_show`
    tool (since `_show` filters `_list` client-side). Dry-run path
    previews `GET_WORK_EXPERIENCE` / `GET_EDUCATION` / `GET_CERTIFICATION`
    with `profileId: <DRY_RUN_PROFILE_ID_PLACEHOLDER>` — matches the
    existing `_show` dry-run preview verbatim (same wire call).
  - **Registration test**: `EXPECTED_TOOLS` grows by 3 (102 total profile
    tools, was 99); the per-domain comment table reflects the new counts
    (education 5→6, certifications 5→6, employment 6→7).
  - **Schema/contract rule**: NOT triggered — no new GraphQL operation,
    no `auth.ts` change, no modification to any file under
    `packages/core/src/services/profile/` (the existing `list()` exports
    are reused as-is). E2E coverage is unchanged: `GET_WORK_EXPERIENCE`
    already e2e-covered via `43-profile-employment.e2e.test.ts`;
    `GET_EDUCATION` and `GET_CERTIFICATION` remain in the pre-existing
    UNCOVERED warn-mode set (no delta).
  - **Tests**: new formatter unit tests for all three sub-domains
    (`__tests__/formatters.test.ts`) covering happy path (multi-row)
    - empty list + cli-table3 rendering.

### Fixed

- **`dryRun: true` preview no longer fails MCP output validation on
  write-capable tools (#379)**. MCP SDK ≥1.29
  (`@modelcontextprotocol/sdk` resolves to 1.29.0 via the `^1.28.0`
  catalog range) tightened server-side `validateToolOutput`
  (`mcp.js`): when a tool declares an `outputSchema` and a result omits
  `structuredContent`, the SDK now HARD-THROWS
  `Output validation error: Tool <name> has an output schema but no
structured content was provided` (earlier SDKs skipped validation in
  that case). Every write tool's `dryRun: true` branch returns the
  uniform `{ ok, dryRun, preview }` envelope with NO `structuredContent`
  by design (issue #165) — a shape that does not, and cannot, match the
  success-path `outputSchema` added in #226. The result: every MCP
  client (Claude Desktop / Claude Code) hit the error on every
  `dryRun: true` call against `ttctl_profile_basic_update`,
  `ttctl_profile_employment_add/update`, and the other 8 tools that
  carried an `outputSchema`. Server-side mutation logic was unaffected —
  only the MCP output-validation layer rejected the preview.
  - **Fix**: `outputSchema` removed from all 11 tools that declared one
    (basic_update, basic_photo_upload, resume_upload, education
    add/update/remove, employment add/update/remove, industries
    update/show) — aligning with the tools that never declared one
    (`industries_add`, `skills_add`, …). A single ZodObject
    `outputSchema` cannot describe both the success shape and the
    dry-run envelope, and the SDK silently drops union / `oneOf` output
    schemas (`normalizeObjectSchema` → `undefined`), so the
    success-path schema and the universal dry-run envelope are
    irreconcilable under one declared schema. The `text` content slot
    still carries the JSON payload (LLM clients parse it client-side);
    `@ttctl/core` TypeScript types remain the success-shape contract for
    code-level consumers.
  - **Supersedes the #226 / #342 / #344 `outputSchema` prose in
    this same Unreleased cycle.** Those entries describe declaring /
    extending `profileIndustriesRowOutputSchema` /
    `profileEmploymentRowOutputSchema` and the "top-10 write-capable
    tools carry an `outputSchema`" scope — post-#379 NO tool declares an
    `outputSchema`, `packages/mcp/src/tools/output-schemas.ts` is
    deleted, and the per-item-shape claims there no longer hold. Read
    those bullets as the development history that this entry resolves.
  - **Tests**: the #226 `registration.test.ts` presence-check is
    inverted into a #379 regression guard ("no registered tool declares
    an `outputSchema`"); a new
    `packages/mcp/src/__tests__/dryrun-output-validation.test.ts` drives
    a real `Client`↔`Server` over `InMemoryTransport` so `tools/call`
    round-trips through the SDK's `validateToolOutput` — the layer the
    pre-existing `dryrun-smoke.test.ts` bypasses by calling `handler()`
    directly (the blind spot that let this ship). Empirically confirmed
    RED with an `outputSchema` reintroduced, GREEN without.
  - **Schema/contract rule: NOT triggered** — MCP-layer only (Zod
    `outputSchema` removals + docstrings + tests); no new GraphQL
    operation; no `packages/core/src/auth.ts` or
    `packages/core/src/services/profile/**` change; no inferred wire
    contract. Track 1/2 disposition N/A (no new op).

- **`profile.external.update` mutation response now echoes `twitter`
  (#345)**. Closes a MINOR Class B (write-only-echo) gap surfaced by the
  MCP/CLI surface-shape audit (`docs/briefs/2026-05-17-scope-mcp-cli-surface-shape-audit.md`):
  the `UpdateExternalProfiles` mutation accepts `twitter` on its input
  (`ExternalProfilesUpdate`) but the response selection set previously
  dropped it, so the typed `UpdateExternalProfilesResult.profile` shape
  carried only 5 of the 6 input URL fields. Callers writing a twitter
  URL got back a `notice` but had no way to verify the persisted value
  from the mutation response alone — they had to issue a follow-up
  `profile.external.show()` call (the read-side companion shipped in
  #343). The original source comment at the v0 input declaration
  acknowledged the omission as an oversight ("`twitter`/`behance`/`dribbble`
  are exposed because they are present in the schema") rather than an
  intentional design decision.
  - **Core**: `UPDATE_EXTERNAL_PROFILES_MUTATION` selects `twitter`
    inside the `updateExternalProfiles.profile { … }` block, alongside
    the existing five URL fields. The typed `UpdateExternalProfilesResult.profile`
    interface and the internal `UpdateExternalProfilesPayload.profile`
    interface both grow a `twitter: string | null` slot, and the
    `update()` mapping forwards `payload.profile.twitter ?? null`.
  - **CLI**: `formatUpdatePrettyEntity` renders `twitter` between
    `website` and `behance` — matches the ordering used by `external
show` (#343) for cross-command consistency. The pretty/JSON/YAML
    envelopes now carry twitter on every external-update response.
  - **MCP**: `ttctl_profile_external_update` returns the same enriched
    `UpdateExternalProfilesResult` shape on `jsonResponse` (no MCP-side
    output-schema declaration; the tool returns the typed core result
    verbatim).
  - **Wire validation**: `UpdateExternalProfiles` remains **T1** per
    `docs/wire-validation-routing.md` (schema-gappy: in
    `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`). The selection-set extension
    adds the first wire-shape snapshot for this op
    (`packages/e2e/src/wire-snapshots/UpdateExternalProfiles.snapshot.json`,
    generated on first `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1`
    run per `packages/e2e/src/wire-snapshots/README.md`). A future
    selection-set regression — twitter dropped again — would surface as
    a structural diff against this snapshot. The existing E2E at
    `packages/e2e/src/42-profile-external-show.e2e.test.ts` extends its
    `update → show` round-trip with (a) per-field type-presence assertions
    (`updated.profile[f]` is `string | null` for every URL field
    regardless of which subset the input carried) and (b) the new
    snapshot assertion. The schema/contract rule is TRIGGERED (extending
    response selection of an existing mutation per inferred field
    availability); E2E test is gated by `TTCTL_E2E=1`.
  - Unit tests extended: a new `update` regression test asserts
    `result.profile.twitter` echoes the server-supplied value, plus the
    existing fixtures gain `twitter: null` where missing. The CLI
    `formatUpdatePrettyEntity` test grows a "renders twitter when set"
    case.

- **Default `pretty` output for `basic show` and `portfolio list` now
  surfaces every editable field (#129)**. Closes the audit-confirmed
  HIGH-severity formatter defects from #124: `ttctl profile basic show`
  and `ttctl profile portfolio list` previously hid up to half of the
  fields the user can edit, so a freshly-set `--bio` / `--headline` /
  `--description` / `--accomplishment` was invisible at the default
  output unless the user added `--output=json`.
  - **`formatProfilePretty`** (renamed from `formatProfileText` per the
    #126 slot rename): now renders `bio` (multi-paragraph block,
    paragraph breaks preserved as actual blank lines), `headline`,
    `languages` (comma-separated when ≤3, sub-list when >3), and the
    `photoUrl` (`Profile.photo.large`) — previously dropped per the
    audit. Field ordering: identity (name, email, phone, city) first,
    then user-narrative (headline, bio, languages), then role metadata
    (vertical, specializations, availability, rate, time zone, public
    skills), then server-side metadata (photo URL).
  - **`runProfileBasicShow`** dispatches a second call (the new
    `profile.basic.getBasicInfo()` from #127) against
    `talent_profile/graphql` to fetch the bio/headline/languages
    fields the mobile-gateway `Profile` type does not surface. The two
    payloads merge into a `BasicShowPayload` shape (`{ profile,
basicInfo }`) consumed by the formatter / JSON / YAML branches.
    Auth-revoked / Cloudflare-403 from the secondary call propagate;
    other failures (NETWORK_ERROR, GRAPHQL_ERROR on the secondary
    surface) are non-fatal — the formatter renders `(unset)` for the
    talent-profile fields and a stderr diagnostic surfaces the
    underlying message.
  - **`formatPortfolioPretty`** (renamed from `formatPortfolioText`):
    now renders `description` (multi-paragraph block), `accomplishment`
    (multi-paragraph block, skip-if-null), `coverImage`, and
    `clientOrCompanyName` — previously dropped per the audit. Items
    are rendered as multi-line blocks separated by a blank line; the
    server's order is preserved. `tags` and `media` were flagged by
    the issue body as candidates but are NOT on the wire `PortfolioItem`
    (verified empirically by #127); the formatter does not invent them.
  - **`runProfilePortfolioList`** registers only the `pretty` slot with
    `emitResult`, routing the user-visible `--output=pretty` to the
    curated multi-line layout. The shape dispatcher in `formatResult`
    prefers `table` for list-shape data when both slots are present,
    but `description` and `accomplishment` are paragraph-length —
    a row-based table layout collapses them. `formatPortfolioTable`
    stays exported for direct test use and future override-registry
    dispatch wiring.
  - **Standardised null convention for `pretty`** (per the #124 audit
    § Standardization Recommendation): fields the user CAN set but
    hasn't render as `(unset)`. Empty `bio` carries a CTA-style
    `(unset — set with: ttctl profile basic update --bio "<text>")`
    hint. Skip-if-null is reserved for fields that aren't user-editable
    from the CLI (`phoneNumber` empty, no public skills, …). The
    standard is exposed via the new `packages/cli/src/lib/format-helpers.ts`
    module — `unsetOr(value, fallback?)`, `indentLines(text, indent?)`,
    `renderMultiParagraph(prefix, body, outerIndent?)` — so other
    sub-domains adopt it as their formatters are revisited.
  - **JSON/YAML branches**: multi-paragraph `bio` round-trips correctly.
    JSON renders `\n\n` as a single-level escape; YAML renders as a
    `|` literal block scalar with paragraph breaks visible (no
    double-escape `\\n\\n` artifacts).
  - **Tests**: snapshot tests for `formatProfilePretty` (full-data,
    minimal-data, multi-paragraph bio, language sub-list, viewer-null,
    talent-profile-call-failed branches), `formatPortfolioPretty`
    (full-data, minimal-data, multi-paragraph description+accomplishment,
    server-ordering preservation, singular/plural header,
    no-truncation-for-long-URLs branches), and the new
    `lib/format-helpers.ts` module (`unsetOr` / `indentLines` /
    `renderMultiParagraph`).

### Security

- **Transport pins a no-follow redirect policy and rejects HTTP 3xx as a
  typed `RedirectError` (#268)**. Verification of PR #237's transport
  layer found no explicit redirect posture: `node-wreq` defaults to
  `redirect: "follow"` (up to 20 hops), so a 3xx from a compromised CDN
  edge would be followed. `node-wreq` strips the `authorization` header
  on cross-origin hops, but a followed redirect still carries the request
  body (operation name + variables) to the redirect target — a
  body-exfiltration vector that depended on a transitive library default.
  - **`node-wreq` call sites** (`impersonatedTransport`,
    `impersonatedMultipartTransport`, and the hand-rolled
    `multipartImpersonatedFetch` on the photo-upload path) now pin
    `redirect: "manual"` so a 3xx is returned verbatim instead of
    followed.
  - **`undici` call site** (`stockTransport`) needs no explicit option —
    `undici.request()` on the default dispatcher structurally does not
    follow redirects (redirect following is an opt-in interceptor TTCtl
    never installs). Documented in place so the guarantee is legible.
  - **`executeWithResilience`** and the photo-upload path now reject any
    3xx-with-`Location` response by throwing the new `RedirectError`
    (`code: REDIRECT_REFUSED`, extends `TtctlError`) — GraphQL endpoints
    are not expected to redirect, so a 3xx is an anomaly surfaced for
    operator triage. A 3xx WITHOUT a `Location` header is not a redirect
    and is returned verbatim. The error carries `surface`, `endpoint`,
    `status`, and `location` (a URL, not a credential — safe to surface).
  - Audit also confirmed CLEAN on the other two PR #237 spot-checks:
    error objects (`Cf403Error`, `TransportError`) carry no response
    headers, and `transport.ts` holds no module-level per-request state.

### Changed

- **Envelope ABI lock — v0.4 wire contract for write/error/list output
  (#128)**. Locks the public-API contract for machine-readable output
  via discriminated-union envelopes carrying an explicit `version: "1.0"`
  field. Wave 3 of the output-format reframe epic (#121); composes on
  top of the #126 `--output={pretty,json,yaml}` flag reframe. The new
  wire shapes are emitted by every CLI verb that writes (`add` / `update` /
  `remove`) or fails, and by every `list` verb's top-level wrapper:
  - **Write-success envelope**:
    `{ok: true, version: "1.0", operation: "profile.X.add|update|remove", created|updated|removed: <entity>, notice?, changes?: [...]}`
    — `created` / `updated` / `removed` is the verb-discriminated entity
    slot; `notice` carries the server-side advisory (e.g. visibility
    suppressed); `changes` is reserved for future per-field diffs (the
    field is optional in v0.4 and the CLI does NOT populate it pending
    a deep-comparison helper out of scope for this wave).
  - **Error envelope**: `{ok: false, version: "1.0", operation,
errors: [{code, field?, message, hint?, documentationUrl?}]}` —
    always a plural `errors[]` array (single-error responses are still
    a one-element list, future-proofing for multi-error validation
    surfaces). Wraps every `TtctlError`, every domain `*Error` subclass
    (`ProfileError`, `ResumeError`, etc.), every CLI input-validation
    failure (`VALIDATION_ERROR`), and every uncaught path
    (`INTERNAL_ERROR`).
  - **List shape envelope**: top-level list payload changes from a raw
    array `[...]` to `{version: "1.0", items: [...], pageInfo?}` —
    applied to every `list` verb (`profile skills list`,
    `profile education list`, `profile employment list`,
    `profile portfolio list`, `profile certifications list`,
    `profile visas list`, `profile reviews list`). The `version` field
    is the same `"1.0"` literal as the success / error envelopes (so
    consumers can branch on a single discriminator across all envelope
    shapes). The `pageInfo` slot is reserved for future cursor
    pagination (#TBD) and is omitted for now. The `#122` empty-state
    detector (`isEmptyCollection`) continues to recognise both the
    raw `[]` shape (legacy) and the `{items: []}` shape (post-#128).
  - **Pretty rendering**: write-success now emits a single
    `✓ Added: <summary>` / `✓ Updated: <summary>` / `✓ Removed: <summary>`
    header line, optionally followed by a 2-space-indented entity
    preview body (`bio: …`, `linkedin: …`, etc.) and one final indented
    `notice` line when the server returned one. Pretty errors keep the
    pre-existing `Error: …` 3-block layout from #77 for the
    user-facing surface (no UX regression) and route domain-error
    messages through the same envelope-shaped JSON/YAML on the wire.
  - **Routing rules**: `json` / `yaml` modes write the full envelope to
    **stdout** for both success AND error paths (so JSON consumers can
    `jq` over an error in the same pipe shape they use for success).
    `pretty` mode writes success to stdout, errors to **stderr** with
    a one-line summary printed first, and the indented detail block
    after. All error paths exit non-zero (`exitCode: 1` for domain /
    validation failures; `exitCode: 2` for `CF_403_*` Cloudflare
    walkthrough errors, preserving the #77 contract).
  - **`@ttctl/cli` envelope helpers**: new `lib/envelopes.ts` module
    (`emitAddSuccess`, `emitUpdateSuccess`, `emitRemoveSuccess`,
    `emitErrorAndExit`, `wrapListEnvelope`, plus the corresponding
    `buildXxxEnvelope` and `formatXxxJson/Yaml/Pretty` pure builders).
    Every action handler in `packages/cli/src/commands/profile/**` is
    wired through these helpers — ad-hoc `process.stdout.write` /
    `process.stderr.write` / `process.exit` paths for verb output are
    eliminated.
  - **Polymorphic mutation results (visas, portfolio)**: the underlying
    core APIs return `T[]` not a single entity; v0.4 emits
    `created`/`updated`/`removed: <list>` for these sub-domains as a
    pragmatic shape (machine consumers can read the list directly,
    pretty mode renders the verb header + count). Strict per-domain
    narrowing to a single entity slot is deferred — tracked as
    follow-up work for v0.5.

- **Output flag reframe: `--output={pretty,json,yaml}` (#126)**. The
  cross-CLI `--output` enum collapses to three user-visible names —
  `pretty`, `json`, `yaml`. The pre-#126 `text` and `table` names are
  removed (no backward-compat aliases — pre-launch is free moves). The
  user-visible default is `pretty` for ALL `show` and `list` verbs across
  ALL packages — fixing the prior incoherence where `auth status` /
  `auth signin` / `auth signout` defaulted to `table` while every
  `profile *` leaf defaulted to `text`.
  - **Internal `pretty` dispatcher**: `pretty` is the only user-visible
    name for the human layout. `formatResult` dispatches on data shape:
    list-shape data (array, `{items: [...]}`) prefers the caller's
    `table` formatter (column-aligned `cli-table3` rendering for list
    verbs); show-shape data prefers the caller's `pretty` formatter
    (curated key:value rendering for show verbs); both fall back to the
    other when one is missing, with a final `JSON.stringify(_, null, 2)`
    fallthrough plus a stderr hint.
  - **Boolean shortcuts**: `--json` and `--yaml` are global boolean
    flags equivalent to `--output=json` / `--output=yaml`. `-o` short
    alias from #83 continues to work after the rename.
  - **Mutual exclusion**: any two of `{--output, -o, --json, --yaml}`
    present together raise a parse-time error
    (`Conflicting output flags: ... and ...`) before the sub-command's
    action runs. Implemented in the root program's `preAction` hook via
    Commander's `getOptionValueSource("output")` — the default value
    does NOT count as "user-passed".
  - **Slot rename**: `OutputFormatters#text` is renamed to
    `OutputFormatters#pretty` across all 14 sub-command formatter
    registrations and tests. The `table` slot stays — internal-only
    after #126; the dispatcher prefers it for list-shape data.
  - **`--output=text` / `--output=table` rejection**: Commander rejects
    the dropped names with its standard
    `error: option '-o, --output <format>' argument 'text' is invalid.
Allowed choices are pretty, json, yaml.` line.
  - **Behavior parity**: previous `--output=text` use cases route
    through `pretty` (identical rendering until the D3 formatter
    rewrites land in #129). Previous `--output=table` use cases route
    through `pretty` for list verbs (identical rendering — the
    dispatcher picks the table formatter via shape detection).
  - **Per-command override registry**: the `format-overrides.ts`
    registry from #124 stays in place for D5 to wire into the `pretty`
    dispatcher's multi-line strategy lookup.

- **Read-side GraphQL query coverage for the `basic` sub-domain (#127)**.
  Closes the audit-confirmed query-root-cause gap from #124 — the
  mobile-gateway `Profile` type does not expose the user-edited
  narrative fields (`about`, `quote`, `languages`), so the existing
  `profile.basic.show()` call against `mobile-gateway` cannot surface
  them no matter how the formatter is rewritten. Adds a new
  `profile.basic.getBasicInfo(token)` core function that issues a
  `GET_BASIC_INFO` query against `talent_profile/graphql` (Cloudflare-
  protected, via `impersonatedTransport` + Chrome TLS impersonation,
  same surface as `set` and `photoShow`) and returns a typed
  `BasicInfo` projection with `bio` (→ `Profile.about`), `headline` (→
  `Profile.quote`), and `languages` (`{ id, name }[]`). The function
  is independent of `show()` so internal callers that only need the
  `profileId` (e.g. `set`, `photoShow`, sibling sub-domains'
  `resolveProfileId` helpers) keep using the cheap mobile-gateway-only
  `show()` path; only the CLI / MCP `basic show` surface (post-#129
  formatter rewrite) pays the cost of the second talent-profile
  call. Selection set is a deliberate subset of the bundle-extracted
  `GET_BASIC_INFO` operation — `legalName`, `placeIdentity`,
  `country`, `citizenship`, `softwareSkills`, the social URLs, and
  `ProfileRecommendations` are out of scope (audit-confirmed not in
  the user-set-and-dropped defect class; social URLs already covered
  by `external`). Audit-confirmed empirical follow-ups: `tags` /
  `media` are NOT on the wire `PortfolioItem` (verified — neither
  the gateway nor talent_profile schemas declare them); the
  `SectionReview` / `SectionReviewItem` fragments expose only
  structural fields (`id`, `items`, `requestedAt`, `section`,
  `itemId`) — no reviewer-comment / rejection-reason long-form
  fields exist on the wire. Both findings recorded for the #129
  formatter rewrite (which now knows not to expect those fields).
  Formatter consumption of the new `bio` / `headline` / `languages`
  data is tracked separately as #129 (Wave 2 sibling).

### Removed

- **`--output=text` and `--output=table` user-visible names (#126)**.
  Both collapse into `--output=pretty` with internal shape dispatch (see
  the `### Changed` entry above). The `text` and `table` names are not
  accepted at the CLI surface — Commander rejects them with the
  invalid-choice error.

### Added

- **More fields visible in `employment show` / `list` (#344)**.
  Remediates a Class B write/read-asymmetry gap surfaced by the
  post-#340/#341 surface-shape audit
  (`docs/briefs/2026-05-17-scope-mcp-cli-surface-shape-audit.md`):
  `EmploymentFields` (write input) accepted `publicationPermit`,
  `industryIds`, `primaryGeographyId`, and `reportingTo`, but the
  `Employment` read shape dropped them — an agent could set them but
  never verify or display them afterwards. After this change a write
  is verifiable on read (write `publicationPermit: false`, read it
  back; write `industryIds: ["X"]`, read `industries: [{ id: "X" }]`).
  The static `check-write-read-symmetry` gate still reports a
  WARN-level name-asymmetry for `industryIds` / `primaryGeographyId`
  (its name-match cannot pair the scalar write-input names with the
  wire-faithful nested read names) — identical to the pre-existing,
  un-exempted `PortfolioItemInput.industryIds ↔ PortfolioItem`
  warning, and benign for the same reason (the semantic round-trip
  holds; only the field _names_ differ, by wire reality).
  - **`@ttctl/core`**: the `Employment` interface and the
    `EMPLOYMENT_FRAGMENT` selection set gain `publicationPermit`
    (`boolean | null`), `reportingTo` (`string | null`), `industries`
    (`{ id, name }[]`), and `primaryGeography`
    (`{ id, code, name } | null`). The READ wire shape is NOT the
    scalar shape of the write input — `industryIds` / `primaryGeographyId`
    surface on the wire as the nested `industries { nodes { id name } }`
    connection and the `primaryGeography { id code name }` object — so a
    new `mapEmploymentNode` projection (mirroring the established
    `mapPortfolioNode`, per the issue's "mirror the #127 / portfolio
    approach" instruction) maps the raw nodes in `list` / `add` /
    `update`. Round-trip verification still holds: write
    `publicationPermit: false`, read it back on the mapped row.
  - **CLI**: `ttctl profile employment show` (pretty + table) now
    renders `reports to`, `industries`, `geography`, and `public`
    (the publication-permit flag).
  - **MCP**: `profileEmploymentRowOutputSchema` (the `employment_add` /
    `employment_update` `outputSchema`) extended to match — kept in
    lock-step with the `Employment` interface so the declared schema
    does not under-report the returned row. `employment_show` remains
    `outputSchema`-less per #226 scope (top-10 write-capable tools
    only).
  - **Schema/contract rule: TRIGGERED.** The hand-authored
    `EMPLOYMENT_FRAGMENT` selection set is extended with fields whose
    READ wire shape was INFERRED from
    `research/graphql/talent_profile/fragments/Employment.graphql`.
    Ships `packages/e2e/src/42-profile-employment.e2e.test.ts` (gated
    by `TTCTL_E2E=1`): a sentinel round-trip
    (`add → update → show → remove`) that asserts the parity fields
    echo, plus a **T1** `assertWireShapeStable` snapshot on
    `GET_WORK_EXPERIENCE` (`docs/wire-validation-routing.md:123` — the
    op is codegen-excluded / SDL-gappy, so T1 is the derived track).

- **`profile industries show <id>` — CLI + MCP (#342)**. Closes a
  Class A surface-shape gap surfaced by the post-#340/#341 audit
  (`docs/briefs/2026-05-17-scope-mcp-cli-surface-shape-audit.md`): the
  service layer exported `profile.industries.show(token, id)` but
  neither surface exposed it (industries shipped with
  `add`/`update`/`remove`/`list`/`autocomplete` in #74 — the inverse of
  the #341 read-parity gap). The CLI/MCP parity contract test (#151)
  did not catch it because both surfaces omitted symmetrically.
  - **CLI**: `ttctl profile industries show <id> [-o pretty|json|yaml]`
    registered in `packages/cli/src/commands/profile/industries/index.ts`,
    mirroring the per-id `show` of every other sub-domain.
  - **MCP**: `ttctl_profile_industries_show` registered in
    `packages/mcp/src/tools/profile/industries.ts` with a `dryRun`
    path and an `outputSchema` mirroring the `list` per-item
    `IndustryProfile` shape (`profileIndustriesRowOutputSchema`).
  - No new service code: `show()` already existed
    (`packages/core/src/services/profile/industries/index.ts:226`,
    resolving the row via the schema's `node()` resolver — a true
    per-id lookup, distinct from the list-and-filter `show` of
    certifications/education/employment). The schema/contract rule is
    **NOT triggered** — this re-exposes an already-shipped
    `GetIndustryProfile` query; no GraphQL inference, no schema
    gap-filling.
  - Tests: service-layer happy-path + not-found already covered
    (`industries/__tests__/index.test.ts`); surface registration tests
    extended (`wave3-tree`, MCP `registration`/`tools`/`dryrun-smoke`).

- **`ttctl profile external show` — read side of the stored external
  URL state (#343)**. Closes a Class A surface-shape gap from the
  MCP/CLI surface-shape audit (`docs/briefs/2026-05-17-scope-mcp-cli-surface-shape-audit.md`):
  the `profile.external` sub-domain shipped six service functions but
  **none** was a primary read for the stored linkedin / github /
  website / twitter / behance / dribbble URLs. Before this leaf the
  only ways to inspect current values were a no-op `update`
  (write-disguised-as-read) or `advanced-wizard show` (which trims URLs
  from its selection set).
  - **Core**: `profile.external.show(token)` backed by a new
    hand-authored `getExternalProfiles` query against
    `talent_profile/graphql` — selects `id`, `updatedByTalentAt`, and
    all six URL fields directly off the `Profile` type (same access
    pattern `GET_BASIC_INFO` uses). Returns the full six-field shape
    including `twitter` (the `update` mutation's response drops it — a
    separate companion gap; `show` has full parity with what `update`
    accepts). Every URL is `string | null`.
  - **CLI**: `ttctl profile external show [-o pretty|json|yaml]`,
    plus `table` via the formatter hook. Pretty/table render the six
    URLs (unset → `(unset)`) and the last talent-side edit timestamp.
  - **MCP**: `ttctl_profile_external_show` (read counterpart of
    `ttctl_profile_external_update`; agents should use this instead of
    a no-op update to inspect URL state).
  - **Wire validation**: `getExternalProfiles` is schema-gappy (every
    selected field typed `Unknown` in the synthesized SDL), so it is
    added to `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` in `codegen.config.ts`
    and the wire-validation routing manifest — **T1** (wire-shape
    snapshot) disposition per ADR-006. Live E2E coverage ships in
    `packages/e2e/src/42-profile-external-show.e2e.test.ts` (gated by
    `TTCTL_E2E=1`) per the Schema/contract validation rule, including
    a non-destructive `update → show` round-trip (re-applies a current
    URL's exact value — an idempotent no-op write).

- **Release-rollback runbook (#220, reworked for #267)**. Closes
  audit-confirmed CRIT-005 (release/REL-001) from
  `docs/briefs/2026-05-13-audit-everything.md`. Ships
  `docs/operations/release-rollback.md` covering the rollback decision
  tree (deprecate vs unpublish vs roll-forward), the manual
  `npm deprecate` procedure for all four published packages
  (`ttctl`, `@ttctl/core`, `@ttctl/cli`, `@ttctl/mcp`), the
  MCP-registry and Smithery re-submission sequence,
  consumer-communication templates (deprecation message ≤120 chars,
  GitHub Release banner, security advisory, CHANGELOG entry), and a
  post-rollback verification checklist. Cross-referenced from
  `CONTRIBUTING.md` § Release operations. The end-to-end dry-run on
  `v0.1.0-rc.1` (issue item 3) is **deferred** pending #211 (rc.1 cut)
  — see runbook § Dry-run rehearsal.

  An automated `.github/workflows/deprecate-release.yml` was originally
  added by PR #260 (issue #220) but **removed for #267**: npm's OIDC
  trusted-publishing flow does not authorize `npm deprecate`, and
  npmjs.com is now OIDC-only for this account — granular automation
  tokens that would have backed the workflow can no longer be issued.
  npmjs.com's web UI deprecates whole packages only; version-scoped
  deprecation is CLI-only. Rollback is therefore a maintainer-local
  break-glass operation; maintainer reachability is a release-readiness
  gate. See runbook § Authorization model for the constraint detail and
  what would have to change for automation to flip back on.

- **Sub-domain formatter audit + per-command override registry (#124)**.
  Triage of all 11 profile sub-domain formatters
  (`packages/cli/src/commands/profile/*`) against entity types vs
  user-settable fields, recorded at
  `docs/audit/2026-05-output-format-formatter-audit.md`. The audit
  identifies field-dropping defects of HIGH severity in `basic` (bio,
  headline — query root cause; downstream issue #127) and `portfolio`
  (description, accomplishment, coverImage, clientOrCompanyName —
  formatter root cause; downstream issue #129), MEDIUM in `industries`,
  `employment`, `visas`, and LOW in `skills`; remaining sub-domains are
  clean. Recommends a single null-rendering convention for the
  in-flight `pretty` format (`(unset)` for fields the user can set
  but hasn't; `null` for `json`/`yaml`; key omission only when
  structurally absent). Ships
  `packages/cli/src/lib/format-overrides.ts` with the `FormatStrategy`
  type, `FORMAT_OVERRIDES` registry, and `resolveStrategy()` lookup —
  registered today: `profile reviews list` → `multi-line` (forward-
  looking; load-bearing once #127 surfaces reviewer-comment fields).
  Defects to be fixed in follow-up issues (#127 query extensions, #129
  formatter rewrites).

- **Profile basic + skills sub-domains (#73)**. First Wave-3 vertical-slice
  bundle: end-to-end coverage of the `basic` (4 leaves) and `skills` (7
  leaves) sub-domains across `@ttctl/core`, `@ttctl/cli`, and
  `@ttctl/mcp`. Validates the v0 vertical-slice pattern; sister bundles
  #74 / #75 / #76 replicate the shape established here.
  - **`@ttctl/core` `profile.basic`** gains `photoShow` (returns the
    user's profile photo URLs) and `photoUpload` (uploads a new photo
    via the GraphQL multipart-upload spec). `photoUpload` accepts a path
    string or a `Buffer`; content-type is inferred from the file
    extension. Exposes a typed `PhotoUrl` shape and a `PhotoUploadInput`
    interface. The multipart transport hand-rolls a `node-wreq` fetch
    (the existing `impersonatedTransport` hardcodes `application/json`)
    using the same Chrome TLS profile.
  - **`@ttctl/core` `profile.skills`** ships seven leaves — `add(name)`,
    `rm(id)`, `set(id, fields)`, `show(id)`, `list(profileId)`,
    `autocomplete(profileId, query, options?)`, `readiness(profileId)` —
    with a typed `SkillsError` enum (`VALIDATION_ERROR`, `USER_ERROR`,
    `PARTIAL_FAILURE`, `GRAPHQL_ERROR`, `NETWORK_ERROR`, `NO_VIEWER`,
    `UNKNOWN`). The cardinality collapse folds 18 raw GraphQL operations
    into 7 leaves; the mapping table is documented in the module
    top-comment. `set` is multi-flag atomic: each flag (`rating` /
    `experience` / `public`) fires its own GraphQL mutation in the
    deterministic order `rating → experience → public`; partial failures
    raise `PARTIAL_FAILURE` carrying which fields landed.
  - **Translation table** amended: `PROFILE_SKILL_FIELDS` registered as
    a placeholder entry (currently empty — every `ProfileSkillSet` field
    reads naturally as a CLI flag with no rename). Re-exported from
    `@ttctl/core`. Future field renames land here without changing
    call-sites.
  - **CLI**: `ttctl profile basic photo show` / `… photo upload <file>`
    join the `basic` tree (the `--bio` / `--headline` set, free-text
    helper, and output formatter remain unchanged). New `ttctl profile
skills` sub-tree carries seven leaves matching the issue's
    specification — `add <name>`, `remove <id>` (alias: `rm`),
    `update <id>` (with `--rating` / `--experience` / `--public` /
    `--private`), `show <id>`, `list`, `autocomplete <query>`,
    `readiness`. All `show` / `list` / `autocomplete` / `readiness`
    accept `-o text|json|table`. `--experience` accepts a bare integer
    (`"60"`), `Ny` (`"5y"` = 60 months), or `Nm` (`"60m"` = 60 months).
  - **MCP**: 11 new tools registered at server build time —
    `ttctl_profile_basic_show` / `_update` / `_photo_show` /
    `_photo_upload` and `ttctl_profile_skills_add` / `_remove` /
    `_update` / `_show` / `_list` / `_autocomplete` / `_readiness`. Each
    tool ships a verbose `description` (3 example user-intent phrases),
    a Zod-shaped `inputSchema` with property-level docstrings, and a
    uniform `Error/Recovery/Code` rendering for failures. MCP tool names
    use the canonical sub-domain spelling only (no aliases — `rm` /
    `certs` / `experience` are CLI affordances per project policy).
  - **Connection mutations** (`addProfileSkillSetConnection` /
    `removeProfileSkillSetConnection`) fold semantically into `add` /
    `rm` per the cardinality table but are NOT wired in this bundle:
    the connection-id argument requires a UI flow surfacing selectable
    candidates first. Tracked as a follow-up.

- **Profile portfolio + visas + resume sub-domains (#75)**. Three profile
  sub-domains land with their full operation set across `@ttctl/core`,
  `@ttctl/cli`, and `@ttctl/mcp` — 13 leaves total. Includes new
  multipart-upload transport infrastructure for the file-upload
  operations.
  - **Multipart transport**: `core/src/transport.ts` gains
    `impersonatedMultipartTransport` and `buildGraphQLMultipart` for
    GraphQL-multipart-spec uploads via the impersonated TLS path. Both
    are re-exported from `@ttctl/core`. The build helper takes a body +
    files + map and produces a `globalThis.FormData` payload conforming
    to the `jaydenseric/graphql-multipart-request-spec` shape.
  - **Portfolio service** (`core/src/services/profile/portfolio/`): 8
    operations — `list`, `add`, `update`, `remove`, `reorder` (absolute
    position; helpers `positionBefore` / `positionAfter` translate
    neighbour-anchored intent to absolute), `highlight`, `uploadCover`
    (multipart), `uploadFile` (multipart). `PortfolioError` covers the
    domain failure modes (`NO_VIEWER`, `GRAPHQL_ERROR`, `USER_ERROR`,
    `VALIDATION_ERROR`, `FILE_NOT_FOUND`, `FILE_READ_ERROR`,
    `NETWORK_ERROR`, `UNKNOWN`).
  - **Visas service** (`core/src/services/profile/visas/`): 4
    operations — `list`, `add`, `update`, `remove`. `VisasError`
    follows the same code taxonomy minus the file-related codes.
  - **Resume service** (`core/src/services/profile/resume/`): 2
    operations — `upload` (multipart) and `cancelUpload`. `ResumeError`.
  - **CLI commands**:
    - `ttctl profile portfolio {add,update,remove,list,reorder,highlight,upload}`
      (alias `projects` continues to work). `add` and `update` consume
      the free-text helper from #70 for `--description` (inline /
      stdin / `@path` / `--edit`). `list` consumes the output helper
      from #71 (text / json / table). `reorder` accepts mutually
      exclusive `--before <id>` / `--after <id>` / `--to <position>`.
      `upload` accepts mutually exclusive `--cover <file>` /
      `--file <file>`. `remove` carries `rm` alias per #72 convention.
    - `ttctl profile visas {add,update,remove,list}`. `list` consumes
      the output helper. `remove` carries `rm` alias.
    - `ttctl profile resume {upload <file>,cancel-upload}` (alias `cv`
      continues to work).
  - **MCP tools**: 13 tools registered on the MCP server, all using the
    canonical sub-domain names (no CLI aliases per project policy).
    File-upload tools (`ttctl_profile_portfolio_upload_cover`,
    `ttctl_profile_portfolio_upload_file`, `ttctl_profile_resume_upload`)
    accept either a server-relative `filePath` (preferred when the host
    has filesystem access — Claude Desktop, Claude Code) or a base64
    `content` payload (for web-hosted clients). Service-layer
    `FileSource` accepts both shapes uniformly.
  - **Profile command tree**: `cli/src/commands/profile/index.ts` adds
    one wiring for `visas` (visas had no alias contract from #72 so was
    not pre-wired); the other six sub-domains remain as before.
  - **GraphQL operation shapes**: `createPortfolioItem`,
    `updatePortfolioItem`, `createTravelVisa`, and `updateTravelVisa`
    use `[INFERRED]` wrapper keys (`portfolioItem`, `travelVisa`) per
    the inference patterns in `research/notes/10-mutation-input-patterns.md`
    Patterns 1/2. The `UPDATE_BASIC_INFO` precedent (issue #74905
    elsewhere; falsified by live capture) showed that wrapper keys
    occasionally diverge from inference; if any of these mutations is
    rejected by the server, capture the live shape via curl and amend.

- **Profile industries + education + certifications + employment (#74)**.
  Implements the natural-CRUD shape for four profile sub-domains, landing
  21 leaves (5 + 5 + 5 + 6) across CLI and MCP surfaces. All four reuse
  the wave-3 infrastructure already merged: free-text helper (#70) for
  `employment update --description`, output formatter (#71) for every
  `show` / `list` leaf, vocabulary aliases (#72) for `certs` and
  `experience`, and the typed auth-error contract (#77) at the transport
  layer.
  - **Core services** at `@ttctl/core/services/profile/{industries,
education,certifications,employment}/index.ts`. Each exposes the
    canonical CRUD verbs plus sub-domain extras (`industries.list` +
    `industries.autocomplete` for the catalog lookup;
    `employment.employerAutocomplete` for the employer-name catalog;
    `highlight` toggles on education / certifications / employment).
    All services run against the Cloudflare-protected talent-profile
    surface via `impersonatedTransport`; `profileId` is resolved lazily
    via the new `services/profile/shared.ts` helper (which wraps
    `profile.basic.show()` and re-uses `ProfileError`).
  - **CLI commands** at `@ttctl/cli/commands/profile/{industries,
education,certifications,employment}/index.ts`. Each sub-tree
    expands into its full leaf set: - `profile industries add <name> [--connection]` (+ `update`,
    `remove`, `list`, `autocomplete`) - `profile education add --institution --degree [--from --to]`
    (+ `update`, `remove`, `show`, `highlight`) - `profile certifications add --name --issuer [--issued --expires]`
    (+ `update`, `remove`, `show`, `highlight`) - `profile employment add --company --role [--from --to --current]`
    (+ `update`, `remove`, `show`, `highlight`,
    `employer-autocomplete`) - The `certs` and `experience` aliases registered in #72 are
    preserved when each sub-tree expands. `--description` on
    `employment update` consumes the four-mode free-text helper from
    #70 (inline / stdin `-` / file `@path` / `$EDITOR`).
  - **MCP tools** registered under `@ttctl/mcp/tools/profile/*.ts` —
    21 tools total, named with the `ttctl_profile_<sub-domain>_<verb>`
    convention. CLI-only aliases (`certs`, `experience`) do NOT appear
    in the MCP catalog per #72 project policy. Each tool ships rich Zod
    input schemas and intent-example descriptions.
  - **Date input helper** at `core/src/lib/date.ts` (re-exported from
    `@ttctl/core` for both CLI and MCP). Accepts ISO-8601
    (`2023-01-15`) or year-only (`2023`, defaulted to January 1st).
    Validates real calendar dates (rejects 2023-02-30, Feb 29 in
    non-leap years, etc.) and rejects out-of-range years (before 1900,
    after current year + 30).
  - **Wire-format mapping** matches the empirical capture in
    `research/captures/web/inputs/`: Education stores year only
    (`yearFrom` / `yearTo` Int); Employment stores year only
    (`startDate` / `endDate` Int) — month/day are dropped before
    sending; Certification stores month + year as separate Int fields
    (`validFromMonth` / `validFromYear`, `validToMonth` /
    `validToYear`). All four follow Pattern 1 (`{<entity>Id, <entity>:
<Entity>Input}`) for update, Pattern 2 (`{profileId, <entity>:
<Entity>Input}`) for create, Pattern 3 (`{<entity>Id}`) for remove,
    and Pattern 4 (`{<entity>Id, highlight: Boolean}`) for highlight.

- **Profile `external` and `reviews` sub-domains — CLI + MCP (#76)**.
  Second Wave-3 vertical-slice bundle (after #73): two heterogeneous
  profile sub-domains end-to-end across `@ttctl/core`, `@ttctl/cli`, and
  `@ttctl/mcp`. 6 external leaves + 4 reviews leaves + 10 MCP tools.
  - **External (`packages/core/src/services/profile/external/index.ts`)**.
    Six exports: `update` (LinkedIn / GitHub / website / Twitter / Behance /
    Dribbble URLs via `UpdateExternalProfiles`), `customRequirementsShow` /
    `customRequirementsSet` (the three onboarding-readiness booleans —
    background-check, drug-test, time-tracking-tools — backed by
    `getCustomRequirements` / `updateCustomRequirements`), `readiness`
    (`getProfileReadiness` — per-section completion checklist plus the
    rolled-up `submitAvailable` flag), `recommendations`
    (`getProfileRecommendations` — discriminated-union list of "do this
    next" items), `advancedWizardShow` (`getAdvancedProfileData` — wizard
    status + travel-visa summary).
  - **Reviews (`packages/core/src/services/profile/reviews/index.ts`)**.
    Four exports: `list` (`sectionReviews`), `approveItem` /
    `approveSection` (final approvals — destructive per platform
    semantics), `submitForReview` (re-submit profile for platform-side
    re-review).
  - **CLI** (`packages/cli/src/commands/profile/{external,reviews}/`). Each
    leaf is a separate file with pure formatters that consume the #71
    output helper (`text` / `json` / `table`). The `external update`
    leaf accepts six URL flags; `custom-requirements set` accepts the
    three booleans (see § Spec/API divergences below). Approval leaves
    use named flags (`--review-id`, `--item-id`, `--kind`, `--section`)
    rather than the issue's `<id>` shorthand because the API requires
    three fields per call.
  - **MCP** (`packages/mcp/src/tools/profile_{external,reviews}_*.ts`).
    Ten tools wired through `registerAllTools`:
    `ttctl_profile_external_*` (6) and `ttctl_profile_reviews_*` (4),
    matching the per-tool-file convention established by #73. Tool
    descriptions include example user intents to help AI clients route
    natural-language requests.
  - **Tests**. New core service tests cover happy paths, validation
    guards, auth-revoked routing, USER_ERROR rendering, and Cf403
    propagation. New CLI formatter tests cover text/json/table modes for
    every show/list/update leaf. New MCP tests cover tool registration
    shape.

  **Spec/API divergences from issue #76 — documented to surface
  divergences for future maintainers**:
  - `custom-requirements set` is **NOT** free-text. Issue #76 described
    it as multi-paragraph free-text consuming the #70 helper. The
    underlying `UpdateCustomRequirementsInput` schema is in fact three
    booleans (`backgroundCheck`, `drugTest`, `timeTrackingTools`); no
    free-text field exists. The leaf accepts
    `--background-check / --drug-test / --time-tracking-tools <true|false>`.
    The AC item "Free-text helper (#70) consumed by `external
custom-requirements set`" is **not satisfied** — no free-text input
    exists for this leaf. Empirically validated against
    `research/captures/web/inputs/UpdateCustomRequirementsInput.json`.
  - `external update` exposes the schema-supported URL fields
    (`linkedin / github / website / twitter / behance / dribbble`); the
    issue's `--portfolio-url` is **not** a settable field on the schema
    and is dropped (the talent's public profile URL is a server-
    determined read via `getPublicProfileUrl`).
  - Review-approval leaves use named flags rather than the issue's
    single-positional `<id>` shorthand (the API requires `reviewId +
itemId + itemKind` for items, `reviewId + section` for sections).
  - `submitForReview` input shape is **INFERRED — UNVERIFIED** (Pattern 2:
    `{ profileId: ID! }`); no live curl capture exists in
    `research/captures/web/inputs/`. Mismatches surface as `USER_ERROR`
    at runtime.

  **Operations explicitly NOT exposed at v0** (per issue #76 §
  "Operations explicitly NOT exposed as user-facing CLI leaves"):
  `getStepsAndLinks`, `getProfilePrefillStatus`, `getProfileSettingsUrls`,
  `getPublicProfileUrl`, `getProfileVersionsCount`, `analyticsInfo`,
  `getProfileTimestamps`, `getProfileItems`,
  `UpdateAdvancedProfileWizardStatus`. None is exported from the service
  module. File a follow-up issue if user demand surfaces.

- **Vocabulary translation table + CLI aliases (#72)**. Centralizes the
  server-field ↔ CLI-flag mapping in a new `core/src/services/translations.ts`
  and registers user-friendly Commander.js aliases on four profile
  sub-domains.
  - **Translation table**: `PROFILE_BASIC_FIELDS` maps GraphQL field names
    on the `basic` sub-domain to the canonical CLI flag names —
    `quote → headline`, `about → bio`. New helpers `serverToCli` and
    `cliToServer` rename keys in either direction (values pass through;
    unmapped keys pass through unchanged). Future sub-domains amend the
    same module rather than scattering inline literals across services.
    All three are re-exported from `@ttctl/core`.
  - **CLI aliases**: each of the four sub-domains in this batch now
    accepts a user-friendly alongside its canonical name —
    `certifications`/`certs`, `employment`/`experience`,
    `portfolio`/`projects`, `resume`/`cv`. Both forms route to the same
    handler; `--help` renders the canonical name with the alias listed
    parenthetically (Commander.js default).
  - **MCP excludes aliases**: per project policy, MCP tool names use only
    the canonical sub-domain name (e.g.,
    `ttctl_profile_portfolio_add`, never `ttctl_profile_projects_add`).
    Aliases are a CLI ergonomics affordance, not a public API surface.
  - **Convention** (no v0 commands ship `remove` yet): when a sub-domain
    introduces a `remove` verb, it MUST also register `rm` as a
    Commander.js alias on that verb so users can type either form.

### Changed

- **Profile surface refactored to services-tree shape (#69)**. The flat
  `core/src/profile.ts` was relocated to `core/src/services/profile/basic/index.ts`
  and the flat `cli/src/commands/profile.ts` to a `cli/src/commands/profile/`
  sub-tree mirroring the `cli/src/commands/auth/` precedent. This is a pure
  mechanical refactor — no behavior change — that gates the per-sub-domain
  implementation issues #70/#71/#72/#73-#76 (epic #68).
  - `@ttctl/core` exports change from flat (`getProfile`, `updateProfile`,
    `ProfileError`, `ProfileErrorCode`, `ProfileUpdate`, `UpdateProfileResult`)
    to namespaced. Consumers now write `import { profile } from "@ttctl/core"`
    and call `profile.basic.show(...)` / `profile.basic.set(...)`. Error class
    and types are reachable via the namespace (`profile.basic.ProfileError`,
    `profile.basic.ProfileErrorCode`, etc.). The `ProfileShowQuery` /
    `ProfileShowQueryVariables` codegen types remain at the top level.
  - Internal core function renames: `getProfile` → `show`, `updateProfile` → `set`
    (per the core-side verb economy `add` / `rm` / `set` / `show` / `list`).
  - CLI surface: `ttctl profile show` and `ttctl profile update --bio --headline`
    continue to work unchanged (preserved as direct aliases at the `profile`
    level — AC option A). Canonical forms `ttctl profile basic show` and
    `ttctl profile basic update --bio --headline` are now also available and
    will be the form documented going forward.
  - Placeholder modules added for the 10 follow-up sub-domains
    (`skills`, `industries`, `education`, `certifications`, `employment`,
    `portfolio`, `visas`, `resume`, `external`, `reviews`) in both core and
    CLI; these are empty `index.ts` stubs that establish the directory shape
    so #70/#71/#72/#73-#76 can land each sub-domain without further
    structural churn.

### Added

- **Cross-CLI output formatting helper (`@ttctl/cli` `lib/output.ts`, #71)**.
  Generic helper that lets every `show` / `list` leaf accept a uniform
  `--output={text,json,table}` flag. The helper exports `OutputFormat`,
  `OUTPUT_FORMATS` (for `commander`'s `Option#choices`), `formatResult`
  (pure, returns the string + optional stderr warning), and `emitResult`
  (writes to `process.stdout` / `process.stderr`). Behavior:
  - `text` (default): caller-supplied formatter; falls through to
    `JSON.stringify(data, null, 2)` plus a stderr hint when no text
    formatter is provided.
  - `json`: single-line `JSON.stringify(data)` — no extra whitespace, so
    consumers can pipe straight to `jq` / `yq`. The JSON shape commitment
    is "may break across 0.x" pre-1.0 and "stable across majors per
    semver" at 1.0+.
  - `table`: caller-supplied formatter (consumers typically use
    `cli-table3`); falls through to the `text` branch when absent.
  - Wired to `ttctl profile basic show` (and the `ttctl profile show`
    alias) as the proof-of-integration; the table branch now uses
    `cli-table3` and respects the terminal width.
  - Adds `cli-table3` (`^0.6.5`, MIT) to the workspace catalog and to
    `@ttctl/cli`'s production dependencies.

  Usage from a `show` / `list` action handler inside `@ttctl/cli` (the
  helper is package-internal — relative-path import, not a public
  `exports` entry):

  ```ts
  // packages/cli/src/commands/<area>/<sub>/show.ts
  import { emitResult } from "../../../lib/output.js";
  import type { OutputFormat } from "../../../lib/output.js";

  emitResult(payload, format, {
    text: (d) => formatPayloadAsText(d),
    table: (d) => formatPayloadAsTable(d),
  });
  ```

  Note: this changes the `ttctl profile show --output json` byte stream
  from pretty-printed (`JSON.stringify(_, null, 2)`) to single-line. The
  parsed shape is unchanged. Pre-1.0 (`0.x`) tolerates this break; the
  shape becomes contractually stable at 1.0.

- **Free-text input helper for CLI flags (#70)** — `lib/freetext.ts`'s
  `resolveFreeText` lets any string-typed flag accept content via four input
  modes:
  - **Inline** — `ttctl profile update --bio "Senior backend engineer..."`
  - **Stdin** — `cat bio.md | ttctl profile update --bio -`
  - **File** — `ttctl profile update --bio @path/to/bio.md`
  - **Editor** — `ttctl profile update --edit` (opens `$EDITOR` on the bio
    buffer; falls back to `vi` if `$EDITOR` is unset)

  Mode conflicts (`--edit` combined with any concrete value), missing files,
  and double-stdin claims surface as typed `FreeTextError`s with stable
  codes (`MODE_CONFLICT`, `FILE_NOT_FOUND`, `FILE_READ_ERROR`,
  `STDIN_UNAVAILABLE`, `STDIN_DOUBLE_CLAIM`, `EDITOR_FAILED`). CLI handlers
  render these as `<command> failed (CODE): <message>` and exit non-zero
  before any network call. Wired into the `ttctl profile update` and
  `ttctl profile basic update` commands (`--bio` / `--headline` / `--edit`)
  as the proof-of-integration; gates the per-sub-domain implementation
  issues #73-#76.

- Typed auth-error translation contract (`TtctlError` base + `AuthRevokedError`,
  `Cf403Error`, `Cf403PersistentError`, `SchedulerBearerExpired`). Each subclass
  carries a stable `code`, an actionable `recovery` hint, and an `autoRecover`
  flag the transport layer may consult. CLI surfaces auth failures in a uniform
  `Error: <message> / Recovery: <recovery> / (Code: <code>)` three-block layout;
  MCP tool wrappers emit the same content as a structured `isError` response.
  Recovery messages: AuthRevokedError — "Run `ttctl auth signin` to
  re-authenticate."; Cf403Error — try again, file an issue if persistent;
  Cf403PersistentError — see SECURITY.md break-glass; SchedulerBearerExpired —
  re-minted automatically (post-v1). Issue #77.
- Monorepo scaffolding with pnpm workspace and Turbo build orchestration
- `@ttctl/core` package skeleton: config schema (Zod), auth flow stubs, 1Password CLI integration, dual-transport HTTP layer
- `@ttctl/cli` package skeleton with Commander.js program builder
- `@ttctl/mcp` package skeleton with MCP server (stdio transport)
- `ttctl` umbrella package combining CLI and MCP entry points
- `@ttctl/e2e` private package for end-to-end tests against the live Toptal Talent API
- CI pipeline (GitHub Actions) with multi-platform testing (ubuntu, macos, windows)
- Release pipeline with npm provenance attestation
- SPDX license headers on all source files (enforced by `eslint-plugin-header`)
- Dependency license compatibility check in CI (`scripts/check-licenses.js`)
- CODEOWNERS for security-sensitive files
- Dependabot configuration for automated dependency updates
- CONTRIBUTING guide with development setup instructions
- SECURITY policy with vulnerability disclosure and anti-spam stance
- MCP registry configuration files (`server.json`, `smithery.yaml`, `glama.json`)
