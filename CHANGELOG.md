# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
