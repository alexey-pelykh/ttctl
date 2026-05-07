# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
