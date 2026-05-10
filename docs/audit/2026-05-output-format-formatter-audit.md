# Sub-Domain Formatter Audit — 2026-05

> Audit issued under #124 (Wave 1 of the output-format reframe epic, #121).
> Read by downstream issues: #127 (extend GraphQL queries for dropped
> fields) and #129 (rewrite identified formatters).

## TL;DR

Audit of all 11 profile sub-domain formatters in
`packages/cli/src/commands/profile/*` against:

1. Fields **PRESENT** in the entity TypeScript type
2. Fields **SETTABLE** by the user via the corresponding `add` / `update`
   commands
3. Fields **RENDERED** in the default `text` (and `table`) formatters

**Headline findings**:

- **Field-dropping defects** confirmed in 6 of 11 sub-domains. Severity
  ranges from **HIGH** (basic, portfolio) to **MEDIUM** (industries,
  employment, visas) to **LOW** (skills). Five sub-domains are clean
  (education, certifications, resume, external, reviews).
- **Null-rendering inconsistency** is pervasive: at least **four**
  distinct conventions co-exist across the 11 sub-domains (`?`,
  `(unset)`, empty string `""`, skip-if-null) — sometimes within the
  same file across `text` vs `table`. This audit recommends a single
  convention for the in-flight `pretty` format.
- **Two root causes** for field-dropping: (a) the default text formatter
  selects a sub-set of available fields ("formatter root cause" — fix
  by extending the formatter), or (b) the underlying GraphQL **query**
  doesn't fetch the field at all ("query root cause" — fix by
  extending the query in #127, then the formatter in #129). Defects
  flagged below tag the root cause.
- **Per-command override registry**: the issue scope includes a registry
  for `pretty`-shape dispatch (e.g., `reviews list` should default to
  curated multi-line, not a table). The current `reviews` schema does
  not ship long-form text — the override is **forward-looking**: once
  reviewer-comment fields land via #127, the override becomes
  load-bearing. Other override candidates: any `list` whose entity
  carries a paragraph-length field (portfolio `description`,
  employment `experienceItems`).

## Methodology

For each of the 11 sub-domains, this audit recorded:

- **Entity fields**: the source-of-truth interface in
  `packages/core/src/services/profile/<sub>/index.ts`
- **Settable fields**: the CLI flags exposed by `add` and `update`
  leaves in `packages/cli/src/commands/profile/<sub>/`. A field is
  "settable" if some flag maps to it during create or update.
- **Rendered fields**: every `format*Text` and `format*Table` function
  exported from each sub-domain's CLI module. The `text` branch is the
  default user-facing output (precursor to `pretty`); `table` was
  recorded for reference but is being supplanted.
- **Severity classification**:
  - **HIGH** = at least one field that the user can `add` or `update`
    is silently absent from the default `text` output. The user
    edits the field, runs the show/list command, and cannot tell
    their edit landed.
  - **MEDIUM** = some user-settable fields are dropped from `table`
    but still rendered in `text` (or vice-versa); or fields that
    aren't user-settable but materially change the entity's
    interpretation are dropped (e.g., `countryId`).
  - **LOW** = only internal display-order or timestamp fields dropped;
    user-visible state is faithfully echoed.
  - **NONE** = every settable field is rendered in both `text` and
    `table`.

The current `OutputFormat` discriminator is `"text" | "json" | "table"`
(see `packages/cli/src/lib/output.ts`). The sibling Wave-1 work
(#122 empty-state, #123 yaml format, #125 fixtures) is in flight; this
audit treats `text` as the precursor to the post-reframe `pretty`
format and recommends the null convention for that target.

## Per-Sub-Domain Triage

### 1. `basic` — HIGH (query root cause)

**Entity** (`ProfileShowQuery.viewer.viewerRole`, generated): rich —
`fullName`, `email`, `phoneNumber`, `vertical`, `specializations`,
`hourlyRate`, `timeZone`, `availability`, `allocatedHours`,
`hiredHours`, `publicResumeUrl`, `photo {large, small}`, `profile {id,
fullName, city, photo, skillSets}`, plus operational metadata
(`codeOfConduct`, `termsOfService`, `hireMeBanner`, etc.). The nested
`profile` selection currently fetches `id`, `fullName`, `city`, `photo
{large}`, and the `skillSets` summary. **Notably absent from the
selection set: `about` (bio), `quote` (headline), and any
`languages`/`summary`/`memberSince` fields.**

**Settable via `update`**: `--bio` (→ `Profile.about`), `--headline` (→
`Profile.quote`), `--edit` (modifier). That is the entire write
surface today. Photo upload is a separate command pair (`photo show`
/ `photo upload`).

**Rendered in `formatProfileText`** (truncated to 80 cols):

- `role.fullName`, `role.email`, `role.phoneNumber` (skip if `""`),
  `viewerProfile.city` (skip if `""`), `vertical.name`,
  `specializations` (top 3), `availability`, `hours` ratio,
  `hourlyRate.verbose`, `timeZone.value`, public skills (top 5).

**Rendered in `formatProfileTable`**: same set + `allocated_hours`,
`hired_hours`, `public_resume_url`. `city` empty-string falls back to
literal `(unset)`; `phoneNumber` rendered as-is even when empty.

**Field-dropping defects**:

| Field                                 | Settable?                      | In query? | In `text`? | In `table`? | Severity                                                    | Root cause                                                                |
| ------------------------------------- | ------------------------------ | --------- | ---------- | ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `bio` (`about`)                       | ✓ via `--bio`                  | ✗         | ✗          | ✗           | **HIGH**                                                    | **query** — `Profile` selection in `ProfileShow` does not include `about` |
| `headline` (`quote`)                  | ✓ via `--headline`             | ✗         | ✗          | ✗           | **HIGH**                                                    | **query** — same as bio (`quote` not selected)                            |
| `photoUrl` (`photo.large`)            | ✓ via `photo upload`           | ✓         | ✗          | ✗           | MEDIUM                                                      | **formatter** — query has `photo.large` but neither formatter renders it  |
| `summary`, `languages`, `memberSince` | ✗ (not editable from this CLI) | ✗         | ✗          | ✗           | LOW (out of scope for the "user-set, dropped" defect class) | n/a                                                                       |

**Recommendation**: extend the `ProfileShow` query in #127 to add
`about`, `quote`, and (optionally) the talent-profile-side surface
fields needed for a complete read. Then in #129 rewrite
`formatProfileText` to include `bio` (truncated to 200 chars or first
paragraph), `headline`, and `photoUrl` (URL only, on its own line).

> **Surface caveat**: `Profile.about` and `Profile.quote` are not on
> mobile-gateway's `Profile` type per the comment in
> `packages/core/src/services/profile/basic/index.ts:273-278`. The
> read query may need to dispatch a second talent-profile call (or
> the gateway selection set may need expanding upstream). Empirical
> verification belongs to #127.

### 2. `skills` — LOW (cosmetic)

**Entity** (`ProfileSkillSet`): `id`, `experience`, `rating`, `public`,
`position`, `skill {id, name}`, `connectionsCount`.

**Settable via `add`**: `name` only (catalog reference). **Settable via
`update`**: `--rating`, `--experience`, `--experience` (months), `--public` /
`--private`. `position` is server-managed; no CLI flag.

**Rendered in `formatSkillSetText`**: `skill.name`, `id`, `rating`
(skip-if-null), `experience` (skip-if-null), `visibility` ("public" /
"private"), `connectionsCount`.

**Rendered in `formatSkillSetTable`**: same set, but `rating`/`experience`
fall back to **`(unset)`** for null.

**Rendered in `formatSkillsListText`**: `skill.name`, `rating`
(`?` for null), `visibility`, `id`. (4 columns)

**Rendered in `formatSkillsListTable`**: `skill.name`, `rating`
(`(unset)`), `experience` (`(unset)`), `visibility`, `id`. (5 columns)

**Field-dropping defects**:

| Field      | Settable?       | In `text`? | In `table`? | Severity             |
| ---------- | --------------- | ---------- | ----------- | -------------------- |
| `position` | ✗ (no CLI flag) | ✗          | ✗           | LOW (server-managed) |

**Null-rendering inconsistency** (single sub-domain ships **three**
conventions across four functions):

- `formatSkillSetText`: skip-if-null
- `formatSkillSetTable`: `(unset)`
- `formatSkillsListText`: `?` for `rating`
- `formatSkillsListTable`: `(unset)`

**Recommendation**: standardize per § Null-Rendering Convention below.
No query extension needed.

### 3. `industries` — MEDIUM (formatter root cause)

**Entity** (`IndustryProfile`): `id`, `title`, `about`, `domainArea`.

**Settable via `add`**: `<name>` (→ `title`), `--connection` (→
`domainArea`), `--about`. **Settable via `update`**: same.

**Rendered in `formatIndustryText`**: `title`, `domain` (skip-if-null),
`about` (skip-if-null), `id`. **All settable fields covered.**

**Rendered in `formatIndustryTable`**: `id`, `title`, `domain` (`""`
for null), `about` (`""` for null). **All covered.**

**Rendered in `formatIndustryListText`**: same as text per row, joined
by `\n\n`. **All covered.**

**Rendered in `formatIndustryListTable`**: `id`, `title`, `domainArea`
(`""` for null). **`about` is DROPPED — defect.**

**Field-dropping defects**:

| Function                  | Dropped field | Severity | Root cause                              |
| ------------------------- | ------------- | -------- | --------------------------------------- |
| `formatIndustryListTable` | `about`       | MEDIUM   | **formatter** — only 3 columns rendered |

**Null convention**: `text` skip-if-null; `table` empty string `""`.
Cross-formatter inconsistency.

**Recommendation**: in #129, add `about` as a 4th column in
`formatIndustryListTable` (or fold into `pretty` curated multi-line).

### 4. `education` — NONE (clean)

**Entity** (`Education`): `id`, `institution`, `degree`,
`fieldOfStudy`, `location`, `title`, `yearFrom`, `yearTo`, `highlight`.

**Settable via `add`**: `--institution` (req), `--degree` (req),
`--from`, `--to`, `--field-of-study`, `--location`, `--title`.
**Settable via `update`**: above + `--highlight`.

**Rendered in `formatEducationText`**: degree, fieldOfStudy (inline
if present), institution, location (skip-if-null), year range
(`—`/`?–YYYY`/`YYYY–present`/`YYYY–YYYY`), title (skip-if-null),
highlighted (skip-if-false), id. **All settable fields covered.**

**Rendered in `formatEducationTable`**: id, institution, degree,
field_of_study (`""`), location (`""`), title (`""`), years (range
helper), highlight (boolean string). **All covered.**

**Field-dropping defects**: none. **NONE severity.**

**Null convention**: `text` skip-if-null + `—` for empty year range;
`table` empty string `""`. Cross-formatter inconsistency only.

**Recommendation**: no defect work. Apply standardization per § Null
Convention below.

### 5. `certifications` — NONE (clean)

**Entity** (`Certification`): `id`, `certificate`, `institution`,
`link`, `number`, `validFromMonth`, `validFromYear`, `validToMonth`,
`validToYear`, `highlight`.

**Settable via `add`**: `--name` (req → `certificate`), `--issuer`
(req → `institution`), `--issued` (→ `validFromMonth`/`Year`),
`--expires` (→ `validToMonth`/`Year`), `--link`, `--number`. **Settable
via `update`**: above + `--highlight`.

**Rendered in `formatCertificationText`**: `certificate — institution`,
validity range, `cred-id` (skip-if-null), link (skip-if-null),
`highlighted` (skip-if-false), id. **All settable fields covered.**

**Rendered in `formatCertificationTable`**: id, certificate,
institution, valid (range), number (`""`), link (`""`), highlight.
**All covered.**

**Field-dropping defects**: none. **NONE severity.**

**Null convention**: `text` skip-if-null + `—` for empty validity
range; `table` empty string. Same cross-formatter inconsistency.

**Recommendation**: standardization only.

### 6. `employment` — MEDIUM (formatter root cause)

**Entity** (`Employment`): `id`, `company`, `position`,
`companyWebsite`, `noWebsite`, `startDate`, `endDate`,
`experienceItems`, `highlight`, `showViaToptal`, `toptalRelated`.

**Settable via `add`**: `--company` (req), `--role` (req → `position`),
`--from`, `--to`, `--current` (→ endDate=null), `--website`. **Settable
via `update`**: above + `--description` (→ paragraph-split into
`experienceItems`), `--highlight`. (`showViaToptal`/`toptalRelated`
are exposed at the type level for forward growth but have no CLI flags
today — out-of-scope per the audit's "user-settable" criterion.)

**Rendered in `formatEmploymentText`**: `position — company`, website
(skip if null or `noWebsite`), year range, **experienceItems** as
bulleted list, highlighted (skip-if-false), id. **All user-settable
fields rendered.**

**Rendered in `formatEmploymentTable`**: id, company, position, website
(`""`), years, highlight, **`paragraphs` count only** —
`experienceItems` content dropped. **Defect.**

**Field-dropping defects**:

| Function                | Field                                   | Severity | Root cause                                                     |
| ----------------------- | --------------------------------------- | -------- | -------------------------------------------------------------- |
| `formatEmploymentTable` | `experienceItems` (only count rendered) | MEDIUM   | **formatter** — content shown in `text`, only count in `table` |

**Recommendation**: in `pretty` (post-reframe), preserve text-style
paragraph rendering. The table representation of paragraph-bearing
content is fundamentally weak — register `employment list` (and
`employment show` if a `--output table` request lands on a long-text
record) in the override registry as a candidate for curated
multi-line.

**Null convention**: text skip-if-null; table empty string.

### 7. `portfolio` — HIGH (formatter root cause; some fields also need query verification)

**Entity** (`PortfolioItem`): `id`, `title`, `description`, `link`,
`highlight`, `coverImage`, `accomplishment`, `publicationPermit`,
`clientOrCompanyName`, `websiteUrl`, `toptalRelated`, `showViaToptal`.

**Settable via `add`**: `--title` (req), `--description`, `--url` /
`--link`, `--cover` (→ `coverImage` cache-name two-step). **Settable
via `update`**: `--title`, `--description`, `--url` / `--link`,
`--client` (→ `clientOrCompanyName`), `--accomplishment`, `--edit`
(modifier on `description`). **Highlight** is a separate command
(`portfolio highlight <id>`); cover **cannot** be updated post-create.

**Rendered in `formatPortfolioText`**: `id`, `title` (`(untitled)`
fallback), `★` if highlighted, `link` (skip-if-null),
`clientOrCompanyName` (skip-if-null). **5 fields rendered out of 12.**

**Rendered in `formatPortfolioTable`**: id, title (`""`), highlight
(`★`/`""`), link (`""`). **4 columns; client also dropped.**

**Rendered in `emitListResult`** (used by add/update/remove/reorder):
custom-rolled, similar to `formatPortfolioText` (text branch)
or 4-col TSV (table branch). Same dropped set.

**Field-dropping defects** (per the issue's confirmed list, plus an
additional `clientOrCompanyName` asymmetry found in the audit):

| Field                                          | Settable?             | `text` list?  | `table` list? | Severity | Root cause                                                  |
| ---------------------------------------------- | --------------------- | ------------- | ------------- | -------- | ----------------------------------------------------------- |
| `description`                                  | ✓ `add`/`update`      | ✗             | ✗             | **HIGH** | **formatter** (entity has it; query returns it)             |
| `accomplishment`                               | ✓ `update`            | ✗             | ✗             | **HIGH** | **formatter**                                               |
| `coverImage`                                   | ✓ `add`               | ✗             | ✗             | MEDIUM   | **formatter** (URL display)                                 |
| `clientOrCompanyName`                          | ✓ `update`            | ✓ (text only) | ✗             | MEDIUM   | **formatter** asymmetry                                     |
| `tags`, `media`                                | (issue mentions, but) | n/a           | n/a           | n/a      | **NOT IN ENTITY** — likely query root cause; verify in #127 |
| `publicationPermit`                            | ✗ (no flag)           | ✗             | ✗             | LOW      | not user-settable                                           |
| `websiteUrl`, `toptalRelated`, `showViaToptal` | ✗                     | ✗             | ✗             | LOW      | not user-settable                                           |

**Note on `tags` / `media`**: the issue body for #124 mentioned these
as confirmed defects in `formatPortfolioText`. The current
`PortfolioItem` interface in
`packages/core/src/services/profile/portfolio/index.ts` does NOT
declare these fields; the `PortfolioItem` GraphQL fragment may not
select them either. **For #127**: confirm whether
`PortfolioItem` on the wire carries `tags` / `media` (or
`portfolioItem { fileGalleries { … } }` etc.) and decide whether to
extend the read selection.

**Recommendation**: this is the heaviest defect surface. In #129:

- Rewrite `formatPortfolioText` to include `description` (truncated
  to first paragraph or 200 chars), `accomplishment` (truncated),
  `clientOrCompanyName` (full), `coverImage` URL.
- Apply the override registry to route `portfolio list` through a
  curated multi-line strategy if `description`/`accomplishment` are
  exposed (table is unfriendly to paragraph fields).

### 8. `visas` — MEDIUM (formatter root cause)

**Entity** (`TravelVisa`): `id`, `countryId`, `countryName`, `visaType`,
`expiryDate`.

**Settable via `add`**: `--country` (req → `countryId`), `--type` (req
→ `visaType`), `--issued` (accepted but currently dropped server-side;
flagged with stderr warning), `--expires` (→ `expiryDate`). **Settable
via `update`**: `--country`, `--type`, `--expires`.

**Rendered in `formatVisasText`**: `id`, `countryName`, `visaType`,
`expiryDate` (skip-if-null with " (expires …)" suffix).
**`countryId` DROPPED.**

**Rendered in `formatVisasTable`**: id, countryName, visaType,
expiryDate (`""`). **`countryId` DROPPED.**

**Field-dropping defects**:

| Field       | Settable?         | `text`? | `table`? | Severity | Root cause                                                                                                      |
| ----------- | ----------------- | ------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `countryId` | ✓ via `--country` | ✗       | ✗        | MEDIUM   | **formatter** — `countryName` is rendered, `countryId` is the canonical reference id used by `update --country` |

**Why MEDIUM** (not LOW): a user editing visas via this CLI must pass
`--country <id>` — but the only way to discover the id today is
`--output json`. Surfacing the id in `text`/`pretty` lets the user
copy-paste a value for the next mutation.

**Recommendation**: include `countryId` in the `pretty` output
alongside `countryName` (e.g., `United States [country=V1-Country-12]`
or as a separate sub-line in the multi-line render).

**Null convention**: text skip-if-null + suffix-style; table empty
string.

### 9. `resume` — NONE (out of scope for the field-dropping defect class)

**Entity**: there is no read-side `Resume` entity. The sub-domain
exposes only operation-result types: `UploadResumeResult { success }`
and `CancelResumeUploadResult { success }`.

**Settable**: `upload <file>` and `cancel-upload` only — no
metadata flags.

**Rendered**: `success` boolean across all formatters, plus the input
filename echoed in text mode for `upload` (not from the entity, from
the user input).

**Field-dropping defects**: **NONE**. The result shape is
two-fields-or-fewer; nothing to drop.

**Notes**:

- No `show`/`list`/`status` query exists on this surface — resume is
  treated as a write-only fire-and-forget pair. Future work could add
  a status query (out of scope for this audit / for #127).
- Null-rendering: the `success` field is always boolean; null is
  structurally impossible. No convention to standardize.

### 10. `external` — NONE (clean)

**Sub-commands** (read-and-write surface for adjacent settings):
`update`, `custom-requirements show` / `set`, `readiness`,
`recommendations`, `advanced-wizard show`. Each carries its own
result shape and formatter set.

**Entity types** (multiple):

- `UpdateExternalProfilesResult { profile {id, updatedByTalentAt,
linkedin, github, website, behance, dribbble}, notice }`
- `CustomRequirements { backgroundCheck, drugTest,
timeTrackingTools }` (each `boolean | null`)
- `ProfileReadiness { isPhotoResolutionSatisfied, … (9 sub-section
flags), submitAvailable, updatedByTalentAt }` (each `boolean |
null`)
- `ProfileRecommendation { type, payload }` (discriminated union;
  payload polymorphic)
- `AdvancedProfileSnapshot { wizardStatus, travelVisaCount,
travelVisaIds }`

**Settable**: `update --linkedin/--github/--website/--twitter/
--behance/--dribbble`. `custom-requirements set` toggles the three
booleans. Other leaves are read-only.

**Rendered**: every settable field rendered in both `text` and
`table`; server-determined fields (`id`, `updatedByTalentAt`)
intentionally suppressed in `update`/`custom-requirements set`
results. Recommendation `payload` is summarized as
`key=value` pairs; truly polymorphic body is delegated to JSON.

**Field-dropping defects**: **NONE**. The intentional suppression of
`id`/`updatedByTalentAt` is a design choice — these aren't user-edited
and the user cares about the URLs they set, not the server's
record-keeping fields.

**Null-rendering** (multiple co-existing conventions, all
intentional):

- Boolean fields (custom-requirements, readiness): `(unset)` for null
- String fields (URLs): empty string in table, skip-if-null in text
- Glyph rendering: `readiness` uses `✓`/`✗`; other boolean fields use
  `yes`/`no`

**Recommendation**: standardization only. The polymorphic
`recommendations` payload should remain JSON-summarized.

### 11. `reviews` — NONE (clean today; query-extension candidate for #127)

**Sub-commands**: `list`, `approve-item`, `approve-section`,
`submit-for-review`.

**Entity types**:

- `SectionReviewItem { id, itemId, requestedAt }`
- `SectionReview { id, section, requestedAt, items[] }`
- `ApproveItemReviewResult { sectionReviews[], notice }` (and
  `ApproveSectionReviewResult` is a type alias of the same shape)
- `SubmitForReviewResult { notice }`

**Settable**: `approve-item --review-id --item-id --kind`,
`approve-section --review-id --section`, `submit-for-review` (no
flags). `list` has no settable fields.

**Rendered in `formatReviewsText`** (default): per-section header
with `section`, `reviewId`, `requestedAt`; nested per-item lines with
`id`, `itemId`, `requestedAt`. **All entity fields covered.**

**Rendered in `formatReviewsTable`**: 5-column TSV — `section`,
`reviewId`, `itemId`, `sectionItemId`, `requestedAt`. **All covered.**

**Field-dropping defects**: **NONE in current schema.**

**Long-text-field check**: the current `SectionReview` /
`SectionReviewItem` entities carry **no paragraph-length fields** —
all rendered values are short (UUIDs, enum labels, ISO timestamps).
**Table format is currently fit for purpose.**

**Why is `reviews list` registered in the override registry then?**

The orchestrator's epic-level guidance ("`reviews list` should
default to curated multi-line, not table") is **forward-looking**. If
#127 extends the read query to include `reviewerComment` /
`reviewerFeedback` / `rejectionReason` / similar paragraph-length
fields (which is plausible based on the platform's review-flow
semantics), the table layout would break. The audit endorses this
forward-looking registration for two reasons:

1. **No churn cost today** — the override merely steers the formatter
   selection; if the data is short, multi-line still reads fine.
2. **Forward-safe** — once long-text fields land, the multi-line
   already won't break.

The audit also flags a **second-order recommendation**: if #127 does
NOT add long-form text to the `reviews` query, the override can be
revisited (or dropped) in #129 review.

**Null convention**: text uses `?` for null `requestedAt` and
`(unknown section)` for null `section`; table uses empty string. The
`notice` field is suffix-style skip-if-null in text; row-omit-if-null
in table. Same cross-formatter inconsistency present elsewhere.

## Cross-Cutting Findings

### Null-Rendering Convention Inventory

A scan of all 11 sub-domains found **at least four distinct conventions**
in production today:

| Convention          | Where                                                                                                  | Rationale                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `(unset)`           | skills (table); external (custom-requirements / readiness booleans); basic (table for `city`)          | "Show the field exists; flag it as missing"                |
| `?`                 | skills list (text); reviews (text for `requestedAt`); education / employment year-range placeholder    | "Compact placeholder for missing data"                     |
| Empty string `""`   | education/certifications/industries/employment (table); visas (table)                                  | "Pad the column; let the surrounding context disambiguate" |
| Skip-if-null        | education/certifications/industries/portfolio/visas (text); external (URLs in text); employment (text) | "Don't show what isn't there"                              |
| `(unknown section)` | reviews (text, `section` field)                                                                        | One-off                                                    |
| `—`                 | education / certifications / employment year-range fully-empty                                         | "Zero data, distinct from missing component"               |

Some files use **two different conventions in the same module** (e.g.,
`skills/index.ts` uses skip-if-null in `formatSkillSetText`, `(unset)`
in `formatSkillSetTable`, and `?` in `formatSkillsListText`).

### Standardization Recommendation for `pretty`

The Wave-1 reframe target is `pretty` (replacing the current `text`
default). The audit recommends:

| Format   | Convention for null/undefined/empty                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pretty` | **`(unset)`** for fields the user CAN set but hasn't, when the field would otherwise be visible. Genuinely-empty container fields (an empty bullet list) collapse to a single `(none)` line. **Skip-if-null** is allowed for fields that aren't user-relevant (e.g., `position`, `updatedByTalentAt`). Empty string is preserved as `""` (the user explicitly stored an empty value). The literal `?` and `—` placeholders are retired. |
| `json`   | `null` for explicit unset fields; key omitted only when the field is structurally absent from the entity. Empty string is `""`. (Standard JSON conventions.)                                                                                                                                                                                                                                                                            |
| `yaml`   | Same as JSON: `null` for explicit unset; key omitted when absent. (Standard YAML conventions; mirrors #123.)                                                                                                                                                                                                                                                                                                                            |
| `table`  | Existing per-formatter conventions retained for `table`; the format is being de-emphasized. Long-form paragraph fields routed via the override registry to multi-line `pretty` instead.                                                                                                                                                                                                                                                 |

**Rationale**:

- `(unset)` strikes the balance between visibility (the user sees the
  field exists) and honesty (the field is empty, not zero-or-empty
  data).
- The skip-if-null escape hatch is intentional: rendering every server
  field by default would clutter the output. The convention applies
  to user-settable fields only.
- Year-range and validity-range helpers (`—` / `YYYY–present`) are
  domain-specific structured renders, NOT null placeholders — those
  stay (they convey range semantics, not field-missingness).

### Override Registry Decisions

The post-reframe dispatch pipeline takes `(commandPath, format)` and
selects a formatter strategy. For `pretty`, the default strategy is
"key/value with one row per field". Some commands need a different
strategy — typically when the entity carries paragraph-length text
that doesn't fit a row.

**Initial registry contents**:

| Command Path              | Strategy     | Rationale                                                                  |
| ------------------------- | ------------ | -------------------------------------------------------------------------- |
| `profile reviews list`    | `multi-line` | Forward-looking — once #127 surfaces reviewer-comment fields, table breaks |
| `profile employment list` | `multi-line` | `experienceItems` is paragraph-length; current table renders only count    |
| `profile portfolio list`  | `multi-line` | `description` and `accomplishment` are paragraph-length (post-#129 fix)    |

**Other candidates** (registry-tracked but not enrolled today):

- `profile basic show` — once `bio` renders inline, the row layout
  may need a multi-line strategy. Defer to #129's formatter rewrite.
- `profile industries list` — `about` is paragraph-length; currently
  short in practice, but enrolling it would be safe.

**Registry shape** (per the issue body's AC):

```ts
// packages/cli/src/lib/format-overrides.ts
export type FormatStrategy = "default" | "multi-line";

export const FORMAT_OVERRIDES: ReadonlyMap<string, FormatStrategy>;

export function resolveStrategy(commandPath: string): FormatStrategy;
```

The registry is keyed by **canonical command path** (sub-domain
verbs only — no aliases like `certs`, `experience`, `rm`). Aliases
collapse to the canonical form before lookup.

## Implementation Outputs from this Issue (#124)

1. **This triage report** (`docs/audit/2026-05-output-format-formatter-audit.md`).
2. **`packages/cli/src/lib/format-overrides.ts`** — exports the
   override registry shape with the `profile reviews list` entry
   pre-registered. `profile employment list` and
   `profile portfolio list` are added as TODO comments for #129
   to switch on once formatters are rewritten.
3. **Tests** for the override registry (verifies `profile reviews
list` resolves to `multi-line`; default fallback for unknown
   paths).
4. **CHANGELOG note** under `[Unreleased]` describing the audit
   completion and listing the defects scheduled for downstream fix.

## Inputs to Downstream Issues

### #127 — extend GraphQL queries for dropped fields

Audit-confirmed query-root-cause defects (the query doesn't fetch
the field, formatter cannot render what isn't there):

- **`basic`**: extend `ProfileShow` selection on `Profile` to include
  `about` (bio), `quote` (headline). Decide whether to dispatch a
  second talent-profile call vs. lobbying for mobile-gateway
  expansion (architectural call out of audit scope).
- **`portfolio`**: verify whether `tags` and `media` exist on the
  wire `PortfolioItem` and add to the selection if so. (Audit could
  not confirm presence — they're absent from the current TS
  interface.)
- **`reviews`**: verify whether reviewer-comment / rejection-reason
  fields exist on the wire and add to the `SECTION_REVIEWS_QUERY`
  selection. (If yes, `reviews list` override registry entry becomes
  load-bearing immediately.)

Out of scope for this audit: which surface to query, persisted-query
vs full-document, codegen wiring.

### #129 — rewrite identified formatters

Formatter-root-cause defects (entity has the field; query fetches it;
formatter just doesn't render it):

| Sub-domain   | Function                                                        | Action                                                                                    |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `basic`      | `formatProfileText`                                             | Add `bio` (post-#127), `headline` (post-#127), `photoUrl` lines                           |
| `industries` | `formatIndustryListTable`                                       | Add `about` column (or fold into `pretty` multi-line)                                     |
| `employment` | `formatEmploymentTable`                                         | Render `experienceItems` content (or route to `multi-line` via override registry)         |
| `portfolio`  | `formatPortfolioText`, `formatPortfolioTable`, `emitListResult` | Add `description`, `accomplishment`, `coverImage`; restore `clientOrCompanyName` to table |
| `visas`      | `formatVisasText`, `formatVisasTable`                           | Add `countryId` (alongside `countryName`)                                                 |

Plus apply the standardized null convention from § Standardization
Recommendation across all 11 formatter sets.
