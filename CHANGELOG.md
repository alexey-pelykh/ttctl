# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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

### Changed

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
