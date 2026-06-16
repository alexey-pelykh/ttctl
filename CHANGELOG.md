# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-16

First stable release — `npm install -g ttctl` now resolves to a versioned,
provenance-signed build.

Read-heavy, personal-use CLI + MCP access to your own Toptal Talent profile:
**auth**, **profile** (basic info, skills, employment, education,
certifications, industries, portfolio, visas, résumé, external links,
reviews, photo), **applications** (activity items, interview +
availability-request detail, interest-request responses), **engagements**
(list / breaks / stats), **jobs** (browse / recommended / match-quality /
rate-insight / apply funnel / signals), **timesheets** (list / show /
submit / update), **availability** (working + allocated hours),
**contracts**, **payments** (payouts / methods / rate / summary), and
**surveys**.

The incremental development history is retained in the `v0.1.0-rc.1` …
`v0.1.0-rc.18` sections below.

## [v0.1.0-rc.18] - 2026-06-16

### Security

- **Dev-toolchain dependency patches (#819).** Bumped dev-only transitive
  dependencies `vite` (≥8.0.16, GHSA-fx2h-pf6j-xcff) and `ws` (≥8.21.0,
  GHSA-96hv-2xvq-fx4p) past HIGH-severity advisories. Neither ships in the
  published tarball; the bump clears the release-time
  `pnpm audit --audit-level=high` gate.

### Changed

- **Portfolio and visas mutation wire shapes verified live (#90).** The
  GraphQL input wrapper keys for the portfolio and visas mutations,
  previously documented as `INFERRED`, are now confirmed against the live
  Toptal API.

## [v0.1.0-rc.17] - 2026-06-15

### Added

- **`timesheet update` — the missing timesheet CRUD verb (#458).** Wraps
  the `UpdateTimesheet` mutation on both CLI (`ttctl timesheet update`) and
  MCP (`ttctl_timesheet_update`), completing the timesheet
  read/submit/update surface.
- **`profile show --full` rich portal projection (#469).** A `--full` flag
  renders the extended `GetViewer` portal projection (the web profile
  editor's field set) beyond the default summary. (`--verbose` collides
  with the root global flag, so the flag is `--full`.)
- **`profile education` writable skills surface (#633).** `education add`
  and `education update` accept catalog skills — CLI `--skill-id`
  (repeatable) and the MCP `skills` array — mirroring the employment
  skills surface.
- **`me actions list` — performed-actions audit log (#389).** Reads the
  viewer's server-side action history via `GetPerformedActions` (CLI + MCP).
- **Jobs read surface expanded (wave-2).** Five new per-job / feed reads
  across CLI + MCP:
  - `jobs show-many` — `JobsByIDs` batch fetch (#471).
  - `jobs recommended` — `GetRecommendedJobs` algorithmic feed (#472).
  - `jobs match-quality` — `GetJobMatchQualityMetrics` per-job score (#473).
  - `jobs rate-insight` — `GetTalentJobRateInsight` per-job rate intel (#474).
  - `jobs dashboard` — `GetJobsForDashboard` + `GetJobsCountForDashboard`
    projection (#479).
- **`engagements payments list` — per-engagement payments (#388).** Reads
  `viewer.job(id).activityItem.engagement.payments`
  (`GetEngagementPayments`) with hybrid `--limit` + `--after <payment-id>`
  pagination (ADR-007). Takes a job id, per the wire op.
- **`payments show-many` — batch payment fetch (#456).** Wraps
  `PaymentsByIDs` (CLI + MCP), the batch sibling to `payments show`.
- **`payments methods list` surfaces available method types (#812).** The
  list now returns `availableMethods`
  (`viewer.viewerRole.availablePaymentMethods`) alongside the configured
  methods, on both CLI and MCP.

### Changed

- **`@ttctl/core` transport and auth split into modules (#230).**
  `transport.ts` became `transport/` (`stock` / `impersonated` / shared
  infra) and `auth.ts` became `auth/`, closing ARCH-003. CI gates and docs
  repointed at the new paths; no behavior change.

### Fixed

- **SMS-consent guidance corrected: `UPDATE_BASIC_INFO` is not
  server-gated (#540).** Earlier guidance implied a server-side
  SMS-consent precondition on basic-info updates; the gate is the web
  form's client-side checkbox only, so ttctl's `basic set` is never
  blocked by it. Corrected the JSDoc / CLI help / MCP tool descriptions
  across core, CLI, and MCP.
- **`education add` requires the full create field set upfront (#803).**
  The Toptal API rejects a create that omits `fieldOfStudy`, `location`,
  `yearFrom`, or `yearTo`; these are now validated upfront (CLI required
  options, MCP schema, core guard) with a clear error instead of an opaque
  server-side rejection.

## [v0.1.0-rc.16] - 2026-06-14

### Added

- **CLI/MCP parity contract test (#151).**
  `packages/ttctl/src/__tests__/cli-mcp-parity.test.ts` (runs in
  `pnpm test`) is the sibling parity gate to surface-coverage: it walks
  the live Commander tree and a constructed MCP server's tool registry
  (a new `listRegisteredMcpToolNames()` export from `@ttctl/mcp`) and
  reports when a CLI leaf `ttctl <group> <sub-domain> <verb>` and its
  `ttctl_<group>_<sub-domain>_<verb>` MCP tool drift apart. Runtime
  discovery resolves the template-literal tool registrations a source
  scan cannot; intentional divergences live in `.mcp-exempt.yaml` or an
  inline `// mcp-exempt:` comment. Warn-by-default;
  `CLI_MCP_PARITY_STRICT=1` fails on drift.
- **Scalar type-consistency lint gate (#782).**
  `scripts/check-scalar-type-consistency.ts` (wired into `pnpm lint`)
  cross-references hand-authored `export interface` scalar fields under
  `packages/core/src/services/**` against the generated codegen named
  types and Zod schemas, flagging a hand-authored field whose primitive
  contradicts the wire scalar — the structural defense against the #275
  mistype class (#275, #779). Field-name match on a single unambiguous
  contradiction; warn-by-default with `// scalar-consistency-exempt:`
  markers and `SCALAR_CONSISTENCY_STRICT=1`.

### Changed

- **Surface-coverage gate follows sibling-file re-exports (#662).** The
  Class A gate parsed only `export async function` and
  `export const ns = {}`; it now also follows value re-exports
  (`export { name } from "./sibling.js"`, honoring `as` aliases and
  ignoring `export type`), attributing the op to the importing index's
  namespace — so an op implemented in a sibling file (e.g.
  `profile.employment.reportingToAutocomplete`) is no longer invisible
  to it.
- **README-verbs gate resolves `ttctl_*` MCP tool-name claims (#765).**
  The #762 gate routed every `ttctl_*` backtick span to its unchecked
  report; those spans now resolve against the registered MCP tool roster
  (`EXPECTED_TOOLS`, pinned to the live server registry), so a README
  naming a renamed or removed tool is a strict finding rather than a
  silent unchecked row.

### Fixed

- **Scalar type corrections: `paymentGroupId` and time-zone offsets are
  `number`, not `string` (#779).** Two `#275`-class mistypes where the
  hand-authored TypeScript contracted a `string` while the SDL, generated
  codegen, and live wire all return a numeric `Int`. `payments` —
  `Payout.paymentGroupId` / `WirePayment.paymentGroupId` retyped
  `string | null` → `number | null` (live wire returns group ids like
  `261280`). `availability` — `AvailabilityTimeZone.utcOffset` /
  `.stdOffset` retyped `string | null` → `number | null` (live wire
  returns offset seconds, e.g. `3600` for UTC+1), found by the
  accompanying suite-wide scalar-mistype sweep. Runtime rendering is
  unchanged (the wire already sent numbers); the fix aligns the type
  contract so string operations on these fields are no longer silently
  wrong. The `Payments` wire snapshot was hand-corrected (and
  live-verified against a populated cycle): `paymentGroupId` from a
  degenerate `null` capture to `nullable<number>`, and `billingCycle`/`job`
  from a degenerate non-null capture to their true `nullable<object>` shape.

## [v0.1.0-rc.15] - 2026-06-13

### Added

- **README-verbs lint gate (#762).** `scripts/check-readme-verbs.ts`
  (wired into `pnpm lint`) mechanically diffs the README's capability-verb
  claims against the registered CLI command tree and fails the gate when
  the README advertises a verb the CLI does not ship — a structural
  defense against the #751 drift class.

### Changed

- **MCP README tool catalog recounted: 88 → 129 tools (#769).**
  `packages/mcp/README.md` understated the registered MCP surface — it
  claimed 88 tools, omitted the `surveys` domain from the per-domain
  breakdown, and carried stale per-domain counts. Recounted against the
  canonical tool enumeration: 129 tools across 10 domains, `surveys`
  added, per-domain counts refreshed and reconciled to the total.
  Docs-only; the README ships in the `@ttctl/mcp` tarball.
- **Expand npm keywords on the `ttctl` umbrella package (#771).** Broadened
  for registry discoverability ahead of the first stable (`toptal`,
  `freelance`, `mcp-server`, `model-context-protocol`).
- **CI: Codecov upload moved to a dedicated OIDC coverage job (#761,
  #759).** The upload now authenticates via OIDC, and `CODECOV_TOKEN` is
  scoped to the upload step rather than the whole workflow.

### Fixed

- **Drop the unshipped `timesheet update` verb from the README (#751).**
  The root README's Timesheets bullet advertised an `update` verb with no
  `UpdateTimesheet` invocation in core and no `timesheet update` CLI
  command; corrected to "list, view, and submit". Restore when #458 lands.
- **Generate coverage at the repository root so the Codecov upload
  delivers (#760).** Coverage was produced per-package, leaving the upload
  step with nothing to deliver; it is now generated at the root level.

### Security

- **Disposition the 9 transitive `npm audit` advisories (hono ×7,
  ip-address, qs) via a documented allowlist (#770).** All nine arrive
  through `@modelcontextprotocol/sdk`'s optional HTTP/SSE transport stack
  (hono / express-rate-limit / qs / ip-address) and require an active HTTP
  request handler; ttctl's MCP server is stdio-only, so the vulnerable
  paths never enter its runtime module graph — present-but-unreachable (a
  `security-architect` review confirmed the reachability claim). They are
  pinned per-GHSA in `pnpm-workspace.yaml` `auditConfig.ignoreGhsas` (so
  future advisories still surface), with the full triage and reachability
  proof in ADR-011 and the posture plus re-review trigger in `SECURITY.md`.
  A reachable `fast-uri` advisory surfaced during triage was closed with a
  `pnpm.overrides` bump.

### Dependencies

- Bump `undici` 8.3.0 → 8.4.1 (#747), `prettier` 3.8.3 → 3.8.4 (#746),
  `turbo` 2.9.16 → 2.9.18 (#745), `typescript-eslint` 8.60.1 → 8.61.0
  (#749), `graphql` 16.14.0 → 16.14.2 (#748), `codecov/codecov-action`
  6.0.1 → 7.0.0 (#744).

## [v0.1.0-rc.14] - 2026-06-12

### Added

- **`applications interview show`: surface the client-side contact block
  (`clientContactInfo`) (#682).** The captured Android `Interview` doc
  carries the client's `contactFields` (Slack id, email, phone, Skype),
  but ttctl's `INTERVIEW_QUERY` and projection trimmed them. The
  client-side contact — distinct from the interviewer/recruiter-side
  `contacts[]` — is now selected and projected on `InterviewDetail`, and
  the CLI renders a `Client` section after `Contacts`, omitted unless at
  least one channel is populated. MCP: `ttctl_applications_interview_show`
  auto-inherits the field (the tool JSON-serializes the full projection).
  Wire-shape disposition: Schema/contract rule **triggered** (selection
  extension on the hand-authored `Interview` op); **Track 1**
  (`packages/e2e/src/wire-snapshots/Interview.snapshot.json` refreshed —
  the live run captured the field populated on an external interview).
  Validated live (`TTCTL_E2E=1`) via
  `packages/e2e/src/62-applications-interview-show.e2e.test.ts`.
- **`applications interview show`: surface
  `contacts[*].topChatConversation` (#683).** The per-contact TopChat
  discovery handle — selected by the captured Android `Interview.graphql`
  but trimmed from ttctl, the per-contact twin of #682. Each
  `InterviewContact` now carries `topChatConversation` (`id`,
  `slackChannelId` flattened from the `TopChatConversationSlackService`
  inline fragment, and `uploads[]` with `id` / `filename` / `url`), and
  the CLI renders a per-contact `TopChat:` block under `Contacts`.
  Discovery handle only — #23 owns the full TopChat surface (messages,
  downloads). Wire-shape disposition: Schema/contract rule **triggered**
  (the conversation/upload sub-shape is INFERRED from the captured doc;
  the synthesized schema grounds only
  `TopChatConversationSlackService.channelId`); **Track 1** (`Interview`
  snapshot refreshed). Validated live (`TTCTL_E2E=1`): the wire returned a
  populated thread (`id` and `slackChannelId` confirmed as strings);
  `uploads` was empty on the live thread, so the upload-item shape stays
  capture-inferred until a populated capture lands.
- **`timesheet show`: surface `TimesheetRecord.hours` and `persisted`
  (#684).** Both fields are carried by the captured `TimesheetRecord`
  fragment but were trimmed from ttctl's ops and projection — the last
  member of the #559 op-vs-projection spike batch (siblings #682 / #683).
  Core: `TimesheetRecord` gains `hours: string | null` (server-rendered
  hour string, sibling to `duration`) and `persisted: boolean | null`
  (save-state flag); both the `TimesheetDetails` query and the
  `SubmitTimesheet` mutation select them, so `show` and `submit` both
  surface them; MCP auto-inherits. CLI: `timesheet show` renders the
  server `hours` verbatim and derives from `duration` minutes only when
  null — present-hours rows now render the server form (`8.0h`) instead
  of the computed `8.00h`. Wire-shape disposition: Schema/contract rule
  **triggered** (INFERRED fragment fields — the #275 duration-unit-bug
  class); **Track 1** (`TimesheetDetails` and `SubmitTimesheet` snapshots
  refreshed, hand-preserving `note: nullable<string>` against an all-null
  cycle). Validated live (read-only, mobile gateway): `hours` returned as
  a string and `persisted` as a boolean across 15 records.
- **Interview read ops: sibling-reach footers (CLI) and tool-description
  hints (MCP) (#694).** The three interview read ops (`interview show` /
  `interview notes show` / `interview guide show`) trim heavy job-context
  cascades BY-DESIGN (#685) but never said where the full context lives.
  Each pretty render now ends with a discovery footer naming the sibling
  command that carries it (`interview show` points at
  `ttctl applications show <activityItemId>`; `notes show` / `guide show`
  point at `ttctl applications interview show <interviewId>`), suppressed
  when the target id is absent; the three MCP tool descriptions gain a
  matching sentence.
  Pretty-only — `json` / `yaml` output is byte-unchanged.
  `availability-request show` is deliberately excluded (it already renders
  the job context inline).
- **`applications interview show`: inline `job.title` (#696).** Approach B
  of #694 — a user could see an interview but not tell which job it was
  for without a second `applications show` call. Adds `title` to the
  `Interview` op's `job` selection and renders a null-guarded `Title:`
  line in the CLI `Job` section; the MCP payload carries the field
  automatically. Re-evaluated per the #480 BY-DESIGN-to-OVERRIDE protocol:
  a single-field override of the #685 job-cascade trim — the heavy
  `jobActivityItemData` cascade (roughly 50 fields) stays trimmed and
  reachable via `applications show <activityItemId>`. Wire-shape
  disposition: Schema/contract rule **triggered** (selecting `title`
  directly on `interview.job` is a hand-authored selection extension);
  **Track 1** (`Interview.snapshot.json` gains `job.title: string` and
  nothing else — verified surgically, not blind-regenerated). Validated
  live (`TTCTL_E2E=1`, update and assert modes both 3/3) via e2e file 62;
  `job.title` returned as a non-null string.

### Changed

- **TLS impersonation bumped to `chrome_147`; the User-Agent now derives
  from the profile (#38).** `node-wreq` catalog `^2.2.1` → `^2.4.1` (the
  first release shipping a `chrome_147` profile); `IMPERSONATE_PROFILE`
  `chrome_145` → `chrome_147`. `USER_AGENT` now derives its Chrome major
  from `IMPERSONATE_PROFILE` instead of a second hardcoded literal, so the
  UA and the TLS fingerprint can no longer drift — a profile bump rotates
  the whole identity bundle. The photo-upload multipart path previously
  hardcoded its own `Chrome/145.0.0.0` UA (a live cross-layer mismatch);
  it now imports the shared constant. Verified live against the
  Cloudflare-protected `talent_profile` portal (`TTCTL_E2E=1`, read-only
  contracts file, 3/3) — no `Cf403Error` with the `chrome_147`
  fingerprint. Schema/contract rule **NOT triggered** (no wire-format
  change; the tracked-path edit is a pure UA-constant refactor).
- **`applications availability-request show`: the `Job` section leads with
  `Title:` (#699).** Reorders the section to lead with the human-readable
  title (then `Job id:` / `URL:` / `Client:`), matching the Title-first
  order `interview show` adopted in #696. Pretty-render only — field
  content, alignment, and the `json` / `yaml` projection are unchanged.
- **Published tarballs drop compiled test fixtures and orphaned sourcemaps
  (#701).** Surfaced by the 0.1.0 release-readiness audit (CROSS-1).
  `@ttctl/core` shipped 20 compiled test-fixture files under
  `dist/__tests__/**`, and every published package shipped `.js.map` and
  `.d.ts.map` files referencing a `src/` tree absent from the tarball
  (orphaned — zero debugging value; 224 of `@ttctl/cli`'s 452 files). A
  per-package `tsconfig.build.json` (build-only; the default
  `tsconfig.json` stays untouched so type-aware ESLint keeps seeing the
  fixtures) excludes `**/__tests__/**` and disables `sourceMap` /
  `declarationMap`. `.d.ts` declarations are preserved — consumers keep
  full types. `npm pack --dry-run`: core 216 → 100 files, cli 452 → 228.
  The sourcemap omission is a recorded, reversible 0.1.0 policy decision.
- **`THIRD-PARTY-NOTICES.md` ships in all four published packages
  (#705).** `node-wreq` prebuilt binaries statically link `wreq`
  (Apache-2.0) and BoringSSL (Apache-2.0) plus a permissive Rust crate
  graph, and upstream ships no `LICENSE` / `NOTICE` files in the binary
  subpackages — as an AGPL redistributor, TTCtl inherits the
  notice-preservation obligation. A root `THIRD-PARTY-NOTICES.md` records
  the verified licenses and is copied into every published tarball via
  `prepack` (and listed in `files`), alongside `LICENSE`.

### Fixed

- **`profile.portfolio.add`: strip update-only `toptalRelated` from the
  create wire (#645).** The MCP add tool advertised `toptalRelated` and
  `add()` forwarded it onto the create wire, but `PortfolioItemCreateInput`
  rejects the field (`Field is not defined`) — any add supplying it
  failed. A live bogus-id probe settled the asymmetry: create REJECTS the
  field while update ACCEPTS it, and on update the value is
  server-controlled (supplying `true` reads back `false`, mirroring
  Employment #402 / #508). `add()` now strips `toptalRelated` from the
  create payload; the MCP add tool drops it from its input schema;
  `update()` keeps it with a server-controlled doc note. The follow-up
  secondary-field audit (#693) probed the remaining optional create fields
  live and settled them as ACCEPTED (`highlight`, `accomplishment`,
  `clientOrCompanyName`, `websiteUrl`) — `toptalRelated` stays the only
  rejected optional create field. (#693's interim `highlight` strip was
  refuted by the live probe and reverted within this release window — no
  net behavior change for `highlight`.) Wire-shape disposition:
  Schema/contract rule **triggered**; **Track 1** (`createPortfolioItem`
  snapshot unchanged). Validated live (`TTCTL_E2E=1`; 12/12 in the final
  #693 run of `packages/e2e/src/36-profile-portfolio.e2e.test.ts`,
  re-confirming the `toptalRelated` rejection and update round-trip).
- **`node-wreq` native-module load failure surfaces an actionable typed
  error, and the supported-platform matrix is documented (#708).** On
  platforms where `node-wreq` ships no prebuilt binary (`linux-arm64-musl`,
  `win32-arm64`), `npm i -g ttctl` succeeds — the binaries are optional
  dependencies — and the FIRST Cloudflare-protected (`talent-profile`)
  call threw a raw `Failed to load native module` error while
  mobile-gateway calls kept working. A new `impersonatedFetch` wrapper
  translates the load failure into `NativeModuleUnavailableError`
  (`TtctlError` subclass, code `NATIVE_MODULE_UNAVAILABLE`) naming the
  live platform-arch pair, the supported set, and the two known gaps; all
  three impersonated `node-wreq` call sites route through it, the stock
  `undici` path is untouched (mobile-gateway commands keep working), and
  the README gains a supported-platforms matrix plus a drift-guard test
  that fails loudly if a future `node-wreq` bump rewords the load-failure
  messages the detector matches. Schema/contract rule **NOT triggered**
  (pure error-handling wrapper; no wire-format change).
- **`surveys.submit`: require mandatory answers client-side and model the
  CHECKBOX value vocabulary (#754).** A mandatory `INTERVIEW_ENDED`
  CHECKBOX question ("This interview didn't occur.") was unanswerable
  through ttctl: `surveys list` surfaced no value vocabulary for it
  (`answers: []`), and omitting it was rejected opaquely server-side
  (`(occurred): is not included in the list`). `prepareSubmission` now
  rejects unanswered `isMandatory` questions BEFORE any wire call, naming
  each (id and label), and `buildSurveyAnswers` validates an option-less
  CHECKBOX value as `"true"` / `"false"` (case-insensitive in, lowercase
  out, `id: null`) — the serialization the decompiled Android client uses
  (`String.valueOf(boolean)`). The wire format needed no change; the gap
  was vocabulary and completeness. CLI and MCP document the checkbox
  vocabulary and surface each question's `label`. Wire-shape disposition:
  Schema/contract rule **triggered** (inferred input contract); **Track
  1** (`SubmitSurvey` response snapshot unchanged). Live-confirmed
  2026-06-12 via the gated positive path (`TTCTL_E2E_SUBMIT_SURVEY`) — a
  real `INTERVIEW_ENDED` round-trip confirmed the unchecked-maps-to-
  `"false"`-maps-to-`occurred` contract.

### Security

- **MCP file-upload sandbox resolves symlinks before the prefix check,
  closing an exfiltration bypass (#707).** The path-prefix sandbox used
  `path.resolve` — logical `..` normalization only — so a symlink staged
  inside the sandbox pointing out (`~/Documents/innocent.pdf` to
  `~/.ssh/id_rsa`) with an allowed extension passed both defense-in-depth
  gates, and the upload path would read the link TARGET — arbitrary-file
  exfiltration to the operator's Toptal profile on a successful prompt
  injection (audit ref: security M1). `validateSandbox` now resolves the
  real on-disk location with `fs.realpathSync` (final component AND
  intermediate-dir symlinks) before the prefix check and refuses when the
  real location is outside `~/Documents` / `~/Downloads` / `~/Desktop` —
  refused, not silently followed; a symlink whose real target stays inside
  the sandbox is still accepted. On a realpath error the gate falls back
  to the lexical path (a path `realpath` cannot resolve is one `readFile`
  cannot read either). The `TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY=1` bypass and
  the extension allowlist are unchanged. Unit-level TDD: the bypass tests
  were RED against the pre-fix gate, GREEN after.

### Dependencies

- Bump `commander` 14.0.3 → 15.0.0 (#713), `@clack/prompts` 1.4.0 → 1.5.1
  (#714), `node-wreq` ^2.2.1 → ^2.4.1 (#681, the `chrome_147` bump above),
  `turbo` 2.9.14 → 2.9.16 (#715), `tsx` 4.22.3 → 4.22.4 (#716), `eslint`
  10.4.0 → 10.4.1 (#717), `typescript-eslint` 8.59.4 → 8.60.1 (#718),
  `@graphql-codegen/add` 7.0.0 → 7.0.1 (#719), `@graphql-codegen/cli`
  7.0.0 → 7.1.2 (#712), `vitest` and `@vitest/coverage-v8` 4.1.5 → 4.1.8
  (#720, #721), `actions/checkout` 6.0.2 → 6.0.3 (#711).
- Override transitive `shell-quote` to `^1.8.4` (GHSA-w7jw-789q-3m8p,
  critical, reachable via `@graphql-codegen/cli`). The release-time
  `pnpm audit --audit-level=high` gate flagged the freshly published
  advisory and blocked the first rc.14 publish attempt; the override
  re-resolves the locked 1.8.3 to the patched line.

## [v0.1.0-rc.13] - 2026-05-29

### Added

- **`surveys`: new top-level domain for answering pending Toptal surveys
  across `core` / `cli` / `mcp` (#671).** A talent can now list, answer,
  and leave free-text feedback on pending surveys (e.g. `INTERVIEW_ENDED`
  post-interview feedback, `NPS`, `ENGAGEMENT_ENDED`) without switching to
  the Toptal portal. All three ops are hand-authored against the
  mobile-gateway surface and route through **Track 1** wire-shape snapshots
  (each op is in the codegen-exclusion list, so no generated Zod schema
  exists). The two write ops are consent-gated behind a new ADR-009
  `survey-submission` consent domain (`--consent-survey-submission` /
  `surveySubmissionConsentIssued`, the 5th domain), since both are
  irreversible (there is no un-answer wire op) and route content to a third
  party.
  - **`surveys.list`: read-only `PendingSurveys` query (#672).** Surfaces
    each pending survey's `id`, `kind`, `title`, `isMandatory`,
    `alreadyAnswered`, and `questions[]` (each with `id`, `label`, `note`,
    `inputType`, and selectable `answers[]`) — everything an answer flow
    consumes. Core: `surveys.list(token)`. CLI: `ttctl surveys list [-o
pretty|json|yaml]`. MCP: `ttctl_surveys_list` (read-only, dryRun-capable).
    Wire-shape disposition: Schema/contract rule **triggered** (new
    hand-authored op; `Survey.kind` and `SurveyQuestion.note` are
    `Unknown`-typed in the synthesized SDL); **Track 1** (committed
    `packages/e2e/src/wire-snapshots/PendingSurveys.snapshot.json`, captured
    from real wire data). Validated live (`TTCTL_E2E=1`, two runs) via
    `packages/e2e/src/88-surveys-list.e2e.test.ts`; the live shape matched
    the projected `Survey[]` contract.
  - **`surveys.submit`: answer a pending survey via `SubmitSurvey`
    (#673).** Resolves `kind` and per-question answer-option ids from the
    pending list, so the caller supplies only `<surveyId>` and
    `<questionId>=<value>` pairs. Core: `surveys.submit(token, fields,
consent, options)` (consent gate, then resolve kind and option ids from
    `PendingSurveys`, then the mutation, mapping `USER_ERROR` on `errors[]`
    or `success:false`). CLI: `ttctl surveys submit <surveyId> --answer
<qid>=<value>` (repeatable) `--consent-survey-submission`. MCP:
    `ttctl_surveys_submit` (`destructiveHint`, consent literal, zero-network
    `dryRun` preview). Wire-shape disposition: Schema/contract rule
    **triggered** (hand-rolling `SurveyAnswerInput` is the inference act);
    **Track 1** (committed `SubmitSurvey.snapshot.json`). Validated via the
    always-on safe paths in `packages/e2e/src/89-surveys-submit.e2e.test.ts`
    (consent-missing refusal and `NOT_FOUND` resolution, both exercising
    live bearer auth and the gateway `PendingSurveys` read) plus a live
    round-trip (2026-05-29) that submitted a real `INTERVIEW_ENDED` survey
    and confirmed it dropped out of `pendingSurveys`; the gated DESTRUCTIVE
    positive path (`TTCTL_E2E_SUBMIT_SURVEY`) automates the real submit for
    opt-in operators.
  - **`surveys.feedback`: free-text feedback via `AddSurveyFeedback`
    (#674).** Mirrors `submit`, and accepts an explicit `--kind` to reach a
    non-pending survey (e.g. already-answered — the drained-account escape
    hatch). Reuses the `survey-submission` consent domain (no consent or ADR
    change). Core: `surveys.addFeedback(...)` sends the portal-shape `{ kind,
surveyId, feedback }` over the mobile gateway. CLI: `ttctl surveys feedback
    <surveyId> --text <text>`. MCP: `ttctl_surveys_feedback`
    (`destructiveHint`, consent literal, `dryRun` preview). Wire-shape
    disposition: Schema/contract rule **triggered**; **Track 1** (committed
    `AddSurveyFeedback.snapshot.json`). Satisfied by a **capture-based
    disposition** rather than a fresh live round-trip — routing irreversible
    third-party feedback is the exact harm the consent gate guards, and the
    test account had no pending surveys. The `{ kind, surveyId, feedback }`
    wire shape is established from the portal `AddSurveyFeedback` capture
    (proves `kind` exists on the input type), the mobile `AddFeedbackToSurvey`
    capture (omits `kind`, proving it optional on the shared input type), and
    the #673 live transcript (the sibling `surveys.*` op accepts the
    `kind`-bearing portal shape on the gateway). The always-on safe paths in
    `packages/e2e/src/90-surveys-feedback.e2e.test.ts` exercise the live wire
    now; the gated positive path (`TTCTL_E2E_ADD_SURVEY_FEEDBACK`) refreshes
    the snapshot on first natural survey availability.
- **`profile.employment.reportingToAutocomplete`: server-vetted autocomplete
  for `Employment.reportingTo` (#468).** Read-only wrapper over the
  talent-profile `GET_REPORTING_TO_AUTOCOMPLETE` query — given a name prefix,
  returns the suggestions Toptal will accept for the `reportingTo` field. A
  min-length prefix gate (whitespace-trimmed) fires BEFORE any profile-id
  resolution or wire call. Core:
  `profile.employment.reportingToAutocomplete(token, prefix, options?)`. CLI:
  `ttctl profile employment reporting-to-autocomplete <prefix> [--limit N]`.
  MCP: `ttctl_profile_employment_reporting_to_autocomplete`. Wire-shape
  disposition: Schema/contract rule **triggered** (new hand-authored op under
  `packages/core/src/services/profile/employment/**`, in
  `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`); **Track 1**. Validated live
  (`TTCTL_E2E=1`, 2/2) via
  `packages/e2e/src/87-profile-employment-reporting-to-autocomplete.e2e.test.ts`
  (HTTP 200, no GraphQL errors, parses correctly); the wire-shape snapshot is
  **not yet captured** — the test account returned empty (`[]`) for every
  candidate prefix (the account-feature-gated family), so
  `assertWireShapeStable` auto-captures on the first run that yields a
  suggestion.

### Fixed

- **`profile.skills.add-connection`: accept base64-encoded Relay node ids
  (#646).** Regression from rc.12's `connectionType` trim (#626): the
  client-side `inferConnectionTypeFromId` cross-check demanded the _decoded_
  `V1-{Type}-NNN` form, but the canonical wire shape returned by every
  `*.list` tool (and sent by the SPA) is the _encoded_ base64 form
  (`VjEtRW1wbG95bWVudC0xMjM0NQ==`). Ids piped from `skills.list` /
  `employment.list` / `education.list` / `certifications.list` /
  `portfolio.list` were rejected client-side with `VALIDATION_ERROR` before
  the wire call, so no working `connectionId` was reachable end-to-end. Fix
  (Approach B, decode-then-fall-back-to-raw): a new `decodeRelayNodeId`
  helper base64-decodes behind a printable-ASCII gate (encoded ids decode to
  the Relay-shaped string; raw ids decode to non-printable noise and fall
  through to the raw path), so both the encoded canonical form and the
  decoded back-compat form cross-check correctly. The wire payload still
  ships the caller's original input verbatim — no transformation. Sibling
  description sweep across the `add-connection` and `remove-connection` CLI
  help and MCP tool descriptions clarifies that `*.list` tools return the
  encoded form. Wire-shape disposition: Schema/contract rule **triggered**
  (touches `packages/core/src/services/profile/skills/**`), but this is a
  client-side validator widening — the `AddProfileSkillSetConnectionInput {
skillSetId, connectionId }` wire shape is unchanged; **Track 1**
  (`addProfileSkillSetConnection` snapshot capture remains the pre-existing
  deferred gap from #462 / #626).

## [v0.1.0-rc.12] - 2026-05-26

### Added

- **`profile.employment.skills.add` / `profile.employment.skills.remove`:
  per-skill additive wrappers over the full-replace `UpdateEmployment`
  (#614).** Bulk profile uplift across many employments (the maintainer
  carries 13 rows, the largest with 100+ skills) previously forced callers
  to re-implement the read-merge-write bookkeeping ttctl already performs
  internally — one merge script per additive op. Both leaves wrap
  `update()`'s `buildUpdateEmploymentInput` merge path: read the current
  row via `show()`, compute the merged (dedupe by id, preserve current
  order) or filtered skills array, then fire one `UpdateEmployment`
  mutation per row. Discriminated outcome (`updated | noop | preview`):
  `add` returns `noop` when every supplied id is already linked (no wire
  fire); `remove` returns `noop` when no supplied id matches the row AND
  refuses with `VALIDATION_ERROR` when the filtered set would be empty
  (Toptal server rejects `skills: []`, naming `profile.employment.remove`
  as the row-level alternative); caller-supplied duplicates dedupe against
  each other and against current state. Core: `profile.employment.skills`
  namespace exporting `add(token, employmentId, skillIds, options)` and
  `remove(...)`. CLI: `ttctl profile employment skills {add,remove} <id>
--skill-id <id>` (repeatable). MCP: `ttctl_profile_employment_skills_{add,remove}`
  using the existing `DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER` for zero-wire
  preview. Wire-shape disposition: Schema/contract rule **triggered**
  (path `packages/core/src/services/profile/employment/**`) but introduces
  no new GraphQL ops — both wrappers route through the existing
  `UpdateEmployment` mutation; **Track 1 (existing snapshot)** —
  `UpdateEmployment` snapshot owned by
  `46-profile-employment-update-merge.e2e.test.ts`. Validated live
  (`TTCTL_E2E=1`) via `packages/e2e/src/79-profile-employment-skills.e2e.test.ts`
  (add → idempotent re-add → remove → idempotent re-remove →
  refusal-on-empty).
- **`profile.skills.remove-connection`: per-edge unlink of one
  `ProfileSkillSet → entity` link via the `removeProfileSkillSetConnection`
  mutation (#463).** Sibling to `profile.skills.add-connection` (#462 /
  rc.11); removes one connection without cascading to the whole skill-set.
  Wire input is **CAPTURED**
  (`research/captures/web/inputs/RemoveProfileSkillSetConnectionInput.json`):
  `{ skillSetId, connectionId }` — two fields, no `connectionType` (the
  server discriminates the target from the Relay node id's base64 type
  prefix; this refutes the prior Pattern-6 inference in
  `research/notes/10`). Same ADR-009 `profile-capability` consent domain
  (`profileCapabilityConsentIssued: true`). Core:
  `profile.skills.removeConnection(token, fields, consent, options)`
  returns `{ skillSetId, connectionsCount, connectionIds, notice }` with
  the just-unlinked id absent from `connectionIds`; consent gate
  (`CONSENT_REQUIRED` fires BEFORE dry-run); `USER_ERROR` mapping for
  `success: false` / `errors[]`; `UNKNOWN` for null payload;
  `AuthRevokedError` / `Cf403Error` propagated. CLI: `ttctl profile skills
remove-connection --skill-set-id <id> --connection-id <id>
--consent-profile-capability` (no `--connection-type` flag — locked at the
  unit level by `expect(flags).not.toContain('--connection-type')` to
  prevent regression to the 3-field wire shape). MCP:
  `ttctl_profile_skills_remove_connection` with `destructiveHint: true`
  and `profileCapabilityConsentIssued: z.literal(true)`. Wire-shape
  disposition: Schema/contract rule **triggered** (new GraphQL op
  `removeProfileSkillSetConnection` under
  `packages/core/src/services/profile/**`, in
  `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`); **Track 1** — snapshot file
  `packages/e2e/src/wire-snapshots/removeProfileSkillSetConnection.snapshot.json`
  is intentionally absent at PR-merge time and captured operator-driven
  via `TTCTL_E2E_REMOVE_SKILL_CONNECTION=…:… TTCTL_UPDATE_WIRE_SNAPSHOTS=1`
  post-merge (mirrors sibling #462). Validated live (`TTCTL_E2E=1`) via
  `packages/e2e/src/80-profile-skills-remove-connection.e2e.test.ts`
  (always-on dry-run + consent-missing paths; gated DESTRUCTIVE positive
  path requires a populated skill-set with a linked target).

### Changed

- **`profile.skills.add-connection`: trim wire-extra `connectionType` and
  add a Relay-prefix cross-check (#626).** The capture
  `research/captures/web/inputs/AddProfileSkillSetConnectionInput.json`
  sends only `{ skillSetId, connectionId }` (two fields) — the server
  discriminates the target from the Relay node id's base64 type segment.
  ttctl's previous send shape (three fields including `connectionType`)
  was Pattern-6 inferred at #462; this PR aligns the wire to the captured
  shape and keeps `--connection-type` at the CLI / MCP surface as a
  client-side UX guard. New private `inferConnectionTypeFromId` helper +
  `RELAY_PREFIX_TO_CONNECTION_TYPE` map cross-check the declared
  `connectionType` against the `connectionId` Relay prefix; both an
  unrecognized prefix and a prefix-vs-declared-type mismatch now throw
  `VALIDATION_ERROR` BEFORE any wire call. Wire-shape disposition:
  Schema/contract rule **triggered** (existing op, wire input shape
  modified; touches `packages/core/src/services/profile/**`); **Track 1**
  (`addProfileSkillSetConnection` in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`;
  the response snapshot at
  `packages/e2e/src/wire-snapshots/addProfileSkillSetConnection.snapshot.json`
  is unchanged, and the request-side trim is asserted at the unit-test
  level via `.toEqual` on the dry-run preview's `variables.input`).
  **BC**: callers passing an unrecognized Relay prefix or a
  prefix-vs-declared-type mismatch now surface `VALIDATION_ERROR` at the
  service boundary instead of a `GRAPHQL_ERROR` from the live wire —
  same end-state (operation refused), better diagnostics. Suite-wide
  sweep dropped stale "Pattern-6 / INFERRED wire shape" claims from the
  CLI `--help`, service / tool JSDoc, the `78-profile-skills-add-connection.e2e.test.ts`
  header, and the `addProfileSkillSetConnection` row rationale in
  `docs/wire-validation-routing.md`.

### Fixed

- **`profile.specializations.show` exposes `operations.apply.callable` as
  a string, not a boolean (#637).** The synthesized schema declares
  `Operation.callable: String!` (empirical value `"ENABLED"`) and the
  codegen already types every other site correctly; only the
  specializations service mistyped it as `boolean` and projected with
  `?? false` — the wire was always returning a string ("ENABLED"), and
  `TTCTL_E2E=1 pnpm test:e2e src/66-profile-specializations-show.e2e.test.ts`
  surfaced the drift via `typeof apply["callable"]` returning `"string"`
  not `"boolean"`. **Scope**: `SpecializationApplyOperation.callable`
  retyped `string`; projection defaults to `""` on a missing wire field;
  pretty / table formatters drop the dead `.toString()` calls; CLI text
  formatter renders `(unset)` for the empty default; MCP tool docs
  corrected. **BC**: the JSON / YAML output for
  `ttctl profile specializations show` now emits a string value (e.g.
  `"ENABLED"`) instead of a boolean — `jq` / `yq` consumers comparing
  with `==` or `===` need to compare against the string. Same posture
  for callers of `profile.specializations.show()` programmatically.
- **`profile.education.update` no longer nulls omitted writable fields under
  the full-replacement contract, and `add`/`update` map ttctl-surface
  `institution` to wire `title` (the only school-name slot on
  `EducationInput`) (#612).** Same posture as `UpdateCertification` #605
  and `UpdateBasicInfo` #604: `UpdateEducation` treats `EducationInput` as
  a full replacement — pre-fix, calling `ttctl profile education update
<id> --highlight true` would null every other field server-side. Pre-fix,
  `add()` and `update()` also sent `education.institution: <value>` to a
  wire input that has no `institution` slot (capture
  `research/captures/web/inputs/UpdateEducationInput.json`) — the live API
  rejected with `GRAPHQL_ERROR`, blocking BOTH adding and updating
  education rows from ttctl. **Scope**: `core` `update()` now reads the
  current row via `show()` then merges through the exported
  `buildUpdateEducationInput(current, fields)` helper (mirror of
  `buildUpdateCertificationInput`); `add()` builds the wire input via
  `toEducationWireInput(fields)` and defaults `skills: []` (the wire
  requires non-null, same `.blank?` posture as the cert sibling).
  `DRY_RUN_EDUCATION_FIELD_PLACEHOLDER` is exported for the MCP layer;
  the MCP `_update` dry-run preview now surfaces the placeholder for
  every unconditional-echo field. **BC**: removed the `--title` flag from
  `ttctl profile education add`/`update` and the `title` input on the
  MCP `ttctl_profile_education_add`/`_update` tools — the wire `title`
  slot is owned by `institution` (school name), and the read-side
  `Education.title` is server-populated, not user-controlled. Any caller
  passing `--title` was previously overwriting the school name; no
  preservation path exists because the previous semantics were
  data-corrupting.
- **`profile.skills` `experience` is years on the wire, not months (#627).**
  The MCP `ttctl_profile_skills_update.experience` docstring claimed
  "months"; the CLI `--experience` flag, `parseExperience` parser,
  validation messages, and pretty-print rendering all carried the same
  wrong-unit assumption (with `parseExperience` ACTIVELY multiplying `Ny`
  inputs by 12). The wire capture at
  `research/captures/web/inputs/UpdateProfileSkillSetExperienceInput.json`
  annotates `Int (years; 1-20+)`, and several talents' public profiles
  rendered nonsense values (e.g., "60 years" for a skill the caller
  intended as 5 years). **Scope**: corrected every docstring, validation
  message, help text, parser, format helper, service jsdoc, test fixture,
  and snapshot in the skills sub-domain. `parseExperience` no longer
  multiplies by 12 — `5y` now returns `5`; the `Nm` (months) shorthand
  is rejected outright (was never working semantics). Added defensive
  `.max(70)` Zod bound on both `ttctl_profile_skills_add.experience` and
  `ttctl_profile_skills_update.experience` so corruption attempts
  surface at the MCP boundary instead of silently landing on the wire.
  **BC note**: any caller passing `--experience 5y` previously sent `60`
  (= 60 years on the wire — already broken); now sends `5` correctly. No
  preservation path exists for the previous semantics because the
  previous semantics were data-corrupting.

## [v0.1.0-rc.11] - 2026-05-26

### Added

- **`profile.skills.add-connection`: link an existing `ProfileSkillSet` to a
  single employment / education / certification / portfolio row via the
  `addProfileSkillSetConnection` mutation (#462).** Pattern-6 mutation —
  sibling to `profile.specializations.apply` (#467 / PR #534) under the same
  ADR-009 `profile-capability` consent domain (`profileCapabilityConsentIssued:
true`). Core: `profile.skills.addConnection(token, fields, consent,
options)` returns `{ skillSetId, connectionsCount, connectionIds, notice }`
  with write-read symmetry against the existing `list()` read. CLI: `ttctl
profile skills add-connection --skill-set-id <id> --connection-type
<EMPLOYMENT|EDUCATION|PORTFOLIO_ITEM|CERTIFICATION> --connection-id <id>
--consent-profile-capability`. MCP: `ttctl_profile_skills_add_connection`
  with `destructiveHint: true` and `profileCapabilityConsentIssued:
z.literal(true)`. Wire-shape disposition: Schema/contract rule
  **triggered** (new GraphQL op `addProfileSkillSetConnection` under
  `packages/core/src/services/profile/**`, hand-authored against
  `talent-profile`, in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` — both input and
  payload positions are `Unknown` in the synthesized SDL); **Track 1** (new
  `packages/e2e/src/wire-snapshots/addProfileSkillSetConnection.snapshot.json`,
  recorded against the live mutation). Validated live (`TTCTL_E2E=1`) via
  `packages/e2e/src/78-profile-skills-add-connection.e2e.test.ts`.
- **`profile.countries.list`: expose the `getCountries` query as a catalog
  lookup across `core` / `cli` / `mcp` (#596).** Wave-2 follow-up to #586 —
  surfaces the live-verified country catalog so users can discover a valid
  id for `employment.update --primary-geography-id` (and any future site
  consuming a Country id, e.g. `BasicInfo.countryId` / `citizenshipId`).
  Namespace chosen at the top level rather than nested under `employment`
  via `/council` CONVERGENT+HIGH_CONFIDENCE+FALSIFIER-CONVERGENT, since
  Country is a multi-consumer catalog (3 sites) and breaks the
  single-consumer `employerAutocomplete`-nesting precedent. Core:
  `profile.countries.list(token)` → `Country[]` `{ id, code, name }`
  (defensive projection, no-silent-empty contract, mirrors `industries.list`).
  CLI: `ttctl profile countries list [-o pretty|json|yaml]`. MCP:
  `ttctl_profile_countries_list` (read-only, `dryRun`-capable). Wire-shape
  disposition: Schema/contract rule **triggered** (new GraphQL op
  `getCountries` under `packages/core/src/services/profile/**`); **Track 1**
  (committed `packages/e2e/src/wire-snapshots/getCountries.snapshot.json` —
  shape-only `{ code, id, name }`, no PII; `getCountries` is in
  `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`). Validated live (`TTCTL_E2E=1`) via
  `packages/e2e/src/77-profile-countries-list.e2e.test.ts`.

### Fixed

- **Full-replace merge bug class umbrella closed (#604 / #605 / #606 / #607
  / #608).** Toptal's `talent_profile` `<Entity>Input` mutations are
  full-replacement contracts: fields OMITTED from the input are NULLED
  server-side. ttctl services that sent partial inputs silently nulled
  unsent fields. This release ships per-member fixes plus a structural CI
  defense so the class cannot regress.
  - **`profile.basic.set`: preserve 6 social URLs + skype on every
    bio/headline edit (#604).** `UPDATE_BASIC_INFO` is full-replacement
    (#393). The previous merge omitted **all six** social fields the live
    `profile` input carries (`linkedin / github / website / behance /
dribbble / skype`), so every minimal edit silently wiped them. The
    reported scope was 3 fields; the 2026-05-06 live curl in
    `research/notes/10` § Captured exception proved all six. `GET_BASIC_INFO`
    now reads the six fields and the merge echoes them back unchanged, the
    same way `twitter` already worked. **Write ownership is unchanged**: per
    #526 these remain `external.update`-owned; `basic.set`'s `ProfileUpdate`
    still does not accept them as inputs. The merge only preserves; it
    never overrides. Wire-shape disposition: Schema/contract rule
    **triggered** (`UPDATE_BASIC_INFO`; selection grew on `GET_BASIC_INFO`
    and the merge wrapper grew 6 preserved fields); **Track 1** (existing
    `UPDATE_BASIC_INFO` snapshot updated; the 6 new echo fields validated
    via the round-trip in `44-profile-basic.e2e.test.ts`).
  - **`profile.certifications.update`: add read-current+merge over the
    full-replacement `UpdateCertification` contract (#605).** Mirrors the
    proven `buildUpdateEmploymentInput` pattern: read the row via `show()`,
    build a merged `CertificationInput`, layer the user-supplied fields on
    top. A minimal edit (e.g. toggling `highlight`) previously wiped
    `certificate` / `institution` / `link` / `number` / validity dates /
    `skills`. Live-wire discovery during this work: `CreateCertification` /
    `UpdateCertification` REQUIRE non-null `certification.skills` (Rails
    `.blank?` min-1, same gate as #394) — `skills` is now on
    `CertificationFields` as **preservation-only** (`add()` defaults `[]`,
    `update()` echoes `current.skills`); no new CLI / MCP writable flag.
    `#605`'s scope originally also covered `education.update`, but a
    deeper, pre-existing bug surfaced (`education.add/update` send
    `institution`, which the wire's `EducationInput` does NOT define — the
    wire field is `title`); education was split to **#612** for separate
    reverse-engineering. Wire-shape disposition: Schema/contract rule
    **triggered**; **Track 1** (`UPDATE_CERTIFICATION` in
    `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`; committed
    `packages/e2e/src/wire-snapshots/UPDATE_CERTIFICATION.snapshot.json`).
  - **`profile.external.update`: confirm partial-merge contract + correct
    MCP dry-run wrapper key (#606).** `#606` originally suspected
    `UpdateExternalProfiles` of being full-replacement like its #604
    sibling. Empirically refuted: a live E2E that sets ONE writable field
    to a distinct new value (unique-query-param trick to rule out the
    "server no-ops unchanged input" confound) and re-reads via a fresh
    `show()` proves the OTHER writable URLs are preserved. No client-side
    read-merge is warranted. The PR ships the regression-guard E2E plus a
    real adjacent fix: the MCP `ttctl_profile_external_update` dry-run
    preview emitted the stale `externalProfiles:` wrapper key while the
    apply path uses `profile:` — corrected, with 2 unit tests pinning the
    preview to the apply-path shape. Core `update()` JSDoc now records the
    verified partial-merge contract and contrasts the full-replace siblings.
    Wire-shape disposition: Schema/contract rule **triggered**; **Track 1**
    (`UpdateExternalProfiles` snapshot unchanged; new
    `74-profile-external-update-merge.e2e.test.ts` proves the contract).
  - **`profile.employment.update`: defense-in-depth read-merge for
    `highlight` (#607).** Echo `current.highlight` into
    `buildUpdateEmploymentInput`'s merged base so partial employment
    updates that omit `highlight` cannot wipe it server-side. Live E2E
    against the PRIMARY account reveals the server preserves the field on
    omit (same regime as `toptalRelated` per helper-doc § "the field's
    PERSISTED-state on update is server-controlled" and the parallel
    finding for `external.update` in #606), but pattern-consistency with
    #487 / #604 + wire-shape-drift insurance (cf. #275) justify shipping.
    Wire-shape disposition: Schema/contract rule **triggered**; **Track 1**
    (`UpdateEmployment` snapshot unchanged — defense-in-depth at the
    client merge layer, not a wire shape change).
  - **`profile.availability.workingHours.set`: defense-in-depth read-merge
    on the apply path (#608).** The last open verification in the bug-class
    table. Echo current snap fields before applying caller overrides on the
    apply path; dry-run path stays unchanged per the existing #164 AC.
    Empirical verdict via with-fix-stashed E2E: **partial-merge** (same
    regime as #606 / #607). Defense-in-depth for pattern consistency +
    wire-shape-drift insurance.
  - **CI gate: `scripts/check-merge-completeness.ts` (#608).** New
    structural defense wired into `pnpm lint`. Walks
    `research/captures/web/inputs/*Input.json` and for each capture
    asserts the captured payload roster ⊆ ttctl's sent field set for the
    matched operation. Three resolution patterns (inline literal, variable
    assignment, helper call). Per-field exemption via `//
merge-complete-exempt: <field> — <reason>`. Default warn-mode;
    `MERGE_COMPLETENESS_STRICT=1` (or `--strict`) to fail on non-exempt
    gaps once the currently-open gap (#612 `education.update`) is paid
    down. Sibling to existing `check-write-read-symmetry.ts` (Class B),
    `check-surface-coverage.ts` (Class A), and `check-e2e-coverage.ts`
    defenses. CLAUDE.md § Merge-completeness gate documents the contract,
    exemption syntax, and capture-vs-invocation pairing rules.

- **`jobs.apply`: restore `JobApplicationRateInsight` aliases + decouple
  rate-insight pre-fetch from the apply mutation (#610).** `ttctl jobs
apply` aborted with HTTP 400 because the inline `JobApplicationRateInsight`
  query selected `estimatedRevenue` bare on both `TalentJobRateInsight`
  union variants; the live gateway rejected with `FieldsInSetCanMerge`
  despite the synthesized SDL declaring both members compatible.
  - **Track B (root cause)** — restored per-variant aliases on the wire
    query (`competitiveRevenue: estimatedRevenue`, `uncompetitiveRevenue:
estimatedRevenue`, plus matching `*Explanation` pair), mirroring the
    captured mobile op. Public `RateInsight` type unchanged;
    `projectRateInsight` bridges wire → public.
  - **Track A (defense-in-depth)** — the apply mutation should never have
    been blocked by an unused read-only pre-fetch. `apply()`'s
    `Promise.all` now only awaits `applyData` + `applyQuestions`;
    `rateInsight` is fire-and-forget — failures emit a stderr warning and
    apply proceeds. `_shared/transport.ts` non-2xx errors now surface
    `body.errors[0].message` so the next wire breakage self-diagnoses (the
    bare `"returned HTTP 400"` is what forced operator re-curl to identify
    #610 in the first place).
  - Wire-shape disposition: Schema/contract rule **triggered** (alias
    addition on existing fields in `JOB_APPLICATION_RATE_INSIGHT_QUERY`);
    **Track 1** (new
    `packages/e2e/src/wire-snapshots/JobApplicationRateInsight.snapshot.json`
    — the exact breakage class snapshots detect structurally; sibling
    `JobApplyData.snapshot.json` added incidentally). Validated live
    (`TTCTL_E2E=1`) via `57-jobs-apply-data.e2e.test.ts` — 7/7 including
    the rate-insight happy path that surfaced #610.

## [v0.1.0-rc.10] - 2026-05-25

### Added

- **`interest_requests.accept` / availability-request show: surface
  `matcherQuestions` (the screening questions, dropdown options, and
  suggested answers) on the `AvailabilityRequestDetail` read shape
  (#585).** Embeds `job.questions(hideExpertiseQuestion: true)` into the
  `AvailabilityRequest` query, reusing #584's `MATCHER_QUESTION_SELECTION`
  and `projectMatcherQuestion` seam verbatim (the same `ApplicationQuestion`
  shape: `identifier`, `prompt`, `inputType`, `options`, `suggestedAnswer`,
  `isMandatory`). Purely additive — `matcherQuestions` is a sibling
  top-level field, leaving the shared `ApplicationJobRef` untouched; the CLI
  gains a "Matcher questions" section and the MCP accept-tool docstrings
  redirect off the broken `ttctl_applications_show` to the working AR-show
  source. Wire-shape disposition: Schema/contract rule **triggered** — the
  selection adds the **[INFERRED]** `options` and `suggestedAnswer { answer }`
  sub-fields (same provenance as #584, absent from the synthesized
  `JobPositionQuestion`); **Track 1** (new structure-only snapshot
  `packages/e2e/src/wire-snapshots/AvailabilityRequest.snapshot.json`,
  recording all 7 `ApplicationQuestion` fields). Validated live
  (`TTCTL_E2E=1`) against a real availability request carrying 5 matcher
  questions, asserting the per-entry shape resolves on the live wire.
- **`profile.employment.add` / `profile.employment.update`: accept
  `primaryGeographyId` as a write parameter (MCP `primaryGeographyId`, CLI
  `--primary-geography-id <id>`) (#586).** `employment_list` already
  surfaced `primaryGeography` on the read shape, but neither write path let
  you set it. Wrapper-only change — core's `EmploymentFields` already
  threaded the field and `Employment.primaryGeography` already echoed it;
  this exposes it at both user-facing surfaces. Wire-shape disposition:
  Schema/contract rule **triggered** (new INPUT field on the inferred
  employment mutation input); **Track 1** (`CreateEmployment` /
  `UpdateEmployment` remain T1 via the snapshots owned by the employment
  e2e tests; the new input field is validated by the live round-trip, not
  re-snapshotted). Validated live (`TTCTL_E2E=1`) by round-tripping the
  field on create and update and re-assigning a second country, restoring
  prior state in `finally`.
- **`profile.employment.add` / `profile.employment.update`: accept
  `engagementId` (the link to a Toptal `TalentEngagement`) as a write
  parameter (MCP `engagementId`, CLI `--engagement-id <id>`) (#587).** The
  sibling capability to #586's `primaryGeography`, using the identical
  input/echo wrapper pattern. Wire-shape disposition: Schema/contract rule
  **triggered** (new INPUT field on the inferred employment mutation
  input); **Track 1** (`CreateEmployment` / `UpdateEmployment` remain T1;
  the new input field is validated by the live round-trip, not
  re-snapshotted). Validated live (`TTCTL_E2E=1`) by round-tripping
  `engagementId` on both `CreateEmployment` and `UpdateEmployment` —
  resolving the create-path uncertainty: it is a clean wrapper-only field
  like #586. The `engagementId ↔ Employment` link is a pre-existing
  warn-mode write-read-symmetry gap (the field predates the echo),
  consistent with siblings `industryIds` / `primaryGeographyId` — not a
  regression.
- **`interest_requests.accept` dry-run: resolve the actual
  `requestedHourlyRate` and `kind` in the preview instead of
  `"<resolved at apply time>"` placeholders (#593).** Moves the existing
  read-only `GetAvailabilityRequestKind` resolution ahead of the dry-run
  branch, so the preview carries the exact variables the apply path would
  send; resolution runs only when a value is omitted (both-supplied stays
  zero-transport), the irreversible `ConfirmAvailabilityRequest` mutation is
  never issued under dry-run, and resolution failures (unknown id,
  FLEXIBLE-needs-rate) now surface in the preview rather than at apply time.
  Core-only fix; MCP / CLI are pass-through and auto-improve. Wire-shape
  disposition: Schema/contract rule **NOT triggered** — reuses the existing
  `GetAvailabilityRequestKind` query (no new op or field); the only
  behavioral change is that dry-run now performs the read-only resolution it
  previously skipped. **Track**: no new op (existing
  `ConfirmAvailabilityRequest` = T1, `GetAvailabilityRequestKind`
  unchanged). Validated live (`TTCTL_E2E=1`) against a real pending FIXED
  interest request, asserting the preview resolves `requestedHourlyRate` /
  `kind` to real values (read-only — no mutation issued).

### Fixed

- **`ttctl --version` now reports the real package version instead of the
  hard-coded `0.0.0` (#582).** `packages/cli/src/program.ts` hard-coded
  Commander's `.version("0.0.0")`; the release workflow stamps
  `package.json` but not that string, so every published binary's
  `--version` lied while npm metadata stayed correct. Replaced with
  `.version(readPackageVersion(import.meta.url))` (the `@ttctl/core`
  helper) so the umbrella `ttctl` and `@ttctl/cli` report the stamped
  version with zero workflow change. Wire-shape disposition: Schema/contract
  rule **NOT triggered** — CLI-only, no GraphQL operation. **Track**: N/A.
- **`profile.industries.list` / `profile.industries.show`: drop the invalid
  `nodes` wrapper on the `IndustryProfile` curation sub-fields (#583).** The
  hand-authored `ListIndustryProfiles` / `GetIndustryProfile` selections
  wrapped curation sub-fields in a `nodes { … }` connection shape the live
  schema does not expose, risking a wire-shape mismatch. Selection corrected
  to the flat shape; `IndustryCurationRef { id }` and all surfaces (CLI and
  MCP) are otherwise unchanged. Wire-shape disposition: Schema/contract rule
  **triggered** — field-selection change on existing GraphQL ops;
  **Track 1** (`ListIndustryProfiles` / `GetIndustryProfile` are
  schema-gappy per `docs/wire-validation-routing.md`). Validated live
  (`TTCTL_E2E=1`): `ListIndustryProfiles`, `GetIndustryProfile`, and
  `RemoveIndustryProfile` wire shapes match their snapshots against the live
  API.
- **`jobs.apply_questions`: surface dropdown `options`, `suggestedAnswer`,
  and the question `inputType` that were previously dropped (#584).** The
  `JobApplicationQuestions` selection projected only `id` / `question`, so
  dropdown choices, the suggested answer, and the free-text-vs-dropdown
  discriminator never reached the caller. Extends the selection and the
  `projectMatcherQuestion` mapper to the full `ApplicationQuestion` shape.
  Wire-shape disposition: Schema/contract rule **triggered** — `options` and
  `suggestedAnswer { answer }` are **[INFERRED]** (the synthesized
  `JobPositionQuestion` declares only `id` / `question`); **Track 1** (adds
  the previously-uncaptured
  `packages/e2e/src/wire-snapshots/JobApplicationQuestions.snapshot.json`).
  Validated live (`TTCTL_E2E=1`) by asserting the universal shape on every
  entry and round-tripping a real dropdown question's `options` /
  `suggestedAnswer`. (Surfaced, out of scope: the sibling
  `JobApplicationRateInsight` op returns HTTP 400 on the live wire today —
  pre-existing, not addressed here.)
- **`jobs.list` / `jobs.show` / job-activity: fix the HTTP 400 from an
  unguarded `id` selection on the polymorphic `mostRelevantApplication`
  (#530).** `mostRelevantApplication` resolves to a union
  (`AvailabilityRequest | JobApplication`); selecting a bare `id` on the
  union without inline fragments made the live API reject the whole query
  with HTTP 400, breaking `jobs list` / `jobs show` and the job-activity
  reads. Wrapped the selection in
  `... on AvailabilityRequest { id } ... on JobApplication { id }` at both
  sites and adjusted the `mostRelevantApplication` projection for the
  polymorphic shape. Wire-shape disposition: Schema/contract rule
  **triggered** — hand-authored query change; **Track 1** (captured the
  previously-missing `JobsList.snapshot.json` and
  `JobActivityItems.snapshot.json`). Validated live (`TTCTL_E2E=1`): the
  corrected queries resolve HTTP 200 with the polymorphic
  `mostRelevantApplication` shape against the live API.
- **`profile.employment.update` dry-run: list `endDate` (and the other
  merge-preserved fields) among the values resolved at send time (#589).**
  The MCP update dry-run preview hand-maintained a placeholder list that had
  drifted from the apply path's unconditional merge set — it showed 9 fields
  but `buildUpdateEmploymentInput` echoes 11 from current state, omitting
  `endDate`, `toptalRelated`, and `managementExperience`. Added the three
  missing fields (in core-merge order) and corrected a stale comment.
  MCP-only — core `update()` has no dry-run path; the preview is built
  entirely in the MCP tool. Wire-shape disposition: Schema/contract rule
  **NOT triggered** — offline dry-run, zero-transport, no wire op (the added
  fields are already wire-validated via the apply path). **Track**: NEITHER.
- **`profile.basic.set`: normalize the `twitter` value to the bare handle
  Toptal stores, accepting a full URL or a bare handle (#526).** The
  `UpdateBasicInfoInput` wire field is a **bare handle** (`alexey_pelykh`),
  not a URL — unlike the `linkedin` / `github` / `website` fields on the
  same input, which are full URLs (an in-input asymmetry). Callers
  naturally passed a profile URL (`https://x.com/<handle>`), which the
  server then stored verbatim as the "handle", and the field rendered
  broken on the public profile. `set()` now runs the supplied value
  through the new exported `normalizeTwitterHandle()` on BOTH the apply
  (merge) path and the dry-run preview: `https://x.com/<h>`,
  `https://twitter.com/<h>` (with optional scheme, `www.` / `mobile.`
  subdomains, legacy `#!/` hashbang, query / fragment, and a leading
  `@`) all reduce to the bare handle; a bare handle passes through
  unchanged; unrecognised shapes (e.g. `https://example.com/<h>`) pass
  through verbatim so Toptal — the only authority on handle validity —
  decides. Empty-string and `null` clear semantics are preserved
  (`""` → `""`, `null` → `null`). Wire-shape disposition: Schema/contract
  rule **triggered** (`UPDATE_BASIC_INFO` mutation; only the VALUE sent
  is normalized, the input/selection shape is unchanged); **Track 1**
  (existing `packages/e2e/src/wire-snapshots/UPDATE_BASIC_INFO.snapshot.json`,
  no shape change). Validated live (`TTCTL_E2E=1`) by round-tripping both
  a URL input and a bare-handle input through `basic.set` and asserting
  both persist as the normalized bare handle on the mutation echo,
  `basic.show`, and `external_show`.
  - **`profile.external.update`: reject a supplied `twitter` with an
    actionable redirect instead of silently dropping it.** `twitter` is
    NOT part of the external-profiles wire input (the 5 settable fields
    stay `linkedin` / `github` / `website` / `behance` / `dribbble`);
    previously the public `ExternalProfilesUpdate` type omitted it, so a
    supplied value was silently lost at every surface. `update()` now
    accepts `twitter` on its input type and throws a `VALIDATION_ERROR`
    carrying the shared `TWITTER_NOT_EXTERNAL_MESSAGE` — pointing the
    caller at `basic.set` (CLI `ttctl profile basic update --twitter`,
    MCP `ttctl_profile_basic_update`). The redirect fires before any
    transport call (and, on MCP, before the dry-run preview branch).
  - **CLI / MCP doc reconciliation**: `ttctl profile basic update
--twitter` help and the `ttctl_profile_basic_update` MCP field
    description now say the value accepts a URL or a bare handle and is
    normalized. `ttctl profile external update` regains a `--twitter`
    flag (and the MCP tool a `twitter` schema field) purely so the value
    reaches the redirect rather than being rejected as an unknown
    option / stripped by Zod.

## [v0.1.0-rc.9] - 2026-05-24

### Added

- **`profile.employment.list` / `profile.employment.show`: hydrate the
  `employer` catalog card (`name`, `city`, `country`, `logoUrl`,
  `employeeCount`, `industries`) on the `Employment` read shape (#555).**
  Previously `Employment` surfaced only the employer's catalog **id**
  (`employerId`), forcing a separate `employersAutocomplete` lookup for
  any context. Extends `EMPLOYMENT_FRAGMENT`'s `employer { id }`
  sub-selection to the curated subset of the canonical `Employer`
  fragment (`research/graphql/talent_profile/fragments/Employer.graphql`)
  and projects a nested `employer` object through `mapEmploymentNode`
  with per-scalar defensive guards (the card collapses to `null` for
  custom non-catalog workplaces — the same rows where `employerId` is
  `null`; `name` falls back to `""`, the nullable scalars to `null`,
  `employeeCount` to `null` for any non-number, `industries` to `[]`).
  `revenue` / `otherNames` / `otherUrls` / `lastSyncedAt` / `website`
  remain unprojected (lower-priority follow-up). The flat `employerId`
  is unchanged — it remains the field consumed by the update-merge path
  (#394). Wire-shape disposition: Schema/contract rule **triggered** with
  **INFERRED** wire shape (every `Employer` field is `Unknown` in synth
  SDL — `employeeCount` typed `number | null` from the web app's numeric
  rendering, the rest from the `EmployerSuggestion` autocomplete shape);
  Track 1 (wire-shape snapshot at
  `packages/e2e/src/wire-snapshots/GET_WORK_EXPERIENCE.snapshot.json`,
  extended with the `employer` sub-shape). The pre-existing
  `43-profile-employment.e2e.test.ts` already exercises
  `GET_WORK_EXPERIENCE` post-projection wire shape via
  `assertWireShapeStable`; the new sub-fields land inside the same shape
  contract automatically.
  - **CLI renderer changes**: `formatEmploymentText` (per-row pretty)
    gains a compact `employer: <name> (<city, country>; ~<N> employees)`
    header with optional `logo` and `employer industries` sub-lines (all
    omitted for custom workplaces). `formatEmploymentTable` (key/value)
    gains one row per card field (`employer`, `employerCity`,
    `employerCountry`, `employerLogo`, `employeeCount`,
    `employerIndustries`). `formatEmploymentListTable` gains an
    `Employees` column (the company-size signal — the count, or `—` when
    no catalog employer / count is resolved).
  - **MCP**: `ttctl_profile_employment_list` /
    `ttctl_profile_employment_show` return the row verbatim via
    `jsonSuccess`; the nested `employer` object flows through
    automatically via interface-based serialization. The `_list` tool
    description now mentions the employer card so MCP-side agents can
    answer "How big are the companies I have worked at, and where are
    they based?" style prompts.
- **`profile.employment.list` / `profile.employment.show`: expose
  `engagement` (link to `TalentEngagement`) and `isEnterpriseExperience`
  on `Employment` read shape (#554).** Two well-known fields on
  `Employment` (`research/graphql/talent_profile/schema.graphql:269-290`)
  were `Unknown`-typed in synth SDL but selected by the upstream canonical
  fragment at
  `research/graphql/talent_profile/fragments/Employment.graphql:36-38`.
  Extends `EMPLOYMENT_FRAGMENT` with `engagement { id }` and
  `isEnterpriseExperience`, projects through `mapEmploymentNode` with
  defensive shape guards (engagement-without-string-id collapses to
  `null`; non-Boolean `isEnterpriseExperience` collapses to `null`).
  Wire-shape disposition: Schema/contract rule **triggered** with
  **INFERRED** wire shape; Track 1 (wire-shape snapshot at
  `packages/e2e/src/wire-snapshots/GET_WORK_EXPERIENCE.snapshot.json`)
  for ongoing drift detection. Pre-existing
  `43-profile-employment.e2e.test.ts` already exercises
  `GET_WORK_EXPERIENCE` post-projection wire shape via
  `assertWireShapeStable`; the new fields land inside the same shape
  contract automatically.
  - **CLI renderer changes**: `formatEmploymentText` (per-row pretty)
    surfaces an `enterprise` line (when `true`) and an `engagement:
<id>` discovery hint (when set). `formatEmploymentTable` (key/value)
    gains two rows: `enterprise` and `engagement`.
    `formatEmploymentListTable` gains an `Enterprise` column with
    tri-state `yes` / `no` / `—` rendering (the em-dash represents
    the nullable older / non-applicable case).
  - **MCP**: `ttctl_profile_employment_list` /
    `ttctl_profile_employment_show` return the row verbatim via
    `jsonSuccess`; the new fields flow through automatically via
    interface-based serialization. The `_list` tool description now
    mentions the engagement / enterprise fields so MCP-side agents can
    answer "Which of my Toptal employments were Toptal engagements?"
    style prompts.
- **`profile.employment.update` / `profile.portfolio.update`: expose
  `skills` on the update path (MCP tools + CLI subcommands, #541).**
  The core `EmploymentFields.skills` (`packages/core/src/services/profile/employment/index.ts`)
  and `PortfolioItemInput.skills` (`packages/core/src/services/profile/portfolio/index.ts`)
  write paths have accepted `skills` since rc.3, but the wrapper layers
  did not surface them on the update tools — same gap class as #487 /
  #488 / #492. Today's practical impact during a Toptal profile uplift
  campaign: an audit identified ~25 skill ADDs across 3 employment
  entries and ~30 skill REMOVALs across 6 entries — none of which
  could be executed via MCP/CLI without delete+recreate (which
  destroys entry history for established rows). The fix exposes
  `skills` on both surfaces with replace-on-supply semantics inherited
  from the core merge (`{ ...merged, ...fields }` in
  `buildUpdateEmploymentInput`; `{ skills: current.skills, ...,
...changes }` in `portfolio.update()`): supplied set replaces the
  entry's entire skill set; omitted preserves the current set via the
  read-current+merge.
  - **Surfaces updated**: - `packages/mcp/src/tools/profile/employment.ts` — adds `skills:
z.array(z.object({ id, name? })).min(1).optional()` to
    `ttctl_profile_employment_update`'s `inputSchema`; the handler
    maps `name ?? ""` for the wire (the Toptal server accepts an
    empty display name on `SkillRefInput` when the id is meaningful).
    The dry-run preview's `DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER`
    surface stays unchanged — caller-supplied `skills` wins via the
    existing `...fields` spread. - `packages/mcp/src/tools/profile/portfolio.ts` — adds the same
    shape to `ttctl_profile_portfolio_update`'s `inputSchema`;
    `buildPortfolioInput` is extended with optional `skills` and
    maps `name ?? ""` symmetric with the employment surface. - `packages/cli/src/commands/profile/employment/index.ts` — adds
    `--skill-id <id>` (repeatable) to `ttctl profile employment
update`, mirroring the existing `--skill-id` flag on the `add`
    subcommand (#484). `UpdateOptions.skillId?: string[]` typed; the
    handler maps to `fields.skills` with `name: ""` per the CLI
    id-only flow. - `packages/cli/src/commands/profile/portfolio/index.ts` +
    `update.ts` — adds `--skill-id <id>` (repeatable) to `ttctl
profile portfolio update`; the empty-fields error message now
    lists `--skill-id` alongside `--title` / `--description` /
    `--link` / `--client` / `--accomplishment` / `--edit`.
  - **Wrapper-only — schema/contract rule NOT triggered.** No file
    under `packages/core/src/services/profile/**` is modified; no new
    GraphQL operation is introduced. The pre-existing `UpdateEmployment`
    and `updatePortfolioItem` documents already accept the field on the
    wire (verified by E2E test 46-profile-employment-update-merge for
    Employment, and 36-profile-portfolio for the Portfolio surface).
  - **Replacement semantics** mirror `employment_add`: supplied set
    replaces; omitted preserves. The idempotent `addSkills` /
    `removeSkills` mutations the issue body mentions are deferred to a
    follow-up — exposing them requires new GraphQL operations + their
    own wire-validation track (Schema/contract rule fires).
  - **Tests**:
    - `packages/mcp/src/tools/__tests__/profile_update_skills.test.ts`
      (NEW) — 6 dry-run threading cases verifying that supplied skills
      override the placeholder (employment) or appear in the preview
      (portfolio), id-only inputs default `name: ""`, and omitted
      `skills` preserves the merge placeholder / omits the field.
    - `packages/cli/src/__tests__/program.test.ts` — 2 program-shape
      cases asserting `--skill-id` is registered on both update
      subcommands.

- **`profile.portfolio.show` / `profile.portfolio.list`: expose
  `engagement` (link to `TalentEngagement`) on the `PortfolioItem` read
  shape (#552).** Extends the shared `PORTFOLIO_NODE_SELECTION` with the
  `engagement { id }` reference — the link from a portfolio item to the
  underlying `TalentEngagement` the project was delivered through —
  surfaced on every read and mutation response. Completes the read
  surface: with this, every structured sub-field of the empirical
  `Portfolio` fragment is now projected (building on #548 details, #549
  files, #550 kpis, #551 quotes on the same selection). The wire shape was
  **INFERRED** (`PortfolioItem.engagement` is `Unknown` in synth SDL at
  `research/graphql/talent_profile/schema.graphql:374`) and verified by a
  live elimination probe (2026-05-24, maintainer's profile, 32 items): a
  SINGLE nullable object reference (NOT a list / connection —
  `engagement { nodes }` errors "Field 'nodes' doesn't exist on type
  'TalentEngagement'"); 26 of 32 items returned `null`, 6 populated; the
  `id` is the relay global id (e.g. `V1-TalentEngagement-238005`). A
  sibling `plainId` (Int) was probe-confirmed accepted but deliberately
  excluded — it is not in the empirical fragment Toptal's own web client
  uses, and the cross-reference use case keys on the relay id.
  - **Service surface**: new `PortfolioItemEngagement { id: string }` type
    and `engagement: PortfolioItemEngagement | null` field on
    `PortfolioItem`, projected via `projectEngagement(node["engagement"])`
    inside `mapPortfolioNode` in
    `packages/core/src/services/profile/portfolio/index.ts`. Defensive
    projection: a missing / `null` / non-object wire value, or an object
    without a string `id`, projects to `null` — silently absent rather
    than a fabricated shape.
  - **CLI surface**: `ttctl profile portfolio list -o pretty` —
    `renderPortfolioItem` in
    `packages/cli/src/commands/profile/portfolio/list.ts` gains a
    single-line discovery hint
    `Engagement: <id> (TalentEngagement — see \`ttctl engagements list\`)`,
skipped when `engagement`is`null`(the common case). ID-space note
(correcting the issue's guessed hint): this id is a`TalentEngagement.id`, which equals `EngagementListItem.engagementId`on the engagements surface — so the hint points at`ttctl engagements
    list`(match the`engagementId`column), NOT`engagements show <id>`(which consumes a`jobActivityItem.id` and would NOT_FOUND on this id).
  - **MCP surface**: `ttctl_profile_portfolio_list` — `engagement`
    surfaces naturally via `successResponse(items)` JSON serialization; the
    payload snapshot (`packages/mcp/src/tools/__tests__/__snapshots__/payload-snapshots.test.ts.snap`)
    is updated. No tool count change (field-exposure on an existing tool).
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/profile/portfolio/index.ts`, INFERRED wire
    shape. Live probe transcript captured; dedicated E2E in
    `packages/e2e/src/36-profile-portfolio.e2e.test.ts` (pure-behavior
    `it()` title, `#552` in a Provenance comment per the council-ratified
    test-naming convention; gated by `TTCTL_E2E=1`) creates a sentinel and
    asserts `engagement === null` on create, `null`-or-non-array-object on
    every list item, and `typeof engagement.id === "string"` on every
    populated reference — the populated branch RUNS on this account (6 of
    32 items linked).
  - **Track 1 vs Track 2**: **T1** (wire-shape snapshot) —
    `getPortfolioItems` / `createPortfolioItem` are in the talent_profile
    untrusted catalog (gappy synth SDL). The new `engagement` selection
    rides the shared `PORTFOLIO_NODE_SELECTION`; the snapshot at
    `packages/e2e/src/wire-snapshots/createPortfolioItem.snapshot.json`
    was re-seeded with `engagement: { … }` (structure-only nullable
    object) in a follow-up scoped-E2E commit (the #552 subprocess lacked
    desktop 1Password auth; orchestrator handoff completed it).
  - **Doc surface**: TRIGGERED — `profile.portfolio.show` /
    `profile.portfolio.list` (CLI pretty `Engagement:` discovery-hint line;
    MCP tool JSON envelope carries `engagement`).
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged (read-side field projection; no new export, no new
    write-input field, no `e2e-covers:` markers added).

- **`profile.portfolio.show` / `profile.portfolio.list`: expose `quotes`
  (talent-authored client testimonials) on the `PortfolioItem` read shape
  (#551).** Extends the shared `PORTFOLIO_NODE_SELECTION` with a
  direct-list selection
  `quotes { id text clientName clientRole company }` — talent-authored
  client / stakeholder testimonials for the project — surfaced on every
  read and mutation response (building on #548 details, #549 files, #550
  kpis on the same selection). The wire shape was **INFERRED**
  (`PortfolioItem.quotes` is `Unknown` in synth SDL at
  `research/graphql/talent_profile/schema.graphql:389`) and verified by a
  live elimination probe (2026-05-23): a DIRECT list (NOT a connection —
  `quotes { nodes }` errors "Field 'nodes' doesn't exist on type
  'PortfolioItemQuote'"); element type `PortfolioItemQuote`; the empirical
  field set `{id, text, clientName, clientRole, company}` accepted, while
  the issue's guessed `{quote, attribution, role}` were ALL rejected as
  undefined; empty case returns `[]` (NOT `null`) — all 32 probed items
  were empty, so populated sub-field scalar types remain INFERRED.
  - **Service surface**: new
    `PortfolioItemQuote { id: string, text|clientName|clientRole|company:
string | null }` type and `quotes: PortfolioItemQuote[]` field,
    projected via `projectQuotes(node["quotes"])` inside `mapPortfolioNode`
    in `packages/core/src/services/profile/portfolio/index.ts`. Defensive
    projection: non-array wire input → `[]`; per-node missing or non-string
    `id` → dropped (siblings preserved).
  - **CLI surface**: `ttctl profile portfolio list -o pretty` —
    `renderQuotesSummary` (in
    `packages/cli/src/commands/profile/portfolio/list.ts`) emits a per-item
    `Quotes (N quotes):` block, one row per quote
    (`- "<text>" — <attribution>`, where the attribution interleaves
    `clientName`, `clientRole`, and `company` as `<name>, <role> @
<company>`). `(unset)` placeholder for null/empty text; the attribution
    suffix is dropped when no client fields are present. Skip-if-empty.
  - **MCP surface**: `ttctl_profile_portfolio_list` — `quotes` surfaces
    naturally via `successResponse(items)` JSON serialization; the payload
    snapshot is updated. No tool count change.
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/profile/portfolio/index.ts`, INFERRED wire
    shape. Live probe transcript captured; dedicated E2E in
    `packages/e2e/src/36-profile-portfolio.e2e.test.ts` (gated by
    `TTCTL_E2E=1`) adds a sentinel and asserts
    `Array.isArray(sentinel.quotes)` + per-field types on any populated
    quote (skipped with a stderr info note when the account has none — the
    typical case at probe time). A follow-up scoped-E2E commit applied the
    council-ratified test-targeting convention (stripped the
    `(#551 INFERRED → verified)` marker from the `it()` title; provenance
    moved to a comment) and seeded the `createPortfolioItem` snapshot with
    `quotes: []`.
  - **Track 1 vs Track 2**: **T1** (wire-shape snapshot) —
    `getPortfolioItems` / `createPortfolioItem` are in the talent_profile
    untrusted catalog; the new `quotes` selection rides the shared
    `PORTFOLIO_NODE_SELECTION`. Snapshot at
    `packages/e2e/src/wire-snapshots/createPortfolioItem.snapshot.json`
    re-seeded with `quotes: []` in the follow-up commit (the feature
    subprocess lacked desktop 1Password auth).
  - **Doc surface**: TRIGGERED — `profile.portfolio.show` /
    `profile.portfolio.list` (CLI pretty `Quotes (N):` block; MCP tool JSON
    envelope carries `quotes`).
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged (read-side projection; no new export, no new write-input
    field, no `e2e-covers:` markers added).

- **`profile.portfolio.show` / `profile.portfolio.list`: expose `kpis`
  (talent-authored project KPIs) on the `PortfolioItem` read shape
  (#550).** Extends the shared `PORTFOLIO_NODE_SELECTION` with a
  direct-list selection `kpis { id value description }` — talent-authored
  quantified outcomes for the project (e.g.
  `{ value: "40%", description: "page load reduction" }`) — surfaced on
  every read and mutation response (building on #548 details and #549 files
  on the same selection). The wire shape was **INFERRED**
  (`PortfolioItem.kpis` is `Unknown` in synth SDL at
  `research/graphql/talent_profile/schema.graphql:386`) and verified by a
  live elimination probe (2026-05-23): a DIRECT list (NOT a connection —
  `kpis { nodes }` errors "Field 'nodes' doesn't exist on type
  'PortfolioItemKpi'"); element type `PortfolioItemKpi` with exactly the
  three fields `{id, value, description}` (`label` / `name` / `unit`
  rejected as undefined); empty case returns `[]` (NOT `null`) — all 32
  probed items were empty, so populated sub-field scalar types remain
  INFERRED.
  - **Service surface**: new
    `PortfolioItemKpi { id: string, value: string | null,
description: string | null }` type and `kpis: PortfolioItemKpi[]`
    field, projected via `projectKpis(node["kpis"])` inside
    `mapPortfolioNode` in
    `packages/core/src/services/profile/portfolio/index.ts`. Defensive
    projection: non-array wire input → `[]`; per-node missing or non-string
    `id` → dropped (siblings preserved).
  - **CLI surface**: `ttctl profile portfolio list -o pretty` —
    `renderKpisSummary` (in
    `packages/cli/src/commands/profile/portfolio/list.ts`) emits a per-item
    `KPIs (N KPIs):` block, one row per KPI (`- <value>: <description>`).
    `(unset)` placeholder for null/empty `value` or `description` so the
    structural presence of a KPI entry stays visible even when only
    partially filled. Skip-if-empty.
  - **MCP surface**: `ttctl_profile_portfolio_list` — `kpis` surfaces
    naturally via `successResponse(items)` JSON serialization; the payload
    snapshot is updated. No tool count change.
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/profile/portfolio/index.ts`, INFERRED wire
    shape. The `kpis` selection rides the shared `PORTFOLIO_NODE_SELECTION`,
    so live wire-acceptance is exercised by the existing
    `createPortfolioItem` snapshot E2E (snapshot now includes `kpis: []`);
    a dedicated subtest in
    `packages/e2e/src/36-profile-portfolio.e2e.test.ts` adds a sentinel and
    asserts `Array.isArray(sentinel.kpis)` + per-field types on any
    populated KPI (skipped with a stderr info note when none — the typical
    case). Live round-trip transcript captured in the commit message
    (sentinel created, `kpis: []` verified, 0 of 33 items populated,
    sentinel removed).
  - **Track 1 vs Track 2**: **T1** (wire-shape snapshot) —
    `getPortfolioItems` / `createPortfolioItem` are in the talent_profile
    untrusted catalog; the new `kpis` selection rides the shared
    `PORTFOLIO_NODE_SELECTION`. Snapshot at
    `packages/e2e/src/wire-snapshots/createPortfolioItem.snapshot.json`
    re-seeded with `kpis: []` in this commit.
  - **Doc surface**: TRIGGERED — `profile.portfolio.show` /
    `profile.portfolio.list` (CLI pretty `KPIs (N):` block; MCP tool JSON
    envelope carries `kpis`).
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged (read-side projection; no new export, no new write-input
    field, no `e2e-covers:` markers added).

- **`profile.portfolio.show` / `profile.portfolio.list`: expose `files`
  (`PortfolioItemFileConnection` — attachments) on the `PortfolioItem`
  read shape (#549).** Extends the shared `PORTFOLIO_NODE_SELECTION` with
  an inline-fragment selection for the two `PortfolioItemFile`
  connection-node variants (Pdf / Image) the talent-profile wire serves,
  surfaced through `PortfolioItem.files` on every read and mutation
  response. Read-side counterpart to the write-side `uploadPortfolioFile`
  mutation. The wire shape was **INFERRED** — the synthesized SDL at
  `research/graphql/talent_profile/schema.graphql:403` collapses
  `PortfolioItemFileConnection { nodes }` to a single concrete node type
  (`PortfolioItemFilePdf`), but the empirical talent-profile fragments
  project the nodes as a union via inline fragments; the fragments are the
  authority. Inline-fragment selection + `__typename` discriminator +
  defensive `projectFiles()` mapper close the gap (mirrors the #548
  `details` union treatment on the same selection).
  - **Service surface**: new
    `PortfolioItemFile = PortfolioFilePdf | PortfolioFileImage`
    discriminated union (`kind: "pdf" | "image"`, flattened from the
    connection) and `files: PortfolioItemFile[]` field, projected via
    `projectFiles()` / `projectFile()` inside `mapPortfolioNode` in
    `packages/core/src/services/profile/portfolio/index.ts`. Defensive
    projection: null/missing connection or non-array nodes → `[]`; per-node
    unknown/missing `__typename` or non-string `id` → dropped (siblings
    preserved).
  - **CLI surface**: `ttctl profile portfolio list -o pretty` — a per-item
    `Files (N):` block in
    `packages/cli/src/commands/profile/portfolio/list.ts`, one row per file
    (`- PDF: <fileUrl>` / `- Image: <url>`) with an optional ` — <title>`
    suffix and `(no url)` fallback. Skip-if-empty.
  - **MCP surface**: `ttctl_profile_portfolio_list` — `files` surfaces
    naturally via `successResponse(items)` JSON serialization; the payload
    snapshot is updated. No tool count change.
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/profile/portfolio/index.ts`, INFERRED wire
    shape for the union projection. The `files` selection rides the shared
    `PORTFOLIO_NODE_SELECTION`, so its live wire-acceptance is exercised by
    the existing `createPortfolioItem` snapshot E2E; the snapshot at
    `packages/e2e/src/wire-snapshots/createPortfolioItem.snapshot.json` was
    re-seeded in this commit. (No new subtest added to
    `36-profile-portfolio.e2e.test.ts`.)
  - **Track 1 vs Track 2**: **T1** (wire-shape snapshot) —
    `getPortfolioItems` / `createPortfolioItem` are in the talent_profile
    untrusted catalog; the new `files` selection rides the shared
    `PORTFOLIO_NODE_SELECTION`. `assertWireShapeStable` catches
    `__typename` drift on the next E2E run.
  - **Doc surface**: TRIGGERED — `profile.portfolio.show` /
    `profile.portfolio.list` (CLI pretty `Files (N):` block; MCP tool JSON
    envelope carries `files`).
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged (read-side projection; no new export, no new write-input
    field, no `e2e-covers:` markers added).

- **`profile.portfolio.show` / `profile.portfolio.list`: expose `details`
  (`PortfolioItemImageBlock` body) on the `PortfolioItem` read shape
  (#548).** Extends the shared `PORTFOLIO_NODE_SELECTION` with
  inline-fragment selection for the four `PortfolioItemDetails` union
  variants (Image / Text / Video / Gallery) the talent-profile wire
  serves, surfaced through `PortfolioItem.details` on every read and
  mutation response. The wire shape was **INFERRED** — the synthesized SDL
  at `research/graphql/talent_profile/schema.graphql:380` collapses
  `details` to a single concrete type (`PortfolioItemImageBlock`), but the
  captured `getProfileData.graphql:237-244` and the `Portfolio.graphql`
  fragment use inline fragments across four concrete types; the live wire
  is the authority. Inline-fragment selection + `__typename` discriminator
  - defensive `projectDetails()` mapper close the gap.
  * **Service surface**: new `PortfolioItemDetails` discriminated union
    (`kind: "image" | "text" | "video" | "gallery"`; variant interfaces
    `PortfolioImageBlock` / `PortfolioTextBlock` / `PortfolioVideoBlock` /
    `PortfolioGalleryBlock` with `PortfolioGalleryItem`) and
    `details: PortfolioItemDetails | null` field, projected via
    `projectDetails()` inside `mapPortfolioNode` in
    `packages/core/src/services/profile/portfolio/index.ts`. Defensive
    projection: unknown `__typename` (forward-compat for new server
    variants), missing `__typename`, non-string `id`, or non-object input
    → `null` — silently absent rather than fabricated.
  * **CLI surface**: `ttctl profile portfolio list -o pretty` — a per-item
    one-line `Details:` summary in
    `packages/cli/src/commands/profile/portfolio/list.ts`
    (`Details: Image: <url>` / `Details: Text (rich body)` /
    `Details: Video: <url>` / `Details: Gallery (N items)`), with an
    optional ` — <title>` suffix. Skip-if-null.
  * **MCP surface**: `ttctl_profile_portfolio_list` — `details` surfaces
    naturally via `successResponse(items)` JSON serialization; the payload
    snapshot is updated. No tool count change.
  * **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/profile/portfolio/index.ts`, INFERRED wire
    shape for the union projection. Live E2E exists for the
    `add → verify → remove` round-trip; the post-create snapshot at
    `packages/e2e/src/wire-snapshots/createPortfolioItem.snapshot.json` was
    re-seeded in this commit.
  * **Track 1 vs Track 2**: **T1** (wire-shape snapshot) —
    `getPortfolioItems` / `createPortfolioItem` are in the talent_profile
    untrusted catalog; the new `details` selection rides the shared
    `PORTFOLIO_NODE_SELECTION`. `assertWireShapeStable` catches
    `__typename` drift on the next E2E run.
  * **Doc surface**: TRIGGERED — `profile.portfolio.show` /
    `profile.portfolio.list` (CLI pretty `Details:` line; MCP tool JSON
    envelope carries `details`).
  * **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged (read-side projection; no new export, no new write-input
    field, no `e2e-covers:` markers added).

- **`profile.certifications.list` / `profile.certifications.show`: expose
  `Certification.skills` (per-cert skill links, #558).** Surfaces the
  talent's self-attested skill links per certification. The wire returns
  `skills` as a nested connection (`skills { nodes { id name } }`); a new
  `mapCertificationNode` flattener projects it to `SkillRef[]` (mirrors
  `mapEmploymentNode`). The field is read-only (not on
  `CertificationInput`). Companion to #557 (`Certification.status`).
  - **Service surface**: adds `skills: { id; name }[]` to the
    `Certification` interface and `skills { nodes { id name } }` to
    `CERTIFICATION_FRAGMENT`; new `mapCertificationNode` in
    `packages/core/src/services/profile/certifications/index.ts` applied
    on the `list` / `add` / `update` read paths (the per-node `ListResponse`
    / `MutationPayload` types loosen to `Record<string, unknown>` and map
    through the projection). Defensive guards: skill nodes lacking string
    `id` / `name` are dropped; an absent connection defaults to `[]`.
  - **CLI surface**: `ttctl profile certifications` — `formatCertificationText`
    gains a conditional `skills: <comma-joined>` line, `formatCertificationTable`
    gains a `skills` row, `formatCertificationListText` gains a column
    between `status` and `id`, and `formatCertificationListTable` gains a
    `Skills` column. A new `formatSkillsList` helper renders the comma-joined
    names or an em-dash sentinel when empty. All in
    `packages/cli/src/commands/profile/certifications/index.ts`.
  - **MCP surface**: `ttctl_profile_certifications_list` /
    `ttctl_profile_certifications_show` return the row verbatim — no
    formatter change (the MCP payload snapshot is updated to carry the
    nested `skills` array). No tool count change.
  - **Schema/contract rule**: TRIGGERED + INFERRED. Touches
    `packages/core/src/services/profile/certifications/index.ts` and adds a
    new `Unknown`-typed selection to `GET_CERTIFICATION` (a talent-profile
    op). E2E at `packages/e2e/src/69-profile-certifications.e2e.test.ts`
    extended with per-row `skills` shape assertions. **Caveat**: the live
    E2E run could not complete in the authoring subprocess (1Password
    `op item get` authorization timeout — no interactive auth); the snapshot
    `skills` shape is predicted from the live-confirmed `Employment.skills`
    sibling and requires a maintainer
    `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` regen to confirm against the
    live wire.
  - **Track 1 vs Track 2**: T1 — `GET_CERTIFICATION` has no generated
    operation type. Snapshot at
    `packages/e2e/src/wire-snapshots/GET_CERTIFICATION.snapshot.json`
    extended with the `skills` array shape.
  - **Doc surface**: TRIGGERED (touches
    `packages/core/src/services/profile/certifications/**` and the JSDoc on
    the `Certification` interface).
  - **Gates**: write-read symmetry N/A (read-only field, not on
    `CertificationInput`); `// e2e-covers: GET_CERTIFICATION` directive
    present. Surface / E2E-coverage gates unchanged.

- **`profile.certifications.list` / `profile.certifications.show`: expose
  `Certification.status` (verification / expiry state, #557).** Surfaces
  Toptal's per-certification verification / expiry state. Typed
  `string | null` because the synthesized SDL types it `Unknown`; the
  concrete enum members surface verbatim from the wire (likely
  `valid` / `expired` / `pending-verification` per the upstream fragment).
  Read-only (not on `CertificationInput`).
  - **Service surface**: adds `status: string | null` to the
    `Certification` interface and `status` to `CERTIFICATION_FRAGMENT` in
    `packages/core/src/services/profile/certifications/index.ts`.
  - **CLI surface**: `ttctl profile certifications` — `formatCertificationText`
    gains a conditional `status: <value>` line, `formatCertificationTable`
    gains a `status` row, `formatCertificationListText` gains a tab-separated
    column before the `id`, and `formatCertificationListTable` gains a
    `Status` column (em-dash sentinel when `null`).
  - **MCP surface**: `ttctl_profile_certifications_list` /
    `ttctl_profile_certifications_show` return the row verbatim — no
    formatter change. No tool count change.
  - **Schema/contract rule**: TRIGGERED + INFERRED. Touches
    `packages/core/src/services/profile/certifications/index.ts` and adds a
    new `Unknown`-typed selection to `GET_CERTIFICATION`. Live wire confirmed
    via the new `packages/e2e/src/69-profile-certifications.e2e.test.ts`
    (`status` surfaces as `string | null`; enum-member enumeration is
    invisible to T1 per the wire-snapshots redaction policy, accepted
    trade-off).
  - **Track 1 vs Track 2**: T1 — `GET_CERTIFICATION` has no generated
    operation type. Snapshot committed at
    `packages/e2e/src/wire-snapshots/GET_CERTIFICATION.snapshot.json`.
  - **Doc surface**: TRIGGERED (touches
    `packages/core/src/services/profile/certifications/**`).
  - **Gates**: write-read symmetry N/A (read-only field). Side effect:
    `turbo.json`'s `test:e2e` `passThroughEnv` list gains
    `TTCTL_UPDATE_WIRE_SNAPSHOTS` so the documented snapshot-capture
    workflow propagates the flag through Turbo (was previously silently
    dropped).

- **`profile.education.list` / `profile.education.show`: expose
  `Education.skills` (per-degree skill links, #556).** Surfaces the talent's
  self-attested skill links per education record ("learned Python during my
  CS degree"). A 2026-05-23 live wire probe confirmed the connection shape
  `skills { nodes { id name } }` (same as `Employment.skills` /
  `Certification.skills`); ttctl flattens it to `SkillRef[]` via a new
  `mapEducationNode`. Read-only (not on `EducationInput`).
  - **Service surface**: adds `skills: { id; name }[]` to the `Education`
    interface and `skills { nodes { id name } }` to `EDUCATION_FRAGMENT`;
    new `mapEducationNode` (mirrors `mapCertificationNode` /
    `mapEmploymentNode`) in
    `packages/core/src/services/profile/education/index.ts` applied on the
    `list` / `add` / `update` read paths, with the same defensive guards
    (drop non-string skill `id` / `name`; default absent connection to `[]`).
  - **CLI surface**: `ttctl profile education` — `formatEducationText` gains
    a conditional `skills: <comma-joined>` line, `formatEducationTable` gains
    a `skills` row, `formatEducationListText` gains a column before the `id`,
    and `formatEducationListTable` gains a `Skills` column. New
    `formatSkillsList` helper (em-dash when empty) in
    `packages/cli/src/commands/profile/education/index.ts`.
  - **MCP surface**: `ttctl_profile_education_list` /
    `ttctl_profile_education_show` return the row verbatim — no MCP tool
    source change (only the MCP payload snapshot updated). No tool count
    change.
  - **Schema/contract rule**: TRIGGERED + INFERRED. Touches
    `packages/core/src/services/profile/education/index.ts` and adds a new
    `Unknown`-typed selection to `GET_EDUCATION`. NEW live E2E at
    `packages/e2e/src/70-profile-education-skills.e2e.test.ts`; the
    2026-05-23 introspection-by-rejection probe confirmed the
    `skills { nodes [{ id, name }] }` response shape against the maintainer's
    live session.
  - **Track 1 vs Track 2**: T1 — `GET_EDUCATION` has no generated operation
    type. Snapshot at
    `packages/e2e/src/wire-snapshots/GET_EDUCATION.snapshot.json`.
  - **Doc surface**: TRIGGERED (touches
    `packages/core/src/services/profile/education/**`).
  - **Gates**: write-read symmetry N/A (read-only field);
    `// e2e-covers: GET_EDUCATION` directive present. Surface / E2E-coverage
    gates unchanged.

- **`applications.show` / `applications.list`: expose
  `TalentJobActivityItem.mostRelevantApplication` (id-only pointer)
  (#547).** Extends the embedded `TalentJobActivityItem` sub-selection in
  both the `JobActivityItems` (list) and `JobActivityItem` (show) ops with
  `mostRelevantApplication { id }` — the platform-blessed pointer at the
  `AvailabilityRequest` that matters most for an activity row (the closest
  historical fit when a row has multiple ARs). Reverses the field's prior
  "intentionally elided" status and corrects the stale "union" note — the
  field is a single, nullable `AvailabilityRequest`. Projected id-only: a
  presence-indicator pointer like `jobApplication` / `interview`, NOT a
  re-projection of the full AR shape (the row's own `availabilityRequest`
  already carries that). `null` when the row has no associated AR.
  - **Service surface**: new public non-optional field
    `JobActivityItem.mostRelevantApplication: { id: string } | null` in
    `packages/core/src/services/applications/index.ts`. Projected via a
    new `projectMostRelevantApplication` helper (defensive null /
    non-string-id guard, mirrors `projectFixedRate`), wired into both
    `projectActivityItem` and `projectActivityItemDetail`. The wire shape
    is selected as `mostRelevantApplication { __typename id }` in both
    `JOB_ACTIVITY_LIST_QUERY` and `JOB_ACTIVITY_ITEM_QUERY`; the wire
    interface field is typed optional defensively so trimmed/older
    fixtures collapse `undefined` to `null`.
  - **CLI surface**: `ttctl applications show` — `formatApplicationDetail`
    in `packages/cli/src/commands/applications/show.ts` renders a
    `Most relevant application: <id>` deep-link hint (mirrors the
    `Interview: <id>` discovery hint). The list TABLE is intentionally
    unchanged (compact scan view); the field flows through `--json` /
    `--yaml` via the service projection (matches #539's list-level
    JSON/YAML-only exposure).
  - **MCP surface**: `ttctl_applications_show` + `ttctl_applications_list`
    descriptions (`packages/mcp/src/tools/applications.ts`) document the
    field and its chain into
    `ttctl_applications_availability_request_show`. Response passthrough —
    the field flows through automatically. (No tool-count delta — the MCP
    fixtures gain `mostRelevantApplication: null` but no registration/count
    assertion changes.)
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/applications/**`. The CI
    `schema-contract-disposition` gate does NOT fire (its trigger set is
    `auth.ts` + `services/profile/**`); the rule is declared per its
    broader spirit. The field is well-typed in the synth SDL (no INFERRED
    risk). E2E presence-assertions added to
    `packages/e2e/src/15-applications-list.e2e.test.ts` +
    `packages/e2e/src/16-applications-show.e2e.test.ts` (key present and
    `{ id }`-shaped when non-null, null tolerated per single-AR rows).
    Live E2E not run in the authoring subprocess (no credentials) — must
    run locally with `TTCTL_E2E=1` before merge.
  - **Track 1 vs Track 2**: T1 (wire-shape snapshot) — `JobActivityItem` /
    `JobActivityItems` are in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`. No
    `<OpName>.snapshot.json` for either at commit time (same posture as
    #530/#539); snapshot capture is a separate `TTCTL_E2E=1
TTCTL_UPDATE_WIRE_SNAPSHOTS=1` task requiring a real AR id.
  - **Doc surface**: content updated (CLI show renderer + MCP tool
    descriptions). The CI doc-surface attestation gate does NOT fire —
    `services/applications/**` is outside its tracked path set.
  - **Gates**: surface coverage / write-read symmetry unchanged. No
    `// e2e-covers:` markers added in this commit.
- **`engagements.show` / `jobs.show`: expose `Client` context (`city`,
  `countryName`, `foundingYear`, `industry`, `isEnterprise`, `teamSize`)
  (#546).** Surfaces six previously-trimmed `Client` context fields by
  extending the `client { ... }` sub-selection on `ENGAGEMENT_SHOW_QUERY`
  and `JOB_SHOW_QUERY`. `engagements show` previously selected the
  identity-only `client { __typename id fullName }`, so all six are new
  there; `jobs show` already exposed five, so only `foundingYear` is added
  on that surface. All six are well-typed in the synth SDL (`type Client`
  scalars + `teamSize: TeamSize!` selected as `{ value }`), so there is no
  INFERRED-shape component. `Client.crunchbase / facebook / linkedin /
twitter / website` are `Unknown`-typed in the synth SDL and explicitly
  out of scope.
  - **Service surface**: in
    `packages/core/src/services/engagements/index.ts`, `EngagementDetail.job`
    is widened via `Omit<EngagementJobRef, "client"> & { client: {...} }`
    so the detail path carries the six context fields (`id`, `fullName`,
    `city`, `countryName`, `foundingYear`, `industry`, `isEnterprise`,
    `teamSize { value }`) while the list path (`EngagementJobRef.client`)
    stays the identity-only `{ id, fullName }` shape — list responses never
    select the wider set, so widening the shared ref would be type-unsafe.
    In `packages/core/src/services/jobs/index.ts`, `JobDetail.client` and
    the wire `JobDetailEntity.client` gain `foundingYear` (`String?` — the
    server stores it as text, e.g. `"2005"`); the projection passes the
    client struct through, so the new field flows automatically.
  - **CLI surface**: `ttctl engagements show` —
    `formatEngagementDetail` in
    `packages/cli/src/commands/engagements/show.ts` gains a `Client`
    section (`formatClientSection`) rendering name / Industry / Location
    (city, countryName) / Founded / Team size / Enterprise, mirroring the
    existing `jobs show` Client section minus the Website / LinkedIn lines
    (those `Client` fields are `Unknown`-typed and not selected on the
    engagement surface). The prior inline `Client:` line in the Job block
    is removed in favor of the new section. `ttctl jobs show`
    (`packages/cli/src/commands/jobs/show.ts`) gains the single `Founded:`
    line in its existing Client block.
  - **MCP surface**: no change — the `show` tools pass the projected item
    through, so the widened client surfaces automatically (no tool-count
    delta).
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/engagements/**` +
    `packages/core/src/services/jobs/**`. All six fields are well-typed
    (no INFERRED-shape component), but the file-path trigger still fires,
    so E2E presence-assertions are added to
    `packages/e2e/src/19-engagements-show.e2e.test.ts` +
    `packages/e2e/src/24-jobs.e2e.test.ts` (unconditional client-context
    key presence + conditional populated `countryName` / `industry`,
    skip-on-sparse pattern). Live E2E not run in the authoring subprocess
    (no credentials) — must run locally with `TTCTL_E2E=1` before merge.
  - **Track 1 vs Track 2**: T1 (wire-shape snapshot) for both ops
    (`JobActivityItem`, `JobShow`). `assertWireShapeStable` calls added to
    both e2e files; the companion test-only commit (#546 seed) committed
    the structure-only manifests
    `packages/e2e/src/wire-snapshots/JobActivityItem.snapshot.json` and
    `packages/e2e/src/wire-snapshots/JobShow.snapshot.json` from a
    canonical `TTCTL_E2E=1` run (no PII values).
  - **Doc surface**: content updated (CLI renderer changes; MCP
    passthrough). The CI doc-surface attestation gate does NOT fire —
    `services/engagements/**` and `services/jobs/**` are outside its
    tracked path set.
  - **Gates**: surface coverage / write-read symmetry unchanged.
- **`engagements.show` / `jobs.show`: expose `TalentJob` counterparty
  identity (`contacts` + `pointsOfContact`) (#545).** Surfaces the two
  previously-trimmed `TalentJob` counterparty-identity fields on both
  surfaces by extending `ENGAGEMENT_SHOW_QUERY` and `JOB_SHOW_QUERY`:
  `contacts: [CompanyRepresentative]!` (the client-side hiring-manager
  contacts — `id email fullName phoneNumber position timeZone`) and
  `pointsOfContact: PointsOfContact!` (the Toptal-side recruiter
  points-of-contact — `current` / `handoff`, both `Recruiter`-shaped, plus
  `kind`). The `Recruiter` / `PointsOfContact` selection mirrors the
  live-verified, `TTCTL_E2E=1`-gated `timesheet.show` `recruiterData` /
  `pointOfContactData` fragments; `PointsOfContact.handoff` and
  `Recruiter.vacation` are `Unknown` scalars in the synth SDL but proven on
  the wire there.
  - **Service surface**: five new public per-service types —
    `ContactTimeZone`, `RecruiterContactFields`, `Recruiter`,
    `PointsOfContact`, `CompanyRepresentative` — duplicated across
    `packages/core/src/services/engagements/index.ts` and
    `packages/core/src/services/jobs/index.ts` per the per-service type
    convention (cf. `FixedRate`), with cross-ref comments. Surfaced on
    `EngagementDetail.job` (`contacts: CompanyRepresentative[]`,
    `pointsOfContact: PointsOfContact | null`) and the analogous fields on
    `JobDetail`. Projections (`projectRecruiter`, `projectPointsOfContact`,
    `projectContacts`) defensively coalesce every nullable hop, drop wire
    `__typename`, and null-filter the `[CompanyRepresentative]!`-nullable-item
    contacts list (the applications #539 `RecruiterRef` idiom). Engagements
    uses named GraphQL fragments (`timeZoneFields`, `contactFieldsData`,
    `recruiterData`, `pointOfContactData` — the `engagementBreakData`
    precedent); jobs inlines the recruiter shape (no-fragment idiom).
    `timeZone` selects the `{ location, name, value }` superset; the CLI
    label prefers `name`, falling back to `location` then `value`.
  - **CLI surface**: `ttctl engagements show`
    (`packages/cli/src/commands/engagements/show.ts`) and `ttctl jobs show`
    (`packages/cli/src/commands/jobs/show.ts`) each gain a `Contacts`
    section (`formatContactsSection`) and a `Points of Contact` section
    (`formatPointsOfContactSection` + `formatRecruiterLines` +
    `contactTimeZoneLabel`), grouped after the Job/Client block.
  - **MCP surface**: `ttctl_engagements_show`
    (`packages/mcp/src/tools/engagements.ts`) and `ttctl_jobs_show`
    (`packages/mcp/src/tools/jobs.ts`) descriptions document the new
    `job.contacts` / `job.pointsOfContact.current` / `.handoff` fields;
    full response passthrough (no tool-count delta).
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/engagements/**` +
    `packages/core/src/services/jobs/**`; the new selection re-uses the
    INFERRED `handoff` / `vacation` `Unknown`-scalar shape. E2E
    presence-assertions added to
    `packages/e2e/src/19-engagements-show.e2e.test.ts` +
    `packages/e2e/src/24-jobs.e2e.test.ts` (unconditional `contacts` /
    `pointsOfContact` key presence + conditional populated `fullName`,
    skip-on-sparse pattern). Live E2E not run in the authoring subprocess
    (no credentials; the engagements op further blocked by account-scoped
    HTTP 400) — must run locally with `TTCTL_E2E=1` before merge.
  - **Track 1 vs Track 2**: T1 (wire-shape snapshot) for both ops
    (`JobActivityItem`, `JobShow`) — both in
    `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`. No `<OpName>.snapshot.json`
    exists at commit time (these ops used presence-assertions, never
    `assertWireShapeStable`); seeding deferred to a live `TTCTL_E2E=1
TTCTL_UPDATE_WIRE_SNAPSHOTS=1` capture (same posture as #530 / #539).
  - **Doc surface**: content updated (CLI + MCP renderer updates + the
    five new core interfaces). The CI doc-surface attestation gate does NOT
    fire — these services are outside its tracked path set.
  - **Gates**: `// e2e-covers: JobActivityItem` and `// e2e-covers:
JobShow` directives added to the two e2e files. Surface coverage /
    write-read symmetry unchanged.
- **`applications`: expose `talentComment` + `requestedHourlyRate` +
  `rejectReason` + `recruiter` on availability requests (#539).** Extends
  the read-side `AvailabilityRequest` query AND the embedded
  `availabilityRequest { ... }` sub-selections in `JobActivityItems` /
  `JobActivityItem` (all in `services/applications/index.ts`) to surface
  four previously-trimmed first-party fields: `talentComment` (String! —
  the talent's own response free-text), `requestedHourlyRate` (Money! — the
  rate the talent posted in response), `rejectReason` (`Unknown` opaque
  scalar — the decline-reason `key`, treated as `string | null`), and
  `recruiter { firstName lastName fullName }` (recruiter contact identity).
  - **Service surface**: in
    `packages/core/src/services/applications/index.ts`, two new public
    types — `RecruiterRef` (`firstName` / `lastName` / `fullName`, all
    nullable; `firstName` / `lastName` are INFERRED-present-on-wire, the
    synth SDL declares only `fullName: String!` on `Recruiter`) and
    `AvailabilityRequestEmbed` (`id`, `talentComment`,
    `requestedHourlyRate`, `rejectReason`, `recruiter`). The activity-row
    `JobActivityItem.availabilityRequest` is widened from the prior
    `{ id }` presence indicator to `AvailabilityRequestEmbed | null`
    (backwards-compatible — existing `.id` consumers keep working) via the
    new `projectAvailabilityRequestEmbed` helper, wired into both
    `projectActivityItem` and `projectActivityItemDetail`. The standalone
    `AvailabilityRequestDetail` gains the same four fields, projected by
    `projectAvailabilityRequestDetail` from the extended
    `AVAILABILITY_REQUEST_QUERY`. Both projections share defensive
    partial-Money + nullable-recruiter guards.
  - **CLI surface**: `ttctl applications availability-request show`
    (`packages/cli/src/commands/applications/availability-request.ts`) —
    `formatAvailabilityRequestDetail` renders a `Recruiter` section
    (`formatRecruiterName`), a `Talent rate:` line, a `Talent comment`
    block, and a `Reject reason:` line. `ttctl applications show`
    (`packages/cli/src/commands/applications/show.ts`) —
    `formatApplicationDetail` surfaces the same embedded-AR fields
    (`Recruiter` / `Talent rate` / `Talent comment` / `Reject reason`)
    under the `Availability request:` line via `formatEmbedRecruiterName`.
  - **MCP surface**: `ttctl_applications_availability_request_show` and
    `ttctl_applications_show` descriptions
    (`packages/mcp/src/tools/applications.ts`) document the new fields.
    `ttctl_interest_requests_list`
    (`packages/mcp/src/tools/interest_requests.ts`) lifts `recruiter` into
    the `InterestRequestRow` (new `recruiter: RecruiterRef | null` field,
    sourced from `availabilityRequest?.recruiter ?? null`) for
    decline-draft personalisation; `projectRow`'s input type widens to
    `AvailabilityRequestEmbed`. Response passthrough; no tool-count delta.
  - **Schema/contract rule**: TRIGGERED — new INFERRED fields
    (`rejectReason` + `recruiter`) on hand-authored ops under
    `packages/core/src/services/applications/**`. The CI
    `schema-contract-disposition` gate does NOT fire (its trigger set is
    `auth.ts` + `services/profile/**`); declared per its broader spirit.
    E2E coverage extended:
    `packages/e2e/src/64-applications-availability-request-show.e2e.test.ts`
    asserts the four new keys + shapes;
    `packages/e2e/src/15-applications-list.e2e.test.ts` /
    `packages/e2e/src/16-applications-show.e2e.test.ts` assert the
    embedded-AR projection keys;
    `packages/e2e/src/49-applications-reject.e2e.test.ts` round-trips a
    known `talentComment` through the read surface. Live E2E not run in the
    authoring subprocess (no credentials) — must run locally with
    `TTCTL_E2E=1` before merge.
  - **Track 1 vs Track 2**: T1 (wire-shape snapshot) for all three ops
    (`AvailabilityRequest`, `JobActivityItems`, `JobActivityItem`) per
    `docs/wire-validation-routing.md` — all in
    `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`. No `<OpName>.snapshot.json` exists
    at commit time (same posture as #530); capture is a separate
    `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` task requiring a real AR id.
  - **Doc surface**: content updated (CLI + MCP renderer updates +
    `AvailabilityRequestDetail` / `AvailabilityRequestEmbed` /
    `RecruiterRef` interfaces). The CI doc-surface attestation gate does
    NOT fire — `services/applications/**` is outside its tracked path set.
  - **Gates**: surface coverage / write-read symmetry unchanged. No
    `// e2e-covers:` markers added in this commit.

- **`profile.industries.show` / `profile.industries.list`: expose the
  five curated cross-reference arrays (`employments`, `educations`,
  `certifications`, `portfolioItems`, `highlights`) on the
  `IndustryProfile` read shape (#553).** Previously `IndustryProfile`
  surfaced only the four identity columns (`id`, `title`, `about`,
  `domainArea`) and left the relational fields as raw `unknown`.
  Per-industry curation is the entire point of having industry
  profiles, so the read was decorative without them. Extends
  `INDUSTRY_PROFILE_FRAGMENT` with each curation cross-reference as a
  connection-shape sub-selection (`{ nodes { id } }`) and projects them
  into flat `IndustryCurationRef[]` arrays (bare `{ id }`) so callers
  can chase any of them via the matching per-resource `show` (e.g.
  `employments[].id` → `profile.employment.show(id)`,
  `portfolioItems[].id` → `profile.portfolio.show(id)`). The connection
  shape is INFERRED — the synthesized SDL types every `IndustryProfile`
  column as `Scalars['Unknown']['output']`, so the wrapping is
  extrapolated from `AddProfileIndustryConnections`, which already
  selects `profile.{portfolioItems,employments} { nodes { id } }` in the
  same file. A new `projectCurationRefs` helper walks each sub-field
  defensively (null / non-object / `nodes` non-array → `[]`; per-node
  non-string `id` → filtered out) so a per-account / per-feature-flag
  shape mismatch surfaces silently-absent curation rather than a
  fabricated array; a server rejection of the selection still throws
  loudly via `ensureNoTopLevelErrors` at the document-validation layer.
  The asymmetry vs the top-level `nodes` check in `list()` (which throws
  on non-array) is intentional: top-level structure is verified,
  sub-field projection is best-effort.
  - **Service surface**: `IndustryProfile` interface in
    `packages/core/src/services/profile/industries/index.ts` gains the
    five `IndustryCurationRef[]` fields (plus the new `IndustryCurationRef`
    interface); `list()` and `show()` now route the raw row through
    `projectIndustryProfile` (new `RawIndustryProfile` wire-shape type
    feeding `projectCurationRefs` per sub-field).
  - **CLI surface**: `ttctl profile industries show` /
    `ttctl profile industries list` in
    `packages/cli/src/commands/profile/industries/index.ts`.
    `formatIndustryText` (pretty) appends an indented curation block
    (`  <kind> (<count>): <id1>, <id2>`) emitting only populated kinds
    (empty curation suppresses the section). `formatIndustryTable`
    (key/value) gains five rows rendered as `N: id1, id2` (or `0` when
    empty) via a `formatRefsCell` helper. `formatIndustryListTable`
    gains a `Nemp/Nedu/Ncert/Npf/Nhl` summary column.
  - **MCP surface**: no new tool and no tool-count change —
    `ttctl_profile_industries_show` / `ttctl_profile_industries_list`
    already existed and the new fields flow through verbatim via
    `jsonSuccess(row)` interface serialization (the
    `profile_industries` payload snapshot in
    `packages/mcp/src/tools/__tests__/__snapshots__/payload-snapshots.test.ts.snap`
    was updated to carry the five empty arrays).
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/profile/industries/index.ts` (file-path
    trigger) and extends the `IndustryProfile` selection set with five
    INFERRED sub-fields. E2E at
    `packages/e2e/src/41-profile-industries.e2e.test.ts` adds an
    `expectCurationFieldsShape` assertion on the post-add read-back and
    on every `list()` / `show()` snapshot path (asserting the
    post-projection flat `{ id }[]` shape, plus `toEqual([])` for the
    brand-new-industry empty case). The existing graceful-skip behavior
    is preserved when the test account hits the documented
    `"This action is not allowed"` USER_ERROR (auto-memory
    `project_test_account_industries_disabled`).
  - **Track 1 vs Track 2**: T1 (wire-shape snapshot) — the
    `IndustryProfile` columns are `Scalars['Unknown']` in synth SDL, so
    no generated type exists. The post-projection shape is captured by
    the existing snapshot infrastructure at
    `41-profile-industries.e2e.test.ts` (`assertWireShapeStable` over
    `ListIndustryProfiles` / `GetIndustryProfile`); the snapshot lands
    once a seedable account exercises the path. No `.snapshot.json` file
    is committed in this change.
  - **Doc surface**: TRIGGERED — `profile.industries.show` /
    `profile.industries.list` CLI text + table renderers and the MCP
    tool surface.
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged (read-only field exposure; the ops were already covered).

- **`profile.basic.set`: add the writable `twitter` field via
  `UpdateBasicInfoInput` (#535).** Post-#526, TTCtl had NO write path
  for `Profile.twitter`: `external.update` dropped it (the server
  rejects `twitter` on `UpdateExternalProfilesInput`) and `basic.set`
  intentionally excluded it. Per the live curl evidence in #535,
  `UPDATE_BASIC_INFO` does accept `profile.twitter` as a **bare handle
  string** (no leading `@`, no URL prefix — e.g. `"alexey_pelykh"`) and
  the response selection set echoes it back. This makes `basic.set` the
  canonical write surface for `twitter` — the only one of the six social
  URLs the talent_profile basic-info input accepts — while
  `linkedin / github / website / behance / dribbble` stay owned by
  `external.update`. An empty string or `null` is the explicit "clear
  it" intent (the wire schema permits both representations of absent);
  `undefined` preserves the current value through the read-merge.
  - **Service surface**: `packages/core/src/services/profile/basic/index.ts`
    — `ProfileUpdate.twitter?: string | null`, `BasicInfo.twitter:
string | null` (read projection required by the read-merge
    contract), and `UpdateProfileResult.profile.twitter`. The
    `GET_BASIC_INFO` selection set picks up `twitter`, the
    `UPDATE_BASIC_INFO` mutation selection set echoes it, and
    `UpdateBasicInfoProfileInput.twitter` carries it on the apply path.
    `set()` validation now requires `bio` OR `headline` OR `twitter`;
    the merge mirrors the bio/headline semantics
    (`changes.twitter !== undefined ? changes.twitter : current.twitter`);
    the dry-run preview adds `twitter` to the placeholder-or-supplied
    set.
  - **CLI surface**: `ttctl profile basic update` gains `--twitter
<handle>` (bare handle, `""` to clear) in
    `packages/cli/src/commands/profile/basic/index.ts` +
    `set.ts`. `--twitter` does NOT participate in the free-text
    (stdin / `@file` / `--edit`) surface — it is passed verbatim. The
    empty-fields validation message and hint now list `--twitter`, and
    `formatUpdatePrettyEntity` renders a `twitter:` line alongside
    bio/headline.
  - **MCP surface**: no new tool and no tool-count change —
    `ttctl_profile_basic_update` gains `twitter: z.union([z.string(),
z.null()]).optional()` on its `inputSchema` (pass-through to
    `changes.twitter`; `null`/empty propagate) in
    `packages/mcp/src/tools/profile_basic_update.ts`, plus tool
    title/description/example-prompts.
  - **Schema/contract rule**: TRIGGERED — touches
    `packages/core/src/services/profile/basic/index.ts` (file-path
    trigger) and modifies the live wire shape of `UPDATE_BASIC_INFO`
    (adds `twitter` to both the input and the response selection set).
    Satisfied via a new gated E2E subtest in
    `packages/e2e/src/44-profile-basic.e2e.test.ts`: round-trips
    `set({ twitter })` → asserts the mutation echo, then `getBasicInfo`
    AND `external.show` both surface the sentinel, then restores the
    original handle in `finally` (non-destructive). A `USER_ERROR`
    skip-returns (test-account-state gate, not a wire regression — a
    wrong shape would fail earlier with `GRAPHQL_ERROR`).
  - **Track 1 vs Track 2**: T1 — same disposition as the parent
    `UPDATE_BASIC_INFO` op (untrusted catalog, no generated type). The
    committed snapshot at
    `packages/e2e/src/wire-snapshots/UPDATE_BASIC_INFO.snapshot.json` is
    updated to include `twitter: { kind: "string" }` in the profile
    echo.
  - **Doc surface**: TRIGGERED —
    `packages/core/src/services/profile/basic/**` is an explicit
    doc-surface attestation trigger; the MCP and CLI descriptions are
    updated to name `basic update` as the canonical write path for
    `twitter`.
  - **Gates**: surface coverage / E2E coverage unchanged; write-read
    symmetry satisfied — the new `twitter` input field is echoed back on
    `UpdateProfileResult.profile.twitter` and on `BasicInfo.twitter`.

- **`profile specializations apply`: `ApplyForSpecialization` mutation
  (CLI + MCP) (#467).** Extends the specializations read leaf with the
  destructive write side — submits the talent's application to an
  additional specialization track (Marketplace, Expert Crowd, etc.) via
  the gateway-portal `ApplyForSpecialization` mutation
  (`specialization(id:).apply(input: {})`). Both surfaces enforce the
  ADR-009 (ttctl) `profile-capability` per-domain consent vocabulary —
  the consent gate fires BEFORE the wire call AND before the dry-run
  preview. There is no withdraw mutation on the wire, which is why the
  operation is classified destructive.
  - **Service surface**: `profile.specializations.apply(token,
specializationId, consent, options?)` in
    `packages/core/src/services/profile/specializations/index.ts`. Wraps
    the hand-authored `ApplyForSpecialization` mutation
    (`mutation ApplyForSpecialization($specializationId: ID!) {
specialization(id: $specializationId) { apply(input: {}) { success
notice errors { code key message } } } }`), routed through
    `callGatewayShared` against the `mobile-gateway` surface
    (`stockTransport`). `ensureDestructiveConsent("ApplyForSpecialization",
"profile-capability", …)` runs as defense-in-depth at the service
    layer; `payload.errors[]` maps to `USER_ERROR`, a missing payload to
    `UNKNOWN`, and `success: false` to a `USER_ERROR`.
  - **CLI surface**: `ttctl profile specializations apply
<specializationId> --consent-profile-capability` —
    `packages/cli/src/commands/profile/specializations/apply.ts` +
    `index.ts`. `--consent-profile-capability` is REQUIRED; `--dry-run`
    previews the wire payload without issuing the mutation.
  - **MCP surface**: `ttctl_profile_specializations_apply` —
    `packages/mcp/src/tools/profile_specializations_apply.ts`. Tool
    count **120 → 121** across the three MCP gate tests
    (`registration.test.ts`, `tools.test.ts`, `dryrun-smoke.test.ts`).
    The tool requires `profileCapabilityConsentIssued: z.literal(true)`
    on input and carries the `destructiveHint: true` annotation.
  - **Schema/contract rule**: TRIGGERED — new hand-authored mutation
    under `packages/core/src/services/profile/`. Satisfied via
    `packages/e2e/src/68-profile-specializations-apply.e2e.test.ts`
    (`// e2e-covers: ApplyForSpecialization`): always-on dry-run-preview,
    consent-missing-refusal (asserts `CONSENT_REQUIRED` with NO wire
    call), and negative-path tests, plus a gated DESTRUCTIVE positive
    path opt-in via `TTCTL_E2E_APPLY_SPECIALIZATION=<id>` that captures
    the snapshot.
  - **Track 1 vs Track 2**: T1 — `ApplyForSpecialization` is in
    `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (no generated type), so T1 is
    mechanically forced per ADR-006. The snapshot at
    `packages/e2e/src/wire-snapshots/ApplyForSpecialization.snapshot.json`
    is captured on the first gated positive-path run with
    `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` (not committed in this change).
    `docs/wire-validation-routing.md` gains an `ApplyForSpecialization`
    T1 row; the `mobile-gateway` summary updates 46→47 (active) and the
    total 106→107.
  - **Doc surface**: not touched as an attestation trigger — the change
    is below the explicit doc-surface scope
    (`packages/core/src/auth/**` / `profile/basic/**`); the
    `profile/specializations/**` directory is outside it.
  - **Gates**: write-read symmetry — `apply` is not in the static
    `check-write-read-symmetry.ts` verb regex, verified behaviorally
    instead: the gated E2E positive path cross-checks via `show()`
    (`operations.apply.callable` flips to `false` post-apply). Surface
    coverage / E2E coverage satisfied (the new op is `e2e-covers`-marked
    and registered on both CLI and MCP).

- **`profile specializations show`: `GetTalentSpecializations` read
  (CLI + MCP) (#466).** Read-only viewer-scoped wrapper around the
  gateway-portal `GetTalentSpecializations` query so the talent can
  enumerate the specialization badges (Core, Marketplace, Expert Crowd,
  etc.) shown on the public profile. Lands the new
  `profile.specializations.*` sub-namespace. Viewer-scoped with no
  input — the wire op takes no variables; an empty list is a legitimate
  state for fresh accounts.
  - **Service surface**: `profile.specializations.show(token) →
Specialization[]` in
    `packages/core/src/services/profile/specializations/index.ts`
    (registered as `export * as specializations` in
    `packages/core/src/services/profile/index.ts`). Hand-authored
    `GetTalentSpecializations` query
    (`viewer { id specializations { id title ...TalentSpecialization } }` - `TalentSpecialization` fragment selecting `slug`, `title`,
    `description`, `logoUrl`, `applicationStatus`, `eligibleJobsCount`,
    `applicationCompletedAt`, `operations { apply { callable messages } }`)
    routed through `callGatewayShared` with `requireViewer: true`
    against the `mobile-gateway` surface. Selection is verbatim from the
    captured op document (no trim needed); `viewer.id` is preserved for
    `requireViewer` parity and `specialization.id` so callers can
    round-trip a known id through `ApplyForSpecialization`.
  - **CLI surface**: `ttctl profile specializations show` with `-o
pretty | json | yaml` —
    `packages/cli/src/commands/profile/specializations/show.ts` +
    `index.ts` (wired into the profile tree in
    `packages/cli/src/commands/profile/index.ts`). Pretty mode renders a
    per-row labelled block (or an explanatory empty-state line); the
    table emits `slug` / `title` / `status` / `applicationCompletedAt` /
    `eligibleJobsCount` / `apply.callable` columns.
  - **MCP surface**: `ttctl_profile_specializations_show` —
    `packages/mcp/src/tools/profile_specializations_show.ts`. Tool count
    **118 → 119** across the three MCP gate tests
    (`registration.test.ts`, `tools.test.ts`, `dryrun-smoke.test.ts`).
  - **Schema/contract rule**: TRIGGERED — new hand-authored
    gateway-portal op under `packages/core/src/services/profile/`. E2E at
    `packages/e2e/src/66-profile-specializations-show.e2e.test.ts`
    (`// e2e-covers: GetTalentSpecializations`): the json-shape, pretty,
    and snapshot subtests skip-return with a stderr note when the
    account has no specializations (no row-shape to assert).
  - **Track 1 vs Track 2**: T1 — `GetTalentSpecializations` is in
    `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`; no generated operation type
    exists, so T1 is mechanically forced per ADR-006. The snapshot at
    `packages/e2e/src/wire-snapshots/GetTalentSpecializations.snapshot.json`
    is pinned via `assertWireShapeStable` once captured on a populated
    `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run (not committed in
    this change). `docs/wire-validation-routing.md` gains a
    `GetTalentSpecializations` T1 row; the `mobile-gateway` summary
    totals update 45→46 / 89→90 / 105→106.
  - **Doc surface**: not touched as an attestation trigger — the new
    `profile/specializations/**` directory is below the explicit
    doc-surface scope (`auth/**` / `profile/basic/**`).
  - **Gates**: surface coverage / E2E coverage satisfied (op is
    `e2e-covers`-marked and registered on both CLI and MCP); write-read
    symmetry N/A (read-only).

- **`profile industries add-connections`: `AddProfileIndustryConnections`
  Pattern-6 helper (CLI + MCP) (#465).** Pattern-6 connection helper
  that links a catalog industry to one or more profile rows (employment
  and/or portfolio items). Wire shape recovered from the portal-bundle
  decompile: input is `{ profileId, industriesConnections: [{
industryId, profileItems }] }`, where `industryId` is the **catalog
  `Industry` id** (NOT the `IndustryProfile` row id the issue body
  suggested) and `profileItems` is a mixed array of
  `V1-Employment-<n>` / `V1-PortfolioItem-<n>` ids. Wired through the
  ADR-009 (ttctl) `profile-capability` consent gate (it writes
  recruiter-visible industry tags onto profile rows).
  - **Service surface**: `profile.industries.addConnections(...)` in
    `packages/core/src/services/profile/industries/index.ts`. Wraps the
    hand-authored `AddProfileIndustryConnections` mutation (input
    `AddProfileIndustryConnectionsInput!`), routed via `stockTransport`
    against the `mobile-gateway` surface. New `IndustryConnectionLink`
    (`{ industryId, profileItems: string[] }`),
    `AddIndustryConnectionsConsent`, `IndustryConnectionsProfileNode`,
    and `AddIndustryConnectionsResult` interfaces;
    `ensureDestructiveConsent(…, "profile-capability", input)` runs at
    the service layer. The wire shape is flagged INFERRED — UNVERIFIED
    in the service JSDoc.
  - **CLI surface**: `ttctl profile industries add-connections
--industry-id <id> [--employment-id <id> …] [--portfolio-item-id
<id> …] --consent-profile-capability` in
    `packages/cli/src/commands/profile/industries/index.ts`.
    `--employment-id` / `--portfolio-item-id` are repeatable
    (commander option-collector → array); a VALIDATION_ERROR fires when
    neither is supplied.
  - **MCP surface**: `ttctl_profile_industries_add_connections` —
    `packages/mcp/src/tools/profile/industries.ts`. Tool count **119 →
    120** across the three MCP gate tests (`registration.test.ts`,
    `tools.test.ts`, `dryrun-smoke.test.ts`). Requires
    `profileCapabilityConsentIssued: z.literal(true)` and carries
    `destructiveHint: true`.
  - **Schema/contract rule**: TRIGGERED — new hand-authored mutation
    under `packages/core/src/services/profile/`. Satisfied via
    `packages/e2e/src/67-profile-industries-add-connections.e2e.test.ts`
    (`// e2e-covers: AddProfileIndustryConnections`): consent-gate
    refusal (asserts `CONSENT_REQUIRED`), empty-links validation
    refusal, and a live round-trip that re-links an existing industry
    edge and snapshots the response.
  - **Track 1 vs Track 2**: T1 — gateway-portal untrusted op (no
    generated type). The snapshot at
    `packages/e2e/src/wire-snapshots/AddProfileIndustryConnections.snapshot.json`
    is captured on the first authorized run with
    `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` (not committed in this change). No
    `docs/wire-validation-routing.md` change accompanies this commit.
  - **Doc surface**: not touched as an attestation trigger — the change
    is below the explicit doc-surface scope (`auth/**` /
    `profile/basic/**`).
  - **Gates**: surface coverage satisfied (new op registered on both CLI
    and MCP); E2E coverage satisfied via the `e2e-covers` marker.

### Changed

- **`profile skills add` — transparent autocomplete resolution
  (#405).** When `name` is passed without `--skill-id` (CLI) or
  `skillId` (MCP), `profile.skills.add` now fires
  `GET_SKILLS_FOR_AUTOCOMPLETE` and applies the resolution policy:
  a single exact name match (case-insensitive, trimmed) auto-binds
  to that catalog `Skill`; ≥2 exact matches surface a
  `VALIDATION_ERROR` listing the duplicates with `--skill-id` nudge;
  0 exact matches fall back to custom-skill creation (the pre-#405
  behavior — `skillSet.id` is omitted and the server creates a
  non-catalog `Skill` from the free-text `name`). Mirrors the
  `employment.add` `--company` → `employerId` flow from #395 so the
  cross-domain UX stays uniform.
  - **Dry-run network behavior**: dry-run + explicit `skillId` stays
    zero-network. Dry-run WITHOUT `skillId` now fires
    `extractProfileId` + `skillsAutocomplete` so the preview's wire
    shape carries the resolved `skillSet.id` (or omits it for the
    custom-skill fallback) — matching what the live mutation would
    transmit. The `ADD_PROFILE_SKILL_SET` mutation transport is
    never fired in dry-run.
  - **Schema/contract rule**: NOT triggered as a new wire-shape —
    `ADD_PROFILE_SKILL_SET` and `GET_SKILLS_FOR_AUTOCOMPLETE` are
    already covered by the existing #396 capture +
    `47-profile-skills-add.e2e.test.ts` E2E. The resolution logic
    is client-side; no new op or input field. The existing custom-
    skill E2E continues to exercise the 0-match fallback (its
    `TEST_SKILL_NAME = ttctl-e2e-skill-${Date.now()}` is unique by
    construction).
  - **Track 1 disposition**: unchanged — T1 snapshots for
    `ADD_PROFILE_SKILL_SET` continue to apply.
  - **Surface coverage / write-read symmetry / E2E coverage gates**:
    unchanged. `skillId` remains write-only-annotated; the resolved
    binding echoes via `skill.id` / `skill.name` on the read side.

- **`profile.portfolio.update`: document the 200-character `description`
  minimum (#543).** The `ttctl_profile_portfolio_update` MCP tool's
  `description` field and the `ttctl profile portfolio update
--description` CLI flag now name the Toptal 200-character server-side
  minimum, quoting the verbatim rejection (`description is too short
(minimum is 200 characters)`) so MCP clients and CLI users learn the
  constraint up-front instead of discovering it via a post-submit
  validation error. Doc-only: no new GraphQL op, no wire-shape change, no
  behavior change. Mirrors the #542 / #492 precedents.
  - **Surfaces updated**:
    - `packages/mcp/src/tools/profile/portfolio.ts` — the
      `ttctl_profile_portfolio_update` `description` field's `.describe()`
      text gains the verbatim rejection and the 200-char minimum.
    - `packages/cli/src/commands/profile/portfolio/index.ts` — the
      `--description` flag help gains `Minimum 200 characters (#543)`.
    - `packages/mcp/src/tools/__tests__/profile_portfolio.test.ts` — adds
      a regression test asserting the registered tool's `description` field
      describe text contains `"200"` and `"minimum"`.
  - **Schema/contract rule**: NOT triggered — doc-only. No file under
    `packages/core/src/services/profile/**` is touched; no new GraphQL op,
    no wire-format change, no inferred contract.
  - **Doc surface**: TRIGGERED — the MCP tool description and the CLI flag
    help are the user-facing surfaces being corrected.
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged.

- **`profile.portfolio.highlight`: document the Toptal 3-item highlight cap
  (#542).** The `ttctl_profile_portfolio_highlight` MCP tool and the
  `ttctl profile portfolio highlight` CLI command now document the Toptal
  3-item cap on highlighted portfolio items — naming the generic
  `USER_ERROR` returned on the 4th highlight (`Something went wrong. Please
try again later.`) and the remedy (clear an existing highlight with
  `--off` / `highlight: false` first), and pointing MCP clients at
  `ttctl_profile_portfolio_list` for pre-flight. Doc-only: no new GraphQL
  op, no wire-shape change, no behavior change. Mirrors the #492 precedent.
  - **Surfaces updated**:
    - `packages/mcp/src/tools/profile/portfolio.ts` — the
      `ttctl_profile_portfolio_highlight` tool description gains the cap,
      the verbatim USER_ERROR, the remedy, and the `_list` pointer.
    - `packages/cli/src/commands/profile/portfolio/index.ts` — the
      `highlight` command description gains the cap and `--off` remedy.
    - `packages/mcp/src/tools/__tests__/profile_portfolio.test.ts` (NEW) —
      adds a regression test asserting the tool description contains `"3"`,
      matches `/cap|limit/`, and points at `ttctl_profile_portfolio_list`.
  - **Schema/contract rule**: NOT triggered — doc-only. No file under
    `packages/core/src/services/profile/**` is touched; no new GraphQL op,
    no wire-format change, no inferred contract.
  - **Doc surface**: TRIGGERED — the MCP tool description and the CLI
    command description are the user-facing surfaces being corrected.
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged.

- **`profile.employment.add` / `profile.employment.update`: validate
  `experienceItems` length (50–250 chars/item) client-side (#492).** The
  Toptal `talent_profile/graphql` server enforces a 50–250 char/item rule on
  `employment.experienceItems` and rejects out-of-range paragraphs with
  `USER_ERROR: Each item must have at least 50 and less than 250 characters`.
  Pre-#492 the dryRun preview accepted any length, so an agentic / batch
  caller drafting a description got false confidence — dryRun returned `ok`,
  the live call rejected. This change refuses out-of-range input client-side
  on both the apply and dryRun paths, so the dryRun preview is now a
  trustworthy pre-flight gate.
  - **Service surface**: new exported `validateExperienceItems(items)` helper
    (bounds `EXPERIENCE_ITEM_MIN_CHARS = 50` / `EXPERIENCE_ITEM_MAX_CHARS = 250`)
    that throws `ProfileError(VALIDATION_ERROR)` on the first offender, naming
    its index, length, and a truncated preview. Called early in `add()` and in
    `buildUpdateEmploymentInput()` in
    `packages/core/src/services/profile/employment/index.ts`. Caller-supplied
    input only — read-current echo paths intentionally skip the gate (legacy
    data may sit outside the bounds); empty arrays pass silently.
  - **CLI surface**: `ttctl profile employment add` — the `--description`
    help text now states the 50–250 char/item constraint
    (`packages/cli/src/commands/profile/employment/index.ts`).
  - **MCP surface**: `ttctl_profile_employment_update` calls
    `profile.employment.validateExperienceItems(...)` before its dryRun branch
    (the MCP dryRun does NOT route through `buildUpdateEmploymentInput`, so the
    core check would not otherwise fire there); both the `add` and `update`
    `description` schema `describe()` strings surface the 50–250 constraint
    (`packages/mcp/src/tools/profile/employment.ts`). No tool count change.
  - **Schema/contract rule**: NOT triggered. The diff touches a file under
    `packages/core/src/services/profile/**` (the file-path trigger), but the
    change is a purely client-side validation gate — no wire-format change, no
    new GraphQL operation, no inferred contract introduced. The existing
    `UpdateEmployment` snapshot and live-capture inputs remain the
    authoritative wire contract. (Mirrors the #488 disposition: file-path
    trigger present, but no wire change → rule not triggered.)
  - **Track 1 vs Track 2**: unchanged — no new op; `UpdateEmployment` remains
    on T1.
  - **Doc surface**: TRIGGERED (touches
    `packages/core/src/services/profile/employment/**` plus the MCP and CLI
    description text).
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged.

### Fixed

- **`profile.external.update`: drop unwritable `twitter` from input
  (#526).** Reporter (rc.7 MCP) called `external_update` with
  `linkedin + github + website + twitter` and the live
  `talent-profile` server rejected the variable verbatim: `"Variable
$input of type UpdateExternalProfilesInput! was provided invalid value
  for profile.twitter (Field is not defined on ExternalProfilesInput)"`.
  Crucially the failure is **transactional** — the three otherwise-valid
  URLs (`linkedin`, `github`, `website`) were also NOT persisted; a
  follow-up call with the same payload minus `twitter` succeeded on all
  three. Earlier rc.3 work (#345) had grown `twitter` into the typed
  input/result on the inference that response-selection presence
  implied input acceptance — that inference is now contradicted by live
  wire evidence and was load-bearing on the same data point
  (`research/notes/10-mutation-input-patterns.md` § Social and
  `05-talent-profile-api.md` line 191, which both list `twitter` as a
  writable social field). Most plausible cause: Toptal's X migration
  (Twitter → X) dropped the input field from `ExternalProfilesInput`
  but kept the read field on the `Profile` entity for backward
  compatibility, which is why `external show` continues to surface a
  `twitter` value.
  - **Surfaces updated**:
    - `packages/core/src/services/profile/external/index.ts` —
      `ExternalProfilesUpdate` and the internal
      `UpdateExternalProfilesInput.profile` shape drop `twitter`; the
      `update()` builder no longer forwards it; the
      `VALIDATION_ERROR` message lists the five remaining writable
      fields (linkedin / github / website / behance / dribbble). The
      response selection set and `UpdateExternalProfilesResult.profile`
      KEEP `twitter` so callers writing other fields still observe the
      server-side echo for round-trip verification (the
      `Profile`-entity field is intact server-side).
    - `packages/cli/src/commands/profile/external/index.ts` —
      removes `--twitter <url>` and trims the action signature; the
      command description now references the 5 settable fields and
      points callers at `external show` for the read side.
    - `packages/cli/src/commands/profile/external/update.ts` —
      action handler and VALIDATION_ERROR message updated to match
      the 5-field surface. `formatUpdatePrettyEntity` continues to
      render `twitter` when the server echoes a non-null value
      (preserves the post-update visibility benefit from #345).
    - `packages/mcp/src/tools/profile_external_update.ts` —
      `inputSchema` drops `twitter`; the dispatcher no longer
      forwards it; tool title/description/example-prompts updated.
      `ttctl_profile_external_show` continues to surface the field
      on the read side (no MCP-side change there).
  - **Tests updated**:
    - `packages/core/src/services/profile/external/__tests__/index.test.ts` —
      the #345 regression test ("returns twitter on the result when
      the server echoes it") is rewritten to drive the mutation with
      `linkedin` (the write side) while asserting the echo still
      surfaces twitter on the response. Adds an explicit
      `expect("twitter" in profileFields).toBe(false)` to lock the
      input shape against regression.
    - `packages/e2e/src/42-profile-external-show.e2e.test.ts` —
      introduces `WRITABLE_URL_FIELDS` (5 entries, no `twitter`) for
      round-trip subject selection; `URL_FIELDS` (6 entries with
      `twitter`) remains for read-shape coverage. The
      `UpdateExternalProfiles` snapshot subtest still expects
      `twitter` in the response shape — `Profile` echo is unchanged.
  - **Schema/contract rule**: TRIGGERED. Touches
    `packages/core/src/services/profile/external/index.ts` (the
    file-path trigger) and modifies the live wire shape of
    `UpdateExternalProfiles` (removes a field from the input). E2E
    coverage at `42-profile-external-show.e2e.test.ts` exercises the
    new 5-field input via the existing round-trip subtest; the
    `UpdateExternalProfiles` snapshot test continues to assert the
    response echo. The reporter's wire evidence in the issue body
    is the load-bearing transcript for this change — the failure
    mode is itself the contract assertion.
  - **Track 1 vs Track 2**: T1 unchanged for `UpdateExternalProfiles`
    (op remains in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`); the existing
    `packages/e2e/src/wire-snapshots/UpdateExternalProfiles.snapshot.json`
    captures the response shape including `twitter` and remains
    unmodified (the input-shape change does not alter the response
    selection set or its received shape — twitter was already `null`
    in the snapshot's source capture).
  - **Doc surface**: TRIGGERED for the MCP tool description and the
    CLI command description; both are updated to name `external show`
    as the canonical read path for `twitter`. No README content
    references `--twitter`.
  - **Surface coverage / write-read symmetry / E2E coverage gates**:
    unchanged. Write-read symmetry now has one fewer input field to
    verify (twitter dropped from the writable surface); the gate
    continues to pass for the remaining five.

- **`profile.employment.update`: correct misleading `publicationPermit`
  documentation (#488).** Reporter (rc.7 MCP) observed two anomalies:
  (1) supplying `publicationPermit: true` on an entry currently at
  `false` succeeds on the wire (mutation returns `ok`) but a follow-up
  `employment_show` still reports `false` — verified 3× including a
  `publicationPermit`-only update; (2) two employment entries with
  `publicationPermit: false` render on the public resume regardless,
  so the field does NOT gate public listing. Reporter's decisive
  checks (dryRun vs. live wire faithfulness) confirmed via the
  committed `packages/e2e/src/wire-snapshots/UpdateEmployment.snapshot.json`
  capturing `publicationPermit: { kind: "boolean" }` and the
  `research/captures/web/inputs/UpdateEmploymentInput.json` declaring
  `EmploymentInput.publicationPermit: Boolean` — ttctl IS sending the
  field correctly. Settlement: the field has TWO independent server-side
  mechanisms — (a) input-side Rails `.blank?` gate that rejects `false`
  on the wire with USER_ERROR (the #402 settlement, accurate), and (b)
  server-controlled persisted-state determination where the wire accepts
  the input without error but the server applies its own logic on read
  (newly observed, mirrors `toptalRelated`). Sending `true` does NOT
  guarantee a `false`-current row flips to `true`. The "publicly
  listable" framing in the rc.6 (#402) MCP description is inaccurate —
  the field does not gate resume rendering. No code behavior change
  (wire shape unchanged; merge logic unchanged): the fix is purely
  documentation correction across the MCP tool descriptions, service-
  layer comments, and the existing E2E docstring.
  - **Surfaces updated**:
    - `packages/mcp/src/tools/profile/employment.ts` —
      `ttctl_profile_employment_update` tool main description (`publicationPermit`
      sentence) and per-field `publicationPermit` description.
    - `packages/mcp/src/tools/profile/portfolio.ts` —
      `ttctl_profile_portfolio_add` + `_update` per-field
      `publicationPermit` descriptions (same wire field; Portfolio
      likely shares the server-controlled persisted-state semantic —
      uninvestigated).
    - `packages/core/src/services/profile/employment/index.ts` —
      inline comment in `add()` documents the cross-cutting #488 note.
    - `packages/core/src/services/profile/portfolio/index.ts` —
      inline comment in `add()` documents the cross-cutting #488 note.
    - `packages/e2e/src/52-profile-employment-update-blank-gate-overrides.e2e.test.ts` —
      docstring acknowledges the #488 coverage gap (we cannot construct
      a `false`-current sentinel via ttctl — the create-side `.blank?`
      gate rejects `false`).
  - **Schema/contract rule**: NOT triggered. Touches files under
    `packages/core/src/services/profile/**` (the file-path trigger), but
    comment-only — no wire format change, no new GraphQL op, no
    inferred contract introduced. The existing
    `UpdateEmployment.snapshot.json` and live-capture inputs remain the
    authoritative wire contract.
  - **Track 1 vs Track 2**: T1 (unchanged) — `UpdateEmployment` remains
    on the wire-shape-snapshot track; this change introduces no new op.
  - **Doc surface**: TRIGGERED. Touches
    `packages/mcp/src/tools/profile/employment.ts` and sibling Portfolio
    tool descriptions — the documentation is the user-facing surface
    being corrected. No code-path behavior changed.

- **`profile.employment.add` / `profile.employment.update`: document
  client-side year-normalization of `YYYY-MM-DD` date inputs (#527).** The
  MCP and CLI surfaces accept ISO-8601 (`YYYY-MM-DD`) and year-only (`YYYY`)
  per the `dateInput` regex, but the Toptal `EmploymentInput.startDate` /
  `.endDate` wire fields are typed `Int` (year-only) per
  `research/captures/web/inputs/UpdateEmploymentInput.json` and the
  `GET_WORK_EXPERIENCE.snapshot.json` wire-shape snapshot. ttctl extracts
  `parseDateInput(...).year` client-side before populating the payload,
  silently dropping month/day — so `from: "2024-10-15"` behaves identically
  to `from: "2024"` with no way to discover that from the tool surface alone.
  Documentation-only correction across all three surfaces; no wire/operation
  change, no behavior change, no test change.
  - **Service surface**: `packages/core/src/services/profile/employment/index.ts`
    — the `Employment` JSDoc gains a **Date-precision contract (#527)** block
    citing both the capture file and the wire-shape snapshot; per-field
    comments added on `EmploymentFields.startDate` / `.endDate` for direct
    core consumers.
  - **CLI surface**: `ttctl profile employment add` / `update` — module JSDoc
    carries the wire-evidence + normalization contract; the `--from` / `--to`
    option strings on both subcommands now reference #527
    (`packages/cli/src/commands/profile/employment/index.ts`).
  - **MCP surface**: `packages/mcp/src/tools/profile/employment.ts` — the
    `add` and `update` tool descriptions and the `from` / `to` per-field
    `describe()` strings document the year-normalization contract. No tool
    count change.
  - **Schema/contract rule**: NOT triggered. Touches a file under
    `packages/core/src/services/profile/**` (the file-path trigger), but
    comment/description-only — no wire-format change, no new GraphQL op, no
    inferred contract introduced.
  - **Track 1 vs Track 2**: unchanged — no new op; `UpdateEmployment` remains
    on T1.
  - **Doc surface**: TRIGGERED (touches
    `packages/core/src/services/profile/employment/**` and the MCP / CLI tool
    descriptions — the documentation is the user-facing surface being
    corrected).
  - **Gates**: surface coverage / write-read symmetry / E2E coverage
    unchanged.

- **`jobs` / `applications`: wrap `offeredHourlyRate` in an inline fragment
  on `AvailabilityRequestFixedMetadata` (#530).** Toptal split
  `AvailabilityRequestMetadata` into a polymorphic supertype;
  `offeredHourlyRate` now lives only on the
  `AvailabilityRequestFixedMetadata` variant. The hand-authored selections
  in `JOB_ACTIVITY_LIST_QUERY`, `JOB_ACTIVITY_ITEM_QUERY`, `JOBS_LIST_QUERY`,
  and `JOB_SHOW_QUERY` selected `offeredHourlyRate` directly under
  `metadata`, which the gateway now rejects with HTTP 400
  (`GRAPHQL_VALIDATION_FAILED`) — breaking `ttctl jobs list / show`,
  `ttctl applications list / stats`, and any consumer of the two
  `JobActivity*` operations. The fix wraps the rate selection in
  `... on AvailabilityRequestFixedMetadata`, mirroring the pre-existing
  fixes in `GET_AVAILABILITY_REQUEST_KIND_QUERY` and
  `AVAILABILITY_REQUEST_QUERY`, and adds `__typename` selections for the
  `AvailabilityRequestFlexibleMetadata` and
  `MarketplaceAvailabilityRequestFlexibleMetadata` variants for
  forward-compatible variant discrimination.
  - **Service surface**: selection-set change to four pre-existing ops
    across `packages/core/src/services/applications/index.ts` (`JobActivityItems`
    / `JobActivityItem`) and `packages/core/src/services/jobs/index.ts`
    (`JobsList` / `JobShow`). The wire-side TS interfaces
    `AvailabilityRequestWireEntity` (applications) and `ActivityItemRateWire`
    (jobs) mark `__typename` and `offeredHourlyRate` optional/nullable.
    `projectFixedRate` in both services short-circuits to `null` when the AR
    resolves to a non-Fixed variant (the rate is absent on the wire there) —
    otherwise the first non-Fixed row would crash. The AR presence indicator
    still rides through; only the rate goes `null`. The engagements service
    is confirmed unaffected — its `JobActivityItems` / `JobActivityItem`
    bodies do not select `availabilityRequest.metadata.offeredHourlyRate`.
  - **CLI / MCP surface**: no renderer or tool changes — selection-set and
    wire-projection fix only.
  - **Schema/contract rule**: NOT triggered — the diff touches no file
    under `packages/core/src/auth.ts` or
    `packages/core/src/services/profile/**`, and introduces no new
    hand-authored GraphQL operation; it only modifies the SELECTION SET of
    four pre-existing ops to match the upstream schema split. The
    inline-fragment fix pattern is already empirically validated by the
    pre-existing E2E coverage for `GET_AVAILABILITY_REQUEST_KIND_QUERY` and
    `AVAILABILITY_REQUEST_QUERY` (same selection shape, same `mobile-gateway`
    surface). Six new unit tests (3 per service) cover the Flexible and
    MarketplaceFlexible variants on the list and show paths.
  - **Track 1 vs Track 2**: T1 for all four affected ops (`JobsList`,
    `JobShow`, `JobActivityItems`, `JobActivityItem`) per
    `docs/wire-validation-routing.md` — all in
    `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS` (no generated Zod schema, gappy
    synth SDL). No `<OpName>.snapshot.json` exists at commit time; capture
    is a separate `TTCTL_E2E=1 TTCTL_UPDATE_WIRE_SNAPSHOTS=1` task, out of
    scope for this production-unblock fix.
  - **Doc surface**: not triggered (no touch to
    `packages/core/src/auth/**` or `packages/core/src/services/profile/**`).
  - **Gates**: surface coverage / write-read symmetry / e2e coverage
    unchanged.

- **`profile.basic.set`: document the SMS-consent account-state
  precondition for `UPDATE_BASIC_INFO` (no issue; refs #536).** The
  Toptal `UPDATE_BASIC_INFO` mutation has an account-state precondition
  that is NOT visible on the wire input: the talent must have agreed to
  "receive text messages for important notifications" in account
  settings (talent.toptal.com → notifications). When that consent is
  disabled the mutation does not go through, and the failure is hard to
  diagnose without prior knowledge of the gate. Tier 1 (docs-only): the
  precise wire failure mode has NOT been empirically captured, so a
  dedicated domain error code (Tier 2) is deferred until a captured
  failure response is available — today the failure surfaces via
  whichever `ProfileError` branch catches it (most likely `USER_ERROR`
  or `GRAPHQL_ERROR`). No code behavior change. TTCtl deliberately does
  NOT expose `UpdateSmsNotificationsSettings` (README § Out of scope),
  so the only remediation is a one-time web-UI toggle by the user.
  - **Surfaces updated**:
    - `packages/core/src/services/profile/basic/index.ts` — JSDoc on
      `set()` documents the precondition + the deferral rationale +
      cross-ref to README § Out of scope.
    - `packages/cli/src/commands/profile/basic/index.ts` —
      `.addHelpText("after", …)` on `ttctl profile basic update`
      surfaces the precondition.
    - `packages/cli/src/commands/profile/basic/set.ts` — action-handler
      JSDoc reference.
    - `packages/mcp/src/tools/profile_basic_update.ts` — precondition
      note in the `ttctl_profile_basic_update` tool description so
      MCP-side agents instruct the user to re-enable SMS consent in the
      web UI on failure (we cannot toggle it for them).
  - **Schema/contract rule**: NOT triggered. Touches files under
    `packages/core/src/services/profile/**` (the file-path trigger), but
    comment / help-text only — no wire format change, no new GraphQL op,
    no inferred contract introduced.
  - **Track 1 vs Track 2**: T1 (unchanged) — `UPDATE_BASIC_INFO` remains
    on the wire-shape-snapshot track; this change introduces no new op.
  - **Doc surface**: TRIGGERED — touches
    `packages/core/src/services/profile/basic/**` and the MCP / CLI
    descriptions; the documentation is the user-facing surface being
    corrected. No code-path behavior changed.

### Removed

- **`ttctl_profile_reviews_submit_for_review` MCP tool — removed (#544).**
  The tool was a UX trap: exposed on the MCP surface, but every call
  returned the GraphQL error `SubmitForReviewInput isn't a defined input
type (on $input)` because its input shape was INFERRED-UNVERIFIED (#91,
  wontfix). Investigation per #544 further established the tool is
  unnecessary — Toptal profile edits for the flows TTCtl exercises land
  live immediately; no "submit for review" gate applies to the normal
  editing flow. Removed from the MCP surface (the cleanest of the #544
  resolution options).
  - **Surfaces updated**:
    - Deleted `packages/mcp/src/tools/profile_reviews_submit_for_review.ts`
      and its import + registration call from `packages/mcp/src/tools/index.ts`.
    - MCP tool inventory tests (`registration.test.ts`, `tools.test.ts`,
      `dryrun-smoke.test.ts`) updated 121 → 120 tools.
    - `docs/security/mcp-leakage-threat-model.md` — `profile.reviews`
      section header (4 → 3 tools); the row for the deleted tool removed.
  - **Intentionally untouched**: the `ttctl profile reviews
submit-for-review` CLI command (explicit user-typed invocation is not a
    UX trap), the `packages/core/src/services/profile/reviews/index.ts` core
    service (still invoked by the CLI command — the surface-coverage gate now
    reports it as CLI-only, a Class C informational row that does not fail the
    gate), and the `codegen.config.ts` / `docs/wire-validation-routing.md` /
    ADR-009 / e2e references to the underlying wire op, which remain in place.
  - **Schema/contract rule**: NOT triggered — this removes a broken tool; it
    does not introduce a new GraphQL operation or new wire contract.
  - **Doc surface**: not applicable — no files under
    `packages/core/src/services/profile/**`, `packages/core/src/auth/**`, or
    the exact-paths set were modified.
  - **Gates**: surface coverage now reports `profile.reviews.submitForReview`
    as CLI-only (Class C informational); write-read symmetry / E2E coverage
    unchanged.

## [v0.1.0-rc.8] - 2026-05-22

### Added

- **`applications interview guide show <interviewId>` — `InterviewGuide`
  content read (#470).** Read-only wrapper around the captured
  mobile-gateway `InterviewGuide` query. Returns structured
  `InterviewGuideProjection`
  (`{ interviewId, guideId, sections[].{ identifier, title, subtitle,
tips[].{ identifier, title, content, hardcodedContent } } }`) — the
  guide/tips skeleton that drives the talent's prep view, with
  `tip.content` (job/talent-personalized markdown) and
  `tip.hardcodedContent` (generic template) as the actual prose.
  Resolves two issue-body wire ambiguities at capture time: input is
  the **interview id** (the op takes `$interviewId: ID!`), not an
  `interviewType` enum; and the return shape is **structured
  sections/tips**, not a single Markdown/HTML blob. Sub-sub-namespace
  pattern follows #440's `.notes.show()` sibling under the
  `applications.interviews.*` namespace from #439.
  - **Service surface**: `applications.interviews.guide.show(token,
interviewId) → InterviewGuideProjection` in
    `packages/core/src/services/applications/index.ts`. Inline
    hand-authored query (selection trimmed from the captured doc —
    drops the heavy `interviewContacts` + `job → jobData` cascade,
    `client`, and `mobileFeedbackForm`). Preserves the captured op's
    `statuses: ALL` so any interview state's guide is fetchable.
  - **CLI surface**: `ttctl applications interview guide show
<interviewId>` with `-o pretty | json | yaml`. Pretty mode emits a
    Sections / Tips outline; JSON/YAML emit the verbatim projection.
  - **MCP surface**: `ttctl_applications_interview_guide_show` —
    read-only tool. Bumps the MCP tool count delta tracked across
    `registration.test.ts` / `tools.test.ts` / `dryrun-smoke.test.ts`.
  - **Schema/contract rule**: TRIGGERED — new hand-authored
    GraphQL op. E2E at
    `packages/e2e/src/65-applications-interview-guide.e2e.test.ts`.
    NOT_FOUND probe live-passes against the new `InterviewGuide` op;
    projection + snapshot tests skip-return until the test account
    surfaces an interview in `JobActivityItems` (same `HTTP 400`
    account-scoped limitation as #439 / #440, tracked in #520).
  - **Track 1 vs Track 2**: T1 — `InterviewGuide` is in
    `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`; structurally forced. Routing
    manifest row added (`docs/wire-validation-routing.md`). Snapshot
    file `packages/e2e/src/wire-snapshots/InterviewGuide.snapshot.json`
    will land once a real interview id is reachable on the maintainer
    account.

- **`applications availability-request show <id>` —
  `AvailabilityRequest` query wrapper (#442).** Read-only wrapper
  around the captured mobile-gateway `AvailabilityRequest` op. Returns
  `AvailabilityRequestDetail` — the same canonical AR id the #411
  `applications confirm` / `reject` write-side leaves accept (NOT the
  activity-item id). Discover the id via `applications show
<activityId>` (`Availability request: <id>` line). Mirrors the #439
  / #440 sub-namespace precedent at
  `applications.availabilityRequests.*`.
  - **Service surface**: `applications.availabilityRequests.show(
token, id) → AvailabilityRequestDetail`. Selection is a trimmed
    subset of the captured `AvailabilityRequest.graphql` — trims
    `job` to the `ApplicationJobRef` shape (drops the heavy `jobData`
    cascade) and omits the `Unknown`-typed `jobExpertiseAnswers` /
    `rejectReason` fields.
  - **CLI surface**: `ttctl applications availability-request show
<id>` with the standard `pretty | json | yaml` output triplet.
  - **MCP surface**: `ttctl_applications_availability_request_show` —
    `ttctl_applications_*` tool count bumps 116 → 117.
  - **Schema/contract rule**: TRIGGERED — new hand-authored op against
    the mobile-gateway. E2E at
    `packages/e2e/src/64-applications-availability-request-show.e2e.test.ts`,
    **3/3 live-passed in 10.50s**. The NOT_FOUND probe (the
    load-bearing live test for op callability) exercised the op
    against a syntactically-plausible-but-never-issued id and got
    back a structurally-valid `code: "NOT_FOUND"` envelope — proving
    op name, query shape, and error-mapping all work against the live
    API. The detail + snapshot tests skip-returned gracefully (same
    `JobActivityItems` HTTP 400 account limitation as #439 / #440 /
    #470).
  - **Track 1 vs Track 2**: T1 — `AvailabilityRequest` is in
    `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`; structurally forced. Routing
    manifest row added. Snapshot deferred until an AR is reachable on
    the maintainer account (independent of #520, which scopes
    `Interview` + `GetInterviewNotes` only).

- **`applications interview notes show <jobId>` — `GetInterviewNotes`
  query wrapper (#440).** Read-only wrapper around the portal-side
  `GetInterviewNotes` query — returns `InterviewNotesProjection`
  (`jobId` echo, `interview.{ id, kind, talentNotes }`) so the talent
  can read their interview prep notes via CLI / MCP. Sub-sub-namespace
  `applications.interviews.notes.show()` extends the #439
  `applications.interviews.*` line. Resolves the issue-body's
  `Input: id — interview id` mis-statement against wire reality: the
  op takes `$jobId: ID!` (a `TalentJob.id`) and traverses
  `viewer.job(id).activityItem.interview.{ id, kind, talentNotes }`.
  Discover the job id via `applications interview show <interviewId>`
  (the `Job → Job id` line from the #439 projection) or
  `applications show <activityId>`.
  - **Service surface**: `applications.interviews.notes.show(token,
jobId) → InterviewNotesProjection`. Hand-authored query string —
    trimmed strict subset of the captured portal document (drops the
    heavy job-detail cascade; keeps only the `talentNotes` selection).
  - **CLI surface**: `ttctl applications interview notes show <jobId>`
    with standard output triplet.
  - **MCP surface**: `ttctl_applications_interview_notes_show`.
  - **Schema/contract rule**: TRIGGERED — `GetInterviewNotes` is a
    new GraphQL op for TTCtl, in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`.
    E2E at
    `packages/e2e/src/63-applications-interview-notes-show.e2e.test.ts`;
    NOT_FOUND probe live-passes. Detail + snapshot tests
    skip-returned (same `JobActivityItems` HTTP 400 account limitation
    as #439).
  - **Track 1 vs Track 2**: T1 — structurally forced (op in
    portal-untrusted list). Routing manifest row added. Snapshot
    deferred per #520.

- **`applications interview show <interviewId>` — `Interview` query
  wrapper (#439).** Read-only wrapper around the captured
  mobile-gateway `Interview` query. Returns `InterviewDetail`
  (interviewer contacts, scheduled slots, agenda / prep-guide ref,
  talent's own notes) — the drill-down for the `Interview: <id>` line
  surfaced on `applications show <activityId>`. Establishes the
  `applications.interviews.*` sub-namespace consumed by #440 / #470.
  - **Service surface**: `applications.interviews.show(token, id) →
InterviewDetail`. Selection is a trimmed subset of the captured
    `Interview.graphql` — drops the `jobActivityItemData` fragment
    cascade (caller already has the activity row).
  - **CLI surface**: `ttctl applications interview show <interviewId>`
    with standard output triplet.
  - **MCP surface**: `ttctl_applications_interview_show`.
  - **Schema/contract rule**: TRIGGERED — new hand-authored op. E2E at
    `packages/e2e/src/62-applications-interview-show.e2e.test.ts`;
    NOT_FOUND probe live-passes. Detail + snapshot tests
    skip-returned (account-scoped `JobActivityItems` HTTP 400 — same
    posture as #440 / #470, tracked in #520).
  - **Track 1 vs Track 2**: T1 — structurally forced
    (`GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`). Routing manifest row added.

- **`payments summary` — `GetTalentPaymentSummary` six-total aggregate
  (#448).** Lightweight at-a-glance financial overview complementing
  the heavier paginated `payouts.list`. Wraps the gateway-portal
  `GetTalentPaymentSummary` query — returns the six-field
  `PayoutsSummary` aggregate (`totalPaid` / `totalDue` /
  `totalOutstanding` / `totalOverdue` / `totalOnHold` / `totalDisputed`,
  each a decimal string) spanning the talent's entire payment history.
  Issue-body resolution: the proposed `monthlySummary[]`, "projected
  payout", and `--year` / `--month` filters do not exist in the
  verbatim `GetTalentPaymentSummary.graphql` operation document — the
  op selects only the six flat totals. Per `CLAUDE.md § Schema/contract
validation rule`, the operation document is the wire-contract
  authority; the query document retains the verbatim variable
  declarations (`$status`, `$createdOn`, `$clientIds` — all optional),
  so a future filtered leaf needs no query rewrite.
  - **Service surface**: `payments.summary(token) → PayoutsSummary` in
    `packages/core/src/services/payments/index.ts`.
  - **CLI surface**: `ttctl payments summary` with standard output
    triplet.
  - **MCP surface**: `ttctl_payments_summary` — MCP tool count moves to
    114 across the four bookkeeping sites.
  - **Schema/contract rule**: TRIGGERED — new hand-authored op against
    the gateway-portal surface. E2E at
    `packages/e2e/src/61-payments-summary.e2e.test.ts`, **3/3
    live-passed in 11.33s** against the live mobile-gateway. Wire
    snapshot captured on first `TTCTL_E2E=1
TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run (2026-05-22 14:32) and
    re-asserted stable on the immediately-following run without the
    update flag (14:33).
  - **Track 1 vs Track 2**: T1 — `GetTalentPaymentSummary` is in
    `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`; structurally forced.
    Snapshot committed at
    [`GetTalentPaymentSummary.snapshot.json`](packages/e2e/src/wire-snapshots/GetTalentPaymentSummary.snapshot.json).
    Routing manifest row added.

- **`payments rate current` — `GetTalentRate` lightweight hourly rate
  read; second T2-wired op on `mobile-gateway` (#447).** New
  `payments.rate.current()` service wraps the trusted-catalog
  `GetTalentRate` portal query — returns `viewerRole.hourlyRate.verbose`
  - `roleId` as a single-line hourly rate read, complementing the
    heavier unified `payments rate show` projection from #149 (preserved
    intact — the issue-body's proposed `rate show` name would have
    collapsed market insight + validation + last/ongoing rate-change
    request, so the new leaf is named `current` to avoid regression).
  * **Service surface**: `payments.rate.current(token) →
TalentRateProjection` with inline-composed
    `GET_TALENT_RATE_RESPONSE_SCHEMA` Zod schema passed as the 5th
    positional argument to `callGateway` (the Z-4 / #288 beachhead
    pattern, mirroring `RATE_CHANGE_FORM_DETAILS_RESPONSE_SCHEMA`).
    Wire-shape failures surface a typed `PaymentsError(code:
"WIRE_SHAPE_ERROR")` envelope per
    `docs/wire-validation-error-format.md` (#281).
  * **CLI surface**: `ttctl payments rate current` with standard
    output triplet (pretty mode emits the verbose single-line rate).
  * **MCP surface**: `ttctl_payments_rate_current` read-only tool.
  * **Schema/contract rule**: TRIGGERED — new call site for a
    GraphQL operation not previously invoked from
    `packages/core/src/**`. E2E at
    `packages/e2e/src/60-payments-rate-current.e2e.test.ts` (gated by
    `TTCTL_E2E=1`; see PR transcript). Two unit tests prove the T2
    wire-up fires: `hourlyRate.verbose` as number rejects via
    `WIRE_SHAPE_ERROR`; `viewerRole.roleId` as string rejects via
    `WIRE_SHAPE_ERROR`.
  * **Track 1 vs Track 2**: **T2 (wired)** — `GetTalentRateQuery`
    exists in the trusted-catalog `packages/core/src/__generated__/gateway.ts`.
    The inline-composed `GET_TALENT_RATE_RESPONSE_SCHEMA` is the
    second T2-wired op on `mobile-gateway` after `RateChangeFormDetails`.
    Routing manifest row added; mobile-gateway summary delta: `1→2
T2 wired`; total `1→2 T2 wired`.

- **`ttctl jobs apply <job-id>` — direct-apply CLI verb with `--consent`
  gate + `--show-questions` preview + `--suggest-answers` + `--dry-run`
  (#430 / #426 / #437 / #428 / #452).** Application-funnel write-side
  arrives. The user-facing direct-apply verb composes the apply funnel
  end-to-end per
  [ADR-008](hq/engineering/adr/ADR-008-application-funnel-write-side.md):
  pre-apply read suite (#424) → consent-gated mutation (#426) → opt-in
  similar-answers suggestion (#452). The verb lives on `jobs` (reads
  naturally: "apply to a job") while the underlying service module is
  `applications.apply()` from #426.
  - **Service surface (core, #426)**: `applications.apply(token,
jobId, input, options) → ApplyOutcome`. Symmetric with
    `applications.confirm` / `applications.reject`; lives on the
    `applications.*` module per ADR-008 § Decision Part 5 (funnel-
    crossing implementation, not a `jobs.*` surface). The flow is:
    (1) consent gate refuses (`CONSENT_REQUIRED`) BEFORE any wire
    call when `input.consentIssued !== true` (type-system literal +
    runtime check covering `as`-cast / JSON-sourced inputs); (2)
    dry-run short-circuit (zero wire calls including no pre-fetch;
    `<resolved at apply time>` placeholder when rate is unresolved);
    (3) pre-fetch via `Promise.all` — `applyData` + `applyQuestions` + `rateInsight` concurrently; reject-on-first; (4) structural
    validation of `matcherAnswers[]` (uses `id`, per recovered SDL)
    and `expertiseAnswers[]` (uses `questionId`) against the question
    inventory; (5) rate default per REQ-A4 — caller `requestedHourlyRate`
    overrides `PreApplyData.suggestedRate`; (6) `JobApply` mutation
    with wire-quirk-aware variable mapping: `understand: $consentIssued`
    (Q3 — wire field is `understand`) and `pitchData: $talentCard`
    (Q1 — variable is `talentCard`, input field is `pitchData`); (7)
    error mapping — wire-`already_applied` remaps to a typed
    `ALREADY_APPLIED` envelope with an `applications show <activity-id>`
    recovery hint.
  - **Pre-apply read suite (core, #424)**:
    `applications.applyData(token, jobId)` (aggregate pre-apply
    context — job + `viewerRole.rates` + `platformConfiguration.rateValidationRules`),
    `applications.applyQuestions(token, jobId)` (matcher + expertise
    question inventory, 4-field `{ identifier, prompt, type, isMandatory }`),
    `applications.rateInsight(token, jobId)` (`RateInsight | null`
    discriminated union — `competitive` / `uncompetitive`, with
    `BigDecimal` scalars NOT `Money`; verified against captured doc
    - schema). The `NOT_FOUND_MESSAGE_PATTERN` regex widens from
      `/Record not found/i` to
      `/Record not found|Invalid ID|Node id .*? resolves to/i` —
      load-bearing for the new pre-apply reads that surface Relay
      decode errors on bad ids (per the project's Toptal wire-quirks
      auto-memory).
  - **CLI surface (#430)**: `ttctl jobs apply <job-id>` with
    `--consent` (REQUIRED, no default — legal-compliance attestation
    per ADR-008 § Decision Part 4; absence raises `CONSENT_REQUIRED`
    with no wire call), `--rate <decimal>` (optional; defaults from
    `PreApplyData.suggestedRate` when omitted — REQ-A4),
    `-m, --message <text>`, `--answers-file <path>` / `--pitch-file
<path>` (locked JSON grammar per ADR-008 § Decision Part 2;
    supports `-` for stdin; shares `readJsonInput` lib from #428),
    `--show-questions` (preview-only, REQ-Q3 — routed BEFORE the
    consent gate; fetches `applyData + applyQuestions` and emits a
    structured preview WITHOUT issuing the mutation),
    `--dry-run` (threaded to `applications.apply(.., { dryRun })`),
    and the standard `-o pretty | json | yaml`. DESTRUCTIVE-warning
    text matches the `applications confirm` (#411) posture.
  - **CLI sibling (#437)**: `ttctl jobs show <id> --with-questions`
    (opt-in flag) parallel-runs `applications.applyQuestions(token,
id)` alongside the existing `jobs.show()` fetch. Pretty output
    gains `Matcher Questions (N)` and `Expertise Questions (N)`
    sections; JSON envelope carries `{ ...JobDetail, questions: {
matcher, expertise } }`. Flag-omitted behavior is byte-identical
    to the pre-#437 baseline.
  - **CLI extension (#428)**: `ttctl applications confirm` gains
    `--answers-file <path>` (`{ matcherAnswers: [...], expertiseAnswers:
[...] }` JSON) and `--pitch-file <path>` (`PitchInput` JSON
    object). Both accept `-` for stdin; the second `-` claim
    surfaces a typed `STDIN_DOUBLE_CLAIM` validation error.
    Malformed JSON, missing files, and wrong top-level shapes refuse
    with `VALIDATION_ERROR` envelopes BEFORE any wire call.
    `applications.confirm()` core gets the matching wire-payload
    forwarding test coverage in #423.
  - **MCP surface (#436)**: 4 new tools — `ttctl_jobs_apply` (the
    DESTRUCTIVE mutation tool, consent-gated via `consentIssued:
z.literal(true)`) + `ttctl_jobs_apply_data` +
    `ttctl_jobs_apply_questions` + `ttctl_jobs_apply_rate_insight`
    (read-only pre-apply tools). MCP tool count moves 107 → 111;
    the three `// surface-exempt:` markers from #424 are removed
    (the fns are now genuinely surfaced).
  - **MCP IR-accept extension (#429)**: `ttctl_interest_requests_accept`
    gains `matcherAnswers` / `expertiseAnswers` / `pitchData` as
    optional opaque `z.unknown()` fields. Forwarded as the wire's
    `matcherQuestionsAnswers` / `expertiseQuestionsAnswers` /
    `pitchInput` variables. Backward compat preserved when fields
    are absent (#411 regression guard).
  - **`applications.similarAnswers` (#452)**: New core fn wraps the
    captured `SimilarJobQuestionAnswers($id)` op. Fans out N parallel
    calls (one per matcher + expertise question via an internal
    `applyQuestions(jobId)` pre-fetch) and returns
    `SimilarJobAnswerGroup[]` grouped per question — matches the
    mobile app's apply-screen autocomplete behavior. CLI exposes
    `--suggest-answers` as an opt-in flag (NOT in the default 3-query
    pre-apply suite). Failures degrade gracefully: stderr warning,
    apply continues, output omits the suggestions section. No
    auto-fill of the answers payload — suggestions are advisory only.
    MCP exposes the standalone `ttctl_jobs_apply_similar_answers`
    tool (MCP tool count moves 111 → 112).
  - **Codegen recovery (#425)**: `pnpm codegen` regenerated with
    research-side recovery of `JobPositionAnswerInput` /
    `JobExpertiseAnswerInput` / `PitchInput` input shapes. Consumed
    immediately by #438's Stage-2 schema tightening (already in this
    cut's `### Changed`).
  - **Live E2E (#445)**: Schema/contract gate satisfied for #423 /
    #424 / #426 / #428 / #429 / #430 / #436 in one PR. Three new
    e2e files at numbers `56-` / `57-` / `58-` (the proposed `50-` /
    `51-` / `52-` and the fallback `53-` / `54-` / `55-` all
    collided with existing files — preserves the file-ordering
    test's strictly-increasing invariant). Wire-shape snapshots
    materialise on the operator's first `TTCTL_E2E=1
TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run. ADR-008 design open
    questions Q1 / Q2 / Q3 / Q4 are env-gated for live resolution.
  - **Cross-cutting docs + redaction (#446)**: README adds
    `## Applying to jobs` + `## Interest Requests` sections;
    `docs/wire-validation-routing.md` gains the four T1 rows for
    `JobApply` / `JobApplyData` / `JobApplicationQuestions` /
    `JobApplicationRateInsight` plus a new "Application-funnel
    write-side T2 promotion" sub-section. MCP diagnostic redaction
    extended with the `MCP_PII_FIELD_NAMES` allowlist (7 keys —
    `matcheranswers`, `matcherquestionsanswers`, `expertiseanswers`,
    `expertisequestionsanswers`, `pitchdata`, `pitchinput`,
    `talentcard`) plus the `redactMcpPiiFields` traversal. CLI help
    drive-by fix: `jobs apply` `APPLY_ANSWERS_FILE_HELP` corrects
    matcher answer shape from `{questionId, answer}` to `{id,
answer}` (pre-#446 help would have caused Zod strict-mode
    rejection at runtime).
  - **Schema/contract rule**: TRIGGERED — new hand-authored ops
    `JobApply`, `JobApplyData`, `JobApplicationQuestions`,
    `JobApplicationRateInsight`, `SimilarJobQuestionAnswers`. Live
    coverage at `packages/e2e/src/56-jobs-apply.e2e.test.ts`,
    `57-jobs-apply-data.e2e.test.ts`,
    `58-applications-confirm-with-questions.e2e.test.ts`, and
    `59-jobs-apply-similar-answers.e2e.test.ts` (committed
    `SimilarJobQuestionAnswers.snapshot.json`). The
    `ConfirmAvailabilityRequest` wire is unchanged in shape — only
    the variables payload populates (#423 / #428 / #429 tests pin
    the forwarding contract).
  - **Track 1 vs Track 2**: T1 for all five ops — every op remains
    in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`. T2 promotion is
    forward-compatible per the routing manifest's
    "Application-funnel write-side T2 promotion" sub-section, gated
    on the broader codegen-exclusion shrink. `SimilarJobQuestionAnswers`
    snapshot is committed; the other four snapshots materialise from
    the operator's first env-gated E2E run per the protocol in
    `packages/e2e/src/wire-snapshots/README.md`.

- **Per-domain consent gate for INFERRED-destructive mutations
  (#258, [ADR-009](hq/engineering/adr/ADR-009-per-domain-consent-vocabulary.md)).**
  Ships `ensureDestructiveConsent(opName, domain, input, options?)` in
  `packages/core/src/consent.ts` plus a new `ConsentRequiredError`
  (`TtctlError` subclass, `code: "CONSENT_REQUIRED"`) and a
  `ConsentDomain` type with four values per ADR-009 § Decision Part 1:
  `"interview-action"` / `"payment-routing"` /
  `"profile-capability"` / `"timesheet-billing"`. The Zod-boundary
  field names mirror the type (`interviewActionConsentIssued` /
  `paymentRoutingConsentIssued` / `profileCapabilityConsentIssued` /
  `timesheetBillingConsentIssued`) and surface as per-domain CLI
  flags (`--consent-{domain}`). The first wired-up site is
  `submitForReview` (`profile-capability` domain), the existing
  INFERRED-destructive mutation that motivated #258. Each gate runs
  BEFORE any wire call.
  - **Service surface**: `profile.reviews.submitForReview(token,
consent)` now requires `consent.profileCapabilityConsentIssued:
true` (compile-time literal + runtime gate). Absent / `false` /
    non-boolean values surface `ConsentRequiredError`. The static
    type is narrowed for in-tree callers; the runtime check covers
    the `as`-cast / JSON-sourced inputs from CLI / MCP / agents.
  - **CLI surface**: `ttctl profile reviews submit-for-review` gains
    a `--consent-profile-capability` flag with explanatory `--help`
    text. The flag is required for the mutation to fire — omission
    surfaces the `CONSENT_REQUIRED` envelope with a recovery hint
    (exit code 1).
  - **MCP surface**: `ttctl_profile_reviews_submit_for_review` adds
    `profileCapabilityConsentIssued: z.literal(true)` as a required
    input field, plus the `annotations.destructiveHint: true` MCP
    annotation so hosts (Claude Desktop / Cursor / Windsurf) can
    surface a confirmation prompt to the operator.
  - **Env-var bypass**: `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1`
    bypasses the consent-literal check for non-interactive CI / test
    contexts. The bypass does NOT cover the supplementary
    `idempotencyKey` + `accountIdentifierEcho` factors that
    payment-routing CREATE\_\* mutations will require (per ADR-009
    § Decision Part 2) — those factors protect against bugs in any
    caller, agent or human.
  - **Payment-routing CREATE\_\* additional factors**: the gate
    enforces `idempotencyKey: string` (length >= 16) +
    `accountIdentifierEcho: string` (length >= 4, must match the
    caller-supplied `expectedAccountIdentifier`) when the
    `paymentRoutingCreate` option is passed. The 17 dependent
    mutations (#432-#476) consume this in their respective PRs;
    this PR ships the gate utility with unit-test coverage of the
    factor enforcement (echo-mismatch test included).
  - **Orthogonality with ADR-008**: the wire-level `consentIssued:
Boolean!` on `JobApply` (ADR-008's apply-funnel compliance
    signal) is unchanged. The `applications.apply()` gate stays
    inline and continues to throw `ApplicationsError("CONSENT_REQUIRED")`.
    ADR-009's tokens are TTCtl-layer gates at the Zod input
    boundary; they do not appear on the wire.
  - **Schema/contract rule**: NOT TRIGGERED — no new wire ops; no
    wire-format changes. The `submitForReview` mutation's wire
    shape (`{ profileId: ID! }`) is unchanged; only the TTCtl-layer
    signature gains the `consent` parameter.

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

### Changed

- **Stage-2 surface tightening (#438) — `ConfirmInput` / `ApplyInput`
  / MCP IR-accept + jobs-apply Zod schemas now validate against the
  recovered SDL shapes from #425.** Replaces the opaque
  `z.array(z.unknown())` / `z.unknown()` pass-throughs shipped in
  Wave 0 with typed Zod schemas
  (`JobPositionAnswerInputSchema().strict()`,
  `JobExpertiseAnswerInputSchema().strict()`,
  `PitchInputSchema().strict()`) per ADR-008 § Decision Part 3.
  Surfaces affected: Core `ConfirmInput.matcherQuestionsAnswers` /
  `.expertiseQuestionsAnswers` / `.pitchInput`; Core
  `ApplyInput.matcherAnswers` / `.expertiseAnswers` / `.pitchData`;
  CLI `applications confirm` AND CLI `jobs apply` (both validate via
  the new `parseAsRecovered<T>(value, schema, flagName)` helper in
  `packages/cli/src/lib/json-input.ts`); MCP
  `ttctl_interest_requests_accept` AND MCP `ttctl_jobs_apply` tool
  inputSchemas (replaces `z.array(z.unknown())` / `z.unknown()` with
  `z.array(...InputSchema().strict())` / `...InputSchema().strict()`).
  - **Pre-1.0 minor breaking change**: agents / scripts passing
    malformed shapes now fail at client-side schema validation
    (typed `VALIDATION_ERROR` envelope at the CLI; typed Zod
    rejection at the MCP framework) rather than at the wire. The
    behavioral change is fail-fast — the previously-opaque
    pass-through would have flowed through to the wire and either
    been silently accepted (if the wire was permissive) or
    rejected with a generic `GRAPHQL_ERROR`.
  - **Field-name fix (matcher answers)**: the previous opaque
    Wave-0 documentation said matcher answers used `questionId`;
    per the recovered SDL, `JobPositionAnswerInput` uses `id` —
    **NOT** `questionId`. The runtime `validateAnswerIds` check
    in `applications.apply()` is updated to validate
    `matcherAnswers[*].id` against the inventory (expertise
    answers continue to use `questionId` per
    `JobExpertiseAnswerInput`; the field-name asymmetry is per the
    recovered SDL). Callers passing matcher answers with
    `questionId` will now be rejected at the CLI/MCP boundary
    BEFORE the wire call. Recovery: rename `questionId` → `id`
    in matcher answer entries.
  - **Example-shape migration**: the example payloads in
    `applications confirm` / `jobs apply` `--help` output and the
    `ttctl_interest_requests_accept` / `ttctl_jobs_apply` tool
    descriptions are updated to reflect the recovered shapes
    (matcher uses `{ id, answer }`; expertise uses
    `{ questionId, other, subjectId }`; pitch uses the typed
    `PitchInput` schema — every nullable slot must be present,
    `null` for the empty case, per `codegen.config.ts`'s
    `nullishBehavior: "nullable"`).
  - **Schema/contract rule**: NOT TRIGGERED (no new wire ops); the
    behavior change is in client-side validation routing. The
    existing E2E coverage for `confirm` (and #445's apply
    coverage once it lands) must continue passing — the
    wire-format itself is unchanged.

- **README: enumerate by-design out-of-scope surfaces (#427).**
  Adds an `### Out of scope` subsection under `## What It Does`
  enumerating the Toptal Talent surfaces TTCtl deliberately does not
  implement. Each bullet carries a kebab-case category label
  (`abuse-prevention`, `third-party-SDK`, `client-onboarding`,
  `one-time-action`, `mobile-only-UI`, `staff-side`, `sourcing-side`)
  plus a short rationale. Calls out `scheduler.toptal.com` (interview
  scheduling) separately as currently absent rather than out-by-design
  — deferred until reverse-engineering research closes.

- **README: append `update` verb to Timesheets bullet (#431).**
  One-line edit anticipating #458 (UpdateTimesheet) which is unblocked
  since #258 (consent gate) merged. The parallel timesheet enumeration
  in `packages/mcp/README.md` will need the same update when #458
  registers the `ttctl_timesheet_update` MCP tool; tracked separately
  as #513.

- **availability allocated-hours: lock semantics with Gherkin +
  wire-shape snapshots (#461).** Specification-by-example coverage
  for `availability.allocatedHours.{show,set}` plus Track 1 wire-shape
  snapshots for `GetAvailability` and `UpdateAllocatedHours` on the
  mobile-gateway surface. Lock-only chore — no code change in
  `packages/core/src/services/availability/`. Six Gherkin scenarios
  in `features/availability-allocated-hours.feature.md` lock read,
  round-trip update, client-side validation (non-integer + negative
  rejected), dry-run preview, and the write-read symmetry property
  (`allocatedHours` echoes on `GetAvailability` because both ops
  select from the same `viewer.viewerRole.allocatedHours` wire
  source). Documents that the op is viewer-scoped — no engagement-
  level allocation surface exists on the API, correcting the issue
  body's initial premise. `scripts/check-write-read-symmetry.ts`
  `SCAN_PREFIXES` extended to include `services/availability/` for
  forward-compat monitoring (current API shape produces zero
  automatic pairings — rationale documented in the SCAN_PREFIXES
  JSDoc). Committed snapshots at
  [`GetAvailability.snapshot.json`](packages/e2e/src/wire-snapshots/GetAvailability.snapshot.json)
  and
  [`UpdateAllocatedHours.snapshot.json`](packages/e2e/src/wire-snapshots/UpdateAllocatedHours.snapshot.json).
  - **Schema/contract rule**: NOT TRIGGERED — no new GraphQL
    operations or wire-input changes. All ops are pre-existing and
    already verified by `23-availability-write.e2e.test.ts`.
  - **Track 1 vs Track 2**: T1 (unchanged) — wire-shape snapshots
    for the existing ops, consistent with their mobile-gateway
    surface and the absence of generated Zod schemas for them.

### Fixed

- **`profile employment update` on `noEmployer:true` rows (#508).**
  The Rails apply path has a symmetric anchor gate on
  `UpdateEmployment`, mirror of the #484 CREATE-side contract:
  noEmployer rows require the `(noWebsite, companyWebsite)` anchor
  pair echoed PLUS `managementExperience` and `toptalRelated` on the
  wire input — otherwise the path falls through to the
  `employer_id .blank?` validator and produces the misleading
  `employerId: You can't leave this empty` error. The fix in
  `buildUpdateEmploymentInput`: (a) echoes the anchor pair from
  current on the null-employerId branch; (b) force-echoes
  `managementExperience` and `toptalRelated` on every UPDATE; (c)
  extends `EMPLOYMENT_FRAGMENT` to read `managementExperience` so
  the echo has source data; (d) fixes `mapEmploymentNode` to coerce
  non-string `reportingTo` to `null` (was incorrectly typed as
  `unknown[]` on rows where the wire returned an empty array).
  Catalog-employer rows continue to omit the anchor pair per the
  #487 rollback (where echoing trips a DIFFERENT anchor gate,
  "either employer or company website"). Supersedes the WORM framing
  in `research/notes/15-employment-custom-workplace-worm.md` and
  refutes the catalog-Employer hypothesis in #505 (closed as not
  planned). Verified on the live talent-profile wire via
  `45-profile-employment-add.e2e.test.ts` (now exercises a full
  `update → restore` on a real noEmployer row). Wire-shape snapshots
  refreshed for `CreateEmployment`, `UpdateEmployment`, and
  `GET_WORK_EXPERIENCE` to reflect the extended fragment.

- **`profile employment update`: preserve `current.endDate` through
  merge on partial updates (#487).** Wire-breakage where
  `employment_update` silently null-set `endDate` on partial updates
  that did not supply `to`, converting closed roles ("Year – Year")
  to ongoing ("Year – Present") on the public Toptal profile. Root
  cause: `buildUpdateEmploymentInput` in
  `packages/core/src/services/profile/employment/index.ts` omitted
  `endDate` from the `merged` object; the talent_profile/graphql
  server treats absence of a nullable field as null-set, not
  "preserve current" — asymmetric with `startDate` which was already
  force-echoed. Fix force-echoes `endDate` through the merge with a
  three-state semantic: caller `endDate === undefined` → preserve
  `current.endDate`; caller `endDate === null` → clear (mark closed
  role as current); caller `endDate === number` → set to year.
  Identity check (not `??`) because `null` is a meaningful intentional
  value. A broader "echo every read-side-surfaced field" generalisation
  was attempted mid-PR and rolled back: echoing `(companyWebsite,
noWebsite)` on catalog-employer rows trips the Rails anchor gate
  `(employerId): You should specify either employer or company
website` — same class as the #484 CREATE-side anchor contract.
  `(highlight, toptalRelated)` were rolled back at the same time
  pending per-field live verification. The endDate-only scope is the
  empirically-safe class on this surface. Live-passed at
  `packages/e2e/src/53-profile-employment-update-end-date-preservation.e2e.test.ts`
  (sentinel uses `position: "..."` not `publicationPermit: false`,
  because Rails `.blank?(false)` returns `true` and the wire rejects
  the latter BEFORE the apply path runs).
  - **Schema/contract rule**: TRIGGERED — file-path trigger of the
    code-review checklist (touches
    `packages/core/src/services/profile/employment/index.ts`).
  - **Track 1 vs Track 2**: T1 (unchanged) — `UpdateEmployment` has
    no generated operation type; the open-role baseline snapshot at
    `packages/e2e/src/wire-snapshots/UpdateEmployment.snapshot.json`
    remains the continuing structural reference (the closed-role
    sentinel here intentionally does NOT call `assertWireShapeStable`
    to avoid baseline divergence).

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
